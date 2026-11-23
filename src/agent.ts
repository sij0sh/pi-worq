import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Block, errorText, obj, PlanReport, PqAnswer, ReviewReport, text, WorkReport, type Verdict } from "./contracts.ts";
import type { Limits } from "./config.ts";
import { git } from "./process.ts";
import type { Kind, Prompts } from "./prompts.ts";
import { clean, DIGEST, one, planMarkdown, pqMessage, reviewLines, slug, workText, type ReviewRecord } from "./render.ts";
import { Conversation, tool, type Driver, type Tool } from "./session.ts";
import { processTools, readTools, writeTools } from "./tools.ts";
import { agentDirectory, baselineProject, intact, pin, removeWorktree, snapshot, worktree, writeScoped, type Project } from "./workspace.ts";

export type AgentState = "starting" | "running" | "waiting" | "reviewing" | "review-ready" | "closed" | "cancelled" | "failed";
export const ENDED: AgentState[] = ["closed", "cancelled", "failed"];
export interface AgentEvent { type: "review-ready" | "ask" | "failed"; ref: string; text: string }
export interface Attachment { ref: string; path?: string; text: string }
export interface Delegation { id: string; question: string; why: string; state: "running" | "answered" | "failed" | "cancelled"; answer?: PqAnswer; error?: string }
export const UNANSWERED = "Main did not answer in time. Missing authorization is not approval. Stop the affected work and report the unresolved decision.";

/** Bounded concurrency shared by subagents and reviewers. */
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

export interface AgentDeps {
  driver: Driver;
  prompts: Prompts;
  limits: Limits;
  state: string;
  root: string;
  semaphore: Semaphore;
  notify(event: AgentEvent): void;
  /** Judge one role's model choice before any work; built in Worq.spawn over the config and the driver. */
  check(role: string): void;
}

/**
 * One Main-spawned Pi SDK agent. Lifecycle per round: running (may delegate PQs, ask Main) → submit →
 * reviewing (roster runs in parallel, sealed) → review-ready (Main adjudicates) → next round on worq_send.
 * Never spawns, retries or merges on its own.
 */
export class Agent {
  readonly id = randomUUID();
  readonly ref: string;
  readonly kind: Kind;
  readonly task: string;
  readonly attachments: Attachment[];
  readonly verify: boolean;
  readonly branch?: string;
  readonly owner = process.pid;
  state: AgentState = "starting";
  round = 0;
  started = Date.now();
  finished?: number;
  error?: string;
  candidate?: string;
  diffstat?: string;
  plan?: { path: string; text: string };
  work?: string;
  submission?: string;
  reviews: ReviewRecord[] = [];
  readonly delegations: Delegation[] = [];
  ask?: { question: string; resolve(answer: string): void };
  readonly done: Promise<void>;
  private readonly history: { seq: number; line: string }[] = [];
  private seq = 0;
  private dir?: string;
  private project?: Project;
  private conversation?: Conversation<typeof PlanReport | typeof WorkReport>;
  private next?: { resolve(text: string): void; reject(error: unknown): void };
  private closing = false;
  private asks = 0;
  private readonly controller = new AbortController();
  private readonly deps: AgentDeps;
  private start!: () => void;

  constructor(deps: AgentDeps, input: { ref: string; kind: Kind; task: string; attachments: Attachment[]; verify?: boolean }) {
    this.deps = deps;
    this.ref = input.ref;
    this.kind = input.kind;
    this.task = input.task;
    this.attachments = input.attachments;
    this.verify = input.verify ?? true;
    if (input.kind.access === "write") this.branch = `worq/${input.ref}`;
    const begun = new Promise<void>((resolve) => { this.start = resolve; });
    this.done = begun.then(() => this.run());
  }
  get signal() { return this.controller.signal; }
  get ended() { return ENDED.includes(this.state); }
  get openPqs() { return this.delegations.filter((d) => d.state === "running").length; }
  launch() { this.start(); return this; }

  log(line: string) {
    this.history.push({ seq: ++this.seq, line: one(clean(line), 400) });
    // Keep the opening activity as well as the tail: the start of a long run is what explains it.
    if (this.history.length > 200) this.history.splice(40, this.history.length - 200);
  }
  tail(lines = 20, since = 0) { return this.history.filter((h) => h.seq > since).slice(-lines); }
  private set(state: AgentState) { this.state = state; this.log(`state ${state}`); this.publish(); }
  private publish() {
    if (!this.dir) return;
    try {
      const file = join(this.dir, "record.json");
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, ...this.view(), history: this.history }, null, 2) + "\n", { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch { /* the record is forensic; the live view stays authoritative */ }
  }
  view() {
    return {
      ref: this.ref, id: this.id, owner: this.owner, kind: this.kind.name, state: this.state, round: this.round, task: this.task,
      branch: this.branch, candidate: this.candidate, plan: this.plan?.path, error: this.error, ask: this.ask?.question,
      attachments: this.attachments.map((a) => a.ref), delegations: this.delegations.map(({ id, question, state, error }) => ({ id, question, state, error })),
      reviews: this.reviews, started: this.started, finished: this.finished,
    };
  }

  /** Main's one talk verb: steer, answer, or start the next round, depending on state. */
  send(textIn: string): string {
    const message = textIn.trim();
    if (!message) throw new Block("empty", "Nothing to send");
    this.log(`← main: ${message}`);
    switch (this.state) {
      case "running":
        this.conversation?.deliver(`Main: ${message}`);
        return `Steered ${this.ref}`;
      case "waiting":
        this.ask?.resolve(`Main: ${message}`);
        return `Answered ${this.ref}`;
      case "review-ready":
        if (this.round >= this.deps.limits.rounds) throw new Block("round-limit", `${this.ref} used its ${this.deps.limits.rounds} rounds; adjudicate the existing evidence or close the run`);
        this.next?.resolve(`Main reviewed round ${this.round} and asks for another round:\n${message}`);
        return `Round ${this.round + 1} started for ${this.ref}`;
      case "starting": case "reviewing":
        throw new Block("busy", `${this.ref} is ${this.state}; wait for its next message`);
      default:
        throw new Block("ended", `${this.ref} is ${this.state}`);
    }
  }
  /** Stop everything this agent owns. From review-ready this is a normal close. Bounded. */
  async cancel() {
    if (this.ended) return;
    this.closing = this.state === "review-ready";
    this.controller.abort(new Block("cancelled", this.closing ? "Closed by Main" : "Cancelled by Main"));
    this.next?.reject(this.signal.reason);
    this.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.done.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, 15_000); })]);
    clearTimeout(timer);
  }

  private async run() {
    const { prompts, limits, root, driver } = this.deps;
    const signal = this.signal;
    let box: ReturnType<typeof processTools> | undefined;
    try {
      signal.throwIfAborted();
      this.dir = await agentDirectory(this.deps.state, this.id);
      if (this.kind.access === "write") {
        this.project = await baselineProject(root, signal);
        this.work = await worktree(this.project, this.dir, this.branch!, signal);
        this.log(`worktree on ${this.branch} from ${this.project.baseline.slice(0, 10)}`);
      }
      const cwd = this.work ?? root;
      const tools: Tool[] = [...readTools(cwd), this.delegateTool(cwd), this.askTool()];
      if (this.kind.access === "write") {
        box = processTools(cwd, join(this.dir, "runtime"), { signal });
        tools.push(...writeTools(cwd), ...box.tools);
      }
      const write = this.kind.access === "write";
      this.conversation = new Conversation({
        driver, signal, turns: limits.agentTurns, minutes: limits.agentMinutes, pending: () => this.openPqs,
        spec: { profile: "agent", name: `agent.${this.kind.name}`, cwd, tools, system: `${prompts.protocol}\n\n${this.kind.prompt}\n\n${prompts.guard}`, log: (line) => this.log(line) },
        finish: {
          name: "submit", schema: write ? WorkReport : PlanReport,
          description: write ? "Submit your work for independent review." : "Submit your plan for independent review. Worq saves it to .agents/plans/.",
          validate: () => { if (this.openPqs) throw new Block("pq-open", `PQs ${this.delegations.filter((d) => d.state === "running").map((d) => d.id).join(", ")} are still open: end your turn to wait for their answers, then submit.`); },
        },
      });
      let message = JSON.stringify({ task: this.task, kind: this.kind.name, ...(this.kind.access === "write" ? { verify: this.verify } : {}), ...(this.attachments.length ? { attachments: this.attachments } : {}) }, null, 2);
      for (;;) {
        this.round++;
        this.set("running");
        const report = await this.conversation.run(message);
        await this.review(report);
        message = await new Promise<string>((resolve, reject) => {
          this.next = { resolve, reject };
          if (signal.aborted) reject(signal.reason);
        });
        this.next = undefined;
      }
    } catch (error) {
      if (signal.aborted) this.state = this.closing ? "closed" : "cancelled";
      else {
        this.error = errorText(error);
        this.state = "failed";
      }
    } finally {
      this.controller.abort(new Block("ended", "Agent ended"));
      for (const d of this.delegations) if (d.state === "running") d.state = "cancelled";
      this.ask?.resolve(UNANSWERED);
      this.conversation?.dispose();
      await box?.close().catch((error) => { this.error ??= errorText(error); });
      if (this.work && this.project) {
        // Keep any progress on the branch; the worktree goes, the branch stays.
        try { this.candidate = await pin(this.work, AbortSignal.timeout(30_000), `worq ${this.ref}: ${this.state}`);
          await removeWorktree(this.project.root, this.work); this.work = undefined; } catch (error) { this.log(`Worktree retained at ${this.work}: ${errorText(error)}`); }
      }
      this.finished = Date.now();
      this.log(`state ${this.state}`);
      this.publish();
      // After cleanup, so Main sees the final state (worktree gone, progress pinned on the branch).
      if (this.state === "failed") this.deps.notify({ type: "failed", ref: this.ref, text: `[worq ${this.ref}] ${this.kind.name} agent failed: ${this.error}${this.work ? `\nWorktree retained at ${this.work}.` : this.branch ? `\nProgress kept on ${this.branch}.` : ""}\nLast activity:\n${this.tail(10).map((h) => h.line).join("\n")}` });
    }
  }

  private delegateTool(cwd: string): Tool {
    return tool("delegate",
      "Delegate one probing question (PQ) to a fresh read-only subagent. Fire and forget: returns an id now; the answer arrives later as a [PQ dN] message. Use only for independent, bounded questions answerable by reading.",
      obj({ question: text(800), why: text(400) }), ({ question, why }) => {
        if (this.delegations.length >= this.deps.limits.subagents) throw new Block("pq-limit", `PQ limit (${this.deps.limits.subagents}) reached; investigate directly`);
        const d: Delegation = { id: `d${this.delegations.length + 1}`, question, why, state: "running" };
        this.delegations.push(d);
        this.log(`→ PQ ${d.id}: ${question}`);
        void this.pq(d, cwd);
        return `Delegated ${d.id}. Keep working, or end your turn to wait; the answer arrives as a [PQ ${d.id}] message.`;
      });
  }
  private async pq(d: Delegation, cwd: string) {
    const signal = this.signal;
    const { driver, prompts, limits, semaphore } = this.deps;
    let conversation: Conversation<typeof PqAnswer> | undefined;
    let release: (() => void) | undefined;
    try {
      this.deps.check("subagent");
      release = await semaphore.acquire(signal);
      conversation = new Conversation({
        driver, signal, turns: limits.subagentTurns, minutes: limits.subagentMinutes,
        spec: { profile: "subagent", name: "subagent", cwd, tools: readTools(cwd), system: `${prompts.pq}\n\n${prompts.guard}`, log: (line) => this.log(`  ${d.id} ${line}`) },
        finish: { name: "answer", description: "Return your answer to the probing question.", schema: PqAnswer },
      });
      d.answer = await conversation.run(JSON.stringify({ question: d.question, why: d.why, context: this.task.slice(0, 2000) }, null, 2));
      d.state = "answered";
    } catch (error) {
      if (this.signal.aborted) return;
      d.state = "failed";
      d.error = errorText(error);
    } finally {
      release?.();
      conversation?.dispose();
    }
    this.log(`← PQ ${d.id} ${d.state}`);
    this.conversation?.deliver(pqMessage(d.id, d.question, d.answer, d.error));
  }
  private askTool(): Tool {
    return tool("ask_main",
      "Ask Main (the user's Pi session) one concise question about user-owned intent, scope or permission that the task and repository cannot settle. Blocks until answered.",
      obj({ question: text(1200) }), async ({ question }, toolSignal) => {
        if (++this.asks > this.deps.limits.asks) return "Ask limit reached. Do not assume authorization. Report the unresolved decision.";
        const signal = AbortSignal.any([this.signal, toolSignal]);
        const conversation = this.conversation;
        conversation?.pause();
        this.set("waiting");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await new Promise<string>((resolve, reject) => {
            this.ask = { question, resolve };
            timer = setTimeout(() => resolve(UNANSWERED), this.deps.limits.askMinutes * 60_000);
            timer.unref?.();
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            this.deps.notify({ type: "ask", ref: this.ref, text: `[worq ${this.ref}] ${this.kind.name} agent asks:\n${question}\n\nAnswer with worq_send(ref "${this.ref}"). Answer yourself when this conversation or the repository settles it; otherwise ask the user first.` });
          });
        } finally {
          clearTimeout(timer);
          this.ask = undefined;
          if (this.state === "waiting") this.set("running");
          conversation?.resume();
        }
      });
  }

  private async review(report: PlanReport | WorkReport) {
    const signal = this.signal;
    const { root, prompts } = this.deps;
    this.set("reviewing");
    if (this.kind.access === "read") {
      const plan = report as PlanReport;
      const path = `.agents/plans/${this.ref}-${slug(this.task)}.md`;
      const markdown = planMarkdown({ ref: this.ref, kind: this.kind.name, round: this.round, task: this.task, report: plan });
      await writeScoped(root, path, markdown);
      this.plan = { path, text: markdown };
      this.submission = markdown;
      this.log(`plan saved to ${path}`);
    } else {
      this.candidate = await pin(this.work!, signal, `worq ${this.ref}: round ${this.round}`);
      this.diffstat = await git(this.work!, signal, "diff", "--stat", this.project!.baseline, this.candidate) || "No changes from the baseline";
      this.submission = workText(report as WorkReport);
      this.log(`candidate ${this.candidate.slice(0, 10)}`);
    }
    const roster = this.kind.access === "read" || this.verify ? prompts.reviewers(this.kind.name) : [];
    this.reviews = await Promise.all(roster.map((r) => this.reviewer(r.name, r.prompt)));
    signal.throwIfAborted();
    this.set("review-ready");
    this.deps.notify({ type: "review-ready", ref: this.ref, text: this.digest() });
  }
  private async reviewer(name: string, prompt: string): Promise<ReviewRecord> {
    const { driver, prompts, limits, root, semaphore } = this.deps;
    const own = new AbortController();
    const signal = AbortSignal.any([this.signal, own.signal]);
    const write = this.kind.access === "write";
    const scratch = join(this.dir!, `review-${this.round}-${name}`);
    let box: ReturnType<typeof processTools> | undefined;
    let conversation: Conversation<typeof ReviewReport> | undefined;
    let release: (() => void) | undefined;
    try {
      this.deps.check(`reviewer.${name}`);
      release = await semaphore.acquire(signal);
      let cwd = root;
      if (write) {
        await mkdir(scratch, { mode: 0o700 });
        cwd = await snapshot(root, scratch, this.candidate!, signal);
        box = processTools(cwd, join(scratch, "runtime"), { signal, verify: { artifacts: join(this.dir!, "artifacts", `r${this.round}-${name}`), services: limits.services } });
      }
      conversation = new Conversation({
        driver, signal, turns: limits.reviewerTurns, minutes: limits.reviewerMinutes,
        spec: { profile: "reviewer", name: `reviewer.${name}`, cwd, tools: [...readTools(cwd), ...(box?.tools ?? [])], system: `${prompts.reviewer}\n\n${prompt}\n\n${prompts.guard}`, log: (line) => this.log(`  review ${name} ${line}`) },
        finish: { name: "report", description: "Return your independent review.", schema: ReviewReport },
      });
      const payload = {
        request: this.task, kind: this.kind.name, round: this.round,
        submission: this.submission,
        ...(this.attachments.length ? { plans: this.attachments } : {}),
        ...(write ? { commit: this.candidate, diffstat: this.diffstat } : {}),
      };
      const out = await conversation.run(JSON.stringify(payload, null, 2));
      if (write && !(await intact(cwd, this.candidate!, signal))) return { name, verdict: "unknown", error: "Reviewer changed tracked files or the checked-out commit" };
      return { name, ...out, verdict: out.verdict as Verdict, artifacts: [...(out.artifacts ?? []), ...(box?.saved ?? [])] };
    } catch (error) {
      if (this.signal.aborted) throw error;
      return { name, verdict: "unknown", error: errorText(error) };
    } finally {
      own.abort(new Block("ended", "Review ended"));
      release?.();
      conversation?.dispose();
      await box?.close().catch(() => {});
      if (write) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** What Main reads when a round is ready. Adjudication is Main's job; `worq_list` holds the rest. */
  digest() {
    const write = this.kind.access === "write";
    const head = `[worq ${this.ref}] ${this.kind.name} round ${this.round} review-ready`;
    const where = write ? `Branch ${this.branch} @ ${this.candidate?.slice(0, 10)}\n${this.diffstat}` : `Plan: ${this.plan?.path}`;
    const next = write
      ? this.verify
        ? `Adjudicate each finding (accept/reject/defer, never by count); the digest carries the four most consequential per reviewer, worq_list("${this.ref}") the rest with full text. Accepted → worq_send("${this.ref}", "<witness as worq_list shows it> — <the change>"). Passed and you agree → merge ${this.branch} by hand (git merge), then worq_cancel("${this.ref}") to close. plan-fault → spawn a new plan with @${this.ref}'s plan.`
        : `No verifier ran: read git diff ${this.project!.baseline.slice(0, 10)}..${this.branch} yourself, then merge it by hand (git merge) or worq_send("${this.ref}", "<the change>") for one repair round, then worq_cancel("${this.ref}") to close.`
      : `Ready → fold what you accept into the execute task and worq_spawn("execute", "<task> @${this.ref}"), then worq_cancel("${this.ref}") to close. Adjudicate each finding (accept/reject/defer, never by count); the digest carries the four most consequential per reviewer, worq_list("${this.ref}") the rest. worq_send("${this.ref}", "<witness as worq_list shows it> — <change>") only when a finding changes the plan's criteria or scope.`;
    return [head, one(this.submission ?? "", 600), where, "Reviews:", ...reviewLines(this.reviews, { ...DIGEST, label: `worq_list(${this.ref})` }), next].join("\n");
  }
}
