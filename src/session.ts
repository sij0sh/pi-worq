import type { Static, TSchema } from "typebox";
import { Block, errorText, parse } from "./contracts.ts";

export type Profile = "agent" | "subagent" | "reviewer";
export type ToolOutput = string | { text: string; image?: { mimeType: string; data: string }; terminate?: boolean };
export interface Tool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  run(params: Static<T>, signal: AbortSignal): Promise<ToolOutput> | ToolOutput;
}
export const tool = <T extends TSchema>(name: string, description: string, parameters: T, run: Tool<T>["run"]): Tool => ({ name, description, parameters, run } as Tool);

/** What a driver needs to start one SDK session. */
export interface Spec {
  profile: Profile;
  /** Model key: agent.<kind>, subagent, reviewer.<name>. */
  name: string;
  cwd: string;
  system: string;
  tools: Tool[];
  log(line: string): void;
  turn(): void;
  /** A tool call failed (including SDK-side argument validation, which runs before Tool.run). */
  toolError(name: string, message: string): void;
}
/** One live SDK session. `prompt` resolves when the session goes idle; true means the model request failed before starting. */
export interface Handle {
  prompt(text: string): Promise<boolean>;
  steer(text: string): Promise<void>;
  readonly streaming: boolean;
  abort(): Promise<void>;
  /** Switch to the fallback model once. False when none is left. */
  fallback(): Promise<boolean>;
  dispose(): void;
}
export type Driver = (spec: Spec) => Promise<Handle>;

export const NUDGE = "You ended your turn without calling your finish tool. Re-ask your recursive question: if consequential work remains within your authority, do it; otherwise call the finish tool now.";
const CONTINUE = "The previous model request failed. Continue the same assignment from the conversation and tool results so far.";

export interface ConversationOptions<T extends TSchema> {
  driver: Driver;
  spec: Omit<Spec, "tools" | "turn" | "toolError"> & { tools: Tool[] };
  finish: { name: string; description: string; schema: T; validate?: (value: Static<T>) => void };
  turns: number;
  minutes: number;
  signal: AbortSignal;
  /** Open work (delegations) the session must wait for before it may stop. */
  pending?: () => number;
}

/**
 * The single session primitive. Drives one SDK session until it calls its finish tool:
 * queued messages, one settlement nudge, fallback model, turn and time budgets, cancellation.
 * `run` can be called again for another round in the same session.
 */
export class Conversation<T extends TSchema> {
  private handle?: Handle;
  private result?: Static<T>;
  private rejected?: string;
  private readonly inbox: string[] = [];
  private wake?: () => void;
  private turns = 0;
  private readonly budget = new AbortController();
  readonly signal: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private remaining = 0;
  private since = 0;
  private readonly options: ConversationOptions<T>;

  constructor(options: ConversationOptions<T>) {
    this.options = options;
    this.signal = AbortSignal.any([options.signal, this.budget.signal]);
  }
  get streaming() { return this.handle?.streaming ?? false; }

  private finishTool(): Tool {
    const { name, description, schema, validate } = this.options.finish;
    return tool(name, `${description} Ends your turn.`, schema, (params) => {
      try {
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
  private async open() {
    if (this.handle) return this.handle;
    const { spec, turns } = this.options;
    this.handle = await this.options.driver({
      ...spec,
      tools: [this.finishTool(), ...spec.tools],
      turn: () => { if (++this.turns > turns) this.budget.abort(new Block("turn-limit", `${spec.name} reached its turn limit (${turns})`)); },
      toolError: (name, message) => { if (name === this.options.finish.name) this.rejected = message.slice(0, 800); },
    });
    return this.handle;
  }
  /** Deliver a message: steers a streaming session, otherwise queues it for the next prompt. */
  deliver(text: string) {
    if (this.handle?.streaming) void this.handle.steer(text).catch(() => { this.inbox.push(text); this.poke(); });
    else { this.inbox.push(text); this.poke(); }
  }
  poke() { const wake = this.wake; this.wake = undefined; wake?.(); }
  /** Pause the time budget (e.g. while Main answers). */
  pause() { clearTimeout(this.timer); this.timer = undefined; this.remaining = Math.max(1, this.remaining - (Date.now() - this.since)); }
  resume() {
    this.since = Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.budget.abort(new Block("time-limit", `${this.options.spec.name} ran out of time`)), this.remaining);
    this.timer.unref?.();
  }

  async run(first: string): Promise<Static<T>> {
    this.result = undefined;
    this.remaining = this.options.minutes * 60_000;
    this.resume();
    const signal = this.signal;
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(signal.reason);
      if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
    });
    void aborted.catch(() => {});
    try {
      const handle = await Promise.race([this.open(), aborted]);
      let next = first;
      let nudged = false;
      for (;;) {
        const failed = await Promise.race([handle.prompt(next), aborted]);
        signal.throwIfAborted();
        if (this.result !== undefined) return this.result;
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
          throw this.rejected
            ? new Block("rejected", `${this.options.spec.name} submission rejected: ${this.rejected}`)
            : new Block("no-result", `${this.options.spec.name} ended without calling ${this.options.finish.name}`);
        }
        nudged = true;
        next = this.rejected ? `Your ${this.options.finish.name} call was rejected: ${this.rejected}\nCorrect it and call ${this.options.finish.name} again.` : NUDGE;
      }
    } catch (error) {
      if (signal.aborted) await this.stop();
      throw signal.aborted ? signal.reason : error;
    } finally {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  /** Abort the live turn, bounded to 5s. */
  async stop() {
    const handle = this.handle;
    if (!handle?.streaming) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([handle.abort().catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
  }
  dispose() { clearTimeout(this.timer); this.poke(); this.handle?.dispose(); this.handle = undefined; }
}
