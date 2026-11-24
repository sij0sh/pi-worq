import type { Static, TSchema } from "typebox";
import { Block, errorText } from "./contracts.ts";
import { Conversation, type Sessions } from "./session.ts";
import type { Driver, Runtime, Tool } from "./sdk/contract.ts";
import type { ReviewIdentity, Telemetry } from "./telemetry.ts";
import { readTools } from "./tools.ts";

/** Bounded concurrency shared by every subagent. */
export class Semaphore {
  private free: number;
  private readonly queue: (() => void)[] = [];
  constructor(size: number) { this.free = size; }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve, reject) => {
      const go = () => { signal.removeEventListener("abort", stop); resolve(); };
      const stop = () => { this.queue.splice(this.queue.indexOf(go), 1); reject(signal.reason); };
      this.queue.push(go);
      signal.addEventListener("abort", stop, { once: true });
    });
    let released = false;
    return () => { if (released) return; released = true; const next = this.queue.shift(); if (next) next(); else this.free++; };
  }
}

export interface SubagentDeps {
  driver: Driver;
  semaphore: Semaphore;
  /** The owner's effective runtime at child launch: children never pick their own. */
  runtime(): Runtime | undefined;
  telemetry?: Telemetry;
  sessions?: Sessions;
  warning?(message: string): void;
  launched?(role: string, runtime: Runtime, label: string): void;
}
/** A private workspace prepared once the subagent holds a slot. */
export interface Workspace { cwd: string; tools: Tool[]; check?(signal: AbortSignal): Promise<string | undefined>; close(): Promise<void> }
export interface Assignment<T extends TSchema> {
  /** Telemetry row and session key. */
  key: string;
  /** Owner's telemetry key and ref. */
  parent: string;
  ref: string;
  /** Role key for runtime selection and the SDK session. */
  role: string;
  /** Telemetry row role ("PQ", "review"). */
  row: string;
  review?: ReviewIdentity;
  question?: string;
  label: string;
  title: string;
  consequence: string;
  system: string;
  payload: string;
  schema: T;
  description: string;
  turns: number;
  minutes: number;
  cwd: string;
  signal: AbortSignal;
  log(line: string): void;
  started?(): void;
  workspace?(signal: AbortSignal): Promise<Workspace>;
}
export type Outcome<T extends TSchema> = { value: Static<T> } | { error: string; cancelled: boolean };

/** One bounded child: independent context, read tools by default, no further delegation. Never throws. */
export async function runSubagent<T extends TSchema>(deps: SubagentDeps, a: Assignment<T>): Promise<Outcome<T>> {
  const { telemetry, sessions } = deps;
  telemetry?.add(a.key, a.ref, a.row, a.parent, a.review, a.question);
  // Own controller: Main can cancel this child without touching its parent or siblings.
  const own = new AbortController();
  const signal = AbortSignal.any([a.signal, own.signal]);
  let conversation: Conversation<T> | undefined;
  let workspace: Workspace | undefined;
  let release: (() => void) | undefined;
  let state: "done" | "failed" | "cancelled" = "failed";
  sessions?.set(a.key, {
    key: a.key, ref: a.ref, role: a.role, label: a.label, consequence: a.consequence,
    runtime: () => conversation?.runtime, pending: () => conversation?.pendingChange,
    cancel: async () => { telemetry?.state(a.key, "cancelling"); own.abort(new Block("cancelled", `${a.label} cancelled by Main`)); return `${a.label} cancelled`; },
    configure: (change) => {
      if (!conversation) throw new Block("busy", `${a.label} has no live session yet; try again once it is running`);
      return conversation.configure(change);
    },
  });
  try {
    const runtime = deps.runtime();
    release = await deps.semaphore.acquire(signal);
    if (runtime) deps.launched?.(a.role, runtime, a.label);
    a.started?.();
    telemetry?.state(a.key, "running");
    workspace = await a.workspace?.(signal);
    const cwd = workspace?.cwd ?? a.cwd;
    conversation = new Conversation({
      driver: deps.driver, signal, warning: deps.warning, turns: a.turns, minutes: a.minutes,
      spec: { runtime, observe: telemetry?.sink(a.key), name: a.role, cwd, tools: workspace?.tools ?? readTools(cwd), system: a.system, log: a.log },
      finish: { description: a.description, schema: a.schema },
    });
    const value = await conversation.run(a.payload);
    const problem = await workspace?.check?.(signal);
    if (problem) return { error: problem, cancelled: false };
    state = "done";
    return { value };
  } catch (error) {
    const cancelled = signal.aborted;
    state = cancelled ? "cancelled" : "failed";
    return { error: errorText(own.signal.aborted ? own.signal.reason : error), cancelled };
  } finally {
    sessions?.delete(a.key);
    telemetry?.state(a.key, state);
    own.abort(new Block("ended", `${a.label} ended`));
    release?.();
    conversation?.dispose();
    await workspace?.close().catch(() => {});
  }
}
