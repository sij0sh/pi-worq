import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Block, errorText, obj, PlanReport, PqAnswer, ReviewReport, text, WorkReport, type Verdict } from "./contracts.ts";
import type { Limits } from "./runtime/config.ts";
import { git } from "./process.ts";
import type { Kind, Prompts } from "./prompts.ts";
import { clean, DIGEST, one, planMarkdown, pqMessage, reviewLines, reviewStatus, workText, type ReviewRecord } from "./render.ts";
import { Conversation, WorkerHandoff } from "./session.ts";
import { tool, type Driver, type Runtime, type Tool } from "./sdk/contract.ts";
import { processTools, readTools, writeTools } from "./tools.ts";
import { agentDirectory, baselineProject, intact, pin, removeWorktree, snapshot, worktree, writeScoped, type Project } from "./workspace.ts";

import { label, type Revision, type Telemetry } from './telemetry.ts';

export type AgentState = "starting" | "running" | "waiting" | "reviewing" | "review-ready" | "closed" | "cancelled" | "failed" | "handed-off";
export const ENDED: AgentState[] = ["closed", "cancelled", "failed", "handed-off"];
export interface AgentEvent { type: "review-ready" | "ask" | "checkpoint" | "warning" | "failed" | "handed-off"; ref: string; text: string }
export interface Attachment { path: string; text: string }
export interface Delegation { role?: string; id: string; question: string; why: string; state: "queued" | "running" | "answered" | "failed" | "cancelled"; answer?: PqAnswer; error?: string }
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
  telemetry?: Telemetry;
  driver: Driver;
  prompts: Prompts;
  limits: Limits;
  state: string;
  root: string;
  semaphore: Semaphore;
  notify(event: AgentEvent): void;
  runtime?: Runtime;
  select(role: string, title: string, signal: AbortSignal): Promise<Runtime | undefined>;
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
  readonly title: string;
  readonly verify: boolean;
  readonly reason?: string;
  readonly mode?: "fast" | "thorough";
  private reviewPolicy?: string;
  get reviewPolicyLabel() {
    if (this.kind.access === "write" && !this.verify) return "explicitly skipped";
    if (this.reviewPolicy) return this.reviewPolicy;
    if (this.kind.workflow) return "none (workflow)";
    return this.kind.name === "plan" && this.mode === "fast" ? "pending roster selection" : "kind roster";
  }
  readonly branch?: string;
  readonly owner = process.pid;
  state: AgentState = "starting";
  round = 0;
  started = Date.now();
  finished?: number;
  error?: string;
  candidate?: string;
  handoff?: { path?: string; partial?: string; error?: string; inline?: string };
  private unresolved?: string;
  diffstat?: string;
  plan?: { path: string; text: string };
  work?: string;
  submission?: string;
  reviews: ReviewRecord[] = [];
  readonly delegations: Delegation[] = [];
  readonly launches: { role: string; runtime: Runtime; label?: string }[] = [];
  ask?: { question: string; resolve(answer: string): void };
  readonly done: Promise<void>;
  private readonly history: { seq: number; line: string }[] = [];
  private seq = 0;
  private dir?: string;
  private project?: Project;
  private conversation?: Conversation<typeof PlanReport | typeof WorkReport>;
  private next?: { resolve(text: string): void; reject(error: unknown): void };
  private revision?: Revision;
  private planRound?: number;
  private priorReviewRound?: number;
  private closing = false;
  private asks = 0;
  private spent = 0;
  private grant = 0;
  private warned = false;
  private warning = (message: string) => this.budgetNotice("warning", message);
  private budgetNotice(type: "warning" | "checkpoint", message: string) {
    this.log(message);
    this.deps.notify({ type, ref: this.ref, text: `${this.headline} ${message}\nRound ${this.round}; ${this.openPqs} open PQs; last submission: ${one(this.submission ?? "none yet", 240)}\nRecent activity:\n${this.tail(5).map(h => h.line).join("\n")}` });
  }
  private readonly checkpoints = new Set<() => void>();
  private beforeAttempt = async (signal: AbortSignal) => {
    const { runTurns, continuationTurns, checkpointSeconds } = this.deps.limits;
    if (this.spent < runTurns + this.grant || this.grant >= continuationTurns) return;
    // Only wait between requests. A streaming Pi turn cannot be suspended safely.
    this.warned = true;
    this.deps.telemetry?.state(this.id, this.state, 'budget');
    this.budgetNotice("checkpoint", `No turns left. Main may approve up to ${continuationTurns - this.grant} more via /continue N within ${checkpointSeconds}s.`);
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); signal.removeEventListener("abort", wake); this.checkpoints.delete(wake); resolve(); };
      const timer = setTimeout(wake, checkpointSeconds * 1000);
      this.checkpoints.add(wake);
      signal.addEventListener("abort", wake, { once: true });
      if (signal.aborted || this.spent < runTurns + this.grant) wake();
    });
    this.deps.telemetry?.state(this.id, this.state, this.state === 'waiting' ? 'ask' : undefined);
  };
  private chargeTurn = () => {
    const limits = this.deps.limits;
    const left = limits.runTurns + this.grant - this.spent - 1;
    if (left < 0) this.controller.abort(new Block("run-limit", "Cumulative turn allowance exhausted"));
    else this.spent++;
    if (left >= 0 && left <= Math.max(1, Math.floor(limits.runTurns / 10)) && !this.warned) {
      this.warned = true;
      const headroom = limits.continuationTurns - this.grant;
      // A grant can prevent a hard stop even if the next model turn is inside a streaming request.
      if (headroom > 0) this.budgetNotice("checkpoint", `${left} further run turns authorized; ${headroom} available for explicit approval via /continue N.`);
      else this.warning(`${left} further run turns authorized; no additional turns can be granted.`);
    }
  };
  private admitCloseout = () => {
    // Reviewers start after submission and settle before another worker round.
    if (this.signal.aborted || this.state !== "running" || this.openPqs ||
        this.deps.limits.runTurns + this.grant - this.spent < 2) return false;
    this.spent++;
    return true;
  };
  private readonly controller = new AbortController();
  private readonly deps: AgentDeps;
  private start!: () => void;

  constructor(deps: AgentDeps, input: { ref: string; title?: string; dir?: string; kind: Kind; task: string; attachments: Attachment[]; verify?: boolean; mode?: "fast" | "thorough"; reason?: string }) {
    this.deps = deps;
    this.ref = input.ref;
    this.title = input.title ?? input.ref;
    this.dir = input.dir;
    this.kind = input.kind;
    if (deps.runtime) this.launches.push({ role: `agent.${input.kind.name}`, runtime: deps.runtime });
    this.task = input.task;
    this.attachments = input.attachments;
    this.mode = input.mode;
    this.reason = input.reason;
    this.verify = input.verify ?? true;
    if (input.kind.access === "write") this.branch = `worq/${input.ref}`;
    const begun = new Promise<void>((resolve) => { this.start = resolve; });
    this.done = begun.then(() => this.run());
  }
  get headline() { return `${this.title} (${this.ref}) · ${this.kind.name}`; }
  get signal() { return this.controller.signal; }
  get ended() { return ENDED.includes(this.state); }
  get openPqs() { return this.delegations.filter((d) => (d.state === "queued" || d.state === "running")).length; }
  launch() { this.deps.telemetry?.add(this.id, this.ref, label(this.kind.name)!, undefined, undefined, undefined, this.title, Boolean(this.kind.workflow)); this.start(); return this; }

  log(line: string) {
    this.history.push({ seq: ++this.seq, line: one(clean(line), 400) });
    // Keep the opening activity as well as the tail: the start of a long run is what explains it.
    if (this.history.length > 200) this.history.splice(40, this.history.length - 200);
  }
  tail(lines = 20, since = 0) { return this.history.filter((h) => h.seq > since).slice(-lines); }
  private set(state: AgentState) { this.state = state; this.deps.telemetry?.state(this.id, state, state === 'waiting' ? 'ask' : state === 'review-ready' ? 'adjudicate' : undefined); this.log(`state ${state}`); this.publish(); }
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
      ref: this.ref, title: this.title, owner: this.owner, kind: this.kind.name, state: this.state, round: this.round, task: this.task,
      budget: { spent: this.spent, allowance: this.deps.limits.runTurns + this.grant }, mode: this.mode, reason: this.reason,
      worktree: this.work, branch: this.branch, candidate: this.candidate, plan: this.plan?.path, error: this.error, ask: this.ask?.question,
      attachments: this.attachments.map((a) => a.path), delegations: this.delegations.map(({ question, state, error }) => ({ question, state, error })),
      handoff: this.handoff, reviews: this.reviews, started: this.started, finished: this.finished,
    };
  }

  /** Main's one talk verb: steer, answer, or start the next round, depending on state. */
  send(textIn: string): string {
    const message = textIn.trim();
    if (message.startsWith("/continue")) {
      const count = Number(/^\/continue ([1-9]\d*)$/.exec(message)?.[1]);
      if (this.ended || !this.warned || !Number.isSafeInteger(count) || count > this.deps.limits.continuationTurns - this.grant) throw new Block("run-limit", "No such checkpoint allowance");
      this.grant += count; this.warned = false;
      for (const wake of this.checkpoints) wake();
      this.log(`Main approved ${count} more run turns`);
      return `Cumulative allowance ${this.deps.limits.runTurns + this.grant}`;
    }
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
    let handoff: WorkerHandoff | undefined;
    let box: ReturnType<typeof processTools> | undefined;
    try {
      signal.throwIfAborted();
      this.dir ??= await agentDirectory(this.deps.state, this.ref);
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
      const workflow = this.kind.workflow;
      const noReviewers = workflow ? "\n\nNo independent reviewers run for this workflow; submit a self-contained result." : "";
      this.conversation = new Conversation({
        driver, signal, beforeAttempt: this.beforeAttempt, chargeTurn: this.chargeTurn, warning: this.warning, turns: limits.agentTurns, minutes: limits.agentMinutes, admitCloseout: this.admitCloseout, pending: () => this.openPqs,
        spec: { runtime: this.deps.runtime, observe: this.deps.telemetry?.sink(this.id), name: `agent.${this.kind.name}`, cwd, tools, ...(workflow ? { skills: [workflow.skill] } : {}), system: `${prompts.protocol}\n\n${this.kind.prompt}${noReviewers}\n\n${prompts.guard}`, log: (line) => this.log(line) },
        finish: {
          name: "submit", schema: write ? WorkReport : PlanReport,
          description: workflow ? `Submit your result.${write ? "" : " Worq saves it to .agents/plans/."}` : write ? "Submit your work for independent review." : "Submit your plan for independent review. Worq saves it to .agents/plans/.",
          validate: () => { if (this.openPqs) throw new Block("pq-open", `PQs ${this.delegations.filter((d) => (d.state === "queued" || d.state === "running")).map((d) => JSON.stringify(d.question)).join(", ")} are still open: end your turn to wait for their answers, then submit.`); },
        },
      });
      let message = JSON.stringify({ task: this.task, ...(this.mode ? { route: this.mode, reason: this.reason, guidance: this.mode === "fast" ? "Use the shortest focused check that demonstrates the result; escalate missing evidence to Main." : "Delegate independent decision-changing questions and verify high-cost failure cases." } : {}), kind: this.kind.name, ...(this.kind.access === "write" ? { verify: this.verify } : {}), ...(this.attachments.length ? { attachments: this.attachments } : {}) }, null, 2);
      for (;;) {
        if (this.revision) this.deps.telemetry?.source(this.id, this.revision.round);
        this.deps.telemetry?.live.delete(this.id);
        this.revision = undefined;
        this.round++;
        this.unresolved = undefined;
        this.set("running");
        const report = await this.conversation.run(message);
        await this.review(report);
        this.priorReviewRound = this.round;
        message = await new Promise<string>((resolve, reject) => {
          this.next = { resolve, reject };
          if (signal.aborted) reject(signal.reason);
        });
        this.next = undefined;
      }
    } catch (error) {
      if (signal.aborted && signal.reason?.code !== "run-limit") this.state = this.closing ? "closed" : "cancelled";
      else if (!signal.aborted && error instanceof WorkerHandoff) {
        handoff = error;
        this.state = "handed-off";
      } else {
        this.error = errorText(signal.reason ?? error);
        this.state = "failed";
      }
    } finally {
      this.controller.abort(new Block("ended", "Agent ended"));
      const open = this.delegations.filter(d => (d.state === "queued" || d.state === "running")).map(d => ({ id: d.id, question: d.question }));
      for (const d of this.delegations) if ((d.state === "queued" || d.state === "running")) d.state = "cancelled";
      this.ask?.resolve(UNANSWERED);
      this.conversation?.dispose();
      await box?.close().catch((error) => { this.error ??= errorText(error); });
      if (handoff) {
        this.handoff = handoff.quiescent ? {} : { error: "SDK quiescence could not be confirmed" };
        if (this.work) {
          try {
            if (this.error || this.handoff.error) throw new Error([this.handoff.error, this.error].filter(Boolean).join("; "));
            this.handoff.partial = await pin(this.work, AbortSignal.timeout(30_000), `worq ${this.ref}: unreviewed handoff`);
          } catch (error) { this.handoff.error = errorText(error); }
        }
        const evidence = JSON.stringify({
          status: "handed-off", round: this.round, objective: this.task, trigger: handoff.trigger,
          workerTurns: handoff.turns, sharedTurns: { spent: this.spent, allowance: limits.runTurns + this.grant },
          unreviewed: { ordinary: handoff.ordinary || "No completed ordinary assistant text observed.", closeout: handoff.closeout || undefined, unresolvedQuestion: this.unresolved, openPqs: open, partialCommit: this.handoff.partial },
          priorReview: { round: this.priorReviewRound, candidate: this.candidate, plan: this.plan?.path, planRound: this.planRound, reviews: this.reviews },
          recovery: { worktree: this.work, branch: this.branch, error: this.handoff.error, cleanup: this.work ? "Main owns later cleanup; ignored files remain in the worktree." : undefined },
        }, null, 2);
        const file = join(this.dir!, `handoff-${this.round}.json`);
        try {
          writeFileSync(`${file}.tmp`, evidence + "\n", { mode: 0o600 });
          renameSync(`${file}.tmp`, file);
          this.handoff.path = file;
        } catch (error) {
          this.handoff.error = [this.handoff.error, `Handoff write failed: ${errorText(error)}`].filter(Boolean).join("; ");
          this.handoff.inline = JSON.stringify({
            objective: this.task.slice(0, 1000), trigger: handoff.trigger,
            ordinary: handoff.ordinary.slice(-4000) || "No completed ordinary assistant text observed.",
            closeout: handoff.closeout.slice(-2000) || undefined, unresolvedQuestion: this.unresolved,
          }, null, 2);
        }
      } else if (this.work && this.project) {
        // Never remove the only copy of interrupted work.
        try {
          const reviewed = this.candidate;
          this.candidate = await pin(this.work, AbortSignal.timeout(30_000), `worq ${this.ref}: ${this.state}`);
          if (this.candidate !== reviewed && this.revision) this.deps.telemetry?.source(this.id, this.revision.round);
          await removeWorktree(this.project.root, this.work);
          this.work = undefined;
        } catch (error) {
          this.log(`Worktree retained at ${this.work}: ${errorText(error)}`);
        }
      }
      this.deps.telemetry?.state(this.id, this.state, this.state === 'failed' ? 'failure' : undefined);
      const interrupted = this.deps.telemetry?.live.get(this.id);
      if (interrupted?.status === 'reviewing') this.deps.telemetry?.revision({ ...interrupted, status: 'inconclusive' }, true);
      this.deps.telemetry?.live.delete(this.id);
      this.deps.telemetry?.changed();
      this.finished = Date.now();
      this.log(`state ${this.state}`);
      this.publish();
      if (this.handoff) this.deps.notify({ type: "handed-off", ref: this.ref, text: [
        `${this.headline} handed-off (round ${this.round}); partial work is unreviewed.`,
        this.handoff.path, this.candidate && `Prior candidate: ${this.candidate}`, this.plan && `Prior plan: ${this.plan.path}`, this.work && `Retained worktree: ${this.work} (Main owns cleanup).`,
        this.handoff.partial && `Unreviewed recovery commit: ${this.handoff.partial}`, this.handoff.error, this.handoff.inline,
      ].filter(Boolean).join("\n") });
      // After cleanup, so Main sees the final state (worktree gone, progress pinned on the branch).
      if (this.state === "failed") this.deps.notify({ type: "failed", ref: this.ref, text: `${this.headline} failed: ${this.error}${this.work ? `\nWorktree retained at ${this.work}.` : this.branch ? `\nProgress kept on ${this.branch}.` : ""}\nLast activity:\n${this.tail(10).map((h) => h.line).join("\n")}` });
    }
  }

  private delegateTool(cwd: string): Tool {
    return tool("delegate",
      "Delegate one probing question (PQ) to a fresh read-only subagent. Fire and forget: returns the question now; the answer arrives later as a [PQ] message headed by that question. Use only for independent, bounded questions answerable by reading.",
      obj({ question: text(800), why: text(400), name: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" })) }), ({ question, why, name }) => {
        if (this.delegations.length >= this.deps.limits.subagents) throw new Block("pq-limit", `PQ limit (${this.deps.limits.subagents}) reached; investigate directly`);
        const d: Delegation = { role: name ? `subagent.${name}` : "subagent", id: `d${this.delegations.length + 1}`, question, why, state: "queued" };
        this.delegations.push(d);
        this.log(`→ PQ: ${question}`);
        void this.pq(d, cwd, name ? `subagent.${name}` : "subagent");
        return `Delegated PQ: ${question}\nKeep working, or end your turn to wait for the [PQ] answer.`;
      });
  }
  private async pq(d: Delegation, cwd: string, role: string) {
    const key = this.id + ':' + d.id;
    this.deps.telemetry?.add(key, this.ref, 'PQ', this.id, undefined, clean(d.question).replace(/\s+/g, " ").trim());
    this.deps.telemetry?.state(key, 'queued');
    const signal = this.signal;
    const { driver, prompts, limits, semaphore } = this.deps;
    let conversation: Conversation<typeof PqAnswer> | undefined;
    let release: (() => void) | undefined;
    try {
      const runtime = await this.deps.select(role, `${this.title} · ${d.question}`, signal);
      release = await semaphore.acquire(signal);
      if (runtime) this.launches.push({ role, runtime, label: d.question });
      d.state = 'running';
      this.deps.telemetry?.state(key, 'running');
      conversation = new Conversation({
        driver, signal, beforeAttempt: this.beforeAttempt, chargeTurn: this.chargeTurn, warning: this.warning, turns: limits.subagentTurns, minutes: limits.subagentMinutes,
        spec: { runtime, observe: this.deps.telemetry?.sink(key), name: role, cwd, tools: readTools(cwd), system: `${prompts.pq}\n\n${prompts.guard}`, log: (line) => this.log(`PQ ${d.question}: ${line}`) },
        finish: { name: "answer", description: "Return your answer to the probing question.", schema: PqAnswer },
      });
      d.answer = await conversation.run(JSON.stringify({ question: d.question, why: d.why, context: this.task.slice(0, 2000) }, null, 2));
      d.state = "answered";
    } catch (error) {
      if (this.signal.aborted) return;
      d.state = error instanceof Block && error.code === 'cancelled' ? 'cancelled' : 'failed';
      d.error = errorText(error);
    } finally {
      this.deps.telemetry?.state(key, this.signal.aborted ? 'cancelled' : d.state);
      release?.();
      conversation?.dispose();
    }
    this.log(`← PQ ${d.state}: ${d.question}`);
    this.conversation?.deliver(pqMessage(d.question, d.answer, d.error));
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
            timer = setTimeout(() => { this.unresolved = question; resolve(UNANSWERED); }, this.deps.limits.askMinutes * 60_000);
            timer.unref?.();
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            this.deps.notify({ type: "ask", ref: this.ref, text: `${this.headline} asks:\n${question}\n\nAnswer with worq_send(ref "${this.ref}"). Answer yourself when this conversation or the repository settles it; during planning, defer unresolved preferences to reviewed-plan approval using provisional assumptions or alternatives. Never assume permission.` });
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
    let identity: Revision['identity'];
    if (this.kind.access === "read") {
      const plan = report as PlanReport;
      const path = `.agents/plans/plan-${this.ref}.md`;
      const markdown = planMarkdown({ ref: this.ref, title: this.title, kind: this.kind.name, round: this.round, task: this.task, report: plan, label: this.kind.workflow ? "Workflow result" : "Plan" });
      await writeScoped(root, path, markdown, { create: !this.plan });
      if (this.planRound !== undefined && this.plan?.path === path) this.deps.telemetry?.source(this.id, this.planRound, true);
      this.planRound = this.round;
      identity = { digest: createHash('sha256').update(markdown, 'utf8').digest('hex') };
      this.plan = { path, text: markdown };
      this.submission = markdown;
      this.log(`plan saved to ${path}`);
    } else {
      this.candidate = await pin(this.work!, signal, `worq ${this.ref}: round ${this.round}`);
      identity = { sha: this.candidate };
      this.diffstat = await git(this.work!, signal, "diff", "--stat", this.project!.baseline, this.candidate) || "No changes from the baseline";
      this.submission = workText(report as WorkReport);
      this.log(`candidate ${this.candidate.slice(0, 10)}`);
    }
    const workflow = Boolean(this.kind.workflow);
    const skipped = workflow || (this.kind.access === "write" && !this.verify);
    const configured = skipped ? [] : prompts.reviewers(this.kind.name);
    const focused = this.kind.name === "plan" && this.mode === "fast"
      ? configured.find(r => r.name === "subtraction") : undefined;
    const roster = focused ? [focused] : configured;
    this.reviewPolicy = workflow ? "none (workflow)" : focused ? "focused (subtraction)" : configured.length ? "kind roster" : "no configured reviewers";
    const revision: Revision = { run: this.id, round: this.round, identity, status: 'reviewing', source: false, reviews: [] };
    this.revision = revision;
    this.deps.telemetry?.revision(revision);
    const reports: Revision['reviews'] = [];
    this.reviews = await Promise.all(roster.map(async (r, i) => {
      let artifacts = 0;
      const brief = focused ? `${r.prompt}\n\nYou are the only reviewer on this fast plan. First check that the smallest plan satisfies the original request and preserves relevant contracts; flag missing required outcomes as well as unnecessary scope. Look for a concrete case where the proposed checks pass but a requested outcome fails.` : r.prompt;
      const result = await this.reviewer(r.name, brief, i, count => { artifacts = count; });
      reports[i] = { name: label(r.name)!, verdict: result.verdict, findings: result.findings?.map(f => f.need === true) ?? [], artifacts };
      this.deps.telemetry?.revision({ ...revision, reviews: reports.filter(Boolean) });
      return result;
    }));
    signal.throwIfAborted();
    const status = !roster.length ? (skipped ? 'skipped' : 'inconclusive') : reports.some(r => r.verdict === 'unknown') ? 'inconclusive' : reports.every(r => r.verdict === 'pass' && !r.findings.length) ? 'pass' : 'findings';
    this.deps.telemetry?.revision({ ...revision, status, ready: true, source: true, reviews: reports }, true);
    this.set("review-ready");
    this.deps.notify({ type: "review-ready", ref: this.ref, text: this.digest() + `\n${this.deps.limits.rounds - this.round} repair rounds remain. Route: ${this.mode ?? "default"}.${workflow ? `\nThis workflow stays live until /worq cancel ${this.ref}; it keeps one limits.agents slot.` : ""}` });
  }
  private async reviewer(name: string, prompt: string, slot: number, artifacts: (count: number) => void): Promise<ReviewRecord> {
    const { driver, prompts, limits, root, semaphore } = this.deps;
    const key = this.id + ':r' + this.round + ':' + slot;
    this.deps.telemetry?.add(key, this.ref, 'reviewer ' + label(name), this.id, { round: this.round, slot: slot + 1 });
    const own = new AbortController();
    const signal = AbortSignal.any([this.signal, own.signal]);
    const write = this.kind.access === "write";
    const scratch = join(this.dir!, `review-${this.round}-${name}`);
    let box: ReturnType<typeof processTools> | undefined;
    let conversation: Conversation<typeof ReviewReport> | undefined;
    let completed = false;
    let release: (() => void) | undefined;
    try {
      this.deps.telemetry?.state(key, 'queued');
      const runtime = await this.deps.select(`reviewer.${name}`, this.title, signal);
      release = await semaphore.acquire(signal);
      if (runtime) this.launches.push({ role: `reviewer.${name}`, runtime, label: `round ${this.round}` });
      this.deps.telemetry?.state(key, 'running');
      let cwd = root;
      if (write) {
        await mkdir(scratch, { mode: 0o700 });
        cwd = await snapshot(root, scratch, this.candidate!, signal);
        box = processTools(cwd, join(scratch, "runtime"), { signal, verify: { artifacts: join(this.dir!, "artifacts", `r${this.round}-${name}`), services: limits.services } });
      }
      conversation = new Conversation({
        driver, signal, beforeAttempt: this.beforeAttempt, chargeTurn: this.chargeTurn, warning: this.warning, turns: limits.reviewerTurns, minutes: limits.reviewerMinutes,
        spec: { runtime, observe: this.deps.telemetry?.sink(key), name: `reviewer.${name}`, cwd, tools: [...readTools(cwd), ...(box?.tools ?? [])], system: `${prompts.reviewer}\n\n${prompt}\n\n${prompts.guard}`, log: (line) => this.log(`  review ${name} ${line}`) },
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
      completed = true;
      artifacts(box?.saved.length ?? 0);
      return { name, ...out, verdict: out.verdict as Verdict, artifacts: [...(out.artifacts ?? []), ...(box?.saved ?? [])] };
    } catch (error) {
      if (this.signal.aborted) throw error;
      return { name, verdict: "unknown", error: errorText(error) };
    } finally {
      this.deps.telemetry?.state(key, this.signal.aborted ? 'cancelled' : completed ? 'done' : 'failed');
      own.abort(new Block("ended", "Review ended"));
      release?.();
      conversation?.dispose();
      await box?.close().catch(() => {});
      if (write) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Display-only round notice; `worq_list` holds the full findings. */
  digest() {
    const write = this.kind.access === "write";
    const head = `${this.headline} round ${this.round} review-ready · ${reviewStatus(this.reviews)}`;
    const where = write ? `Branch ${this.branch} @ ${this.candidate?.slice(0, 10)}\n${this.diffstat}` : `Plan: ${this.plan?.path}`;
    return [head, where, "Reviews:",
      ...reviewLines(this.reviews, { ...DIGEST, label: `worq_list(${this.ref})` }),
      `Full findings: worq_list(${this.ref}). This notice does not authorize further action.`,
    ].join("\n");
  }
}
