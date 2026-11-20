import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, realpath, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import { Block, ContractSchema, ExecuteSchema, parse, PlanSchema, VerifySchema, type Contract, type Verdict } from "./contracts.ts";
import { Bus, type AgentInfo, type GateKind, type PendingInfo, type Review } from "./bus.ts";
import { CleanupError, git } from "./process.ts";
import { baselineProject, builder, inside, pin, repository, runDirectory, snapshot, type Project } from "./workspace.ts";

export type Phase = "Plan" | "Execute" | "Verify";
export type State = "running" | "question" | "stopping" | "cancelled" | "blocked" | "limited" | "cleanup-unconfirmed" | Verdict | "report-ready";
export interface AgentReport {
  run: string; phase: Phase; attempt: number; role: Assignment["role"] | `lens:${string}`; agent?: string; commit?: string;
  summary: string; notes?: string; verdict?: Verdict; artifacts?: string[];
}
interface Reporter { identify?: (agent: string) => void; artifact?: (path: string) => void }
export interface JobView { id: string; kind: string; state: string; task: string }
export interface RunView {
  version: 1; id: string; owner: number; started?: number; finished?: number; phase: Phase; state: State; activity: string; attempt: number; request: string;
  branch: string; directory?: string; repository?: string; candidate?: string; question?: string; code?: string;
  contract?: Contract; plan?: { summary: string; steps: string[]; verificationNote?: string }; reports: AgentReport[];
  path: string[]; jobs: JobView[]; agents?: AgentInfo[]; pending?: PendingInfo[];
  /** Archived only: older runs recorded host evidence in a separate receipt. */
  receipt?: { path: string; digest: string };
}
export interface Assignment extends Reporter {
  role: "plan" | "execute" | "verify";
  task: object;
  cwd: string;
  signal: AbortSignal;
  artifactsDir: string;
  runtimeDir: string;
  /** Checked inside worq_submit so the agent can repair a rejected result. */
  validate?: (output: unknown) => void;
  bus?: Bus;
}
export interface Roles {
  /** Lens names available for the host-triggered plan challenge. */
  lenses: string[];
  /** One independent, read-only lens review of the finished plan; returns its findings. */
  lens(input: { lens: string; task: object; cwd: string; signal: AbortSignal; bus?: Bus } & Reporter): Promise<string>;
  ask<T extends TSchema>(assignment: Assignment, schema: T): Promise<Static<T>>;
}

async function projectedPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await projectedPath(dirname(path)), path.slice(dirname(path).length).replace(/^\//, ""));
  }
}
export class Run {
  readonly view: RunView;
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private reply?: (value: string) => void;
  private work?: string;
  private root?: string;
  private assignments = 0;
  private asking: Promise<unknown> = Promise.resolve();
  bus?: Bus;
  private readonly options: { cwd: string; stateDir: string; request: string; interactive: boolean; roles: Roles; manager?: boolean; lenses?: boolean };
  constructor(options: Run["options"]) {
    this.options = options;
    const id = randomUUID();
    this.view = { version: 1, id, owner: process.pid, started: Date.now(), phase: "Plan", state: "running", activity: "Locating the repository", attempt: 1,
      branch: `worq/${id}`, request: options.request, reports: [], path: [], jobs: [] };
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
  private async plan(root: string) {
    this.stage("Plan", "Framing the contract and approach");
    const contractOf = (output: Static<typeof PlanSchema>) => output.mode === "change"
      ? parse(ContractSchema, { request: this.view.request, ...output.contract }, "Change plan needs a contract") : undefined;
    const call = async (extra: object = {}) => {
      const { output, publish } = await this.ask(PlanSchema, "plan", root, { request: this.view.request, ...extra }, contractOf);
      publish();
      return { contract: contractOf(output), plan: { summary: output.summary, steps: output.steps ?? [], verificationNote: output.verificationNote } };
    };
    let result = await call();
    if (result.contract) {
      const c = result.contract;
      const findings = await this.challenge(root, { contract: c, plan: result.plan });
      const body = [`Outcome: ${c.outcome}`, `Criteria: ${c.criteria.map((x) => x.outcome).join("; ")}`,
        c.boundaries.length && `Boundaries: ${c.boundaries.join("; ")}`, c.assumptions.length && `Assumptions: ${c.assumptions.join("; ")}`,
        `Approach: ${result.plan.summary}`, ...result.plan.steps.map((step, i) => `${i + 1}. ${step}`),
        result.plan.verificationNote && `Verify guidance: ${result.plan.verificationNote}`].filter(Boolean).join("\n");
      const review = await this.review("plan", body + (findings ? `\n\nLens findings. Approve to proceed or revise with the material findings to resolve:\n${findings}` : ""));
      if (review.decision === "revise" && review.text) {
        this.activity("Revising the plan with the review");
        result = await call({ review: review.text, lensFindings: findings, proposedContract: c, previousPlan: result.plan });
      }
    }
    this.controller.signal.throwIfAborted();
    this.view.contract = result.contract;
    this.view.plan = result.plan;
    this.publish();
    return result;
  }
  /**
   * Host-triggered lens SCQs on the finished plan. They see only the request and Plan's final work;
   * Pi decides in the plan review whether their findings reopen Plan. Without a Pi review nobody can decide, so they are skipped.
   */
  private async challenge(root: string, result: { contract: Contract; plan: RunView["plan"] }) {
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
        let agent: string | undefined;
        const output = await this.options.roles.lens({ lens, task, cwd: root, signal, bus: this.bus, identify: (id) => { agent = id; } });
        signal.throwIfAborted();
        this.addReport({ role: `lens:${lens}`, agent, summary: output });
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
  private addReport(report: Omit<AgentReport, "run" | "phase" | "attempt">) {
    const { id, phase, attempt } = this.view;
    this.view.reports.push({ run: id, phase, attempt, ...report });
    this.publish();
  }
  private async ask<T extends TSchema>(schema: T, role: Assignment["role"], cwd: string, task: object, validate?: (output: Static<T>) => void) {
    const signal = this.controller.signal;
    const key = `${role}-${++this.assignments}`;
    const artifacts: string[] = [];
    let agent: string | undefined;
    const output = await this.options.roles.ask({ role, task, cwd, signal, bus: this.bus,
      artifactsDir: join(this.view.directory!, ".agents", "artifacts", key), runtimeDir: join(this.view.directory!, "runtime", key),
      identify: (id) => { agent = id; }, artifact: (path) => { if (!artifacts.includes(path)) artifacts.push(path); },
      validate: validate && ((value) => validate(value as Static<T>)),
    }, schema);
    signal.throwIfAborted();
    const parsed = parse(schema, output, `${role} response`);
    validate?.(parsed);
    return { output: parsed, publish: (commit?: string) => {
      const { summary, notes, verdict } = parsed as { summary: string; notes?: string; verdict?: Verdict };
      this.addReport({ role, agent, commit, summary, notes, verdict, artifacts: artifacts.length ? artifacts : undefined });
    } };
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
      const root = this.root = await repository(this.options.cwd, signal);
      this.view.repository = root;
      this.bus = new Bus("gates", this.options.manager ?? false);
      this.bus.escalator = (prompt) => { const answer = this.asking.then(() => this.question(prompt)); this.asking = answer.catch(() => {}); return answer; };
      this.bus.onChange(() => {
        this.view.agents = this.bus!.agentsView();
        this.view.pending = this.bus!.pendingView();
        try { this.publish(); } catch { this.notify(); }
      });
      const state = await projectedPath(resolve(this.options.stateDir));
      if (inside(root, state)) throw new Block("state-location", "State and workspaces must be outside the original project");
      this.view.directory = await runDirectory(state, this.view.id);
      const { contract, plan } = await this.plan(root);
      if (!contract) {
        this.finish("report-ready", plan.summary);
        return;
      }
      const project = await baselineProject(root, signal);
      let feedback: { summary: string; notes?: string } | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.view.attempt = attempt;
        this.view.candidate = undefined;
        this.stage("Execute", "Building in the candidate worktree");
        this.work ??= await builder(project, this.view.directory, this.view.branch, signal);
        const task = { request: this.view.request, contract, plan, feedback };
        const result = await this.ask(ExecuteSchema, "execute", this.work, task);
        let commit = await pin(this.work, signal);
        result.publish(commit);
        const candidate = await this.review("candidate", `${result.output.summary}\n${await git(this.work, signal, "diff", "--stat", project.baseline, commit) || "No changes"}`);
        if (candidate.decision === "revise" && candidate.text) {
          this.activity("Revising the candidate with the review");
          const revised = await this.ask(ExecuteSchema, "execute", this.work, { ...task, review: candidate.text });
          commit = await pin(this.work, signal);
          revised.publish(commit);
        }
        this.view.candidate = commit;
        this.stage("Verify", "Independently testing the candidate");
        const resultVerify = await this.verify(project, commit);
        if (resultVerify.verdict === "pass") {
          await this.removeWork();
          signal.throwIfAborted();
          this.finish("pass", "Verify agent accepted the candidate · not merged");
          return;
        }
        if (resultVerify.verdict === "inconclusive") {
          this.finish("inconclusive", "Verify agent could not establish the result", "verify-inconclusive");
          return;
        }
        if (attempt === 3) {
          this.finish("fail", "Verify agent reported a mismatch after the final repair", "repair-limit");
          return;
        }
        feedback = { summary: resultVerify.summary, notes: resultVerify.notes };
        this.view.path.push(`${attempt} · Verify reported a mismatch → Execute`);
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
  private async verify(project: Project, commit: string) {
    const signal = this.controller.signal;
    const scratch = join(this.view.directory!, `verify-${this.view.attempt}`);
    await mkdir(scratch, { mode: 0o700 });
    let cleanup = true;
    try {
      const cwd = await snapshot(project, scratch, commit, signal);
      const { output, publish } = await this.ask(VerifySchema, "verify", cwd, {
        request: this.view.request, contract: this.view.contract, commit, verificationNote: this.view.plan?.verificationNote,
      });
      // Workspace integrity, not a test oracle. Untracked test output is fine.
      if (await git(cwd, signal, "rev-parse", "HEAD") !== commit || await git(cwd, signal, "status", "--porcelain=v1", "--untracked-files=no")) {
        throw new Block("candidate-mutated", "Verification changed tracked files or checked out a different commit");
      }
      publish(commit);
      return output;
    } catch (error) {
      cleanup = !(error instanceof CleanupError);
      throw error;
    } finally {
      if (cleanup) await rm(scratch, { recursive: true, force: true });
    }
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
  data.reports ??= []; // Records from before agent reports remain inspectable.
  if (["running", "stopping", "question"].includes(data.state)) {
    let alive = true;
    try { process.kill(data.owner, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    data.state = "blocked";
    data.activity = alive ? "Detached checkpoint; owner may still be active" : "Interrupted checkpoint; cleanup not confirmed";
  }
  return data;
}
