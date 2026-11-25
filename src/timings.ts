import type { SessionEvent } from "./sdk/contract.ts";

type Bucket = "activeModelMs" | "waitMainMs" | "activeGateMs" | "toolMs";
const priority: Bucket[] = ["waitMainMs", "activeModelMs", "activeGateMs", "toolMs"];
type Milestone = "firstTurnAt" | "submittedAt" | "reviewStartedAt" | "reviewFinishedAt" | "parkedAt" | "resumedAt" | "finishedAt";

/** Owner-only intervals. Track observed totals independently of the exclusive work breakdown. */
export class RunTimings {
  readonly at: Partial<Record<Milestone, number>> = {};
  private clock: number;
  private readonly active = { activeModelMs: 0, waitMainMs: 0, activeGateMs: 0, toolMs: 0 };
  private readonly elapsed = { ...this.active };
  private readonly observed = { activeModelMs: 0, waitMainMs: 0, toolMs: 0 };
  private turns = 0;
  private toolCalls = 0;
  private gateMs = 0;
  private modelSamples = 0;
  private completedResponses = 0;
  private cacheComplete = 0;
  private readonly cache: { responses: number; read?: number; write?: number; input?: number } = { responses: 0 };
  private modelEnd?: () => void;
  private parkedSince?: number;
  private parkedMs = 0;
  private reviewSince?: number;
  private reviewMs = 0;

  private readonly startedAt: number;
  constructor(startedAt: number, now = () => performance.now()) {
    this.startedAt = startedAt;
    this.now = now;
    this.clock = now();
  }
  private readonly now: () => number;
  private tick() {
    const now = this.now();
    const bucket = priority.find(key => this.active[key] > 0);
    const ms = now - this.clock;
    if (bucket) this.elapsed[bucket] += ms;
    if (this.active.activeModelMs) this.observed.activeModelMs += ms;
    if (this.active.waitMainMs) this.observed.waitMainMs += ms;
    this.observed.toolMs += ms * this.active.toolMs;
    this.clock = now;
  }
  private begin(bucket: Bucket) {
    this.tick();
    this.active[bucket]++;
    return () => { this.tick(); this.active[bucket]--; };
  }
  endModel() { this.modelEnd?.(); this.modelEnd = undefined; }
  event(event: SessionEvent) {
    if (event.type === "turn") {
      this.at.firstTurnAt ??= Date.now();
      this.turns++;
    } else if (event.type === "response-start") {
      this.at.firstTurnAt ??= Date.now();
      this.endModel();
      this.modelSamples++;
      this.modelEnd = this.begin("activeModelMs");
    } else if (event.type === "response") {
      this.endModel();
      if (event.completed) this.completedResponses++;
    } else if (event.type === "telemetry" && "cache" in event.value) {
      let fields = 0;
      for (const key of ["read", "write", "input"] as const) {
        const n = event.value.cache[key];
        if (n === undefined || !Number.isSafeInteger(n) || n < 0) continue;
        this.cache[key] = (this.cache[key] ?? 0) + n;
        fields++;
      }
      if (fields) this.cache.responses++;
      if (fields === 3) this.cacheComplete++;
    }
  }
  tool() { this.toolCalls++; return this.begin("toolMs"); }
  gate() {
    const end = this.begin("activeGateMs");
    return (durationMs: number) => { end(); this.gateMs += durationMs; };
  }
  waitMain() { return this.begin("waitMainMs"); }
  park() { this.at.parkedAt = Date.now(); this.parkedSince = this.now(); }
  leavePark(resumed: boolean) {
    if (this.parkedSince !== undefined) this.parkedMs += this.now() - this.parkedSince;
    this.parkedSince = undefined;
    if (resumed) this.at.resumedAt = Date.now();
  }
  review() {
    this.at.reviewStartedAt = Date.now();
    this.reviewSince = this.now();
    return () => {
      this.at.reviewFinishedAt = Date.now();
      this.reviewMs = this.now() - this.reviewSince!;
      this.reviewSince = undefined;
    };
  }
  snapshot() {
    this.tick();
    const { activeModelMs, activeGateMs, toolMs } = this.elapsed;
    const now = this.now();
    return {
      startedAt: this.startedAt, ...this.at,
      activeModelMs: Math.round(this.observed.activeModelMs), waitMainMs: Math.round(this.observed.waitMainMs),
      toolMs: Math.round(this.observed.toolMs), gateMs: this.gateMs,
      workModelMs: Math.round(activeModelMs), activeGateMs: Math.round(activeGateMs), workToolMs: Math.round(toolMs),
      workMs: Math.round(activeModelMs + activeGateMs + toolMs),
      reviewMs: Math.round(this.reviewMs + (this.reviewSince === undefined ? 0 : now - this.reviewSince)),
      parkedMs: Math.round(this.parkedMs + (this.parkedSince === undefined ? 0 : now - this.parkedSince)),
      turns: this.turns, toolCalls: this.toolCalls, modelSamples: this.modelSamples, completedResponses: this.completedResponses,
      cache: { ...this.cache, completeResponses: this.cacheComplete },
    };
  }
}

export function timingLine(t: ReturnType<RunTimings["snapshot"]>) {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const { read, write, input, completeResponses, responses } = t.cache;
  const total = (read ?? 0) + (write ?? 0) + (input ?? 0);
  const ratio = completeResponses > 0 && completeResponses === responses && completeResponses >= t.completedResponses && completeResponses >= t.turns && total > 0;
  const cache = ratio ? `${Math.round(100 * read! / total)}% cache` : responses ? "cache ratio unavailable (partial or zero usage)" : "cache unavailable";
  return `Timing: ${sec(t.workMs)} measured work (${t.modelSamples ? `${sec(t.workModelMs)} model` : "model timing unavailable"} · ${sec(t.workToolMs)} tools · ${sec(t.activeGateMs)} gates) · ${sec(t.reviewMs)} review · ${sec(t.parkedMs)} parked · ${sec(t.waitMainMs)} waiting for Main · ${t.turns} turns · ${cache}`;
}
