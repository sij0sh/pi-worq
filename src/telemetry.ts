import type { AgentState } from "./agent.ts";
import type { Verdict } from "./contracts.ts";

export type Outcome = { kind: "exit"; code: number; stdout: boolean; stderr: boolean }
  | { kind: "search"; count: number; capped: boolean }
  | { kind: "ok" | "sdk-error" | "launch" | "timeout" | "output-limit" | "process-exit" | "cleanup-unconfirmed" | "cancelled" | "missing"; cancelled?: boolean };
export interface Setup { model?: string; thinking?: string; skills: string[] }
export type Observation = { phase: "request" | "idle" | "closed" } | { setup: Setup } | { context: number | undefined }
  | { turn: true } | { cache: { read?: number; write?: number; input?: number; speed?: number } } | { start: string; name: string } | { end: string; outcome: Outcome };
export const observe = <T>(sink: ((value: T) => void) | undefined, value: T) => { try { sink?.(value); } catch { /* display only */ } };
export const label = (s: string | undefined) => s?.replace(/[^a-zA-Z0-9._+:/ -]/g, "?").slice(0, 96);
export interface Revision {
  run: string; round: number; identity: { digest: string } | { sha: string };
  status: "reviewing" | "ready" | "skipped" | "inconclusive" | "pass" | "findings";
  source: boolean; rewritten?: boolean; ready?: boolean;
  reviews: { name: string; verdict: Verdict | "unknown"; findings: boolean[]; artifacts: number }[];
}
export interface Call { name: string; at: number; outcome?: Outcome }
export interface ReviewIdentity { round: number; slot: number }
export interface Row {
  key: string; ref: string; title?: string; role: string; parent?: string; review?: ReviewIdentity; born: number; since: number;
  state: AgentState | "queued" | "answered" | "done"; actor?: "Main"; blocker?: "ask" | "budget" | "adjudicate" | "failure";
  phase?: "request" | "idle" | "closed"; setup?: Setup; context?: { percent?: number; at: number }; cache: { responses: number; read: number; write: number; reads: number; writes: number };
  question?: string; turns?: number; rate?: number; speed?: number;
  current: Map<string, Call>; last?: Call;
}
export class Telemetry {
  readonly rows = new Map<string, Row>();
  readonly activity: { key: string; at: number; text: string; outcome?: Outcome }[] = [];
  readonly live = new Map<string, Revision>();
  readonly settled: Revision[] = [];
  activityGap = 0;
  evidenceGap = 0;
  private readonly listeners = new Set<() => void>();
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  changed() { for (const fn of this.listeners) observe(fn, undefined); }
  private event(key: string, text: string, outcome?: Outcome) {
    this.activity.push({ key, at: Date.now(), text, outcome });
    if (this.activity.length > 240) { this.activity.shift(); this.activityGap++; }
  }
  add(key: string, ref: string, role: string, parent?: string, review?: ReviewIdentity, question?: string, title?: string) {
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
      } else if ("setup" in value) r.setup = value.setup;
      else if ("context" in value) r.context = { percent: value.context, at: Date.now() };
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
  revision(value: Revision, settled = false) {
    this.live.set(value.run, value);
    if (settled) {
      this.settled.push(value);
      if (this.settled.length > 20) { this.settled.shift(); this.evidenceGap++; }
    }
    this.changed();
  }
  source(run: string, round: number, rewritten = false) {
    const current = this.live.get(run);
    if (current?.round === round) this.live.set(run, { ...current, source: false, rewritten });
    for (const [i, revision] of this.settled.entries()) if (revision.run === run && revision.round === round) this.settled[i] = { ...revision, source: false, rewritten };
    this.changed();
  }
}
