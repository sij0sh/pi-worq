import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { observe, type Observation } from "./telemetry.ts";
import { Block, errorText, parse } from "./contracts.ts";
import { tool, type CoreHandle, type Driver, type SessionEvent, type Tool } from "./sdk/contract.ts";

export const NUDGE = "You ended your turn without calling your finish tool. Re-ask your recursive question: if consequential work remains within your authority, do it; otherwise call the finish tool now.";
const CONTINUE = "The previous model request failed. Continue the same assignment from the conversation and tool results so far.";


export class WorkerHandoff extends Error {
  readonly turns: number;
  readonly ordinary: string;
  readonly closeout: string;
  readonly trigger: string;
  readonly quiescent: boolean;
  constructor(turns: number, ordinary: string, closeout: string, trigger: string, quiescent = true) {
    super("Worker turn budget exhausted");
    this.turns = turns; this.ordinary = ordinary; this.closeout = closeout; this.trigger = trigger; this.quiescent = quiescent;
  }
}

/** What a caller supplies; the Conversation turns the adapter's event stream into these sinks. */
export interface ConversationSpec {
  /** Role key: agent.<kind>, subagent[.<name>], reviewer.<name>. */
  name: string;
  cwd: string;
  system: string;
  tools: Tool[];
  log(line: string): void;
  observe?(value: Observation): void;
}
export interface ConversationOptions<T extends TSchema> {
  driver: Driver;
  spec: ConversationSpec;
  finish: { name: string; description: string; schema: T; validate?: (value: Static<T>) => void };
  turns: number;
  minutes: number;
  signal: AbortSignal;
  /** Open work (delegations) the session must wait for before it may stop. */
  beforeAttempt?: (signal: AbortSignal) => Promise<void>;
  chargeTurn?: () => void;
  warning?: (message: string) => void;
  pending?: () => number;
  admitCloseout?: () => boolean;
}

/**
 * The single session primitive. Drives one SDK session until it calls its finish tool:
 * queued messages, one settlement nudge, fallback model, turn and time budgets, cancellation.
 * `run` can be called again for another round in the same session.
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
  private phase: "ordinary" | "closeout" | "fenced" = "fenced";
  private ordinary = "";
  private closeout = "";
  private excess?: AbortController;
  private readonly budget = new AbortController();
  readonly signal: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private remaining: number;
  private softTimer?: ReturnType<typeof setTimeout>;
  private since = 0;
  private readonly options: ConversationOptions<T>;

  constructor(options: ConversationOptions<T>) {
    this.remaining = options.minutes * 60_000;
    this.options = options;
    this.signal = AbortSignal.any([options.signal, this.budget.signal]);
  }
  get streaming() { return this.handle?.streaming ?? false; }

  private finishTool(): Tool {
    const { name, description, schema, validate } = this.options.finish;
    return tool(name, `${description} Ends your turn.`, schema, (params) => {
      try {
        this.signal.throwIfAborted();
        const value = parse(schema, params, name);
        validate?.(value);
        this.result = value;
        this.rejected = undefined;
        return { text: "Submitted.", terminate: true };
      } catch (error) {
        this.rejected = errorText(error);
        throw error;
      }
    });
  }
  private charge() {
    const { spec, turns, warning, chargeTurn } = this.options;
    if (this.turns >= turns) {
      this.budget.abort(new Block("turn-limit", `${spec.name} reached its turn limit (${turns})`));
      return;
    }
    chargeTurn?.();
    this.turns++;
    if (turns - this.turns === 1) warning?.(`${spec.name}: one further turn remains; summarize evidence and unfinished work`);
  }
  /** The core validates every tool call against its schema, so adapters only dispatch. */
  private wrap(target: Tool): Tool {
    return {
      ...target, run: (params, signal, report) => {
        if (this.options.admitCloseout && this.phase !== "ordinary") throw new Block("turn-limit", "Tool dispatch is closed");
        return target.run(parse(target.parameters, params, target.name), signal, report);
      },
    };
  }
  private event(event: SessionEvent) {
    const { spec, admitCloseout, finish } = this.options;
    switch (event.type) {
      case "telemetry": observe(spec.observe, event.value); return;
      case "log": spec.log(event.text); return;
      case "tool-start": spec.log(`→ ${event.name} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`); return;
      case "tool-error":
        if ((!admitCloseout || this.phase === "ordinary") && event.name === finish.name) this.rejected = event.message.slice(0, 800);
        spec.log(`✗ ${event.name}: ${event.message.slice(0, 300)}`);
        return;
      case "text":
        spec.log(event.text);
        if (!event.completed || !admitCloseout || !event.text.trim()) return;
        if (this.phase === "ordinary") this.ordinary = `${this.ordinary}\n${event.text}`.trim().slice(-8000);
        if (this.phase === "closeout") this.closeout = `${this.closeout}\n${event.text}`.trim().slice(-4000);
        return;
      case "turn":
        if (admitCloseout && !this.prepaid && (this.phase !== "ordinary" || this.turns >= this.options.turns)) {
          this.phase = "fenced";
          this.excess?.abort();
          return;
        }
        if (!this.prepaid) this.charge();
        this.prepaid = false;
    }
  }
  private async open() {
    if (this.handle) return this.handle;
    const { spec, driver } = this.options;
    const caps = driver.capabilities(spec.name);
    if (caps.context.system !== "replace" || caps.context.ambientInstructions) throw new Block("capability", `${spec.name}: isolated context required`);
    const handle = await driver.open({
      id: this.id, name: spec.name, cwd: spec.cwd, system: spec.system, signal: this.signal,
      tools: [this.finishTool(), ...spec.tools].map((t) => this.wrap(t)),
      emit: (event) => this.event(event),
    });
    // An open that settles after cancellation or dispose must not leave a live session behind.
    if (this.closed || this.signal.aborted) { handle.dispose(); throw this.signal.reason ?? new Block("cancelled", `${spec.name} closed while opening`); }
    this.handle = handle;
    return handle;
  }
  /** Deliver a message: steers a streaming session, otherwise queues it for the next prompt. */
  deliver(text: string) {
    if (this.options.admitCloseout && this.phase !== "ordinary") return;
    const handle = this.handle;
    if (handle?.streaming && handle.steer) void handle.steer(text).catch(() => {
      if (this.options.admitCloseout && this.phase !== "ordinary") return;
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
    this.timer = setTimeout(() => this.budget.abort(new Block("time-limit", `${this.options.spec.name} ran out of time`)), this.remaining);
    this.timer.unref?.();
    clearTimeout(this.softTimer);
    this.softTimer = setTimeout(() => this.options.warning?.(`${this.options.spec.name}: about ${Math.ceil(this.remaining / 10000)} seconds remain; summarize unfinished work`), this.remaining * 0.9);
    this.softTimer.unref?.();
  }

  async run(first: string): Promise<Static<T>> {
    this.result = undefined;
    this.ordinary = this.closeout = "";
    this.phase = "ordinary";
    this.excess = new AbortController();
    this.prepaid = false;
    const caller = this.options.signal;
    caller.throwIfAborted();                // a caller abort never prompts
    this.budget.signal.throwIfAborted();    // a spent budget is terminal: no prompt
    const gate = this.signal;

    this.resume();
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(gate.reason);
      if (gate.aborted) fail(); else gate.addEventListener("abort", fail, { once: true });
    });
    void aborted.catch(() => {});
    const excess = new Promise<undefined>((resolve) => this.excess!.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    let stopping: Promise<boolean> | undefined;
    const stopOnce = (force = false) => stopping ??= this.stop(force);
    try {
      if (this.options.admitCloseout && this.turns >= this.options.turns) {
        throw new WorkerHandoff(this.turns, "", "", "prompt admission");
      }
      const handle = await Promise.race([this.open(), aborted]);
      let next = first;
      let nudged = false;
      let corrections = 0;
      for (;;) {
        if (this.options.admitCloseout && this.turns >= this.options.turns) {
          gate.throwIfAborted();
          throw new WorkerHandoff(this.turns, this.ordinary, "", "prompt admission");
        }
        if (this.turns < this.options.turns) await this.options.beforeAttempt?.(gate);
        gate.throwIfAborted();
        this.charge(); // Count attempts even when preflight fails before turn_start.
        gate.throwIfAborted();
        this.prepaid = true;
        const turn = handle.prompt(next);
        void turn.catch(() => {});        // an abandoned promise can still reject
        const outcome = await Promise.race([turn, aborted, excess]);
        const failed = outcome === undefined ? undefined : outcome === "failed" || outcome === "preflight-failed";
        if (gate.aborted) {
          await stopOnce();               // caller or budget abort: stop the turn, once
          if (caller.aborted) throw caller.reason;
          if (this.result !== undefined) return this.result;
          throw gate.reason;
        }
        if (this.result !== undefined) return this.result;
        if (this.options.admitCloseout && this.turns >= this.options.turns) {
          if (failed === undefined || this.excess.signal.aborted) {
            const quiescent = await stopOnce(true);
            gate.throwIfAborted();
            throw new WorkerHandoff(this.turns, this.ordinary, "", "automatic turn admission", quiescent);
          }
          await this.handoff(handle, gate, aborted, excess, stopOnce);
        }
        if (failed) {
          if (await handle.fallback()) { next = this.inbox.shift() ?? CONTINUE; continue; }
          throw new Block("model", `${this.options.spec.name}: model request failed`);
        }
        const queued = this.inbox.shift();
        if (queued !== undefined) { next = queued; continue; }
        if ((this.options.pending?.() ?? 0) > 0) {
          await Promise.race([new Promise<void>((resolve) => { this.wake = resolve; }), aborted]);
          next = this.inbox.shift() ?? "Continue.";
          continue;
        }
        if (nudged) {
          // A rejected finish gets one further explained attempt; a bare end of turn gets one nudge.
          if (this.rejected !== undefined && corrections < 2) {
            corrections++;
            next = `Your ${this.options.finish.name} call was rejected: ${this.rejected}\nCorrect it and call ${this.options.finish.name} again.`;
            continue;
          }
          throw this.rejected
            ? new Block("rejected", `${this.options.spec.name} submission rejected: ${this.rejected}`)
            : new Block("no-result", `${this.options.spec.name} ended without calling ${this.options.finish.name}`);
        }
        nudged = true;
        next = this.rejected ? `Your ${this.options.finish.name} call was rejected: ${this.rejected}\nCorrect it and call ${this.options.finish.name} again.` : NUDGE;
      }
    } catch (error) {
      if (gate.aborted) await stopOnce();  // at most once, only after an abort
      if (caller.aborted) throw caller.reason;
      if (this.result !== undefined) return this.result;
      if (!gate.aborted && this.options.admitCloseout && this.turns >= this.options.turns && !(error instanceof WorkerHandoff)) {
        this.phase = "fenced";
        const quiescent = await stopOnce(true);
        gate.throwIfAborted();
        throw new WorkerHandoff(this.turns, this.ordinary, "", "ordinary request did not settle normally", quiescent);
      }
      throw error;
    } finally {
      this.phase = "fenced";
      this.pause();
    }
  }
  private async handoff(handle: CoreHandle, gate: AbortSignal, aborted: Promise<never>, excess: Promise<undefined>, stopOnce: (force: boolean) => Promise<boolean>): Promise<never> {
    let text = "";
    gate.throwIfAborted();
    let quiescent = !handle.streaming;
    if (quiescent && this.options.admitCloseout?.()) {
      this.phase = "closeout";
      this.prepaid = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      try {
        const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 15_000); });
        const result = await Promise.race([
          handle.prompt("End this session. Do not use tools. Write a concise handoff for Main: completed work, evidence, blockers and next steps.", { toolFree: true }),
          deadline, excess, aborted,
        ]);
        settled = result !== undefined && !handle.streaming;
        if (settled && result === "completed" && !this.prepaid && this.phase === "closeout") text = this.closeout;
      } catch { /* The host record does not depend on model closeout. */ }
      finally {
        this.phase = "fenced";
        clearTimeout(timer);
        quiescent = settled || await stopOnce(true);
      }
    } else if (!quiescent) {
      this.phase = "fenced";
      quiescent = await stopOnce(true);
    }
    gate.throwIfAborted();
    throw new WorkerHandoff(this.turns, this.ordinary, text, "last ordinary turn settled", quiescent);
  }
  /** Abort the live turn, bounded to 5s. */
  async stop(force = false) {
    const handle = this.handle;
    if (!handle || (!force && !handle.streaming)) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([handle.abort().then(() => true, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(timer);
    return stopped && !handle.streaming;
  }
  dispose() { this.closed = true; clearTimeout(this.softTimer); clearTimeout(this.timer); this.poke(); this.handle?.dispose(); this.handle = undefined; }
}
