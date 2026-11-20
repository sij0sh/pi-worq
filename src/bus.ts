import { Block } from "./contracts.ts";

/** How much the manager (main Pi session) is consulted. */
export type ReviewMode = "gates" | "asks-only" | "off";
export type GateKind = "plan" | "candidate";
export type Decision = "approve" | "revise" | "escalate";
export interface AgentInfo { id: string; role: string; state: "running" | "waiting" | "done" | "failed"; turns: number; sealed: boolean; last?: string }
export interface PendingInfo { id: string; kind: "ask" | "gate"; agent?: string; gate?: GateKind; body: string; created: number }
export interface Review { decision: Decision; text?: string; by: "manager" | "user" | "auto" }
export type BusEvent = { type: "ask" | "gate"; pending: PendingInfo; context: string } | { type: "settled"; id: string; outcome: string };
export interface AgentHandle { steer(text: string): void; followUp(text: string): void; interrupt(text: string): Promise<void> }
export interface Timing { askMs: number; gateMs: number }

interface Agent { info: AgentInfo; tail: { seq: number; line: string }[]; handle?: AgentHandle }
interface Pending { info: PendingInfo; settle(value: string | Review): void }
const TAIL = 60;
const one = (text: string, max = 240) => text.replace(/\s+/g, " ").trim().slice(0, max);
export const unanswered = "No manager answer. Decide within your authority, record the assumption in your summary, and continue.";

/**
 * Message bus between Worq's SDK agents and the manager (main Pi session, the user, or the CLI).
 * Agents ask; the controller opens review gates; the manager replies, reviews, steers or interrupts.
 */
export class Bus {
  private readonly agents = new Map<string, Agent>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: BusEvent) => void>();
  private readonly changes = new Set<() => void>();
  private seq = 0;
  private counter = 0;
  /** True when a manager session can answer; otherwise asks resolve at once and gates auto-approve. */
  attached: boolean;
  /** Ask the user (set by the run); used for escalation. */
  escalator?: (prompt: string) => Promise<string>;
  readonly mode: ReviewMode;
  readonly timing: Timing;
  constructor(mode: ReviewMode, attached: boolean, timing: Timing = { askMs: 120_000, gateMs: 180_000 }) {
    this.mode = mode;
    this.timing = timing;
    this.attached = attached && mode !== "off";
  }
  on(listener: (event: BusEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onChange(listener: () => void) { this.changes.add(listener); return () => { this.changes.delete(listener); }; }
  private emit(event: BusEvent) { for (const l of this.listeners) { try { l(event); } catch { /* listeners cannot affect agents */ } } }
  private changed() { for (const l of this.changes) { try { l(); } catch { /* ignore */ } } }
  private next(prefix: string) { return `${prefix}${++this.counter}`; }

  register(role: string, sealed: boolean) {
    const id = this.next(role === "worker" ? "w" : role[0]);
    const agent: Agent = { info: { id, role, state: "running", turns: 0, sealed }, tail: [] };
    this.agents.set(id, agent);
    this.changed();
    return {
      id,
      attach: (handle: AgentHandle) => { if (!sealed) agent.handle = handle; },
      log: (line: string) => {
        agent.tail.push({ seq: ++this.seq, line: one(line, 400) });
        if (agent.tail.length > TAIL) agent.tail.shift();
        agent.info.last = one(line, 120);
      },
      turn: () => { agent.info.turns++; },
      close: (state: "done" | "failed") => { agent.info.state = state; agent.handle = undefined; this.changed(); },
    };
  }
  private agent(id: string) {
    const agent = this.agents.get(id);
    if (!agent) throw new Block("no-agent", `Unknown agent ${id}. Use worq_agents to list agents.`);
    return agent;
  }
  private live(id: string) {
    const agent = this.agent(id);
    if (agent.info.sealed) throw new Block("sealed", `${id} (${agent.info.role}) is independent (verification or lens); it cannot be steered`);
    if (!agent.handle) throw new Block("agent-closed", `${id} is ${agent.info.state}`);
    return agent.handle;
  }

  /**
   * An agent asks the manager. Never rejects for lack of a manager: the agent gets a decide-yourself answer.
   * Plan owns the user's intent, so without a manager its questions go to the user when one is attached.
   */
  async ask(agentId: string, question: string, signal: AbortSignal): Promise<string> {
    const agent = this.agent(agentId);
    if (!this.attached) {
      if (agent.info.role !== "plan" || !this.escalator) return unanswered;
      agent.info.state = "waiting";
      this.changed();
      try { return `User: ${await this.escalator(question)}`; }
      catch { signal.throwIfAborted(); return unanswered; }
      finally { if (agent.info.state === "waiting") agent.info.state = "running"; this.changed(); }
    }
    const context = [`Role: ${agent.info.role}`, ...agent.tail.slice(-8).map((x) => `- ${x.line}`)].join("\n");
    agent.info.state = "waiting";
    try {
      const answer = await this.wait<string>("ask", { agent: agentId, body: question }, context, this.timing.askMs, signal, () => unanswered);
      return answer;
    } finally { if (agent.info.state === "waiting") agent.info.state = "running"; this.changed(); }
  }
  /** The controller asks the manager to review a handoff. */
  async gate(gate: GateKind, body: string, signal: AbortSignal): Promise<Review> {
    if (!this.attached || this.mode !== "gates") return { decision: "approve", by: "auto" };
    return this.wait<Review>("gate", { gate, body }, "", this.timing.gateMs, signal, () => ({ decision: "approve", by: "auto" }));
  }
  private wait<T extends string | Review>(kind: "ask" | "gate", fields: Pick<PendingInfo, "agent" | "gate" | "body">, context: string, ms: number, signal: AbortSignal, fallback: () => T): Promise<T> {
    signal.throwIfAborted();
    const id = this.next(kind === "ask" ? "q" : "g");
    const info: PendingInfo = { id, kind, ...fields, created: Date.now() };
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); this.pending.delete(id); this.changed(); };
      const abort = () => { done(); this.emit({ type: "settled", id, outcome: "cancelled" }); reject(signal.reason); };
      timer = setTimeout(() => { done(); this.emit({ type: "settled", id, outcome: "timed out" }); resolve(fallback()); }, ms);
      timer.unref?.();
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { info, settle: (value) => { done(); resolve(value as T); } });
      this.changed();
      this.emit({ type: kind, pending: info, context });
    });
  }
  private take(id: string, kind: "ask" | "gate") {
    const pending = this.pending.get(id);
    if (!pending || pending.info.kind !== kind) throw new Block("no-pending", `No open ${kind === "ask" ? "question" : "review"} ${id}`);
    return pending;
  }

  // Manager operations (tools, /worq subcommands and the CLI share these).
  reply(id: string, text: string) {
    this.take(id, "ask").settle(`Manager: ${text}`);
    return `Answered ${id}`;
  }
  review(id: string, decision: Decision, text?: string) {
    const pending = this.take(id, "gate");
    if (decision === "revise" && !text?.trim()) throw new Block("review-text", "A revision needs text explaining what to change");
    if (decision === "escalate") { void this.escalate(id, text).catch(() => {}); return `Escalated ${id} to the user`; }
    pending.settle({ decision, text, by: "manager" });
    return `${decision === "approve" ? "Approved" : "Requested revision on"} ${id}`;
  }
  async escalate(id: string, note?: string) {
    const pending = this.pending.get(id);
    if (!pending) throw new Block("no-pending", `No open item ${id}`);
    if (!this.escalator) throw new Block("no-user", "No user is attached to answer");
    const { info } = pending;
    const prompt = info.kind === "ask"
      ? `An agent asks: ${one(info.body, 400)}${note ? ` (Pi: ${one(note, 200)})` : ""}`
      : `Review ${info.gate}: ${one(info.body, 360)}${note ? ` (Pi: ${one(note, 200)})` : ""} — approve? (y, or type what to change)`;
    const answer = await this.escalator(prompt);
    if (!this.pending.has(id)) return;
    if (info.kind === "ask") pending.settle(`User: ${answer}`);
    else pending.settle(/^(y|yes|ok|okay|approve[ds]?|lgtm|accept)[.!]*$/i.test(answer.trim()) ? { decision: "approve", by: "user" } : { decision: "revise", text: answer, by: "user" });
  }
  send(agentId: string, text: string, mode: "steer" | "followUp" = "steer") {
    const handle = this.live(agentId);
    (mode === "steer" ? handle.steer : handle.followUp)(`Manager: ${text}`);
    this.agent(agentId).tail.push({ seq: ++this.seq, line: `← manager (${mode}): ${one(text)}` });
    return `Sent to ${agentId} (${mode})`;
  }
  async interrupt(agentId: string, text: string) {
    await this.live(agentId).interrupt(`Manager interrupted you: ${text}`);
    this.agent(agentId).tail.push({ seq: ++this.seq, line: `← manager (interrupt): ${one(text)}` });
    return `Interrupted ${agentId}`;
  }
  log(agentId: string, lines = 20, since = 0) {
    return this.agent(agentId).tail.filter((x) => x.seq > since).slice(-lines);
  }
  agentsView(): AgentInfo[] { return [...this.agents.values()].map((a) => ({ ...a.info })); }
  pendingView(): PendingInfo[] { return [...this.pending.values()].map((p) => ({ ...p.info })); }
}
