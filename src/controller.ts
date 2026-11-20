import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { realpath, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import { Block, ContractSchema, coverage, ExecuteSchema, JourneySchema, OrientSchema, parse, PlanSchema, RouteSchema, type Contract, type Plan } from "./contracts.ts";
import { CleanupError, git } from "./process.ts";
import { catalog, verify, type Evidence } from "./verify.ts";
import { builder, inside, pin, preflight, runDirectory, type Project } from "./workspace.ts";

export type Phase = "Orient" | "Plan" | "Execute" | "Verify";
export type State = "running" | "question" | "stopping" | "cancelled" | "blocked" | "limited" | "cleanup-unconfirmed" | "pass";
export interface JobView { id: string; kind: string; state: string; task: string }
export interface RunView {
  version: 1; id: string; owner: number; phase: Phase; state: State; activity: string; attempt: number; request: string;
  branch: string; directory?: string; repository?: string; candidate?: string; question?: string; code?: string;
  contract?: Contract; proposedContract?: Contract; plan?: Plan; selfChecks: string[]; evidence: Evidence[];
  receipt?: { path: string; digest: string }; path: string[]; jobs: JobView[];
}
export interface Assignment {
  role: "plan" | "execute" | "journey" | "route";
  task: object;
  cwd: string;
  signal: AbortSignal;
  project?: Project;
  directory?: string;
  job?: (view: JobView) => void;
  selfCheck?: (value: string) => void;
}
export interface Roles {
  orient(task: object, profile: Project["profile"], signal: AbortSignal): Promise<unknown>;
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
  private readonly options: { cwd: string; profilePath?: string; stateDir: string; request: string; interactive: boolean; roles: Roles };
  constructor(options: Run["options"]) {
    this.options = options;
    const id = randomUUID();
    this.view = { version: 1, id, owner: process.pid, phase: "Orient", state: "running", activity: "Checking profile and baseline", attempt: 1,
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
    this.view.activity = "Waiting for /worq answer";
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
  private async orient(project: Project, feedback?: string) {
    this.stage("Orient", "Capturing the requested outcome");
    const signal = this.controller.signal;
    const base = { request: this.view.request, availableChecks: catalog(project), ...(feedback ? { feedback, previousContract: this.view.contract } : {}) };
    const call = async (task: object) => parse(OrientSchema, await this.options.roles.orient(task, project.profile, signal), "Orient response");
    let response = await call(base);
    signal.throwIfAborted();
    if ("question" in response) {
      const answer = await this.question(response.question);
      this.activity("Updating the contract with your answer");
      response = await call({ ...base, question: response.question, answer });
      if ("question" in response) throw new Block("unclear-intent", response.question);
    }
    const contract = parse(ContractSchema, response.contract, "Contract");
    coverage(contract, project.profile);
    if (feedback && JSON.stringify(contract) !== JSON.stringify(this.view.contract)) {
      this.view.proposedContract = contract;
      const approval = await this.question("Review the proposed contract in /worq status. Reply 'approve' to accept the change.");
      if (approval !== "approve") throw new Block("contract-unapproved", "Proposed contract was not approved");
      this.view.proposedContract = undefined;
    }
    signal.throwIfAborted();
    this.view.contract = contract;
    this.publish();
  }
  private async ask<T extends TSchema>(schema: T, role: Assignment["role"], cwd: string, task: object, project?: Project) {
    const signal = this.controller.signal;
    const attempt = this.view.attempt;
    const phase = this.view.phase;
    const current = () => !signal.aborted && attempt === this.view.attempt && phase === this.view.phase;
    const output = await this.options.roles.ask({ role, task, cwd, signal, project, directory: role === "execute" ? this.view.directory : undefined,
      job: (view) => {
        if (!current()) return;
        const entry = this.view.jobs.findIndex((x) => x.id === view.id);
        if (entry !== -1) this.view.jobs[entry] = view;
        else this.view.jobs.push(view);
        this.publish();
      }, selfCheck: (value) => { if (current()) { this.view.selfChecks.push(value); this.publish(); } },
    }, schema);
    signal.throwIfAborted();
    if (!current()) throw new Block("stale-result", "Role completed for a stale phase or attempt");
    return parse(schema, output, `${role} response`);
  }
  private async run() {
    const signal = this.controller.signal;
    try {
      const project = await preflight(this.options.cwd, this.options.profilePath, signal);
      this.root = project.root;
      this.view.repository = project.root;
      const state = await projectedPath(resolve(this.options.stateDir));
      if (inside(project.root, state)) throw new Block("state-location", "State and workspaces must be outside the original project");
      this.view.directory = await runDirectory(state, this.view.id);
      await this.orient(project);
      let feedback: string | undefined;
      let needsPlan = true;
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.view.attempt = attempt;
        this.view.receipt = undefined;
        this.view.evidence = [];
        this.view.candidate = undefined;
        const contract = this.view.contract!;
        if (needsPlan) {
          this.stage("Plan", "Designing a short implementation route");
          this.view.plan = await this.ask(PlanSchema, "plan", this.work ?? project.root, { request: this.view.request, contract, feedback });
        }
        this.stage("Execute", "Building in the candidate worktree");
        this.work ??= await builder(project, this.view.directory, this.view.branch, signal);
        const result = await this.ask(ExecuteSchema, "execute", this.work, {
          request: this.view.request, contract, plan: this.view.plan, feedback, devChecks: (project.profile.devChecks ?? []).map((c) => c.id),
        }, project);
        this.view.selfChecks.push(`Round ${attempt} · ${result.summary}`);
        const commit = await pin(this.work, signal);
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
        // Keep private acceptance observations out of downstream worker briefs.
        feedback = `${resultRoute.route} finding: ${resultRoute.reason}\nAffected criteria: ${[...new Set(failures.map((e) => e.criterion))].join(", ")}`;
        this.view.path.push(`${attempt} · ${resultRoute.route} → ${resultRoute.route === "product" ? "Execute" : resultRoute.route === "design" ? "Plan" : "Orient"}`);
        needsPlan = resultRoute.route !== "product";
        if (resultRoute.route === "intent") {
          this.view.attempt = attempt + 1;
          await this.orient(project, feedback);
        }
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
