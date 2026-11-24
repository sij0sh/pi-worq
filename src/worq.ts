import { Agent, type AgentEvent, type Attachment } from "./agent.ts";
import { Block } from "./contracts.ts";
import { MAIN, type Config } from "./runtime/config.ts";
import type { Kind, Prompts } from "./prompts.ts";
import { one, reviewLines, reviewStatus } from "./render.ts";
import { modelChoices, resolveRuntime, type ModelChoice, type RuntimeRequest } from './runtime/launch.ts';
import type { Driver, Runtime, RuntimeChange } from "./sdk/contract.ts";
import type { SessionControl, Sessions } from "./session.ts";
import { Semaphore } from "./subagent.ts";
import { baselineProject, reserveName, readPlan, repository } from "./workspace.ts";

export interface WorqDeps {
  telemetry?: import('./telemetry.ts').Telemetry;
  driver: Driver;
  prompts: Prompts;
  /** The installed catalog: every launchable package. */
  kinds: ReadonlyMap<string, Kind>;
  config: Config;
  state: string;
  cwd: string;
  notify(event: AgentEvent): void;
  /** Operator-only notice (obsolete settings). */
  warn?(text: string): void;
}
/** One launch, from any route. Absent runtime fields inherit; see resolveRuntime. */
export interface LaunchRequest extends RuntimeRequest {
  kind: string;
  task?: string;
  title?: string;
  attach?: string[];
  /** Legacy wire field. true is redundant for reviewed packages; false is refused. */
  verify?: boolean;
}
export interface LaunchOptions {
  /** Only the confirmed /worq route has user authority; tool and socket requests are "main". */
  caller: "user" | "main";
  signal?: AbortSignal;
  /** Runs after admission succeeds, immediately before the agent starts. */
  beforeStart?(): void;
}
export const REF_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)+$";
export const KIND_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const REF = new RegExp(REF_PATTERN);
const MAX_TASK = 8000;
function nameFrom(title: string) {
  if (typeof title !== "string" || title.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*(?: +[a-z0-9]+(?:-[a-z0-9]+)*){1,3}$/i.test(title.trim())) throw new Block("title", "Supply a 2–4 word title using letters, numbers or internal hyphens");
  return title.trim().toLowerCase().replace(/ +/g, "-");
}
/** A readable title from the task's first words, else the package name. */
function generatedTitle(kind: string, task: string) {
  const words = (task.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => w.slice(0, 16)).slice(0, 4);
  return words.length >= 2 ? words.join(" ") : [...kind.split("-"), "run"].slice(0, 4).join(" ");
}

/** Agents owned by this Pi session. Every route admits through `launch`; Main manages them all alike. */
export class Worq {
  private readonly starting = new Set<{ label: string }>();
  private readonly agents = new Map<string, Agent>();
  /** Every live controllable session (owners, PQs, reviews), keyed by telemetry row key. */
  readonly sessions: Sessions = new Map();
  private readonly semaphore: Semaphore;
  private readonly deps: WorqDeps;
  private warned = false;
  constructor(deps: WorqDeps) {
    this.deps = deps;
    this.semaphore = new Semaphore(deps.config.limits.parallel);
  }
  private admissions = new AbortController();
  get size() { return this.agents.size; }
  get kinds() { return this.deps.kinds; }
  all() { return [...this.agents.values()]; }
  get(ref: string) {
    const agent = this.agents.get(ref);
    if (!agent) throw new Block("unknown-ref", `No agent ${ref} in this session. worq_list shows refs.`);
    return agent;
  }

  /**
   * Common new-launch boundary for every route: warn once about ignored settings, refuse on removed ones.
   * Management (list/send/cancel/configure) never passes through here.
   */
  gate() {
    const { config } = this.deps;
    if (config.ignored?.length && !this.warned) { this.warned = true; this.deps.warn?.(config.ignored.join("\n")); }
    if (config.migration) throw new Block("config", config.migration);
  }
  /** The runtime a launch with no explicit fields would use, for the /worq picker. */
  defaults(signal: AbortSignal = this.admissions.signal): Promise<Runtime> {
    return resolveRuntime(this.deps.driver, {}, signal);
  }
  /** Picker information; never needed for a launch. */
  launchChoices(initial: Runtime): Promise<ModelChoice[]> {
    return modelChoices(this.deps.driver, initial);
  }
  /** Convenience for Main-authority launches. */
  spawn(kind: string, task: string | undefined, opts: Omit<LaunchRequest, "kind" | "task"> = {}, signal?: AbortSignal): Promise<Agent> {
    return this.launch({ ...opts, kind, ...(task !== undefined ? { task } : {}) }, { caller: "main", signal });
  }
  /**
   * The one admission path. Order: gate, authorization, payload, runtime preflight (adapter-local) — all before any
   * pending slot, ref or worktree. Then capacity + pending slot, repository/baseline/attachments, ref, start.
   */
  async launch(request: LaunchRequest, { caller, signal: callerSignal, beforeStart }: LaunchOptions): Promise<Agent> {
    const { prompts, config } = this.deps;
    this.gate();
    const kind = this.kinds.get(request.kind);
    const spawnable = [...this.kinds.values()].filter((k) => !k.userOnly).map((k) => k.name);
    if (!kind) throw new Block("kind", `Unknown kind ${request.kind}; installed: ${spawnable.join(" | ") || "none"}`);
    if (kind.userOnly && caller !== "user") throw new Block("invocation", `${kind.name} is user-only (disable-model-invocation); launch it with /worq`);
    if (request.verify === false) throw new Block("verify", `verify:false is no longer supported: review follows the package's review frontmatter${kind.review ? ` (${kind.name} is reviewed)` : ""}. Omit verify, or install an unreviewed package for unreviewed runs.`);
    if (request.verify === true && !kind.review) throw new Block("invalid-payload", `verify does not apply to ${kind.name} (no review)`);
    const direction = (request.task ?? "").trim();
    if (direction.length > MAX_TASK) throw new Block("invalid-payload", `Task exceeds ${MAX_TASK} characters`);
    const task = direction || `Run the ${kind.name} workflow on this repository and submit its result.`;
    const title = request.title?.trim() || generatedTitle(kind.name, direction);
    let base = nameFrom(title);
    if (!REF.test(base)) base = `${base}-run`;
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.admissions.signal]) : this.admissions.signal;
    signal.throwIfAborted();
    this.capacity();
    const runtime = await resolveRuntime(this.deps.driver, { sdk: request.sdk, model: request.model, thinking: request.thinking }, signal);
    this.capacity();
    const pending = { label: `${title} · ${kind.name} · pending launch` };
    this.starting.add(pending);
    try {
      const preflight = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const root = await repository(this.deps.cwd, preflight);
      if (kind.access === "write") await baselineProject(root, preflight);
      const attachments = await this.attachments(root, request.attach ?? []);
      signal.throwIfAborted();
      const { ref, dir } = await reserveName(root, this.deps.state, base);
      signal.throwIfAborted();
      const agent = new Agent({ runtime, telemetry: this.deps.telemetry, driver: this.deps.driver, prompts, limits: config.limits, state: this.deps.state, root, semaphore: this.semaphore, notify: this.deps.notify, sessions: this.sessions },
        { ref, title, dir, kind, task, attachments });
      this.agents.set(ref, agent);
      beforeStart?.();
      agent.launch();
      return agent;
    } finally { this.starting.delete(pending); }
  }
  /** Parked agents hold no slot. */
  private capacity() {
    const live = this.all().filter((a) => a.active).length + this.starting.size;
    const max = this.deps.config.limits.agents;
    if (live >= max) throw new Block("at-capacity", `${live} agents are active (limits.agents ${max}); wait, close or cancel one first`);
  }
  private async attachments(root: string, sources: string[]): Promise<Attachment[]> {
    const out = new Map<string, Attachment>();
    for (const source of new Set(sources)) {
      const live = this.agents.get(source);
      if (live?.plan) { out.set(live.plan.path, { path: live.plan.path, text: live.plan.text }); continue; }
      if (!source.startsWith(".agents/plans/") && !isRef(source)) throw new Block("plan", "Attach an exact plan name or a repo-relative .agents/plans/*.md path");
      const path = source.startsWith(".agents/plans/") ? source : `.agents/plans/plan-${source}.md`;
      const text = await readPlan(root, path);
      if (!out.has(path)) out.set(path, { path, text });
    }
    return [...out.values()];
  }

  list(ref?: string): string {
    if (ref) return this.detail(this.get(ref));
    const agents = this.all();
    const pending = [...this.starting].map(p => p.label);
    if (!agents.length && !pending.length) return "No Worq agents in this session.";
    return pending.concat(agents.map((a) => {
      const pqs = a.delegations.length ? ` · PQs ${a.delegations.length - a.openPqs}/${a.delegations.length}` : "";
      const verdicts = a.review ? ` · review ${a.review.verdict}` : "";
      const extra = a.ask ? ` · asks: ${one(a.ask.question, 160)}` : a.error ? ` · ${one(a.error, 160)}` : "";
      return `${a.headline} · ${a.state} · round ${a.round}${pqs}${verdicts}${extra}\n    ${one(a.task, 140)}`;
    })).join("\n");
  }
  private detail(a: Agent): string {
    return [
      `${a.headline} · ${a.state} · round ${a.round}`,
      `Task: ${a.task}`,
      `Review: ${a.reviewed ? "one independent review per submission" : "none"}`,
      ...a.launches.map(l => `${l.role}: ${JSON.stringify(l.runtime)}${l.label ? ` · ${l.label}` : ''}`),
      a.work && `Worktree: ${a.work}`,
      a.attachments.length && `Attached: ${a.attachments.map((x) => x.path).join(", ")}`,
      a.exhausted && `Parked without submission: ${a.exhausted}`,
      a.plan && `Plan: ${a.plan.path}`,
      a.branch && `Branch: ${a.branch}${a.candidate ? ` @ ${a.candidate}` : ""}`,
      a.recoverySha && `Recovery SHA ${a.recoverySha}: UNVERIFIED / not merge-ready`,
      a.diffstat && a.diffstat,
      a.ask && `Open ask: ${a.ask.question}`,
      a.error && `Error: ${a.error}`,
      a.delegations.length && ["PQs:", ...a.delegations.map((d) => `  ${d.state}: ${d.question}${d.answer ? `\n     → ${one(d.answer.answer, 300)}` : d.error ? `\n     → ${one(d.error, 200)}` : ""}`)].join("\n"),
      a.reviewed && (a.plan || a.candidate) && [`Review (round ${a.round}): ${reviewStatus(a.review)}`, ...reviewLines(a.review)].join("\n"),
      ["Recent activity:", ...a.tail(20).map((h) => `  ${h.line}`)].join("\n"),
    ].filter(Boolean).join("\n");
  }
  send(ref: string, text: string) {
    const agent = this.get(ref);
    if (agent.state === "parked") this.capacity();
    return agent.send(text);
  }
  /** A live session by row key, or an owner by ref. */
  session(target: string): SessionControl {
    const found = this.sessions.get(target) ?? (this.agents.has(target) ? this.sessions.get(this.agents.get(target)!.id) : undefined);
    if (!found) throw new Block("ended", "That session is no longer live");
    return found;
  }
  /** Models the session may switch to: same harness, current first. */
  async choices(target: string): Promise<ModelChoice[]> {
    const session = this.session(target);
    const runtime = session.runtime() ?? { ...MAIN };
    await this.deps.driver.load?.(runtime.sdk);
    const current = { ...runtime, model: runtime.model ?? this.deps.driver.defaultModel?.(runtime.sdk) };
    return modelChoices(this.deps.driver, current, current.sdk);
  }
  async configure(target: string, change: RuntimeChange): Promise<string> {
    const session = this.session(target);
    const outcome = await session.configure(change);
    const what = [change.model && `model ${change.model}`, change.thinking && `thinking ${change.thinking}`].filter(Boolean).join(", ");
    return outcome === "applied" ? `${session.label}: ${what} applied` : `${session.label}: ${what} queued for the next safe request boundary`;
  }
  async cancel(ref: string): Promise<string> {
    if (ref === "all") {
      const pending = this.starting.size;
      if (!this.admissions.signal.aborted) {
        this.admissions.abort(new Block('cancelled', 'Pending launches cancelled'));
        this.admissions = new AbortController();
      }
      const live = this.all().filter((a) => !a.ended);
      await Promise.all(live.map(a => a.cancel()));
      const stopped = live.map(a => `${a.ref} (${a.state})`);
      if (pending) stopped.push(`${pending} pending launch${pending === 1 ? '' : 'es'}`);
      return stopped.length ? `Stopped ${stopped.join(', ')}` : 'No live agents';
    }
    const agent = this.get(ref);
    if (agent.ended) return `${agent.ref} already ${agent.state}`;
    await agent.cancel();
    return `${agent.ref} ${agent.state}${agent.work ? `; retained worktree ${agent.work}` : agent.branch ? `; branch ${agent.branch} kept` : ""}`;
  }
  async shutdown() { this.admissions.abort(new Block('cancelled', 'Worq closed')); await this.cancel("all"); }
}
export const isRef = (value: string) => REF.test(value);
