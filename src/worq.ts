import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, ENDED, Semaphore, type AgentEvent, type Attachment } from "./agent.ts";
import { Block } from "./contracts.ts";
import type { Config } from "./config.ts";
import type { Prompts } from "./prompts.ts";
import { one, reviewLines } from "./render.ts";
import type { Driver } from "./session.ts";
import { branchExists, repository } from "./workspace.ts";

export interface WorqDeps {
  driver: Driver;
  prompts: Prompts;
  config: Config;
  state: string;
  cwd: string;
  notify(event: AgentEvent): void;
}
const REF = /^[0-9a-f]{4}$/;

/** Agents owned by this Pi session. Main is the only spawner. */
export class Worq {
  private readonly agents = new Map<string, Agent>();
  private readonly semaphore: Semaphore;
  private readonly deps: WorqDeps;
  constructor(deps: WorqDeps) {
    this.deps = deps;
    this.semaphore = new Semaphore(deps.config.limits.parallel);
  }
  get size() { return this.agents.size; }
  all() { return [...this.agents.values()]; }
  get(ref: string) {
    const agent = this.agents.get(ref.replace(/^@/, "").toLowerCase());
    if (!agent) throw new Block("unknown-ref", `No agent ${ref} in this session. worq_list shows refs.`);
    return agent;
  }

  async spawn(kindName: string, task: string): Promise<Agent> {
    const { prompts, config } = this.deps;
    const kind = prompts.kinds.get(kindName);
    if (!kind) throw new Block("kind", `Unknown kind ${kindName}; use ${[...prompts.kinds.keys()].join(" | ")}`);
    const live = this.all().filter((a) => !a.ended).length;
    if (live >= config.limits.agents) throw new Block("at-capacity", `${live} agents are live (limits.agents ${config.limits.agents}); close or cancel one first`);
    const root = await repository(this.deps.cwd, AbortSignal.timeout(10_000));
    const attachments = await this.attachments(root, task);
    let ref = "";
    for (let i = 0; i < 20 && !ref; i++) {
      const candidate = randomBytes(2).toString("hex");
      if (!this.agents.has(candidate) && !(await branchExists(root, `worq/${candidate}`, AbortSignal.timeout(10_000)))) ref = candidate;
    }
    if (!ref) throw new Block("ref", "Could not allocate a free agent ref");
    const agent = new Agent({ driver: this.deps.driver, prompts, limits: config.limits, state: this.deps.state, root, semaphore: this.semaphore, notify: this.deps.notify },
      { ref, kind, task, attachments });
    this.agents.set(ref, agent);
    agent.launch();
    return agent;
  }
  /** `@ref` in a task attaches that agent's plan: from this session, or from <repo>/.agents/plans/<ref>-*.md. */
  private async attachments(root: string, task: string): Promise<Attachment[]> {
    const refs = [...new Set([...task.matchAll(/(?:^|[^\w@])@([0-9a-f]{4})\b/g)].map((m) => m[1]))];
    const out: Attachment[] = [];
    for (const ref of refs) {
      const live = this.agents.get(ref);
      if (live?.plan) { out.push({ ref, path: live.plan.path, text: live.plan.text }); continue; }
      const dir = join(root, ".agents", "plans");
      const file = (await readdir(dir).catch(() => [] as string[])).find((name) => name.startsWith(`${ref}-`) && name.endsWith(".md"));
      if (file) { out.push({ ref, path: `.agents/plans/${file}`, text: await readFile(join(dir, file), "utf8") }); continue; }
      if (live) out.push({ ref, text: `Agent ${ref} (${live.kind.name}, ${live.state}) has no plan. Its latest submission:\n${live.submission ?? "none yet"}${live.branch ? `\nBranch: ${live.branch}` : ""}` });
      else throw new Block("unknown-ref", `@${ref} names no agent in this session and no plan in .agents/plans/`);
    }
    return out;
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
      a.attachments.length && `Attached: ${a.attachments.map((x) => `@${x.ref}${x.path ? ` (${x.path})` : ""}`).join(", ")}`,
      a.plan && `Plan: ${a.plan.path}`,
      a.branch && `Branch: ${a.branch}${a.candidate ? ` @ ${a.candidate.slice(0, 10)}` : ""}`,
      a.diffstat && a.diffstat,
      a.ask && `Open ask: ${a.ask.question}`,
      a.error && `Error: ${a.error}`,
      a.delegations.length && ["PQs:", ...a.delegations.map((d) => `  ${d.id} ${d.state}: ${one(d.question, 200)}${d.answer ? `\n     → ${one(d.answer.answer, 300)}` : d.error ? `\n     → ${one(d.error, 200)}` : ""}`)].join("\n"),
      a.reviews.length && ["Reviews:", ...reviewLines(a.reviews, 600)].join("\n"),
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
    return `${agent.ref} ${agent.state}${agent.branch ? `; branch ${agent.branch} kept` : ""}`;
  }
  async shutdown() { await this.cancel("all"); }
}
export const isRef = (value: string) => REF.test(value);
