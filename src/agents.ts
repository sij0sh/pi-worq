import { readdirSync, readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import {
  createAgentSession, createExtensionRuntime, defineTool, SessionManager, SettingsManager,
  type ExtensionContext, type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { array, Block, id, obj, parse, text } from "./contracts.ts";
import type { Assignment, Roles } from "./controller.ts";
import type { Bus } from "./bus.ts";
import { CleanupError, runProcess } from "./process.ts";
import { readSmall, runtimeEnv, scoped, writeScoped } from "./workspace.ts";

function resources(prompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
}
const result = (text: string, terminate = false) => ({ content: [{ type: "text" as const, text }], details: undefined, terminate });
function tool<T extends TSchema>(name: string, description: string, parameters: T, fn: (params: Static<T>, signal?: AbortSignal) => Promise<string> | string) {
  return defineTool({ name, label: name, description, parameters, executionMode: "sequential", async execute(_id, params, signal) {
    signal?.throwIfAborted();
    return result(await fn(parse(parameters, params, name), signal));
  } });
}
async function joined<T>(operation: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    abort = () => { timer = setTimeout(() => reject(new CleanupError(`Could not confirm ${what} settled after cancellation`)), 6_000); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, watchdog]); }
  finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
}
function loadPrompt(name: string) {
  const path = `prompts/${name}.md`;
  let prompt: string;
  try { prompt = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").trim(); }
  catch (error) { throw new Block("prompt-file", `Cannot read ${path}: ${(error as Error).message}`); }
  if (!prompt) throw new Block("prompt-file", `${path} is blank`);
  return prompt;
}
const notes = Type.Optional(array(text(400), 6));
const lensSchema = obj({ summary: text(1600), evidence: notes, unresolved: notes, newQuestions: notes });
function finding(response: Static<typeof lensSchema>) {
  const section = (label: string, items?: string[]) => items?.length ? `\n${label}:\n${items.map((item) => `- ${item}`).join("\n")}` : "";
  return response.summary + section("Evidence", response.evidence) + section("Unresolved", response.unresolved) + section("New questions", response.newQuestions);
}
/** Lens SCQs: every prompts/lenses/*.md except the shared reviewer policy. */
function loadLenses() {
  let names: string[];
  try { names = readdirSync(new URL("../prompts/lenses/", import.meta.url)).filter((f) => f.endsWith(".md") && f !== "reviewer.md").map((f) => f.slice(0, -3)).sort(); }
  catch { return new Map<string, string>(); }
  return new Map(names.map((name) => [name, loadPrompt(`lenses/${name}`)]));
}

export function piRoles(context: Pick<ExtensionContext, "model">): Roles {
  const instructions = {
    plan: loadPrompt("plan"),
    execute: loadPrompt("execute"),
    journey: loadPrompt("verify-journey"),
    route: loadPrompt("verify-route"),
  };
  const guard = loadPrompt("shared");
  const settle = loadPrompt("settle");
  const lenses = loadLenses();
  const reviewer = lenses.size ? loadPrompt("lenses/reviewer") : "";
  const model = context.model;
  type Role = keyof typeof instructions | "lens";
  async function sdk<T extends TSchema>(input: { role: Role; cwd: string; task: object; signal: AbortSignal; tools: ToolDefinition[]; turns: number; bus?: Bus; prompt?: string; validate?: (output: unknown) => void }, schema: T) {
    input.signal.throwIfAborted();
    if (!model) throw new Block("model", "Select a Pi model before starting Worq");
    const budget = new AbortController();
    const signal = AbortSignal.any([input.signal, budget.signal]);
    // Time budget pauses while the agent waits on its manager.
    let remaining = input.role === "lens" ? 90_000 : 240_000, since = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resume = () => { since = Date.now(); timeout = setTimeout(() => budget.abort(new Block("agent-budget", `${input.role} ran out of time`)), remaining); };
    const pause = () => { clearTimeout(timeout); remaining = Math.max(1, remaining - (Date.now() - since)); };
    resume();
    // Verify and lens agents stay independent: no manager questions or steering.
    const sealed = input.role === "journey" || input.role === "route" || input.role === "lens";
    const agent = input.bus?.register(input.role, sealed);
    let submitted: Static<T> | undefined;
    const submit = defineTool({ name: "worq_submit", label: "Submit", description: "Submit the terminal structured result", parameters: schema, executionMode: "sequential", async execute(_id, params) {
      signal.throwIfAborted();
      if (submitted !== undefined) return result("Submitted", true);
      const value = parse(schema, params, `${input.role} submission`);
      input.validate?.(value);
      submitted = value;
      return result("Submitted", true);
    } });
    const tools = [submit, ...input.tools];
    let asks = 0;
    if (agent && !sealed) tools.push(tool("ask_manager", "Ask your manager (the main Pi session) one concise question when a decision is outside your authority or you are blocked. Waits for the answer.", obj({ question: text(1200) }), async ({ question }) => {
      signal.throwIfAborted();
      if (++asks > 3) return "Question limit reached. Decide within your authority and record the assumption.";
      pause();
      try { return await input.bus!.ask(agent.id, question, signal); } finally { resume(); }
    }));
    try {
      const { session } = await createAgentSession({ cwd: input.cwd, model, thinkingLevel: "low",
        resourceLoader: resources(`${input.prompt ?? instructions[input.role as keyof typeof instructions]}\n${guard}`), tools: tools.map((t) => t.name), customTools: tools,
        sessionManager: SessionManager.inMemory(input.cwd), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      let aborting: Promise<void> | undefined;
      let turns = 0;
      const inbox: string[] = [];
      const abort = () => { aborting ??= session.abort(); void aborting.catch(() => {}); };
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_start") { agent?.turn(); if (++turns > input.turns) budget.abort(new Block("agent-budget", `${input.role} reached its turn limit`)); }
        else if (event.type === "tool_execution_start") agent?.log(`→ ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`);
        else if (event.type === "message_end" && event.message.role === "assistant") {
          const said = (event.message.content as { type: string; text?: string }[]).flatMap((c) => c.type === "text" && c.text?.trim() ? [c.text] : []).join(" ");
          if (said) agent?.log(said);
        }
      });
      const queue = (text: string, mode: "steer" | "followUp") => {
        if (session.isStreaming) void session[mode](text, undefined, { source: "extension" }).catch(() => inbox.push(text));
        else inbox.push(text);
      };
      agent?.attach({
        steer: (text) => queue(text, "steer"),
        followUp: (text) => queue(text, "followUp"),
        async interrupt(text) { inbox.unshift(text); if (session.isStreaming) await session.abort(); },
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        let next = JSON.stringify(input.task, null, 2);
        let settling = false;
        for (;;) {
          await joined(session.prompt(next), signal, `${input.role} session`);
          if (aborting || signal.aborted || submitted !== undefined) break;
          const message = inbox.shift();
          if (message) { next = message; continue; }
          // One settlement turn: re-ask the role's recursive question instead of blocking at once.
          if (settling) break;
          settling = true;
          next = settle;
        }
        if (aborting) await joined(aborting, signal, `${input.role} abort`).catch((error) => { throw new CleanupError(String(error)); });
        signal.throwIfAborted();
        if (submitted === undefined) throw new Block("agent-output", `${input.role} ended without submitting a result`);
        agent?.close("done");
        return submitted;
      } finally { signal.removeEventListener("abort", abort); unsubscribe(); session.dispose(); }
    } catch (error) { agent?.close("failed"); throw error; }
    finally { clearTimeout(timeout); }
  }
  return {
    lenses: [...lenses.keys()],
    async lens({ lens, task, cwd, signal, bus }) {
      const prompt = lenses.get(lens);
      if (!prompt) throw new Block("lens", `Unknown lens ${lens}`);
      return finding(await sdk({ role: "lens", prompt: `${reviewer}\n\n${prompt}`, cwd, task, signal, tools: readTools(cwd, signal), turns: 12, bus }, lensSchema));
    },
    async ask(assignment, schema) {
      if (assignment.role === "journey" || assignment.role === "route") return sdk({ ...assignment, tools: [], turns: 2 }, schema);
      return managed(assignment, schema);
    },
  };

  async function managed<T extends TSchema>(assignment: Assignment, schema: T) {
    const { signal, cwd } = assignment;
    let cleanupError: CleanupError | undefined;
    let closed = false;
    const parent = new AbortController();
    const parentSignal = AbortSignal.any([signal, parent.signal]);
    const check = () => { parentSignal.throwIfAborted(); if (closed) throw new Block("role-closed", "This role is closed"); if (cleanupError) throw cleanupError; };
    const canWrite = assignment.role === "execute";
    const tools = readTools(cwd, parentSignal, () => closed);
    if (canWrite) tools.push(
      tool("write_file", "Create or replace a complete UTF-8 file in the candidate", obj({ path: text(1024), content: Type.String({ maxLength: 80_000 }) }), async ({ path, content }) => {
        check();
        await writeScoped(cwd, path, content);
        return `Wrote ${path}`;
      }),
      tool("edit_file", "Replace one exact and unique text region in a candidate file", obj({ path: text(1024), old: text(25_000), replacement: Type.String({ maxLength: 40_000 }) }), async ({ path, old, replacement }) => {
        check();
        const before = await readSmall(await scoped(cwd, path), 256 * 1024);
        const index = before.indexOf(old);
        if (index === -1 || before.indexOf(old, index + 1) !== -1) throw new Block("edit-match", "Old text must match exactly once");
        check();
        await writeScoped(cwd, path, before.slice(0, index) + replacement + before.slice(index + old.length));
        return `Edited ${path}`;
      }),
      tool("delete_file", "Remove one regular candidate file", obj({ path: text(1024) }), async ({ path }) => {
        check();
        const target = await scoped(cwd, path);
        if (!(await lstat(target)).isFile()) throw new Block("delete", "Only regular files can be removed");
        check();
        const { unlink } = await import("node:fs/promises");
        await unlink(target);
        return `Removed ${path}`;
      }),
    );
    const commands = new Set<ReturnType<typeof runProcess>>();
    if (canWrite) tools.push(tool("dev_check", "Run one approved development check by ID; not acceptance evidence", obj({ id }), async ({ id }, toolSignal) => {
      check();
      const command = assignment.project?.profile.devChecks?.find((recipe) => recipe.id === id);
      if (!command || !assignment.directory) throw new Block("dev-check", `No approved development check named ${id}`);
      try {
        const env = await runtimeEnv(join(assignment.directory, "dev-env"));
        const signal = toolSignal ? AbortSignal.any([parentSignal, toolSignal]) : parentSignal;
        const pending = runProcess(command.executable, command.args, { cwd, env, signal, ms: 60_000 });
        commands.add(pending);
        const { code, stdout, stderr } = await pending.finally(() => { commands.delete(pending); });
        const message = `${id}: exit ${code}\n${stdout.slice(0, 6000)}\n${stderr.slice(0, 6000)}`;
        assignment.selfCheck?.(message);
        return message;
      } catch (error) {
        if (error instanceof CleanupError) cleanupError = error;
        throw error;
      }
    }));
    try {
      return await sdk({ ...assignment, signal: parentSignal, tools, turns: canWrite ? 36 : 20 }, schema);
    } finally {
      closed = true;
      parent.abort(new Block("role-closed", "Parent role finished"));
      const settled = await Promise.allSettled(commands);
      for (const item of settled) if (item.status === "rejected" && item.reason instanceof CleanupError) cleanupError = item.reason;
      if (cleanupError) throw cleanupError;
    }
  }
}
/** Read-only repository tools shared by Plan, Execute and lens agents. */
function readTools(cwd: string, signal: AbortSignal, closed = () => false): ToolDefinition[] {
  const check = () => { signal.throwIfAborted(); if (closed()) throw new Block("role-closed", "This role is closed"); };
  return [
    tool("list_files", "List a repository directory (relative path, use . for root)", obj({ path: text(1024) }), async ({ path }) => {
      check();
      const entries = await readdir(await scoped(cwd, path, { root: true }), { withFileTypes: true });
      return entries.filter((entry) => entry.name !== ".git" && !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 250).map((e) => e.name + (e.isDirectory() ? "/" : "")).join("\n");
    }),
    tool("read_file", "Read a repository text file, at most 160 lines per call", obj({ path: text(1024), offset: Type.Optional(Type.Integer({ minimum: 1 })) }), async ({ path, offset = 1 }) => {
      check();
      const raw = await readSmall(await scoped(cwd, path), 256 * 1024);
      if (raw.includes("\0")) throw new Block("binary", "Binary files are not exposed");
      return raw.split("\n").slice(offset - 1, offset + 159).map((value, i) => `${offset + i}: ${value}`).join("\n").slice(0, 20_000);
    }),
  ];
}
