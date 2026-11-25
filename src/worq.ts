import { Agent, type AgentEvent, type AgentState, type Attachment, type NotifyMode } from "./agent.ts";
import { Block } from "./contracts.ts";
import { EXPLORE_LIMITS, exploreRepo, repoStateKey, type ExploreSnapshot } from "./explore.ts";
import { formatGateLines, type GateSpec } from "./gate.ts";
import { MAIN, type Config } from "./runtime/config.ts";
import type { Kind } from "./runtime/workflows.ts";
import { one, reviewLines, reviewStatus } from "./render.ts";
import { modelChoices, resolveRuntime, type ModelChoice, type RuntimeRequest } from './runtime/launch.ts';
import { createWriteScope, findScopeOverlap, UNRESTRICTED_SCOPE, type WriteScope } from "./scope.ts";
import type { Driver, Runtime, RuntimeChange } from "./sdk/contract.ts";
import type { SessionControl, Sessions } from "./session.ts";
import { Semaphore } from "./subagent.ts";
import { checkSwarm, type SwarmCandidate, type SwarmCheckResult } from "./swarm-check.ts";
import { baselineProject, reserveName, readPlan, repository } from "./workspace.ts";

export interface WorqDeps {
  telemetry?: import('./telemetry.ts').Telemetry;
  driver: Driver;
  /** The installed catalog: every launchable package. */
  kinds: ReadonlyMap<string, Kind>;
  config: Config;
  state: string;
  cwd: string;
  notify(event: AgentEvent): void;
  /** Operator-only notice (obsolete settings). */
  warn?(text: string): void;
  /** Override Tier 1 parallel group warmup stagger (ms); 0 disables. */
  exploreStaggerMs?: number;
}
/** One launch, from any route. Absent runtime fields inherit; see resolveRuntime. */
export interface LaunchRequest extends RuntimeRequest {
  kind: string;
  task?: string;
  title?: string;
  attach?: string[];
  group?: string;
  notify?: NotifyMode;
  expect?: number;
  writePaths?: string[];
  gates?: GateSpec[];
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
export const GROUP_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const REF = new RegExp(REF_PATTERN);
const GROUP = new RegExp(GROUP_PATTERN);
const SETTLED: ReadonlySet<AgentState> = new Set(["parked", "done", "closed", "cancelled", "failed"]);
const MAX_TASK = 8000;
interface GroupState {
  id: string;
  notify: NotifyMode;
  expect: number;
  members: string[];
  pending: number;
  fired: boolean;
  admissions: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
interface PendingLaunch {
  label: string;
  inline: boolean;
  access: "read" | "write";
  scope?: WriteScope;
  group?: string;
}
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
  private readonly starting = new Set<PendingLaunch>();
  private readonly agents = new Map<string, Agent>();
  private readonly groups = new Map<string, GroupState>();
  private readonly exploreCache = new Map<string, Promise<ExploreSnapshot>>();
  private readonly tier1Warmup = new Map<string, { ready: Promise<void>; done: () => void; warmed: boolean; until: number; expires: number }>();
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
    const { config } = this.deps;
    this.gate();
    const kind = this.kinds.get(request.kind);
    const spawnable = [...this.kinds.values()].filter((k) => !k.userOnly).map((k) => k.name);
    if (!kind) throw new Block("kind", `Unknown kind ${request.kind}; installed: ${spawnable.join(" | ") || "none"}`);
    if (kind.userOnly && caller !== "user") throw new Block("invocation", `${kind.name} is user-only (disable-model-invocation); launch it with /worq`);
    if (request.notify === "barrier" && !request.group) throw new Block("invalid-payload", "notify: barrier requires group");
    if (request.expect !== undefined && !request.group) throw new Block("invalid-payload", "expect requires group");
    if (request.group && !GROUP.test(request.group)) throw new Block("invalid-payload", `Invalid group name ${request.group}`);
    if (kind.access !== "write" && (request.writePaths?.length || request.gates?.length)) {
      throw new Block("invalid-payload", "writePaths and gates are only valid for access: write kinds");
    }
    const existingGroup = request.group ? this.groups.get(request.group) : undefined;
    if (existingGroup && request.notify && request.notify !== existingGroup.notify) {
      throw new Block("group", `Group ${existingGroup.id} already uses notify=${existingGroup.notify}`);
    }
    const scope = request.writePaths ? createWriteScope(request.writePaths) : undefined;
    const direction = (request.task ?? "").trim();
    if (direction.length > MAX_TASK) throw new Block("invalid-payload", `Task exceeds ${MAX_TASK} characters`);
    const task = direction || `Run the ${kind.name} workflow on this repository and submit its result.`;
    const title = request.title?.trim() || generatedTitle(kind.name, direction);
    let base = nameFrom(title);
    if (!REF.test(base)) base = `${base}-run`;

    if (kind.access === "write") this.assertDisjointScope(scope, request.group);
    this.capacity(kind);

    let group: GroupState | undefined = existingGroup;
    if (request.group) {
      if (!group) {
        group = { id: request.group, notify: request.notify ?? "each", expect: request.expect ?? 0, members: [], pending: 0, fired: false, admissions: new AbortController() };
        this.groups.set(group.id, group);
      } else if (group.timer) {
        clearTimeout(group.timer);
        group.timer = undefined;
      }
      group.pending++;
    }
    const notifyMode: NotifyMode = group?.notify ?? request.notify ?? "each";
    const signals = [callerSignal, this.admissions.signal, group?.admissions.signal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      signal.throwIfAborted();
      const runtime = await resolveRuntime(this.deps.driver, { sdk: request.sdk, model: request.model, thinking: request.thinking }, signal);
      this.capacity(kind);
      if (kind.access === "write") this.assertDisjointScope(scope, request.group);
      const inline = kind.access === "read" && kind.output === "inline";
      const pending: PendingLaunch = { label: `${title} · ${kind.name} · pending launch`, inline, access: kind.access, scope, group: group?.id };
      this.starting.add(pending);
      try {
        const preflight = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        const root = await repository(this.deps.cwd, preflight);
        if (kind.access === "write") await baselineProject(root, preflight);
        const attachments = await this.attachments(root, request.attach ?? []);
        const explore = kind.explore !== "none" ? await this.explore(root, kind.explore, preflight) : undefined;
        signal.throwIfAborted();
        const { ref, dir } = await reserveName(root, this.deps.state, base);
        signal.throwIfAborted();
        const agentNotify = (event: AgentEvent) => {
          const tagged: AgentEvent = group ? { ...event, group: group.id } : event;
          if (group?.notify === "barrier" && (event.type === "done" || event.type === "parked" || event.type === "failed")) {
            this.deps.notify({ ...tagged, wake: false });
            return;
          }
          this.deps.notify(tagged);
        };
        const { startDelay, onWarm } = this.tier1Schedule(group?.id, kind.name, explore);
        const agent = new Agent({
          runtime, telemetry: this.deps.telemetry, driver: this.deps.driver, limits: config.limits, state: this.deps.state, root,
          semaphore: this.semaphore, notify: agentNotify, sessions: this.sessions,
          onSettled: (a) => { if (a.group) this.maybeSettle(this.groups.get(a.group)); },
        }, { ref, title, dir, kind, task, attachments, group: group?.id, notifyMode, scope, gates: request.gates, explore, startDelay, onWarm });
        this.agents.set(ref, agent);
        if (group) {
          group.members.push(ref);
          if (request.expect !== undefined) group.expect = Math.max(group.expect, request.expect);
          group.fired = false;
        }
        beforeStart?.();
        agent.launch();
        return agent;
      } finally { this.starting.delete(pending); }
    } finally {
      if (group) {
        group.pending--;
        if (!group.members.length && group.pending === 0) this.groups.delete(group.id);
        else this.maybeSettle(group);
      }
    }
  }
  /** Cached per-repo-state deterministic exploration snapshot shared across parallel spawns. */
  private async explore(root: string, mode: "auto" | "map", signal: AbortSignal): Promise<ExploreSnapshot | undefined> {
    try {
      const stateKey = await repoStateKey(root, signal);
      const cacheKey = `${root}\0${stateKey}\0${mode}`;
      let pending = this.exploreCache.get(cacheKey);
      if (!pending) {
        const scanSignal = AbortSignal.any([this.admissions.signal, AbortSignal.timeout(10_000)]);
        pending = exploreRepo(root, mode, scanSignal, { key: stateKey }).catch((error) => {
          if (this.exploreCache.get(cacheKey) === pending) this.exploreCache.delete(cacheKey);
          throw error;
        });
        if (this.exploreCache.size >= 16) {
          const oldest = this.exploreCache.keys().next().value;
          if (oldest !== undefined) this.exploreCache.delete(oldest);
        }
        this.exploreCache.set(cacheKey, pending);
      }
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      return undefined;
    }
  }
  /** Stagger parallel Tier 1 group launches so the first scout populates the prompt cache before siblings fire. */
  private tier1Schedule(groupId: string | undefined, kindName: string, snapshot: ExploreSnapshot | undefined): { startDelay?: Promise<void>; onWarm?: () => void } {
    const staggerMs = this.deps.exploreStaggerMs ?? EXPLORE_LIMITS.tier1StaggerMs;
    if (!groupId || !snapshot || snapshot.tier !== 1 || snapshot.bytes < EXPLORE_LIMITS.tier1WarmupThresholdBytes || staggerMs <= 0) {
      return {};
    }
    const warmupKey = `${groupId}\0${snapshot.key}\0${kindName}`;
    const now = Date.now();
    const existing = this.tier1Warmup.get(warmupKey);
    if (existing && now < existing.expires) {
      if (existing.warmed || now >= existing.until) return {};
      return { startDelay: existing.ready };
    }
    let resolveReady!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = {
      ready: undefined as unknown as Promise<void>,
      done: () => {
        if (entry.warmed) return;
        entry.warmed = true;
        clearTimeout(timer);
        resolveReady();
      },
      warmed: false,
      until: now + staggerMs,
      expires: now + 5 * 60_000,
    };
    entry.ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
      timer = setTimeout(() => entry.done(), staggerMs);
      timer.unref?.();
    });
    if (this.tier1Warmup.size >= 32) {
      const oldest = this.tier1Warmup.keys().next().value;
      if (oldest !== undefined) this.tier1Warmup.delete(oldest);
    }
    this.tier1Warmup.set(warmupKey, entry);
    return { onWarm: entry.done };
  }
  /** Parked agents hold no slot. Lightweight inline read kinds use their own capacity pool. */
  private capacity(kind: Kind) {
    const inline = kind.access === "read" && kind.output === "inline";
    if (inline) {
      const liveInline = this.all().filter((a) => a.active && a.lightweight).length + [...this.starting].filter((s) => s.inline).length;
      const max = this.deps.config.limits.inlineAgents;
      if (liveInline >= max) throw new Block("at-capacity", `${liveInline} inline agents are active (limits.inlineAgents ${max}); wait or cancel one first`);
      return;
    }
    const live = this.all().filter((a) => a.active && !a.lightweight).length + [...this.starting].filter((s) => !s.inline).length;
    const max = this.deps.config.limits.agents;
    if (live >= max) throw new Block("at-capacity", `${live} agents are active (limits.agents ${max}); wait, close or cancel one first`);
  }
  /** Reject overlapping scopes against active write agents, in-flight write launches, and same-group write agents. */
  private assertDisjointScope(scope: WriteScope | undefined, groupId?: string) {
    const peers: { ref: string; scope?: WriteScope }[] = [
      ...this.all()
        .filter((a) => a.kind.access === "write" && (a.active || (groupId !== undefined && a.group === groupId && a.state !== "cancelled" && a.state !== "failed")))
        .map((a) => ({ ref: a.ref, scope: a.scope })),
      ...[...this.starting]
        .filter((s) => s.access === "write")
        .map((s) => ({ ref: s.label, scope: s.scope })),
    ];
    for (const peer of peers) {
      // Preserve legacy compatibility when neither agent opts into writePaths.
      if (!scope && !peer.scope) continue;
      const overlap = findScopeOverlap(scope ?? UNRESTRICTED_SCOPE, peer.scope ?? UNRESTRICTED_SCOPE);
      if (overlap) {
        throw new Block(
          "scope-conflict",
          `writePaths (${scope?.patterns.join(", ") ?? "**"}) overlaps live agent ${peer.ref} (${peer.scope?.patterns.join(", ") ?? "**"}): ${overlap[0]} <-> ${overlap[1]}`,
        );
      }
    }
  }
  private maybeSettle(group: GroupState | undefined) {
    if (group?.notify !== "barrier" || group.fired) return;
    if (group.pending > 0 || !group.members.length) return;
    if (group.expect > 0 && group.members.length < group.expect) return;
    const agents = group.members.map((ref) => this.agents.get(ref)).filter((a): a is Agent => a !== undefined);
    if (!agents.every((a) => SETTLED.has(a.state))) return;

    const emit = () => {
      group.timer = undefined;
      if (group.fired || group.pending > 0) return;
      if (group.expect > 0 && group.members.length < group.expect) return;
      const latest = group.members.map((ref) => this.agents.get(ref)).filter((a): a is Agent => a !== undefined);
      if (!latest.every((a) => SETTLED.has(a.state))) return;
      group.fired = true;
      // Never wake Main if every member was explicitly cancelled or closed.
      if (latest.every((a) => a.state === "cancelled" || a.state === "closed")) return;
      this.deps.notify({ type: "barrier", ref: `group:${group.id}`, group: group.id, wake: true, text: this.groupDigest(group, latest) });
    };

    if (group.expect > 0) { emit(); return; }
    // Without explicit expect, coalesce rapid sequential spawns in the same turn.
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(emit, 150);
    group.timer.unref?.();
  }
  private groupDigest(group: GroupState, agents: Agent[]): string {
    const counts = new Map<string, number>();
    for (const a of agents) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
    const tally = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
    const perItem = Math.max(240, Math.floor(3200 / Math.max(1, agents.length)));
    // Surface failures and parked adjudications first.
    const rank = (s: AgentState) => s === "failed" ? 0 : s === "parked" ? 1 : s === "done" ? 2 : 3;
    const ordered = [...agents].sort((a, b) => rank(a.state) - rank(b.state));
    const lines = ordered.map((a) => {
      const body = a.state === "failed"
        ? `failed: ${one(a.error ?? "unknown error", perItem)}`
        : a.state === "parked"
          ? (a.exhausted ? `parked (budget): ${one(a.exhausted, perItem)}` : `parked · ${reviewStatus(a.review)}${a.review?.summary ? ` — ${one(a.review.summary, perItem)}` : ""}`)
          : a.state === "done"
            ? one(a.summary ?? a.diffstat ?? a.plan?.path ?? "done", perItem)
            : a.state;
      const where = a.branch ? ` [${a.branch}]` : a.plan ? ` [${a.plan.path}]` : "";
      return `- [${a.state}] ${a.ref} (${a.kind.name})${where}: ${body}`;
    });
    const expected = group.expect > 0 ? ` (expect ${group.expect})` : "";
    return [
      `Group ${group.id} settled · ${agents.length} member${agents.length === 1 ? "" : "s"}${expected} (${tally})`,
      ...lines,
      `Inspect full details: worq_list(ref) or worq_list(group: "${group.id}"). Attach inline outputs or plans by ref.`,
    ].join("\n");
  }
  private async attachments(root: string, sources: string[]): Promise<Attachment[]> {
    const out = new Map<string, Attachment>();
    for (const source of new Set(sources)) {
      const live = this.agents.get(source);
      if (live?.plan) { out.set(live.plan.path, { path: live.plan.path, text: live.plan.text }); continue; }
      if (live?.kind.output === "inline" && live.submission) {
        const path = `inline/${live.ref}.md`;
        out.set(path, { path, text: `# ${live.title} (${live.ref})\n\n${live.submission}` });
        continue;
      }
      if (!source.startsWith(".agents/plans/") && !isRef(source)) throw new Block("plan", "Attach an exact plan name or a repo-relative .agents/plans/*.md path");
      const path = source.startsWith(".agents/plans/") ? source : `.agents/plans/plan-${source}.md`;
      const text = await readPlan(root, path);
      if (!out.has(path)) out.set(path, { path, text });
    }
    return [...out.values()];
  }

  list(ref?: string, groupId?: string): string {
    if (ref) return this.detail(this.get(ref));
    if (groupId) {
      const group = this.groups.get(groupId);
      if (!group) throw new Block("unknown-group", `No group ${groupId} in this session.`);
      const agents = group.members.map((r) => this.agents.get(r)).filter((a): a is Agent => a !== undefined);
      const settled = agents.length > 0 && agents.every((a) => SETTLED.has(a.state)) && group.pending === 0 && (group.expect === 0 || agents.length >= group.expect);
      const header = `Group ${group.id} (${group.notify}) · ${agents.length}${group.expect > 0 ? `/${group.expect}` : ""} member${agents.length === 1 ? "" : "s"}${group.pending ? ` · ${group.pending} pending` : ""} · ${settled ? "settled" : "active"}`;
      if (!agents.length) return header;
      return `${header}\n${this.groupDigest(group, agents)}`;
    }
    const agents = this.all();
    const pending = [...this.starting].map(p => p.label);
    if (!agents.length && !pending.length) return "No Worq agents in this session.";
    return pending.concat(agents.map((a) => {
      const groupTag = a.group ? ` [${a.group}]` : "";
      const pqs = a.delegations.length ? ` · PQs ${a.delegations.length - a.openPqs}/${a.delegations.length}` : "";
      const verdicts = a.review ? ` · review ${a.review.verdict}` : a.state === "done" ? " · not independently reviewed" : "";
      const extra = a.ask ? ` · asks: ${one(a.ask.question, 160)}` : a.error ? ` · ${one(a.error, 160)}` : "";
      return `${a.headline}${groupTag} · ${a.state}${a.final && !a.ended ? " · final revision" : ""}${pqs}${verdicts}${extra}\n    ${one(a.task, 140)}`;
    })).join("\n");
  }
  hasGroupWriters(groupId: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;
    return group.members.some((r) => {
      const a = this.agents.get(r);
      return !!a && a.kind.access === "write" && a.state !== "cancelled" && a.state !== "failed";
    });
  }
  async checkGroup(groupId: string, target = "HEAD", signal = AbortSignal.timeout(30_000)): Promise<SwarmCheckResult> {
    const group = this.groups.get(groupId);
    if (!group) throw new Block("unknown-group", `No group ${groupId} in this session.`);
    const root = await repository(this.deps.cwd, signal);
    const writers = group.members
      .map((r) => this.agents.get(r))
      .filter((a): a is Agent => !!a && a.kind.access === "write" && a.state !== "cancelled" && a.state !== "failed")
      .map((a): SwarmCandidate => ({
        ref: a.ref,
        branch: a.branch!,
        commit: a.candidate,
        baseline: a.baseline,
        state: a.state,
        gatesPassed: a.gateResults.length ? a.gateResults.every((g) => g.passed) : undefined,
      }));
    return checkSwarm(root, writers, { target, signal });
  }
  private detail(a: Agent): string {
    return [
      `${a.headline} · ${a.state}`,
      a.group && `Group: ${a.group} (${a.notifyMode})`,
      `Task: ${a.task}`,
      `Phase: ${a.state === "reviewing" ? "independent review in progress" : a.state === "done" ? (a.review ? "final revision submitted (not re-reviewed)" : "not independently reviewed") : a.final ? "final revision after feedback" : a.review ? "reviewed; awaiting acceptance or feedback" : "initial work"}`,
      ...a.launches.map(l => `${l.role}: ${JSON.stringify(l.runtime)}${l.label ? ` · ${l.label}` : ''}`),
      a.work && `Worktree: ${a.work}`,
      a.explore && `Explore: tier ${a.explore.tier} (${a.explore.stats.sourceFiles} source file${a.explore.stats.sourceFiles === 1 ? "" : "s"}, ${(a.explore.bytes / 1024).toFixed(1)} KB)`,
      a.scope && `Write paths: ${a.scope.patterns.join(", ")}`,
      a.attachments.length && `Attached: ${a.attachments.map((x) => x.path).join(", ")}`,
      a.exhausted && `Parked without submission: ${a.exhausted}`,
      a.plan && `Plan: ${a.plan.path}`,
      a.branch && `Branch: ${a.branch}${a.candidate ? ` @ ${a.candidate}` : ""}`,
      a.recoverySha && `Recovery SHA ${a.recoverySha}: UNVERIFIED / not merge-ready`,
      a.diffstat && a.diffstat,
      a.gateResults.length && ["Gates:", ...formatGateLines(a.gateResults)].join("\n"),
      a.kind.access === "write" && a.submission && `Writer submission:\n${a.submission}`,
      a.kind.output === "inline" && a.submission && `Submission:\n${a.submission}`,
      a.ask && `Open ask: ${a.ask.question}`,
      a.error && `Error: ${a.error}`,
      a.delegations.length && ["PQs:", ...a.delegations.map((d) => `  ${d.state}: ${d.question}${d.answer ? `\n     → ${one(d.answer.answer, 300)}` : d.error ? `\n     → ${one(d.error, 200)}` : ""}`)].join("\n"),
      a.review && [`Review: ${reviewStatus(a.review)}`, ...reviewLines(a.review)].join("\n"),
      ["Recent activity:", ...a.tail(20).map((h) => `  ${h.line}`)].join("\n"),
    ].filter(Boolean).join("\n");
  }
  send(ref: string, text: string) {
    const agent = this.get(ref);
    const wasParked = agent.state === "parked";
    if (wasParked) this.capacity(agent.kind);
    const out = agent.send(text);
    if (wasParked && agent.group) {
      const group = this.groups.get(agent.group);
      if (group) {
        if (group.timer) { clearTimeout(group.timer); group.timer = undefined; }
        group.fired = false;
      }
    }
    return out;
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
    if (session.invalidated?.()) throw new Block("runtime-invalidated", `${session.label}: its runtime is invalidated; restart the session`);
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
  async cancel(target: string): Promise<string> {
    if (target === "all") {
      const pending = this.starting.size;
      if (!this.admissions.signal.aborted) {
        this.admissions.abort(new Block('cancelled', 'Pending launches cancelled'));
        this.admissions = new AbortController();
      }
      for (const group of this.groups.values()) {
        if (group.timer) { clearTimeout(group.timer); group.timer = undefined; }
        if (!group.admissions.signal.aborted) {
          group.admissions.abort(new Block("cancelled", `Group ${group.id} cancelled`));
          group.admissions = new AbortController();
        }
      }
      const live = this.all().filter((a) => !a.ended);
      await Promise.all(live.map(a => a.cancel()));
      const stopped = live.map(a => `${a.ref} (${a.state})`);
      if (pending) stopped.push(`${pending} pending launch${pending === 1 ? '' : 'es'}`);
      return stopped.length ? `Stopped ${stopped.join(', ')}` : 'No live agents';
    }
    if (target.startsWith("group:")) {
      const id = target.slice("group:".length);
      const group = this.groups.get(id);
      if (!group) throw new Block("unknown-group", `No group ${id} in this session.`);
      if (group.timer) { clearTimeout(group.timer); group.timer = undefined; }
      group.admissions.abort(new Block("cancelled", `Group ${id} cancelled`));
      group.admissions = new AbortController();
      const live = group.members.map((r) => this.agents.get(r)).filter((a): a is Agent => !!a && !a.ended);
      await Promise.all(live.map((a) => a.cancel()));
      return live.length ? `Stopped group ${id}: ${live.map((a) => `${a.ref} (${a.state})`).join(", ")}` : `No live agents in group ${id}`;
    }
    const agent = this.get(target);
    if (agent.ended) return `${agent.ref} already ${agent.state}`;
    await agent.cancel();
    return `${agent.ref} ${agent.state}${agent.work ? `; retained worktree ${agent.work}` : agent.branch ? `; branch ${agent.branch} kept` : ""}`;
  }
  async shutdown() {
    for (const entry of this.tier1Warmup.values()) entry.done();
    this.tier1Warmup.clear();
    this.admissions.abort(new Block('cancelled', 'Worq closed'));
    await this.cancel("all");
  }
}
export const isRef = (value: string) => REF.test(value);
