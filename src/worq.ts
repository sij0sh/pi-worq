import { Agent, ENDED, Semaphore, type AgentEvent, type Attachment } from "./agent.ts";
import { Block } from "./contracts.ts";
import type { Config } from "./config.ts";
import type { Prompts } from "./prompts.ts";
import { one, reviewLines, reviewStatus } from "./render.ts";
import { assertChoice, type Driver } from "./session.ts";
import { reserveName, readPlan, repository } from "./workspace.ts";

export interface WorqDeps {
  telemetry?: import('./telemetry.ts').Telemetry;
  driver: Driver;
  prompts: Prompts;
  config: Config;
  state: string;
  cwd: string;
  notify(event: AgentEvent): void;
}
export const REF_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)+$";
const REF = new RegExp(REF_PATTERN);
function nameFrom(title: string) {
  if (typeof title !== "string" || title.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*(?: +[a-z0-9]+(?:-[a-z0-9]+)*){1,3}$/i.test(title.trim())) throw new Block("title", "Supply a 2–4 word title using letters, numbers or internal hyphens");
  return title.trim().toLowerCase().replace(/ +/g, "-");
}

/** Agents owned by this Pi session. Main is the only spawner. */
export class Worq {
  private starting = 0;
  private readonly agents = new Map<string, Agent>();
  private readonly semaphore: Semaphore;
  private readonly deps: WorqDeps;
  constructor(deps: WorqDeps) {
    this.deps = deps;
    this.semaphore = new Semaphore(deps.config.limits.parallel);
  }
  /** Judge one role's resolved choice against what its harness can do. Fails before any work. */
  private readonly check = (role: string): void => {
    const caps = this.deps.driver.capabilities(role);
    assertChoice(this.deps.config.model(role), caps);
    if (caps.context.system !== "replace" || caps.context.ambientInstructions) throw new Block("capability", `${role}: isolated context required`);
  };
  get size() { return this.agents.size; }
  all() { return [...this.agents.values()]; }
  get(ref: string) {
    const agent = this.agents.get(ref);
    if (!agent) throw new Block("unknown-ref", `No agent ${ref} in this session. worq_list shows refs.`);
    return agent;
  }

  async spawn(kindName: string, task: string, { title, attach = [], verify = true, mode, reason }: { title: string; attach?: string[]; verify?: boolean; mode?: "fast" | "thorough"; reason?: string }): Promise<Agent> {
    const { prompts, config } = this.deps;
    const kind = prompts.kinds.get(kindName);
    if (!kind) throw new Block("kind", `Unknown kind ${kindName}; use ${[...prompts.kinds.keys()].join(" | ")}`);
    if (kind.access !== "write" && verify === false) throw new Block("invalid-payload", "verify:false applies to execute only");
    // Fail a misconfigured role before the repository, the ref or any worktree exists.
    this.check(`agent.${kind.name}`);
    const base = nameFrom(title);
    const live = this.all().filter((a) => !a.ended).length + this.starting;
    if (live >= config.limits.agents) throw new Block("at-capacity", `${live} agents are live (limits.agents ${config.limits.agents}); close or cancel one first`);
    this.starting++;
    try {
      const root = await repository(this.deps.cwd, AbortSignal.timeout(10_000));
      const attachments = await this.attachments(root, attach);
      const { ref, dir } = await reserveName(root, this.deps.state, base);
      const agent = new Agent({ telemetry: this.deps.telemetry, driver: this.deps.driver, prompts, limits: config.limits, state: this.deps.state, root, semaphore: this.semaphore, notify: this.deps.notify, check: this.check },
        { ref, title: title.trim(), dir, kind, task, attachments, verify, mode, reason });
      this.agents.set(ref, agent);
      agent.launch();
      return agent;
    } finally { this.starting--; }
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
    if (!agents.length) return "No Worq agents in this session.";
    return agents.map((a) => {
      const pqs = a.delegations.length ? ` · PQs ${a.delegations.length - a.openPqs}/${a.delegations.length}` : "";
      const verdicts = a.reviews.length ? ` · ${a.reviews.map((r) => `${r.name} ${r.verdict}`).join(", ")}` : "";
      const extra = a.ask ? ` · asks: ${one(a.ask.question, 160)}` : a.error ? ` · ${one(a.error, 160)}` : "";
      return `${a.ref} · ${a.kind.name} · ${a.state} · round ${a.round}${pqs}${verdicts}${extra}\n    ${one(a.task, 140)}`;
    }).join("\n");
  }
  private detail(a: Agent): string {
    return [
      `${a.ref} · ${a.kind.name} · ${a.state} · round ${a.round}`,
      `Task: ${a.task}`,
      `Route: ${a.mode ?? "default"}${a.reason ? ` (${a.reason})` : ""}; review: ${a.reviewPolicyLabel}`,
      `Run turns: ${a.view().budget.spent}/${a.view().budget.allowance}`,
      ...[...new Set([`agent.${a.kind.name}`, ...a.delegations.map(d => d.role ?? "subagent"), ...a.reviews.map(r => `reviewer.${r.name}`)])].map(role => {
        try { return `${role}: ${JSON.stringify(this.deps.config.model(role))}`; } catch (e) { return `${role}: ${String(e)}`; }
      }),
      a.work && `Worktree: ${a.work}`,
      a.attachments.length && `Attached: ${a.attachments.map((x) => x.path).join(", ")}`,
      a.plan && `Plan: ${a.plan.path}`,
      a.branch && `Branch: ${a.branch}${a.candidate ? ` @ ${a.candidate.slice(0, 10)}` : ""}`,
      a.diffstat && a.diffstat,
      a.ask && `Open ask: ${a.ask.question}`,
      a.error && `Error: ${a.error}`,
      a.delegations.length && ["PQs:", ...a.delegations.map((d) => `  ${d.state}: ${d.question}${d.answer ? `\n     → ${one(d.answer.answer, 300)}` : d.error ? `\n     → ${one(d.error, 200)}` : ""}`)].join("\n"),
      (a.state === "review-ready" || a.reviews.length > 0 || (a.state === "closed" && (a.plan || a.candidate))) &&
        [`Reviews: ${reviewStatus(a.reviews)}`, ...reviewLines(a.reviews)].join("\n"),
      ["Recent activity:", ...a.tail(20).map((h) => `  ${h.line}`)].join("\n"),
    ].filter(Boolean).join("\n");
  }
  send(ref: string, text: string) { return this.get(ref).send(text); }
  async cancel(ref: string): Promise<string> {
    if (ref === "all") {
      const live = this.all().filter((a) => !ENDED.includes(a.state));
      await Promise.all(live.map((a) => a.cancel()));
      return live.length ? `Stopped ${live.map((a) => `${a.ref} (${a.state})`).join(", ")}` : "No live agents";
    }
    const agent = this.get(ref);
    if (agent.ended) return `${agent.ref} already ${agent.state}`;
    await agent.cancel();
    return `${agent.ref} ${agent.state}${agent.work ? `; retained worktree ${agent.work}` : agent.branch ? `; branch ${agent.branch} kept` : ""}`;
  }
  async shutdown() { await this.cancel("all"); }
}
export const isRef = (value: string) => REF.test(value);
