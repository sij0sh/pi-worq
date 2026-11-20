import { constants, readdirSync, readFileSync } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import {
  createAgentSession, createExtensionRuntime, defineTool, SessionManager, SettingsManager,
  type ExtensionContext, type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { array, Block, command, obj, parse, PtyAction, text } from "./contracts.ts";
import type { Assignment, Roles } from "./controller.ts";
import type { Bus } from "./bus.ts";
import { loadModelConfig, type AgentRole } from "./model-config.ts";
import { CleanupError, launch, runProcess } from "./process.ts";
import { observePty } from "./pty.ts";
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

export function piRoles(context: Pick<ExtensionContext, "model" | "modelRegistry">): Roles {
  const instructions = {
    plan: loadPrompt("plan"),
    execute: loadPrompt("execute"),
    verify: loadPrompt("verify"),
  };
  const guard = loadPrompt("shared");
  const settle = loadPrompt("settle");
  const lenses = loadLenses();
  const reviewer = lenses.size ? loadPrompt("lenses/reviewer") : "";
  const models = loadModelConfig(context, lenses.keys());
  async function sdk<T extends TSchema>(input: { role: AgentRole | "lens"; lens?: string; cwd: string; task: object; signal: AbortSignal; tools: ToolDefinition[]; turns: number; bus?: Bus; prompt?: string; identify?: (agent: string) => void; validate?: (output: unknown) => void }, schema: T) {
    input.signal.throwIfAborted();
    const selection = models(input.role, input.lens);
    const model = selection.model ?? selection.fallback;
    if (!model) throw new Block("model", "Select a Pi model or set a model in pi-worq.json before starting Worq");
    let fallback = selection.fallback;
    if (fallback?.provider === model.provider && fallback.id === model.id) fallback = undefined;
    const budget = new AbortController();
    const signal = AbortSignal.any([input.signal, budget.signal]);
    // Time budget pauses while the agent waits on its manager.
    let remaining = input.role === "lens" ? 90_000 : 240_000, since = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resume = () => { since = Date.now(); timeout = setTimeout(() => budget.abort(new Block("agent-budget", `${input.role} ran out of time`)), remaining); };
    const pause = () => { clearTimeout(timeout); remaining = Math.max(1, remaining - (Date.now() - since)); };
    resume();
    // Verify and lens agents stay independent: no manager questions or steering.
    const sealed = input.role === "verify" || input.role === "lens";
    const agent = input.bus?.register(input.role, sealed);
    if (agent) input.identify?.(agent.id);
    let submitted: Static<T> | undefined;
    let rejected: string | undefined;
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
      let modelFailed = false;
      const inbox: string[] = [];
      const abort = () => { aborting ??= session.abort(); void aborting.catch(() => {}); };
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_start") { agent?.turn(); if (++turns > input.turns) budget.abort(new Block("agent-budget", `${input.role} reached its turn limit`)); }
        else if (event.type === "tool_execution_start") agent?.log(`→ ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`);
        else if (event.type === "tool_execution_end" && event.toolName === "worq_submit" && event.isError) {
          const content = event.result?.content as { type: string; text?: string }[] | undefined;
          rejected = (content?.flatMap((c) => c.type === "text" ? [c.text ?? ""] : []).join(" ") || "Invalid submission").slice(0, 800);
          agent?.log(`Submission rejected: ${rejected}`);
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          modelFailed = event.message.stopReason === "error";
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
          let started = false;
          modelFailed = false;
          try {
            await joined(session.prompt(next, { preflightResult: (state) => { started = state === "started"; } }), signal, `${input.role} session`);
          } catch (error) {
            // Prompt preflight can reject before a model turn (e.g. missing credentials).
            if (started || !fallback || error instanceof CleanupError || signal.aborted) throw error;
            modelFailed = true;
          }
          if (aborting || signal.aborted || submitted !== undefined) break;
          if (modelFailed && fallback) {
            const backup = fallback;
            fallback = undefined;
            agent?.log(`Model failed; switching to ${backup.provider}/${backup.id}`);
            await joined(session.setModel(backup), signal, `${input.role} model switch`);
            signal.throwIfAborted();
            session.setThinkingLevel("low");
            // Keep completed tool results in the same session; never restart the assignment.
            if (started) next = inbox.shift() ?? "The previous model request failed. Continue the same assignment using the conversation and tool results so far.";
            continue;
          }
          const message = inbox.shift();
          if (message) { next = message; continue; }
          // One settlement turn: re-ask the role's recursive question instead of blocking at once.
          if (settling) break;
          settling = true;
          next = rejected ? `Worq rejected your submission: ${rejected}\nCorrect the submission and call worq_submit again.` : settle;
        }
        if (aborting) await joined(aborting, signal, `${input.role} abort`).catch((error) => { throw new CleanupError(String(error)); });
        signal.throwIfAborted();
        if (submitted === undefined) {
          if (rejected) throw new Block("submission-rejected", `${input.role} submission rejected: ${rejected}`);
          throw new Block("agent-output", `${input.role} ended without submitting a result`);
        }
        agent?.close("done");
        return submitted;
      } finally { signal.removeEventListener("abort", abort); unsubscribe(); session.dispose(); }
    } catch (error) { agent?.close("failed"); throw error; }
    finally { clearTimeout(timeout); }
  }
  return {
    lenses: [...lenses.keys()],
    async lens({ lens, task, cwd, signal, bus, identify }) {
      const prompt = lenses.get(lens);
      if (!prompt) throw new Block("lens", `Unknown lens ${lens}`);
      return finding(await sdk({ role: "lens", lens, prompt: `${reviewer}\n\n${prompt}`, cwd, task, signal, tools: readTools(cwd, signal), turns: 12, bus, identify }, lensSchema));
    },
    ask: managed,
  };

  async function managed<T extends TSchema>(assignment: Assignment, schema: T) {
    const { signal, cwd } = assignment;
    let cleanupError: CleanupError | undefined;
    let closed = false;
    const parent = new AbortController();
    const parentSignal = AbortSignal.any([signal, parent.signal]);
    const check = () => { parentSignal.throwIfAborted(); if (closed) throw new Block("role-closed", "This role is closed"); if (cleanupError) throw cleanupError; };
    const { role, artifactsDir, runtimeDir } = assignment;
    const tools = readTools(cwd, parentSignal, () => closed);
    const artifactName = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$" });
    if (role === "plan") tools.push(tool("write_artifact", "Save a Markdown deliverable in this run's artifact folder, not the repository", obj({ name: artifactName, content: text(80_000) }), async ({ name, content }) => {
      check();
      if (!name.endsWith(".md")) throw new Block("artifact-path", "Use a .md filename");
      await writeScoped(artifactsDir, name, content);
      const path = join(artifactsDir, name);
      assignment.artifact?.(path);
      return `Saved ${path}`;
    }));
    if (role === "execute") tools.push(
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
    const commands = new Set<Promise<unknown>>();
    function track<T>(pending: Promise<T>) {
      commands.add(pending);
      void pending.then(() => commands.delete(pending), (error: unknown) => {
        if (error instanceof CleanupError) cleanupError = error;
        commands.delete(pending);
      });
      return pending;
    }
    const commandSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([parentSignal, signal]) : parentSignal;
    let env: ReturnType<typeof runtimeEnv> | undefined;
    const environment = () => env ??= runtimeEnv(runtimeDir);
    if (role !== "plan") tools.push(tool("run_command", "Run a trusted local command in the candidate checkout and observe its exit and output. Pass arguments directly; no shell parsing.",
      obj({ ...command, stdin: Type.Optional(Type.String({ maxLength: 8192 })) }), async ({ executable, args, stdin }, signal) => {
        check();
        const output = await track(runProcess(executable, args, { cwd, env: await environment(), signal: commandSignal(signal), ms: 60_000, stdin }));
        return `Exit ${output.code}\nstdout:\n${output.stdout.slice(-6000)}\nstderr:\n${output.stderr.slice(-6000)}`;
      }));
    if (role === "verify") {
      const services: { stdout: string; status: string }[] = [];
      tools.push(
        tool("start_local_service", "Launch an existing local test server in the candidate; bind to loopback. Worq stops it when Verify ends. Do not start a detached or external service.", obj(command), async ({ executable, args }) => {
          check();
          if (services.length >= 2) throw new Block("service-limit", "Verify can start at most two local services");
          const service = { stdout: "", status: "running" };
          const child = launch(executable, args, { cwd, env: await environment(), signal: parentSignal, ms: 240_000,
            stdout: (chunk) => { service.stdout = (service.stdout + chunk.toString()).slice(-4000); },
          });
          services.push(service);
          void track(child.done).then(({ code, stderr }) => { service.status = `Exit ${code}\n${stderr.slice(-1500)}`; }, (error) => { service.status = String(error); });
          return `Started service ${services.length}. Use service_status to see if it is ready.`;
        }),
        tool("service_status", "Read a managed local service's status and recent output", obj({ id: Type.Integer({ minimum: 1, maximum: 2 }) }), ({ id }) => {
          check();
          const service = services[id - 1];
          if (!service) throw new Block("no-service", `No service ${id}`);
          return `${service.status}\n${service.stdout}`;
        }),
        tool("observe_terminal", "Launch an interactive terminal app, drive inputs, and return rendered screens for observe steps.",
          obj({ ...command, actions: array(PtyAction, 16, 1) }), async ({ executable, args, actions }, signal) => {
            check();
            const screens = await track(observePty(executable, args, actions, cwd, await environment(), commandSignal(signal)));
            return screens.map(({ step, screen }) => `Step ${step}:\n${screen}`).join("\n\n").slice(-12_000) || "No screens requested";
          }),
        defineTool({ name: "save_artifact", label: "Save artifact", description: "Retain a screenshot or text observation produced in the verification checkout. Small screenshots are also shown to image-capable models.",
          parameters: obj({ path: text(1024), name: Type.Optional(artifactName) }), executionMode: "sequential",
          async execute(_id, { path, name = basename(path) }, signal, _update, ctx) {
            check();
            signal?.throwIfAborted();
            parse(artifactName, name, "Artifact name");
            if (!/\.(png|jpe?g|webp|txt|md|log)$/i.test(name)) throw new Block("artifact-path", "Use a screenshot or text filename");
            const source = await scoped(cwd, path);
            const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            let bytes: Buffer;
            try {
              const info = await file.stat();
              const { size } = info;
              if (!info.isFile() || size > 8 * 1024 * 1024) throw new Block("artifact-file", "Expected a regular file no larger than 8 MiB");
              bytes = Buffer.alloc(size);
              for (let offset = 0; offset < size;) {
                const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
                if (!bytesRead) throw new Block("artifact-file", "File changed while reading; save it after writing has finished");
                offset += bytesRead;
              }
            } finally { await file.close(); }
            await writeScoped(artifactsDir, name, bytes);
            const saved = join(artifactsDir, name);
            assignment.artifact?.(saved);
            const reply = result(`Saved ${saved}`);
            const ext = /\.(png|jpe?g|webp)$/i.exec(name)?.[1].toLowerCase();
            if (!ext || !bytes.length || bytes.length > 2 * 1024 * 1024 || !ctx.model?.input.includes("image")) return reply;
            return { ...reply, content: [...reply.content, { type: "image" as const, mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`, data: bytes.toString("base64") }] };
          },
        }),
      );
    }
    try {
      return await sdk({ ...assignment, signal: parentSignal, tools, turns: role === "plan" ? 20 : 36 }, schema);
    } finally {
      closed = true;
      parent.abort(new Block("role-closed", "Parent role finished"));
      await Promise.allSettled(commands);
      if (cleanupError) throw cleanupError;
      if (env) await rm(runtimeDir, { recursive: true, force: true });
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
