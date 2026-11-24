import type { AgentState } from "./agent.ts";
import type { Verdict } from "./contracts.ts";

export type Outcome = { kind: "exit"; code: number; stdout: boolean; stderr: boolean }
  | { kind: "search"; count: number; capped: boolean }
  | { kind: "ok" | "sdk-error" | "launch" | "timeout" | "output-limit" | "process-exit" | "cleanup-unconfirmed" | "cancelled" | "missing"; cancelled?: boolean };
export interface Setup { sdk?: string; model?: string; thinking?: string; skills: string[] }
interface ContextEstimate { percent?: number; contextWindow: number }
export type Observation = { phase: "request" | "idle" | "closed" } | { setup: Setup } | { context: ContextEstimate | undefined }
  | { change: string | undefined } | { turn: true } | { cache: { read?: number; write?: number; input?: number; speed?: number } } | { start: string; name: string } | { end: string; outcome: Outcome };
export const observe = <T>(sink: ((value: T) => void) | undefined, value: T) => { try { sink?.(value); } catch { /* display only */ } };
export const label = (s: string | undefined) => s?.replace(/[^a-zA-Z0-9._+:/ -]/g, "?").slice(0, 96);
/** An agent's reviewed submission and its one independent review. */
export interface Revision {
  run: string; identity: { digest: string } | { sha: string };
  status: "reviewing" | Verdict;
  review?: { findings: boolean[]; artifacts: number };
}
export interface Call { name: string; at: number; outcome?: Outcome }
export interface Row {
  key: string; ref: string; title?: string; role: string; parent?: string; review?: boolean; born: number; since: number;
  state: AgentState | "queued" | "answered" | "done" | "cancelling"; actor?: "Main"; blocker?: "ask" | "budget" | "adjudicate" | "failure";
  phase?: "request" | "idle" | "closed"; setup?: Setup; context?: ContextEstimate & { at: number }; cache: { responses: number; read: number; write: number; reads: number; writes: number };
  /** Pending or in-progress runtime change, display text. */
  change?: string;
  question?: string; turns?: number; rate?: number; speed?: number;
  current: Map<string, Call>; last?: Call;
}
export class Telemetry {
  readonly rows = new Map<string, Row>();
  readonly activity: { key: string; at: number; text: string; outcome?: Outcome }[] = [];
  /** Per agent run: its one review's evidence. */
  readonly live = new Map<string, Revision>();
  activityGap = 0;
  private readonly listeners = new Set<() => void>();
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  changed() { for (const fn of this.listeners) observe(fn, undefined); }
  private event(key: string, text: string, outcome?: Outcome) {
    this.activity.push({ key, at: Date.now(), text, outcome });
    if (this.activity.length > 240) { this.activity.shift(); this.activityGap++; }
  }
  add(key: string, ref: string, role: string, parent?: string, review?: boolean, question?: string, title?: string) {
    const now = Date.now();
    this.rows.set(key, { key, ref, title, role, parent, review, question: question?.replace(/[\p{C}\s]+/gu, ' ').slice(0, 800), born: now, since: now, state: parent ? "queued" : "starting", current: new Map(), cache: { responses: 0, read: 0, write: 0, reads: 0, writes: 0 } });
    this.event(key, parent ? "queued" : "starting"); this.changed();
  }
  state(key: string, state: Row["state"], blocker?: Row["blocker"]) {
    const r = this.rows.get(key);
    if (!r) return;
    if (r.state !== state || r.blocker !== blocker) { r.since = Date.now(); this.event(key, blocker ?? state); }
    r.state = state; r.blocker = blocker; r.actor = blocker ? "Main" : undefined;
    this.changed();
  }
  sink(key: string): (value: Observation) => void {
    return value => {
      const r = this.rows.get(key);
      if (!r) return;
      if ("phase" in value) {
        if (r.phase !== value.phase) this.event(key, value.phase);
        r.phase = value.phase;
        if (value.phase !== "request") {
          for (const call of r.current.values()) {
            const outcome = { kind: 'missing' } as const;
            r.last = { ...call, outcome };
            this.event(key, `end ${call.name}`, outcome);
          }
          r.current.clear();
        }
      } else if ("setup" in value) {
        // A new model invalidates model-specific estimates; budgets and turns stay cumulative.
        if (r.setup && (r.setup.model !== value.setup.model || r.setup.thinking !== value.setup.thinking)) { r.speed = undefined; r.rate = undefined; r.context = undefined; this.event(key, `runtime ${value.setup.model ?? "?"}/${value.setup.thinking ?? "?"}`); }
        r.setup = r.setup ? { ...value.setup, sdk: value.setup.sdk ?? r.setup.sdk, skills: value.setup.skills.length ? value.setup.skills : r.setup.skills } : value.setup;
      }
      else if ("change" in value) r.change = value.change;
      else if ("context" in value) r.context = value.context && { ...value.context, at: Date.now() };
      else if ('turn' in value) r.turns = (r.turns ?? 0) + 1;
      else if ("cache" in value) {
        const { input, read, write, speed } = value.cache;
        const total = (input ?? NaN) + (read ?? NaN) + (write ?? NaN);
        r.rate = total > 0 ? 100 * read! / total : undefined;
        r.speed = speed;
        r.cache.responses++;
        for (const field of ["read", "write"] as const) {
          const n = value.cache[field];
          if (n !== undefined && Number.isSafeInteger(n) && n >= 0) { r.cache[field] += n; r.cache[field === "read" ? "reads" : "writes"]++; }
        }
      } else if ("start" in value) {
        r.current.set(value.start, { name: value.name, at: Date.now() }); this.event(key, `start ${value.name}`);
      } else {
        const call = r.current.get(value.end);
        if (call) { r.current.delete(value.end); r.last = { ...call, outcome: value.outcome }; this.event(key, `end ${call.name}`, value.outcome); }
      }
      this.changed();
    };
  }
  revision(value: Revision) {
    this.live.set(value.run, value);
    this.changed();
  }
}
