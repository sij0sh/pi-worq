import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createAssistantMessageEventStream, getSystemMessageText, type ToolCall } from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai/models";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorq } from "../index.ts";
import { serve } from "../src/control.ts";
import { literals, obj, parse } from "../src/contracts.ts";
import { resolveRuntime } from "../src/runtime/launch.ts";
import { EMPTY } from "../src/runtime/resources.ts";
import { createUsageTracker } from "../src/runtime/usage.ts";
import { createDriver, discoverAdapters } from "../src/sdk/registry.ts";
import { repo } from "./fake.ts";

const run = promisify(execFile);
const cli = join(import.meta.dirname, "..", "bin", "worq.mjs");

/** A deterministic third-party adapter, written as an operator would install it. Records calls on a global. */
const adapterSource = (key: string) => `
const calls = (globalThis[${JSON.stringify(key)}] ??= { validate: [], models: 0, open: [] });
export default {
  version: 1,
  create(context) {
    return {
      async models() { calls.models++; return ["e/listed"]; },
      defaultModel() { return "e/default"; },
      defaultThinking() { return "low"; },
      capabilities() { return { switchModel: false, thinking: ["low", "high"], context: { system: "replace", ambientInstructions: false }, turnUnit: "prompt" }; },
      validateRuntime(runtime) {
        calls.validate.push(runtime.model);
        if (!/^e\\/[a-z-]+$/.test(runtime.model ?? "")) throw new Error("echo: unknown model " + runtime.model);
      },
      async open(spec) {
        calls.open.push({ name: spec.name, model: spec.runtime.model, thinking: spec.thinking, id: context.id });
        let streaming = false;
        return {
          async prompt() {
            streaming = true;
            spec.emit({ type: "turn" });
            const value = spec.name === "review" ? { verdict: "pass", summary: "fine", findings: [] } : { summary: "echo " + spec.name };
            await spec.tools.find((t) => t.name === "submit").run(value, spec.signal);
            streaming = false;
            return "completed";
          },
          get streaming() { return streaming; },
          async abort() {},
          dispose() {},
        };
      },
    };
  },
};
`;
type Calls = { validate: (string | undefined)[]; models: number; open: { name: string; model?: string; thinking?: string; id: string }[] };
async function install(agentDir: string, id: string, source: string) {
  await mkdir(join(agentDir, "worq", "adapters", id), { recursive: true });
  await writeFile(join(agentDir, "worq", "adapters", id, "adapter.mjs"), source);
}

test("adapter: installed by folder, imported lazily on first explicit request, preflighted without models()", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "worq-adapters-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const key = `__worqEcho${Date.now()}a`;
  await install(agentDir, "echo", adapterSource(key));
  await install(agentDir, "broken", "throw new Error('broken import');");
  await install(agentDir, "pi", adapterSource(key));
  await install(agentDir, "Bad", adapterSource(key));
  const { records, problems } = discoverAdapters(agentDir);
  assert.deepEqual(Object.keys(records).sort(), ["broken", "claude-code", "echo", "pi"]);
  assert.match(problems.find((p) => p.path.endsWith("pi"))?.message ?? "", /shipped adapter/);
  assert.match(problems.find((p) => p.path.endsWith("Bad"))?.message ?? "", /lowercase/);
  assert.equal((globalThis as Record<string, unknown>)[key], undefined, "discovery imports nothing");

  const driver = await createDriver({}, EMPTY, records);
  const signal = new AbortController().signal;
  assert.deepEqual(await resolveRuntime(driver, { sdk: "echo" }, signal),
    { name: "launch", sdk: "echo", path: "", via: "launch request", model: "e/default", thinking: "low" }, "the adapter's own defaults, not Main's");
  assert.equal((await resolveRuntime(driver, { sdk: "echo", model: "e/unlisted", thinking: "high" }, signal)).model, "e/unlisted", "valid unlisted models work");
  await assert.rejects(resolveRuntime(driver, { sdk: "echo", model: "Bogus" }, signal), /unknown model Bogus/);
  const calls = (globalThis as unknown as Record<string, Calls>)[key];
  const validated = calls.validate.length;
  await assert.rejects(resolveRuntime(driver, { sdk: "echo", thinking: "max" }, signal), /max is not a echo thinking level/);
  await assert.rejects(resolveRuntime(driver, { sdk: "echo" }, AbortSignal.abort()), /abort/i);
  assert.equal(calls.validate.length, validated, "capability refusals and cancellation precede the adapter preflight");
  assert.equal(calls.models, 0, "no model enumeration for explicit requests");
  assert.equal(calls.open.length, 0);

  // A failed optional adapter is isolated: its launch fails clearly, the picker skips it, others stay usable.
  await assert.rejects(resolveRuntime(driver, { sdk: "broken" }, signal), /sdk "broken" could not load: broken import/);
  const catalog = await driver.catalog!();
  assert.deepEqual([...catalog.keys()], ["claude-code", "echo"], "pi (no host here) and broken are skipped, not fatal");
  await assert.rejects(resolveRuntime(driver, { sdk: "nope" }, signal), /Unknown sdk "nope" \(installed: pi, broken, claude-code, echo\)/);
});

test("a new folder package and a new adapter launch through worq_spawn and the CLI with no orchestration edits", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = `__worqEcho${Date.now()}b`;
  await install(agentDir, "echo", adapterSource(key));
  await mkdir(join(agentDir, "workflows", "notes"), { recursive: true });
  await writeFile(join(agentDir, "workflows", "notes", "SKILL.md"), "---\ndescription: Write release notes\naccess: read\n---\nWrite the release notes.\n");
  await writeFile(join(agentDir, "workflows", "notes", "REVIEW.md"), "Check the submitted notes.");
  process.env.WORQ_STATE_DIR = state;
  t.after(() => { delete process.env.WORQ_STATE_DIR; });
  const tools: { name: string; description: string; execute: Function }[] = [];
  const handlers: Record<string, Function> = {};
  const notices: { type?: string; ref: string }[] = [];
  const pi = {
    sendUserMessage() {}, registerCommand() {}, registerMessageRenderer() {},
    registerTool: (tool: never) => tools.push(tool),
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
    sendMessage: (message: { details: { ref: string; type?: string } }) => notices.push(message.details),
  };
  // Production catalog, discovery and driver: no driver seam.
  createWorq({ agentDir: () => agentDir })(pi as never);
  const spawn = tools.find((tool) => tool.name === "worq_spawn")!;
  assert.match(spawn.description, /notes \(read\): Write release notes/);
  const ctx = { mode: "print", cwd: root, model: undefined, thinkingLevel: undefined, modelRegistry: { find: () => undefined, getAvailable: () => [] },
    ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
  await handlers.session_start({}, ctx);
  t.after(() => handlers.session_shutdown({}, ctx));
  const parked = async (ref: string) => {
    for (let i = 0; i < 200 && !notices.some((n) => n.ref === ref && n.type === "parked"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(notices.some((n) => n.ref === ref && n.type === "parked"), `expected ${ref} parked`);
  };
  const env = { ...process.env, WORQ_STATE_DIR: state };

  const viaTool = await spawn.execute("id", { kind: "notes", sdk: "echo", model: "e/tool" }, undefined, undefined, ctx);
  assert.equal(viaTool.details.ref, "notes-run");
  await parked("notes-run");
  const viaCli = await run(process.execPath, [cli, "spawn", "notes", "--sdk", "echo", "--model", "e/cli", "--thinking", "high", "--", "Draft", "--the", "notes"], { env });
  assert.match(viaCli.stdout, /Spawned notes agent draft the notes \(draft-the-notes\)/);
  await parked("draft-the-notes");
  const calls = (globalThis as unknown as Record<string, Calls>)[key];
  assert.deepEqual(calls.open.map((o) => [o.name, o.model, o.thinking]), [
    ["agent.notes", "e/tool", "low"], ["review", "e/tool", "low"],
    ["agent.notes", "e/cli", "high"], ["review", "e/cli", "high"],
  ], "the review inherits the owner runtime");
  assert.equal(calls.models, 0);

  // Preflight refusal: no pending slot, ref or open; not mislabelled as a version problem.
  const opened = calls.open.length;
  await assert.rejects(run(process.execPath, [cli, "spawn", "notes", "--sdk", "echo", "--model", "Bogus"], { env }), (error: { stderr: string }) =>
    /unknown model Bogus/.test(error.stderr) && !/older than this CLI/.test(error.stderr));
  await assert.rejects(spawn.execute("id", { kind: "notes", sdk: "echo", thinking: "max" }, undefined, undefined, ctx), /not a echo thinking level/);
  assert.equal(calls.open.length, opened);
  assert.doesNotMatch((await run(process.execPath, [cli, "list"], { env })).stdout, /pending/);
  await run(process.execPath, [cli, "cancel", "all"], { env });
});

test("scripted Main sends spawn guidance tuples through real Pi tools to native worker selection", { timeout: 20_000 }, async t => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  const key = "__worqSpawnGuidanceEcho";
  const globals = globalThis as unknown as Record<string, Calls | undefined>;
  const shutdown: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of shutdown) await close();
    delete globals[key];
    delete process.env.WORQ_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.WORQ_STATE_DIR = state;
  await install(agentDir, "echo", adapterSource(key));
  await mkdir(join(agentDir, "workflows", "notes"), { recursive: true });
  const workerMarker = "Fixture worker instruction.";
  await writeFile(join(agentDir, "workflows", "notes", "SKILL.md"), `---\ndescription: Examine notes\naccess: read\nexplore: none\n---\n${workerMarker}\n`);
  const guide = join(agentDir, "worq", "SPAWN-GUIDANCE.md");
  const hints = join(agentDir, "worq", "RUNTIMES.md");
  const chosen = { sdk: "echo", model: "e/analysis", thinking: "high" };
  await writeFile(guide, `Unlisted prompt prose\n\n| sdk | model | thinking | use when |\n| --- | --- | --- | --- |\n| echo | ${chosen.model} | high | Difficult diagnosis |\n| echo | Bogus | low | Unavailable fixture choice |\n`);
  await writeFile(hints, "| role | sdk | model | thinking |\n| --- | --- | --- | --- |\n| notes | echo | e/hinted | low |\n");

  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const sessionManager = SessionManager.inMemory(root);
  let force = false;
  let restrictSpawn: "hide" | "deselect" | undefined = "hide";
  const visibleBeforeRestriction: boolean[] = [];
  let setTools!: (tools: string[]) => void;
  const usageTracker = createUsageTracker({
    poll: async () => [{
      provider: "claude",
      available: true,
      fiveHour: { usedPercent: 38, remainingPercent: 62, resetsAt: null },
      weekly: { usedPercent: 16, remainingPercent: 84, resetsAt: null },
      fetchedAt: "2026-11-25T13:00:00.000Z",
    }],
  });
  await usageTracker.refresh();
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    systemPromptOverride: () => "Fixture Main custom preamble.", extensionFactories: [createWorq({ agentDir: () => agentDir, usage: usageTracker }), pi => {
      setTools = tools => pi.setActiveTools(tools);
      pi.on("before_agent_start", ({ systemPromptOptions: options }) => {
        if (force) options.forceSystemPrompt = "Exact forced Main prompt.";
        if (!restrictSpawn) return;
        visibleBeforeRestriction.push(options.selectedTools.includes("worq_spawn") && !options.hiddenTools.includes("worq_spawn"));
        if (restrictSpawn === "hide") options.selectedTools = ["worq_spawn", "cloak"];
        else pi.setActiveTools([]);
      });
      pi.registerTool({ name: "cloak", label: "Cloak", description: "Hide the spawn declaration", defaultActive: false,
        parameters: Type.Object({}), prepareLoadout: () => ({ hiddenDeclarations: ["worq_spawn"] }),
        async execute() { throw new Error("fixture only hides tools"); } });
    }],
  });
  await resourceLoader.reload();
  // The snapshot is already loaded; editing the source must not affect subsequent prompts.
  await writeFile(guide, "Deleted table after extension load.\n");
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const main = modelRuntime.getAllModels().filter(m => isModelType(m, "chat"))
    .find(m => m.provider === "openai" && m.thinkingLevelMap?.medium !== undefined);
  assert.ok(main, "a local bundled Main model is available");
  await modelRuntime.setRuntimeApiKey(main.provider, "test-transport-only");
  const prompts: { text: string; tools: string[]; model: string; thinking?: string }[] = [];
  const piWorker: { model: string; thinking?: string }[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let outbound: ToolCall | undefined;
  let nextId = 0;
  modelRuntime.streamSimple = (model, { messages }, options) => {
    const system = messages.filter(m => m.role === "system");
    const text = system.map(getSystemMessageText).join("\n");
    const tools = new Set<string>();
    for (const message of system) {
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    }
    const selection = { model: `${model.provider}/${model.id}`, thinking: options?.reasoning };
    let call: ToolCall | undefined;
    if (text.includes(workerMarker)) {
      if (messages.at(-1)?.role !== "toolResult") {
        piWorker.push(selection);
        call = { type: "toolCall", id: `worker_${++nextId}`, name: "submit", arguments: { summary: "Pi fixture submitted" } };
      }
    } else {
      prompts.push({ text, tools: [...tools], ...selection });
      call = outbound;
      outbound = undefined;
    }
    const reason = call ? "toolUse" : "stop";
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason, message: { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      usage, timestamp: Date.now(), stopReason: reason, content: call ? [call] : [{ type: "text", text: "Scripted response" }] } });
    return stream;
  };
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, sessionManager, modelRuntime,
    model: main, thinkingLevel: "medium", resourceLoader });
  shutdown.push(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  await session.bindExtensions({ mode: "print" });

  const assertRestricted = async (restriction: "hide" | "deselect") => {
    setTools(["worq_spawn"]);
    restrictSpawn = restriction;
    await session.prompt(`A later start hook will ${restriction} spawn`);
    const request = prompts.at(-1);
    assert.ok(request);
    assert.equal(visibleBeforeRestriction.at(-1), true, "spawn was visible until the later start hook");
    assert.equal(request.tools.includes("worq_spawn"), false);
    assert.doesNotMatch(request.text, /worq_spawn_guidance|Difficult diagnosis|Provider usage snapshot/);
  };
  // First provider call of this fresh session: the tool becomes hidden only after Worq's handler.
  await assertRestricted("hide");
  assert.equal(prompts.length, 1);
  await assertRestricted("deselect");
  restrictSpawn = undefined;
  setTools(["worq_spawn"]);
  await session.prompt("Do not delegate this request");
  const visible = prompts.at(-1);
  assert.ok(visible);
  assert.ok(visible.tools.includes("worq_spawn"));
  assert.match(visible.text, /Fixture Main custom preamble/);
  assert.match(visible.text, /honor explicit user preferences first/);
  assert.match(visible.text, /"sdk":"echo","model":"e\/analysis","thinking":"high","use when":"Difficult diagnosis"/);
  assert.match(visible.text, /Provider usage snapshot/);
  assert.match(visible.text, /- claude: 5h 62% left, 7d 84% left/);
  assert.match(visible.text, /Unavailable fixture choice/, "well-formed entries are not preflighted");
  assert.doesNotMatch(visible.text, /Unlisted prompt prose|Deleted table/);
  await assertRestricted("hide"); // A formerly visible shortlist must not survive in replayed history.
  restrictSpawn = undefined;
  setTools(["worq_spawn"]);
  force = true;
  await session.prompt("Exact unmodified prompt");
  assert.equal(prompts.at(-1)?.text, "Exact forced Main prompt.");
  force = false;
  assert.equal(globals[key], undefined, "Main prompts never import/create the adapter or call validation, catalog or open");
  assert.deepEqual(piWorker, [], "Main prompts don't open a Pi worker either");

  const control = (...args: string[]) => run(process.execPath, [cli, ...args]);
  const launch = async (title: string, fields: object) => {
    const id = `main_${++nextId}`;
    const args = { kind: "notes", title, task: "Examine the fixture notes", ...fields };
    outbound = { type: "toolCall", id, name: "worq_spawn", arguments: structuredClone(args) };
    await session.prompt(`Script a spawn: ${title}`);
    const messages = sessionManager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : []);
    const calls = messages.flatMap(m => m.role === "assistant" ? m.content : []);
    assert.deepEqual(calls.find(call => call.type === "toolCall" && call.id === id), { type: "toolCall", id, name: "worq_spawn", arguments: args });
    const result = messages.find(m => m.role === "toolResult" && m.toolCallId === id);
    assert.ok(result?.role === "toolResult");
    return result;
  };
  const assertLaunch = async (title: string, fields: object, expected: { sdk: string; model: string; thinking: string }) => {
    const result = await launch(title, fields);
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const { ref } = result.details as { ref: string };
    const end = Date.now() + 5000;
    let status: string;
    do {
      ({ stdout: status } = await control("list", ref));
      if (/^.* · done$/m.test(status)) break;
      assert.doesNotMatch(status, /^.* · failed$/m);
      await sleep(10);
    } while (Date.now() < end);
    assert.match(status, /^.* · done$/m);
    const record = /^agent\.notes: (\{.*\})/m.exec(status);
    assert.ok(record, status);
    const { sdk, model, thinking } = JSON.parse(record[1]);
    assert.deepEqual({ sdk, model, thinking }, expected);
  };
  const mainSelection = { model: `${main.provider}/${main.id}`, thinking: "medium" };
  await assertLaunch("Listed choice", chosen, chosen);
  const explicit = { sdk: "echo", model: "e/outside", thinking: "low" };
  await assertLaunch("User choice", explicit, explicit);
  await assertLaunch("Hinted default", {}, { sdk: "echo", model: "e/hinted", thinking: "low" });
  await rm(hints);
  await assertLaunch("Main default", {}, { sdk: "pi", ...mainSelection });
  const unavailable = await launch("Unavailable choice", { sdk: "echo", model: "Bogus", thinking: "low" });
  assert.equal(unavailable.isError, true);
  assert.match(JSON.stringify(unavailable.content), /echo: unknown model Bogus/);
  assert.deepEqual(piWorker, [mainSelection], "real Pi worker request inherits the live Main runtime");
  const calls = globals[key] as Calls | undefined;
  assert.ok(calls);
  assert.deepEqual(calls.open.map(({ id, model, thinking }) => ({ sdk: id, model, thinking })), [
    chosen, explicit, { sdk: "echo", model: "e/hinted", thinking: "low" },
  ]);
  assert.ok(calls.validate.includes("Bogus"));
  assert.equal(calls.models, 0);
  assert.ok(prompts.every(({ model, thinking }) => model === mainSelection.model && thinking === mainSelection.thinking));
  assert.equal(session.model?.id, main.id);
  assert.equal(session.thinkingLevel, "medium");
});

test("CLI compatibility: legacy syntax sends the legacy wire shape; new-only requests to an old host get an upgrade hint, never a retry", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "worq-old-host-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  // The previous release's strict spawn schema.
  const old = obj({ kind: literals(["plan", "execute"] as const), task: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }), attach: Type.Optional(Type.Array(Type.String())), verify: Type.Optional(Type.Boolean()) });
  const received: unknown[] = [];
  const socket = await serve(state, async (op, args) => {
    received.push(args);
    parse(old, args, op);
    return { text: "Spawned on the old host", data: { ref: "old-ref" } };
  });
  t.after(() => socket.close());
  const env = { ...process.env, WORQ_STATE_DIR: state };
  const legacy = await run(process.execPath, [cli, "spawn", "plan", "--title", "Old style", "--attach", "x-y", "--", "do", "it"], { env });
  assert.match(legacy.stdout, /old host/);
  assert.deepEqual(received.at(-1), { kind: "plan", title: "Old style", attach: ["x-y"], task: "do it" });
  for (const args of [["spawn", "plan", "do it"], ["spawn", "plan", "--title", "New style", "--model", "p/m", "do it"]]) {
    const before = received.length;
    await assert.rejects(run(process.execPath, [cli, ...args], { env }), (error: { stderr: string }) =>
      /spawn: \//.test(error.stderr) && /older than this CLI[\s\S]*worq spawn <kind> --title/.test(error.stderr));
    assert.equal(received.length, before + 1, "one request, no replay");
  }
});
