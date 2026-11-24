import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import type { Observation, Outcome } from './telemetry.ts';
import type { ModelChoice } from "./config.ts";
import { Block, errorText, parse } from "./contracts.ts";

export type Profile = "agent" | "subagent" | "reviewer";
export type ToolOutput = string | { text: string; image?: { mimeType: string; data: string }; terminate?: boolean };
export interface Tool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  run(params: Static<T>, signal: AbortSignal, report?: (outcome: Outcome) => void): Promise<ToolOutput> | ToolOutput;
}
export const tool = <T extends TSchema>(name: string, description: string, parameters: T, run: Tool<T>["run"]): Tool => ({ name, description, parameters, run } as Tool);

/** Host services reach adapters as one opaque value, narrowed only inside the adapter. */
export interface HostContext { readonly host: unknown }
/** What a harness can do. Pure data: the core never judges a choice from it alone (see assertChoice). */
export interface Capabilities {
  /** The harness can switch to a fallback model. */
  fallback: boolean;
  /** Thinking levels the chosen model accepts; [] means the harness has no level control at all. */
  thinking: readonly string[];
  resources?: readonly ("skills" | "instructions" | "extensions")[];
  context: { system: "replace" | "append"; ambientInstructions: boolean };
}

/** What a driver needs to start one SDK session. */
export interface Spec {
  /** One identity per Conversation, minted in Conversation.open. */
  id: string;
  profile: Profile;
  /** Model key: agent.<kind>, subagent, reviewer.<name>. */
  name: string;
  cwd: string;
  system: string;
  tools: Tool[];
  observe?(value: Observation): void;
  log(line: string): void;
  turn(): void;
  completedText?(text: string): void;
  /** A tool call failed (including SDK-side argument validation, which runs before Tool.run). */
  toolError(name: string, message: string): void;
}
/** One live SDK session. `prompt` resolves when the session goes idle; true means the model request failed before starting. */
export interface Handle {
  prompt(text: string, options?: { toolFree: boolean }): Promise<boolean>;
  /** Duty: deliver a message into the running turn. Throws when it cannot reach this run. */
  steer(text: string): Promise<void>;
  readonly streaming: boolean;
  /** Duty: settle the in-flight `prompt()` and clear `streaming` within the stop bound (5s). */
  abort(): Promise<void>;
  /** Switch to the fallback model once. False when none is left. */
  fallback(): Promise<boolean>;
  dispose(): void;
}
export type Driver = ((spec: Spec) => Promise<Handle>) & { capabilities(name: string): Capabilities };

/**
 * Judge a resolved model choice against what the harness can do. Raises Block("capability") naming
 * the config path of the offending field; `capabilities` itself never judges.
 */
export function assertChoice(choice: ModelChoice, caps: Capabilities): void {
  for (const key of ["skills", "instructions", "extensions"] as const) {
    if (choice.resources?.[key]?.length && !caps.resources?.includes(key)) throw new Block("capability", `${choice.from[key]}: unsupported resource ${key}`);
  }
  if (choice.fallbackModel !== undefined && !caps.fallback) {
    throw new Block("capability", `${choice.from.fallbackModel ?? "fallbackModel"}: ${choice.harness} has no fallback model`);
  }
  if (choice.thinking !== undefined && !caps.thinking.includes(choice.thinking)) {
    const where = choice.from.thinking ?? "thinking";
    throw new Block("capability", caps.thinking.length
      ? `${where}: ${choice.thinking} is not a ${choice.harness} thinking level (${caps.thinking.join(", ")})`
      : `${where}: ${choice.harness} has no thinking level control`);
  }
}

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

export interface ConversationOptions<T extends TSchema> {
  driver: Driver;
  spec: Omit<Spec, "id" | "tools" | "turn" | "toolError"> & { tools: Tool[] };
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
  private handle?: Handle;
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
  private async open() {
    if (this.handle) return this.handle;
    const { spec, driver } = this.options;
    const caps = driver.capabilities(spec.name);
    if (caps.context.system !== "replace" || caps.context.ambientInstructions) throw new Block("capability", `${spec.name}: isolated context required`);
    this.handle = await driver({
      ...spec,
      id: this.id,
      tools: [this.finishTool(), ...spec.tools].map((tool) => this.options.admitCloseout ? {
        ...tool, run: (...args) => {
          if (this.phase !== "ordinary") throw new Block("turn-limit", "Tool dispatch is closed");
          return tool.run(...args);
        },
      } : tool),
      completedText: (text) => {
        if (!this.options.admitCloseout || !text.trim()) return;
        if (this.phase === "ordinary") this.ordinary = `${this.ordinary}\n${text}`.trim().slice(-8000);
        if (this.phase === "closeout") this.closeout = `${this.closeout}\n${text}`.trim().slice(-4000);
      },
      turn: () => {
        if (this.options.admitCloseout && !this.prepaid &&
            (this.phase !== "ordinary" || this.turns >= this.options.turns)) {
          this.phase = "fenced";
          this.excess?.abort();
          return;
        }
        if (!this.prepaid) this.charge();
        this.prepaid = false;
      },
      toolError: (name, message) => {
        if ((!this.options.admitCloseout || this.phase === "ordinary") && name === this.options.finish.name) this.rejected = message.slice(0, 800);
      },
    });
    return this.handle;
  }
  /** Deliver a message: steers a streaming session, otherwise queues it for the next prompt. */
  deliver(text: string) {
    if (this.options.admitCloseout && this.phase !== "ordinary") return;
    const handle = this.handle;
    if (handle?.streaming) void handle.steer(text).catch(() => {
      if (this.options.admitCloseout && this.phase !== "ordinary") return;
      this.options.spec.log("message queued: the harness cannot steer it into the running turn");
      this.inbox.push(text);
      this.poke();
    });
    else { this.inbox.push(text); this.poke(); }
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
        const failed = await Promise.race([turn, aborted, excess]);
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
          if (await handle.fallback()) { this.options.spec.log("Model failed; switched to fallback"); next = this.inbox.shift() ?? CONTINUE; continue; }
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
  private async handoff(handle: Handle, gate: AbortSignal, aborted: Promise<never>, excess: Promise<undefined>, stopOnce: (force: boolean) => Promise<boolean>): Promise<never> {
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
        if (settled && result === false && !this.prepaid && this.phase === "closeout") text = this.closeout;
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
  dispose() { clearTimeout(this.softTimer); clearTimeout(this.timer); this.poke(); this.handle?.dispose(); this.handle = undefined; }
}
