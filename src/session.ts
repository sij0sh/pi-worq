import type { Skill } from "./runtime/skills.ts";
import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { observe, type Observation } from "./telemetry.ts";
import { Block, errorText, parse } from "./contracts.ts";
import { tool, type CoreHandle, type Driver, type RequestDecision, type Runtime, type RuntimeChange, type SessionEvent, type Tool } from "./sdk/contract.ts";

export const NUDGE = "You ended your turn without calling submit. Re-ask your recursive question: if consequential work remains within your authority, do it; otherwise call submit now.";

/**
 * One controllable live session (owner, PQ or review), keyed like its telemetry row.
 * Telemetry observes; this controls. Registered on creation, removed on disposal.
 */
export interface SessionControl {
  key: string;
  ref: string;
  /** Role key (agent.plan, subagent, review …). */
  role: string;
  label: string;
  /** What cancelling this session does, shown before confirmation. */
  consequence: string;
  runtime(): Runtime | undefined;
  /** A fatal runtime invalidation: no live runtime and no resume. */
  invalidated?(): boolean;
  pending(): RuntimeChange | undefined;
  cancel(): Promise<string>;
  configure(change: RuntimeChange): Promise<"applied" | "queued">;
}
export type Sessions = Map<string, SessionControl>;

/** What a caller supplies; the Conversation turns the adapter's event stream into these sinks. */
export interface ConversationSpec {
  runtime?: import('./sdk/contract.ts').Runtime;
  /** Role key: agent.<kind>, subagent[.<name>], review. */
  name: string;
  cwd: string;
  system: string;
  tools: Tool[];
  /** Session-specific skill packages (a workflow's own). */
  skills?: readonly Skill[];
  log(line: string): void;
  observe?(value: Observation): void;
}
export interface ConversationOptions<T extends TSchema> {
  driver: Driver;
  spec: ConversationSpec;
  /** The one finish tool, `submit`, with this assignment's schema. */
  finish: { description: string; schema: T; validate?: (value: Static<T>, signal: AbortSignal) => void | Promise<void> };
  /** Budget per invocation of `run`. */
  turns: number;
  minutes: number;
  signal: AbortSignal;
  warning?: (message: string) => void;
  /** Open work (delegations) the session must wait for before it may stop. */
  pending?: () => number;
  /** A fatal, backend-neutral runtime invalidation. Wakes a parked owner; the session can never run again. */
  invalidated?(error: Block): void;
}

/**
 * The single session primitive. Drives one SDK session until it calls `submit`:
 * queued messages, one settlement nudge, per-invocation turn and time budgets, cancellation.
 * `run` can be called again on the same live session (a parked agent resumed by Main).
 */
export class Conversation<T extends TSchema> {
  private readonly id = randomUUID();
  private handle?: CoreHandle;
  private closed = false;
  private result?: Static<T>;
  private rejected?: string;
  private readonly inbox: string[] = [];
  private wake?: () => void;
  private turns = 0;
  private prepaid = false;
  /** Tool fence: dispatch only while a run is in progress and within budget. */
  private active = false;
  private budget = new AbortController();
  private gate: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private remaining: number;
  private softTimer?: ReturnType<typeof setTimeout>;
  private since = 0;
  private readonly options: ConversationOptions<T>;
  /** Main's runtime change waiting for the next safe boundary. */
  private change?: RuntimeChange;
  /** Covers SDK preflight as well as streaming and tools. */
  private prompting = false;
  private applying: Promise<void> = Promise.resolve();
  /** Serializes admission decisions so concurrent or stale callbacks cannot spend one token twice. */
  private admission: Promise<unknown> = Promise.resolve();
  /** The current prompt's identity and cancellation scope. */
  private current?: { signal: AbortSignal; controller: AbortController };
  /** A fatal, backend-neutral configuration invalidation: the handle can never serve another request. */
  private fatal?: Block;
  private readonly invalidation = new AbortController();
  /** True for an adapter that opted into awaited pre-request admission. */
  private awaitAdmission = false;
  /** Last completed assistant text: what survives budget exhaustion. */
  last = "";

  constructor(options: ConversationOptions<T>) {
    this.remaining = options.minutes * 60_000;
    this.options = options;
    this.gate = options.signal;
  }
  get streaming() { return this.handle?.streaming ?? false; }
  /** Runtime in effect, else the one requested at launch. */
  get runtime(): Runtime | undefined { return this.handle?.runtime ?? this.options.spec.runtime; }
  /** A fatal configuration invalidation is latched for the rest of this session's life. */
  get invalidated() { return this.fatal !== undefined; }
  get fatalError() { return this.fatal; }
  get pendingChange(): RuntimeChange | undefined { return this.change && { ...this.change }; }
  private get ended() { return this.closed || this.options.signal.aborted; }

  private note(value: string | undefined) { observe(this.options.spec.observe, { change: value }); }
  private describe(change: RuntimeChange) {
    const now = this.runtime;
    const from = [now?.model?.split("/").at(-1), now?.thinking].filter(Boolean).join("/");
    const to = [(change.model ?? now?.model)?.split("/").at(-1), change.thinking ?? now?.thinking].filter(Boolean).join("/");
    return from ? `${from} → ${to}` : to;
  }
  /**
   * Change model and/or thinking for this live session. Applies now when the session is idle,
   * otherwise before the next model request, or when the prompt settles. Never interrupts a tool.
   */
  async configure(change: RuntimeChange): Promise<"applied" | "queued"> {
    if (this.fatal) throw this.fatal;
    if (this.ended) throw new Block("ended", `${this.options.spec.name} has ended`);
    if (this.handle && !this.handle.configure) throw new Block("capability", `${this.options.spec.name}: this harness cannot change a live session`);
    const next = { ...this.change, ...change };
    this.handle?.check?.(next);
    this.change = next;
    if (!this.handle || this.prompting || this.handle.streaming) {
      this.options.spec.log(`runtime change queued (${this.describe(next)}): applies at the next safe request boundary`);
      this.note(`◷ ${this.describe(next)}`);
      return "queued";
    }
    await this.flush(this.options.signal, true);
    return "applied";
  }
  /** Only called while idle, after settlement, or at the adapter's pre-request boundary. */
  private flush(signal = this.gate, interactive = false): Promise<void> {
    const applying = this.applying.then(async () => {
      const change = this.change;
      const handle = this.handle;
      if (!change || !handle || this.ended || signal.aborted) return;
      this.change = undefined;
      if (!handle.configure) { this.note(undefined); this.options.spec.log("runtime change dropped: this harness cannot change a live session"); return; }
      this.note("↻ switching");
      try { await handle.configure(change); }
      catch (error) {
        // A fatal invalidation is not an ordinary refusal: latch it and abort this conversation's live work.
        if (error instanceof Block && error.code === "runtime-invalidated") {
          this.invalidate(error);
          throw error;
        }
        this.options.spec.log(`runtime change failed: ${errorText(error)}`);
        if (interactive) throw error;
        this.options.warning?.(`${this.options.spec.name}: runtime change failed: ${errorText(error)}`);
      } finally { this.note(this.change ? `◷ ${this.describe(this.change)}` : undefined); }
    });
    this.applying = applying.catch(() => {});
    return applying;
  }
  /** Latch a backend-neutral fatal runtime invalidation; every caller and future run sees it. */
  private invalidate(error: Block) {
    if (this.fatal) return;
    this.fatal = error;
    this.change = undefined;
    this.note(undefined);
    this.options.spec.log(`runtime invalidated: ${errorText(error)}`);
    // Show unavailable, not stale settings, in the dock and inspector.
    observe(this.options.spec.observe, { setup: { model: undefined, thinking: undefined, skills: [] } });
    this.invalidation.abort(error);
    this.options.invalidated?.(error);
  }
  /**
   * One awaited admission decision for an opted-in adapter. The first request consumes the token `run` already
   * charged; each continuation acquires one turn or aborts the invocation budget with `turn-limit`.
   * Decisions are serialized, prompt identity is rechecked, and queued configuration is applied first.
   */
  private admit(signal: AbortSignal): Promise<RequestDecision> {
    const decide = async (): Promise<RequestDecision> => {
      const current = this.current;
      const refuse = (reason: unknown): RequestDecision => ({ allowed: false, reason });
      if (this.fatal) return refuse(this.fatal);
      if (!current || current.signal !== signal || signal.aborted || this.ended || !this.active) {
        return refuse(signal.aborted ? signal.reason : new Block("stale", `${this.options.spec.name}: stale request admission`));
      }
      if (this.prepaid) this.prepaid = false;
      else {
        const exhausted = this.spend();
        if (exhausted) return refuse(exhausted);
      }
      // A safe boundary: queued model/thinking changes apply before the request is released.
      try { await this.flush(signal); }
      catch (error) { return refuse(error); }
      if (this.fatal) return refuse(this.fatal);
      if (!this.current || this.current.signal !== signal || signal.aborted || this.ended) {
        return refuse(signal.aborted ? signal.reason : new Block("stale", `${this.options.spec.name}: stale request admission`));
      }
      return { allowed: true };
    };
    const answer = this.admission.then(decide, decide);
    this.admission = answer.catch(() => {});
    return answer;
  }
  private async prompt(handle: CoreHandle, text: string, signal: AbortSignal) {
    this.prompting = true;
    try { return await handle.prompt(text, signal); }
    finally { this.prompting = false; }
  }

  private finishTool(): Tool {
    const { description, schema, validate } = this.options.finish;
    return tool("submit", `${description} Ends your turn.`, schema, async (params, signal) => {
      try {
        const live = AbortSignal.any([this.gate, signal]);
        live.throwIfAborted();
        const value = parse(schema, params, "submit");
        await validate?.(value, live);
        this.result = value;
        this.rejected = undefined;
        return { text: "Submitted.", terminate: true };
      } catch (error) {
        if (error instanceof Block && error.code === "cleanup-unconfirmed") this.invalidate(error);
        this.rejected = errorText(error);
        throw error;
      }
    });
  }
  /** Acquire one turn, or abort this invocation's budget with the existing `turn-limit` reason. */
  private spend(): Block | undefined {
    const { spec, turns, warning } = this.options;
    if (this.turns >= turns) {
      const exhausted = new Block("turn-limit", `${spec.name} reached its turn limit (${turns})`);
      this.budget.abort(exhausted);
      return exhausted;
    }
    this.turns++;
    if (turns - this.turns === 1) warning?.(`${spec.name}: one further turn remains; summarize evidence and unfinished work`);
    return undefined;
  }
  private charge() { this.spend(); }
  /** The core validates every tool call against its schema, so adapters only dispatch. */
  private wrap(target: Tool): Tool {
    return {
      ...target, run: (params, signal, report) => {
        if (!this.active || this.gate.aborted) throw new Block("fenced", "Tool dispatch is closed");
        return target.run(parse(target.parameters, params, target.name), signal, report);
      },
    };
  }
  private event(event: SessionEvent) {
    const { spec } = this.options;
    switch (event.type) {
      case "telemetry": observe(spec.observe, event.value); return;
      case "log": spec.log(event.text); return;
      case "tool-start": spec.log(`→ ${event.name} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`); return;
      case "tool-error":
        if (event.name === "submit") this.rejected = event.message.slice(0, 800);
        spec.log(`✗ ${event.name}: ${event.message.slice(0, 300)}`);
        return;
      case "text":
        spec.log(event.text);
        if (event.completed && event.text.trim()) this.last = event.text.slice(-8000);
        return;
      case "turn":
        // An opted-in adapter's turns are observational only: admission already charged or refused the request.
        if (this.awaitAdmission) return;
        if (!this.prepaid) this.charge();
        this.prepaid = false;
    }
  }
  private async open() {
    if (this.handle) return this.handle;
    const { spec, driver } = this.options;
    await driver.load?.(spec.runtime?.sdk ?? "pi");
    const caps = driver.capabilities(spec.name, spec.runtime);
    if (caps.context.system !== "replace" || caps.context.ambientInstructions) throw new Block("capability", `${spec.name}: isolated context required`);
    this.awaitAdmission = caps.requestAdmission === "awaited";
    const handle = await driver.open({
      id: this.id, runtime: spec.runtime, name: spec.name, cwd: spec.cwd, system: spec.system, skills: spec.skills, signal: this.options.signal,
      tools: [this.finishTool(), ...spec.tools].map((t) => this.wrap(t)),
      emit: (event) => this.event(event),
      ...(this.awaitAdmission
        ? { admitRequest: (signal: AbortSignal) => this.admit(signal) }
        : { beforeRequest: (signal: AbortSignal) => this.flush(signal) }),
    });
    // An open that settles after cancellation or dispose must not leave a live session behind.
    if (this.ended) { handle.dispose(); throw this.options.signal.reason ?? new Block("cancelled", `${spec.name} closed while opening`); }
    this.handle = handle;
    return handle;
  }
  /** Deliver a message: steers a streaming session, otherwise queues it for the next prompt. */
  deliver(text: string) {
    const handle = this.handle;
    if (handle?.streaming && handle.steer) void handle.steer(text).catch(() => {
      this.options.spec.log("message queued: the harness cannot steer it into the running turn");
      this.inbox.push(text);
      this.poke();
    });
    else {
      if (handle?.streaming) this.options.spec.log("message queued: the harness cannot steer it into the running turn");
      this.inbox.push(text); this.poke();
    }
  }
  poke() { const wake = this.wake; this.wake = undefined; wake?.(); }
  /** Pause the time budget (e.g. while Main answers). */
  pause() { clearTimeout(this.softTimer); if (!this.timer) return; clearTimeout(this.timer); this.timer = undefined; this.remaining = Math.max(1, this.remaining - (Date.now() - this.since)); }
  resume() {
    this.since = Date.now();
    clearTimeout(this.timer);
    const budget = this.budget;
    this.timer = setTimeout(() => budget.abort(new Block("time-limit", `${this.options.spec.name} ran out of time`)), this.remaining);
    this.timer.unref?.();
    clearTimeout(this.softTimer);
    this.softTimer = setTimeout(() => this.options.warning?.(`${this.options.spec.name}: about ${Math.ceil(this.remaining / 10000)} seconds remain; summarize unfinished work`), this.remaining * 0.9);
    this.softTimer.unref?.();
  }

  /** One invocation with a fresh budget. Budget exhaustion stops the turn and throws; the session stays reusable. */
  async run(first: string): Promise<Static<T>> {
    const caller = this.options.signal;
    caller.throwIfAborted();                // a caller abort never prompts
    if (this.fatal) throw this.fatal;
    if (this.closed) throw new Block("ended", `${this.options.spec.name} has ended`);
    this.result = this.rejected = undefined;
    this.turns = 0;
    this.prepaid = false;
    this.remaining = this.options.minutes * 60_000;
    this.budget = new AbortController();
    const gate = this.gate = AbortSignal.any([caller, this.budget.signal, this.invalidation.signal]);
    this.active = true;
    this.resume();
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(gate.reason);
      if (gate.aborted) fail(); else gate.addEventListener("abort", fail, { once: true });
    });
    void aborted.catch(() => {});
    let stopping: Promise<boolean> | undefined;
    const stopOnce = () => stopping ??= this.stop();
    try {
      const handle = await Promise.race([this.open(), aborted]);
      let next = first;
      let nudged = false;
      let corrections = 0;
      for (;;) {
        this.charge(); // Count attempts even when preflight fails before turn_start.
        gate.throwIfAborted();
        await this.flush();               // safe boundary: no prompt in flight
        gate.throwIfAborted();
        this.prepaid = true;
        // Fresh identity per prompt: stale adapter callbacks can never authorize or spend for a later prompt.
        const controller = new AbortController();
        const promptSignal = AbortSignal.any([gate, controller.signal]);
        this.current = { signal: promptSignal, controller };
        const turn = this.prompt(handle, next, promptSignal);
        void turn.catch(() => {});        // an abandoned promise can still reject
        let outcome: Awaited<typeof turn>;
        try { outcome = await Promise.race([turn, aborted]); }
        finally { this.current = undefined; }
        // Also flush when no further SDK request follows (e.g. submission or waiting for PQs).
        await this.flush();
        if (this.result !== undefined) return this.result;
        if (outcome === "failed" || outcome === "preflight-failed") {
          throw new Block("model", `${this.options.spec.name}: ${outcome === "preflight-failed" ? "model prompt rejected before request" : "model request failed"}`);
        }
        const queued = this.inbox.shift();
        if (queued !== undefined) { next = queued; continue; }
        if ((this.options.pending?.() ?? 0) > 0) {
          await Promise.race([new Promise<void>((resolve) => { this.wake = resolve; }), aborted]);
          next = this.inbox.shift() ?? "Continue.";
          continue;
        }
        const retry = `Your submit call was rejected: ${this.rejected}\nCorrect it and call submit again.`;
        if (nudged) {
          // A rejected finish gets one further explained attempt; a bare end of turn gets one nudge.
          if (this.rejected !== undefined && corrections < 2) { corrections++; next = retry; continue; }
          throw this.rejected
            ? new Block("rejected", `${this.options.spec.name} submission rejected: ${this.rejected}`)
            : new Block("no-result", `${this.options.spec.name} ended without calling submit`);
        }
        nudged = true;
        next = this.rejected ? retry : NUDGE;
      }
    } catch (error) {
      if (gate.aborted && !(await stopOnce())) {
        // A turn that will not stop leaves the session unsafe to resume.
        this.dispose();
      }
      if (caller.aborted) throw caller.reason;
      if (this.result !== undefined) return this.result;
      throw gate.aborted ? gate.reason : error;
    } finally {
      this.active = false;
      this.pause();
    }
  }
  /** Abort the live turn, bounded to 5s. True when the session is idle afterwards. */
  async stop() {
    const handle = this.handle;
    if (!handle?.streaming) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([handle.abort().then(() => true, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(timer);
    return stopped && !handle.streaming;
  }
  get disposed() { return this.closed; }
  dispose() {
    this.closed = true;
    this.current?.controller.abort(new Block("ended", `${this.options.spec.name} has ended`));
    this.current = undefined;
    if (this.change) this.note(undefined);
    this.change = undefined;
    clearTimeout(this.softTimer);
    clearTimeout(this.timer);
    this.poke();
    this.handle?.dispose();
    this.handle = undefined;
  }
}
