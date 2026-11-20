import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { realpath, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import { Block, ContractSchema, coverage, ExecuteSchema, JourneySchema, parse, PlanSchema, RouteSchema, type Contract, type Plan } from "./contracts.ts";
import { Bus, type AgentInfo, type GateKind, type PendingInfo, type Review } from "./bus.ts";
import { CleanupError, git } from "./process.ts";
import { catalog, verify, type Evidence } from "./verify.ts";
import { builder, inside, pin, preflight, runDirectory, type Project } from "./workspace.ts";

export type Phase = "Plan" | "Execute" | "Verify";
export type State = "running" | "question" | "stopping" | "cancelled" | "blocked" | "limited" | "cleanup-unconfirmed" | "pass";
export interface JobView { id: string; kind: string; state: string; task: string }
export interface RunView {
  version: 1; id: string; owner: number; started?: number; finished?: number; phase: Phase; state: State; activity: string; attempt: number; request: string;
  branch: string; directory?: string; repository?: string; candidate?: string; question?: string; code?: string;
  contract?: Contract; proposedContract?: Contract; plan?: Pick<Plan, "summary" | "steps">; selfChecks: string[]; evidence: Evidence[];
  receipt?: { path: string; digest: string }; path: string[]; jobs: JobView[]; agents?: AgentInfo[]; pending?: PendingInfo[];
}
export interface Assignment {
  role: "plan" | "execute" | "journey" | "route";
  task: object;
  cwd: string;
  signal: AbortSignal;
  project?: Project;
  directory?: string;
  selfCheck?: (value: string) => void;
  /** Checked inside worq_submit so the agent can repair a rejected result. */
  validate?: (output: unknown) => void;
  bus?: Bus;
}
export interface Roles {
  /** Lens names available for the host-triggered plan challenge. */
  lenses: string[];
  /** One independent, read-only lens review of the finished plan; returns its findings. */
  lens(input: { lens: string; task: object; cwd: string; signal: AbortSignal; bus?: Bus }): Promise<string>;
  ask<T extends TSchema>(assignment: Assignment, schema: T): Promise<Static<T>>;
}

async function projectedPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await projectedPath(dirname(path)), path.slice(dirname(path).length).replace(/^\//, ""));
  }
}
const approves = (reply: string) => /^(y|yes|ok|okay|approve[ds]?|lgtm|accept|👍)[.!]*$/i.test(reply.trim());
export class Run {
  readonly view: RunView;
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private reply?: (value: string) => void;
  private work?: string;
  private root?: string;
  private asking: Promise<unknown> = Promise.resolve();
  /** Manager channel; exists once the profile is loaded. */
  bus?: Bus;
  private readonly options: { cwd: string; profilePath?: string; profilesDir?: string; stateDir: string; request: string; interactive: boolean; roles: Roles; manager?: boolean; lenses?: boolean };
  constructor(options: Run["options"]) {
    this.options = options;
    const id = randomUUID();
    this.view = { version: 1, id, owner: process.pid, started: Date.now(), phase: "Plan", state: "running", activity: "Checking profile and baseline", attempt: 1,
      branch: `worq/${id}`, request: options.request, selfChecks: [], evidence: [], path: [], jobs: [] };
    this.done = this.run();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { for (const listener of this.listeners) { try { listener(); } catch { /* UI cannot advance or stop a run */ } } }
  private publish() {
    if (this.view.directory) {
      const file = join(this.view.directory, "run.json");
      writeFileSync(`${file}.tmp`, JSON.stringify(this.view, null, 2) + "\n", { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    }
    this.notify();
  }
  private stage(phase: Phase, activity: string) {
    this.controller.signal.throwIfAborted();
    this.view.phase = phase;
    this.view.activity = activity;
    this.view.path.push(`${this.view.attempt} · ${phase}`);
    this.publish();
  }
  private activity(activity: string) {
    this.controller.signal.throwIfAborted();
    this.view.activity = activity;
    this.publish();
  }
  answer(input: string): boolean {
    if (!this.reply || !input.trim() || input.length > 4000 || this.view.state !== "question") return false;
    this.reply(input.trim());
    this.reply = undefined;
    return true;
  }
  stop() {
    if (["running", "question"].includes(this.view.state) && !this.controller.signal.aborted) {
      this.controller.abort(new Block("cancelled", "Stopped by operator"));
      this.view.state = "stopping";
      this.view.activity = "Joining active workers and processes";
      try { this.publish(); } catch { this.notify(); }
    }
    return this.done;
  }
  private async question(prompt: string) {
    if (!this.options.interactive) throw new Block("needs-answer", prompt);
    const signal = this.controller.signal;
    signal.throwIfAborted();
    this.view.question = prompt;
    this.view.activity = "Waiting for your answer";
    this.view.state = "question";
    let rejectReply!: (reason: unknown) => void;
    const pending = new Promise<string>((resolve, reject) => { this.reply = resolve; rejectReply = reject; });
    const abort = () => rejectReply(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try { this.publish(); return await pending; }
    finally {
      signal.removeEventListener("abort", abort);
      this.reply = undefined;
      this.view.question = undefined;
      if (!signal.aborted) this.view.state = "running";
    }
  }
  /** Plan frames contract C (scope for Execute and Verify) and the approach. A changed contract needs the user's approval. */
  private async plan(project: Project, feedback?: string) {
    this.stage("Plan", "Framing the contract and approach");
    const previous = this.view.contract;
    const scope = (contract?: Contract) => { if (!contract) return undefined; const { request: _, ...rest } = contract; return rest; };
    const base = { request: this.view.request, availableChecks: catalog(project), ...(feedback ? { feedback, previousContract: scope(previous), previousPlan: this.view.plan } : {}) };
    const contractOf = (output: unknown) => {
      const contract = parse(ContractSchema, { request: this.view.request, ...(output as Plan).contract }, "Contract");
      coverage(contract, project.profile);
      return contract;
    };
    const call = async (extra: object = {}) => {
      const output = await this.ask(PlanSchema, "plan", this.work ?? project.root, { ...base, ...extra }, project, (value) => { contractOf(value); });
      return { contract: contractOf(output), plan: { summary: output.summary, steps: output.steps } };
    };
    let accepted = previous;
    const confirm = async (result: Awaited<ReturnType<typeof call>>) => {
      for (let revision = 1; accepted && JSON.stringify(result.contract) !== JSON.stringify(accepted); revision++) {
        this.view.proposedContract = result.contract;
        const reply = await this.question("Contract changed — approve? (y, or type what to change)");
        if (approves(reply)) break;
        if (revision > 2) throw new Block("contract-unapproved", "Proposed contract was not approved");
        this.activity("Revising the contract with your changes");
        result = await call({ proposedContract: scope(result.contract), revision: reply });
      }
      this.view.proposedContract = undefined;
      accepted = result.contract;
      return result;
    };
    let result = await confirm(await call());
    const findings = await this.challenge(project, result);
    const describe = (r: typeof result) => {
      const c = r.contract;
      return `Outcome: ${c.outcome}\nCriteria: ${c.criteria.map((x) => `${x.id}: ${x.outcome}`).join("; ")}${c.boundaries.length ? `\nBoundaries: ${c.boundaries.join("; ")}` : ""}${c.assumptions.length ? `\nAssumptions: ${c.assumptions.join("; ")}` : ""}`
        + `\nApproach: ${r.plan.summary}\n${r.plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`;
    };
    const review = await this.review("plan", describe(result) + (findings
      ? `\n\nLens findings. Approve discards them as overfitted; revise reopens Plan with them and your text:\n${findings}` : ""));
    if (review.decision === "revise" && review.text) {
      this.activity("Revising the plan with the review");
      result = await confirm(await call({ review: review.text, ...(findings ? { lensFindings: findings } : {}), proposedContract: scope(result.contract), previousPlan: result.plan }));
    }
    this.controller.signal.throwIfAborted();
    this.view.contract = result.contract;
    this.view.plan = result.plan;
    this.publish();
  }
  /**
   * Host-triggered lens SCQs on the finished plan. They see only the request and Plan's final work;
   * Pi decides in the plan review whether their findings reopen Plan. Without a Pi review nobody can decide, so they are skipped.
   */
  private async challenge(project: Project, result: { contract: Contract; plan: RunView["plan"] }) {
    const names = this.options.roles.lenses;
    if (this.options.lenses === false || !names.length) return undefined;
    const signal = this.controller.signal;
    const attempt = this.view.attempt;
    if (!this.bus?.attached || this.bus.mode !== "gates") { this.view.path.push(`${attempt} · lenses skipped: no Pi plan review`); this.publish(); return undefined; }
    this.activity(`Challenging the plan · ${names.length} lenses`);
    const task = { request: this.view.request, contract: result.contract, plan: result.plan };
    const outcomes = await Promise.allSettled(names.map(async (lens) => {
      const view: JobView = { id: `lens-${lens}-${attempt}`, kind: `lens:${lens}`, state: "running", task: `Challenge the plan through ${lens}` };
      this.view.jobs.push(view);
      this.publish();
      try {
        const output = await this.options.roles.lens({ lens, task, cwd: this.work ?? project.root, signal, bus: this.bus });
        view.state = "done";
        return `[${lens}] ${output}`;
      } catch (error) {
        view.state = error instanceof CleanupError ? "unknown" : signal.aborted ? "stopped" : "failed";
        if (error instanceof CleanupError || signal.aborted) throw error;
        return `[${lens}] failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally { this.publish(); }
    }));
    const fatal = outcomes.find((o) => o.status === "rejected");
    if (fatal) throw fatal.reason;
    signal.throwIfAborted();
    this.view.path.push(`${attempt} · lenses: ${names.join(", ")}`);
    return outcomes.map((o) => (o as PromiseFulfilledResult<string>).value).join("\n\n");
  }
  private async ask<T extends TSchema>(schema: T, role: Assignment["role"], cwd: string, task: object, project?: Project, validate?: Assignment["validate"]) {
    const signal = this.controller.signal;
    const attempt = this.view.attempt;
    const phase = this.view.phase;
    const current = () => !signal.aborted && attempt === this.view.attempt && phase === this.view.phase;
    const output = await this.options.roles.ask({ role, task, cwd, signal, project, validate, bus: this.bus, directory: role === "execute" ? this.view.directory : undefined,
      selfCheck: (value) => { if (current()) { this.view.selfChecks.push(value); this.publish(); } },
    }, schema);
    signal.throwIfAborted();
    if (!current()) throw new Block("stale-result", "Role completed for a stale phase or attempt");
    return parse(schema, output, `${role} response`);
  }
  /** Handoff review by the manager. Auto-approves when no manager is attached or gates are off. */
  private async review(gate: GateKind, body: string): Promise<Review> {
    const bus = this.bus;
    if (!bus?.attached || bus.mode !== "gates") return { decision: "approve", by: "auto" };
    const before = this.view.activity;
    this.activity(`Waiting on Pi · ${gate} review`);
    const review = await bus.gate(gate, body, this.controller.signal);
    this.controller.signal.throwIfAborted();
    this.view.path.push(`${this.view.attempt} · ${gate} review: ${review.decision === "approve" ? "approved" : "revise"}${review.by === "manager" ? "" : ` (${review.by})`}`);
    this.activity(before);
    return review;
  }
  private async run() {
    const signal = this.controller.signal;
    try {
      const project = await preflight(this.options.cwd, this.options.profilePath, signal, this.options.profilesDir);
      this.root = project.root;
      this.view.repository = project.root;
      const manager = project.profile.manager;
      this.bus = new Bus(manager?.review ?? "gates", this.options.manager ?? false, { askMs: (manager?.askSeconds ?? 120) * 1000, gateMs: (manager?.gateSeconds ?? 180) * 1000 });
      this.bus.escalator = (prompt) => { const answer = this.asking.then(() => this.question(prompt)); this.asking = answer.catch(() => {}); return answer; };
      this.bus.onChange(() => {
        this.view.agents = this.bus!.agentsView();
        this.view.pending = this.bus!.pendingView();
        try { this.publish(); } catch { this.notify(); }
      });
      const state = await projectedPath(resolve(this.options.stateDir));
      if (inside(project.root, state)) throw new Block("state-location", "State and workspaces must be outside the original project");
      this.view.directory = await runDirectory(state, this.view.id);
      let feedback: string | undefined;
      let needsPlan = true;
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.view.attempt = attempt;
        this.view.receipt = undefined;
        this.view.evidence = [];
        this.view.candidate = undefined;
        if (needsPlan) await this.plan(project, feedback);
        const contract = this.view.contract!;
        this.stage("Execute", "Building in the candidate worktree");
        this.work ??= await builder(project, this.view.directory, this.view.branch, signal);
        const result = await this.ask(ExecuteSchema, "execute", this.work, {
          request: this.view.request, contract, plan: this.view.plan, feedback, devChecks: (project.profile.devChecks ?? []).map((c) => c.id),
        }, project);
        this.view.selfChecks.push(`Round ${attempt} · ${result.summary}`);
        let commit = await pin(this.work, signal);
        const candidate = await this.review("candidate", `${result.summary}\n${await git(this.work, signal, "diff", "--stat", project.baseline, commit) || "No changes"}`);
        if (candidate.decision === "revise" && candidate.text) {
          this.activity("Revising the candidate with the review");
          const revised = await this.ask(ExecuteSchema, "execute", this.work, {
            request: this.view.request, contract, plan: this.view.plan, feedback, review: candidate.text, devChecks: (project.profile.devChecks ?? []).map((c) => c.id),
          }, project);
          this.view.selfChecks.push(`Round ${attempt} · revised · ${revised.summary}`);
          commit = await pin(this.work, signal);
        }
        this.view.candidate = commit;
        this.stage("Verify", "Choosing an independent user journey");
        const task = { request: this.view.request, contract, commit, surface: project.profile.surface, checks: catalog(project, contract) };
        const journey = await this.ask(JourneySchema, "journey", this.view.directory, task);
        const receipt = await verify(project, contract, journey, { run: this.view.id, attempt, commit }, this.view.directory, signal, (message) => this.activity(message))
          .catch(async (error: unknown) => {
            if (!(error instanceof CleanupError)) await this.discardStage(attempt).catch(() => {});
            throw error;
          });
        await this.discardStage(attempt);
        signal.throwIfAborted();
        this.view.evidence = receipt.evidence;
        this.view.receipt = { path: receipt.path, digest: receipt.digest };
        this.publish();
        if (receipt.pass) {
          await this.removeWork();
          signal.throwIfAborted();
          this.finish("pass", "Verified candidate · not merged");
          return;
        }
        const failures = receipt.evidence.filter((e) => !e.pass);
        this.view.path.push(`${attempt} · Verify observed a mismatch`);
        if (attempt === 3) {
          this.finish("limited", "User-facing mismatch persists; repair limit reached", "repair-limit");
          return;
        }
        this.activity("Classifying a recorded mismatch");
        const resultRoute = await this.ask(RouteSchema, "route", this.view.directory, { ...task, failures });
        const affected = [...new Set(failures.map((e) => e.criterion))].join(", ");
        // The manager sees only the sanitized route, never private acceptance observations.
        const routed = await this.review("route", `Route: ${resultRoute.route}\nReason: ${resultRoute.reason}\nAffected criteria: ${affected}`);
        if (routed.route && routed.route !== resultRoute.route) {
          const confirmed = routed.route !== "intent" || routed.by === "user" || approves(await this.question(`Pi proposes revisiting the contract: ${routed.text ?? resultRoute.reason} — approve? (y/n)`));
          if (confirmed) resultRoute.route = routed.route;
        }
        // Keep private acceptance observations out of downstream worker briefs.
        feedback = `${resultRoute.route} finding: ${resultRoute.reason}\nAffected criteria: ${affected}${routed.decision === "revise" && routed.text ? `\nManager review: ${routed.text}` : ""}`;
        this.view.path.push(`${attempt} · ${resultRoute.route} → ${resultRoute.route === "product" ? "Execute" : "Plan"}`);
        needsPlan = resultRoute.route !== "product";
      }
    } catch (error) {
      if (error instanceof CleanupError) this.finish("cleanup-unconfirmed", error.message, error.code);
      else if (signal.aborted) this.finish("cancelled", "Stopped; active workers and processes joined", "cancelled");
      else this.finish(error instanceof Block && error.code === "agent-budget" ? "limited" : "blocked", error instanceof Error ? error.message : String(error), error instanceof Block ? error.code : "runtime");
    }
  }
  private async removeWork() {
    if (!this.root || !this.work) return;
    const signal = this.controller.signal;
    await git(this.root, signal, "worktree", "remove", "--force", this.work);
    this.work = undefined;
  }
  private async discardStage(attempt: number) {
    // Keep receipts and traces; staging and transient fixture state are disposable.
    const scratch = join(this.view.directory!, `verify-${attempt}`);
    await Promise.all(["product", "build-env", ...Array.from({ length: 12 }, (_, i) => `case-${i + 1}`)]
      .map((path) => rm(join(scratch, path), { recursive: true, force: true })));
  }
  private finish(state: State, activity: string, code?: string) {
    this.view.state = state;
    this.view.finished = Date.now();
    this.view.activity = activity;
    this.view.code = code;
    this.view.question = undefined;
    for (const job of this.view.jobs) if (["running", "stopping"].includes(job.state)) job.state = state === "cleanup-unconfirmed" ? "unknown" : "stopped";
    try { this.publish(); }
    catch (error) {
      if (state === "pass") this.view.state = "blocked";
      this.view.activity += ` · checkpoint unavailable (${String(error)})`;
      this.notify();
    }
  }
}
export async function archived(state: string, id: string, cwd: string) {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id)) throw new Block("run-id", "Use the full run ID shown by Worq");
  const directory = join(state, id);
  const data = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as RunView;
  const root = await realpath(await git(cwd, AbortSignal.timeout(5000), "rev-parse", "--show-toplevel"));
  if (data.version !== 1 || data.id !== id || data.repository !== root) throw new Block("archive", "Run not available for this project");
  if (["running", "stopping", "question"].includes(data.state)) {
    let alive = true;
    try { process.kill(data.owner, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    data.state = "blocked";
    data.activity = alive ? "Detached checkpoint; owner may still be active" : "Interrupted checkpoint; cleanup not confirmed";
  }
  return data;
}
