import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { Block, obj, text } from "../src/contracts.ts";
import type { Capabilities, Driver, Runtime, SessionSpec, Tool } from "../src/sdk/contract.ts";
import { claudeAdapter, workerEnv, type ClaudeMessage, type ClaudeQuery, type ClaudeSdk, type ClaudeServerTool } from "../src/sdk/claude.ts";
import { Conversation } from "../src/session.ts";
import { FULL_CAPS, type FakeOptions, type Script, type Turn } from "./fake.ts";
import { adapterConformance } from "./conformance-suite.ts";

const runtime: Runtime = { name: "launch", sdk: "claude-code", model: "claude-sonnet-4-5", path: "", via: "launch request" };
const finish = { description: "Submit.", schema: obj({ value: text(200) }) };
const tools = (): Tool[] => [
  { name: "echo", description: "Echo.", parameters: obj({ value: text(20) }), run: () => ({ text: "ok", image: { mimeType: "image/png", data: "aGk=" } }) },
  { name: "strict", description: "Strict.", parameters: obj({ n: Type.Integer() }), run: () => "ok" },
  { name: "boom", description: "Boom.", parameters: obj({}), run: () => { throw new Block("boom", "boom"); } },
];

/** The same scripted conversation the shared suite uses, with a real MCP round trip per tool call. */
const adapterScript: Script = async (turn) => {
  const { text: prompt } = turn;
  if (prompt === "tools") {
    await turn.tool("echo", { value: "hi" });
    await turn.tool("echo", { bad: 1 });
    await turn.tool("strict", { n: "no" });
    await turn.tool("boom", {});
    await turn.tool("submit", { value: "tools" });
    return;
  }
  if (prompt.startsWith("Your submit call was rejected")) { await turn.tool("submit", { value: "" }); return; }
  if (prompt === "reject") { await turn.tool("submit", { value: "" }); return; }
  if (prompt === "refuse") return;
  if (prompt === "submit") { await turn.tool("submit", { value: "one" }); return; }
  if (prompt === "submit-two") { await turn.tool("submit", { value: "two" }); return; }
  if (prompt === "hang") return new Promise(() => {});
  if (prompt === "hang-after-submit") { await turn.tool("submit", { value: "kept" }); return new Promise(() => {}); }
  if (prompt === "race") { await turn.tool("submit", { value: "raced" }); await sleep(300); return; }
  if (prompt === "slow") { await sleep(30); await turn.tool("submit", { value: "slow" }); return; }
  if (prompt === "wait") { await sleep(80); return; }
  if (prompt === "main") { await turn.tool("submit", { value: "ok" }); return; }
  if (prompt === "context") { await turn.tool("submit", { value: turn.system }); return; }
  if (prompt === "id") { await turn.tool("submit", { value: turn.spec.id }); return; }
};

interface Captured { options: Record<string, unknown>; tools: ClaudeServerTool[]; handlers: Map<string, ClaudeServerTool["handler"]>; queries: number; spec?: SessionSpec; closed: number; inputs: number; controls: string[] }
interface Overrides {
  policy?: ClaudeSdk["resolveSettings"]; modelAfter?: string; failApply?: boolean;
  init?: () => Promise<unknown>; mcp?: () => Promise<unknown>; usage?: () => Promise<unknown>; catalog?: () => Promise<unknown>;
  eof?: boolean; startupResult?: ClaudeMessage; rejectPromptHook?: boolean;
}
const rows = [
  { value: "default", resolvedModel: "claude-opus-4-1" }, { value: "opus", resolvedModel: "claude-opus-4-1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-4-5" }, { value: "claude-sonnet-4-5", resolvedModel: "claude-sonnet-4-5" },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6" }, { value: "claude-sonnet-4-6[1m]", resolvedModel: "claude-sonnet-4-6" },
  { value: "claude-sonnet-4-9[1m]", resolvedModel: "claude-sonnet-4-9" }, { value: "claude-bad", resolvedModel: "claude-unrelated" },
];

/** A deterministic SDK seam: production adapter code, fake worker stream. */
function fakeSdk(record: FakeOptions = {}, overrides: Overrides = {}) {
  const captured: Captured = { options: {}, tools: [], handlers: new Map(), queries: 0, closed: 0, inputs: 0, controls: [] };
  const sdk: ClaudeSdk & { captured?: Captured } = {
    resolveSettings: overrides.policy ?? (async () => ({ sources: [], machinePolicy: { didNotLoad: false } })),
    createServer(options) {
      captured.tools = options.tools;
      for (const tool of options.tools) captured.handlers.set(tool.name, tool.handler);
      return { type: "sdk", name: options.name, tools: options.tools };
    },
    query({ prompt, options }) {
      captured.queries++;
      captured.options = options;
      return fakeQuery(prompt, options, captured, record, overrides);
    },
  };
  sdk.captured = captured;
  return { sdk, captured };
}

function fakeQuery(input: AsyncIterable<unknown>, options: Record<string, unknown>, captured: Captured, record: FakeOptions, overrides: Overrides): ClaudeQuery {
  const messages: ClaudeMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let model = String(options.model);
  let aborted = false;
  let toolNo = 0;
  let responseId = 0;
  const queue = {
    push(message: ClaudeMessage) { if (ended) return; messages.push(message); wake?.(); wake = undefined; },
    end() { ended = true; wake?.(); wake = undefined; },
  };
  const allowed = Array.isArray(options.allowedTools) ? options.allowedTools.map(String) : [];
  const modelId = () => rows.find((row) => row.value === model)?.resolvedModel ?? model.replace(/\[1m\]$/, "");
  const emitStream = (event: object, parent_tool_use_id: string | null = null) => queue.push({ type: "stream_event", event, parent_tool_use_id });
  const gate = async (event: string, data: object = {}) => {
    const hooks = options.hooks as Record<string, { onFailure: string; hooks: ((input: object, id: undefined, opts: { signal: AbortSignal }) => Promise<{ continue?: boolean }>)[] }[]>;
    assert.equal(hooks[event][0].onFailure, "block");
    return (await hooks[event][0].hooks[0]({ hook_event_name: event, permission_mode: "dontAsk", session_id: "fake-worker", prompt_id: `prompt${captured.inputs}`, ...data }, undefined,
      { signal: new AbortController().signal })).continue !== false;
  };
  const turn = (prompt: string): Turn => ({
    spec: captured.spec!, text: prompt, system: String(options.systemPrompt), steered: [],
    async tool(name, params) {
      if (aborted || ended) return "stopped";
      const handler = captured.handlers.get(name);
      const id = `tool_${++toolNo}`;
      if (!handler) return `No tool ${name}`;
      const result = await handler(params, { signal: options.abortController instanceof AbortController ? options.abortController.signal : undefined }) as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
      const content = result.content ?? [];
      for (const block of content) if (block.type === "image" && block.data && block.mimeType) record.images?.push({ mimeType: block.mimeType, data: block.data });
      if (!(await gate("PostToolBatch", { tool_calls: [{ tool_use_id: id, tool_name: name }] }))) throw new Error("stop verdict");
      return content.flatMap((block) => block.type === "text" ? [block.text ?? ""] : []).join(" ");
    },
    async admit() { return true; },
  });
  const pending: string[] = [];
  let promptWake: (() => void) | undefined;
  let inputEnded = false;
  void (async () => {
    for await (const raw of input) {
      captured.inputs++;
      const message = raw as { message?: { content?: { text?: string }[] } };
      pending.push(message.message?.content?.[0]?.text ?? "");
      promptWake?.(); promptWake = undefined;
    }
  })().finally(() => { inputEnded = true; promptWake?.(); }).catch(() => {});
  void (async () => {
    while (!inputEnded) {
      if (!pending.length) await new Promise<void>((resolve) => { promptWake = resolve; });
      const prompt = pending.shift();
      if (prompt === undefined) return;
      if (!(await gate("UserPromptSubmit", { prompt: overrides.rejectPromptHook ? "wrong prompt" : prompt }))) {
        queue.push({ type: "result", subtype: "success", is_error: false }); continue;
      }
      queue.push({ type: "system", subtype: "init", model: modelId(), tools: allowed,
        mcp_servers: [{ name: "worq", source: "sdk", status: "connected" }], skills: [], slash_commands: [], plugins: [], permissionMode: "dontAsk" });
      if (prompt.startsWith("fail")) { queue.push({ type: "result", subtype: "error_during_execution", is_error: true }); continue; }
      aborted = false;
      const start = { type: "message_start", message: { id: `test${++responseId}`, usage: { input_tokens: 8, cache_read_input_tokens: 2 } } };
      emitStream(start);
      emitStream(start);
      emitStream({ ...start, message: { id: "subagent" } }, "subagent");
      if (prompt !== "hang") {
        emitStream({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } });
        emitStream({ type: "message_stop" });
        emitStream({ type: "message_stop" });
      }
      try {
        const work = adapterScript(turn(prompt));
        if (prompt !== "hang") await work; // An interrupt supplies the only result for the hanging script.
      } catch { /* A stop verdict ends the turn, with the same native success result. */ }
      if (!aborted && prompt !== "hang") queue.push({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 999, output_tokens: 999 } });
    }
  })().catch(() => {});
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        if (overrides.startupResult) yield overrides.startupResult;
        if (overrides.eof) return;
        for (;;) {
          if (!messages.length) {
            if (ended) return;
            await new Promise<void>((resolve) => { wake = resolve; });
          }
          const next = messages.shift();
          if (!next) return;
          yield next;
        }
      })();
    },
    async interrupt() {
      aborted = true;
      queue.push({ type: "result", subtype: "error_during_execution", is_error: true });
      return {};
    },
    close() { captured.closed++; queue.end(); },
    async initializationResult() {
      captured.controls.push("init");
      return overrides.init ? overrides.init() : { hooks_applied: true, hook_on_failure_supported: true, current_permission_mode: "dontAsk", commands: [], models: rows };
    },
    async mcpServerStatus() {
      captured.controls.push("mcp");
      return overrides.mcp ? overrides.mcp() : [{ name: "worq", source: "sdk", status: "connected", tools: captured.tools.map(({ name }) => ({ name })) }];
    },
    async applyFlagSettings(settings) {
      if (overrides.failApply) throw new Error("settings merge refused");
      if (settings.model !== undefined) model = String(settings.model);
    },
    async getContextUsage({ detail }) {
      assert.equal(detail, "summary");
      captured.controls.push("summary");
      return overrides.usage ? overrides.usage() : { model: overrides.modelAfter ?? modelId(), memoryFiles: [], agents: [], percentage: 12, rawMaxTokens: model === "claude-sonnet-4-6[1m]" ? 1_000_000 : 200_000 };
    },
    async supportedModels() { return overrides.catalog ? overrides.catalog() : rows; },
  };
}

/** The production adapter behind a Driver wrapper that records the suite's observations. */
function driverFor(sdk: ClaudeSdk, record: FakeOptions, caps?: Capabilities): Driver {
  const adapter = claudeAdapter({ main: () => ({ model: "anthropic/claude-sonnet-4-5" }) }, sdk);
  return {
    capabilities: () => caps ?? adapter.capabilities(runtime),
    async open(spec) {
      const resolved: SessionSpec = { ...spec, runtime: spec.runtime ?? runtime };
      const captured = (sdk as ClaudeSdk & { captured?: Captured }).captured;
      if (captured) captured.spec = resolved;
      const admit = resolved.admitRequest;
      const handle = await adapter.open({
        ...resolved,
        emit: (event) => {
          if (event.type === "tool-error") record.toolErrors?.push({ name: event.name, message: event.message });
          resolved.emit(event);
        },
        ...(admit ? { admitRequest: async (signal) => { const decision = await admit(signal); if (decision.allowed) record.requests && (record.requests.n++); return decision; } } : {}),
      });
      return {
        ...handle,
        async prompt(prompt, signal) {
          record.calls && (record.calls.n++);
          record.prompts?.push(prompt);
          return handle.prompt(prompt, signal);
        },
        async abort() { record.aborts && (record.aborts.n++); return handle.abort(); },
        get streaming() { return handle.streaming; },
        get selection() { return handle.selection; },
        async configure(change) { return handle.configure?.(change); },
        dispose() { handle.dispose(); },
      };
    },
  };
}

function conversation(driver: Driver, extra: { turns?: number; minutes?: number; system?: string; tools?: Tool[] } = {}) {
  return new Conversation({
    driver, signal: new AbortController().signal, turns: extra.turns ?? 12, minutes: extra.minutes ?? 1, finish,
    spec: { name: "x", cwd: process.cwd(), system: extra.system ?? "SYSTEM", tools: extra.tools ?? tools(), log() {} },
  });
}

test("claude: production adapter passes the shared conformance suite (MINIMAL and FULL)", async () => {
  const options: FakeOptions = { images: [], toolErrors: [], prompts: [], aborts: { n: 0 }, calls: { n: 0 }, requests: { n: 0 }, earlyTerminate: true, steer: "none" };
  const full: Capabilities = { ...FULL_CAPS, requestAdmission: "awaited" };
  const make = (caps: Capabilities): Driver => driverFor(fakeSdk(options).sdk, options, caps);
  await adapterConformance("claude-code", make, options, full, true);
});

test("claude: options keep the worker isolated and only Worq tools", async () => {
  const { sdk, captured } = fakeSdk();
  const adapter = claudeAdapter({ main: () => ({ model: "anthropic/claude-sonnet-4-5" }) }, sdk);
  const handle = await adapter.open({ id: "x", name: "x", cwd: process.cwd(), system: "S", tools: tools(), runtime, emit() {}, signal: new AbortController().signal });
  assert.deepEqual(captured.controls, ["init", "mcp", "summary"]);
  assert.equal(captured.inputs, 0);
  assert.deepEqual(captured.options.settingSources, []);
  assert.deepEqual(captured.options.tools, []);
  assert.equal(captured.options.strictMcpConfig, true);
  assert.equal(captured.options.permissionMode, "dontAsk");
  assert.equal(captured.options.persistSession, false);
  assert.deepEqual(captured.options.allowedTools, ["mcp__worq__echo", "mcp__worq__strict", "mcp__worq__boom"]);
  assert.equal((captured.options.settings as Record<string, unknown>).autoCompactEnabled, false);
  assert.equal((captured.options.extraArgs as Record<string, unknown>)["disable-slash-commands"], null);
  assert.deepEqual(captured.tools.map((tool) => tool.name), ["echo", "strict", "boom"]);
  assert.deepEqual(captured.tools.find((tool) => tool.name === "echo")?.inputSchema, tools()[0].parameters, "the MCP schema is the TypeBox schema, unchanged");
  handle.dispose();
});

test("claude: managed policy that can add behavior refuses before a worker starts", async () => {
  for (const key of ["hooks", "env", "permissions", "plugins", "model", "disableAllHooks", "claudeMd", "agent", "managedMcpServers", "allowManagedHooksOnly"]) {
    const { sdk, captured } = fakeSdk({}, { policy: async () => ({ sources: [{ source: "managed", settings: { [key]: {} } }], machinePolicy: { didNotLoad: false } }) });
    const adapter = claudeAdapter({}, sdk);
    await assert.rejects(async () => adapter.validateRuntime(runtime, new AbortController().signal), (error: unknown) => error instanceof Block && error.code === "policy", key);
    await assert.rejects(adapter.open({ id: "x", name: "x", cwd: process.cwd(), system: "S", tools: [], runtime, emit() {}, signal: new AbortController().signal }), /isolation refused/);
    assert.equal(captured.queries, 0, `${key}: no worker was started`);
  }
  const unreadable = fakeSdk({}, { policy: async () => ({ sources: [], machinePolicy: { didNotLoad: ["file"] } }) });
  await assert.rejects(async () => claudeAdapter({}, unreadable.sdk).validateRuntime(runtime, new AbortController().signal), /managed policy could not be read/);
  const noReader = { ...fakeSdk().sdk, resolveSettings: undefined as never };
  await assert.rejects(async () => claudeAdapter({}, noReader).validateRuntime(runtime, new AbortController().signal), /cannot inspect managed policy/);
});

test("claude: workerEnv keeps native identity/credentials and drops ambient behavior switches", () => {
  const env = workerEnv({
    PATH: "/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "key", ANTHROPIC_AUTH_TOKEN: "token",
    ANTHROPIC_BASE_URL: "http://evil", ANTHROPIC_MODEL: "other", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/tmp/x",
    CLAUDE_CODE_MAX_RETRIES: "99", AWS_PROFILE: "prod",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/me");
  assert.equal(env.ANTHROPIC_API_KEY, "key");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "token");
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
});

test("claude: admission runs before the first request and before each continuation; a refused continuation is not retried", async () => {
  {
    const options: FakeOptions = { requests: { n: 0 }, prompts: [] };
    const c = conversation(driverFor(fakeSdk(options).sdk, options), { turns: 4 });
    assert.deepEqual(await c.run("submit"), { value: "one" });
    assert.equal(options.requests!.n, 1, "one request, one admission");
    c.dispose();
  }
  {
    const options: FakeOptions = { requests: { n: 0 }, prompts: [] };
    const c = conversation(driverFor(fakeSdk(options).sdk, options), { turns: 1 });
    await assert.rejects(c.run("tools"), (error: unknown) => error instanceof Block && error.code === "turn-limit");
    assert.equal(options.requests!.n, 1, "the refused continuation was never released");
    assert.equal(c.streaming, false);
    assert.deepEqual(await c.run("submit"), { value: "one" }, "fresh budget reuses the same handle");
  }
});

test("claude: configure verifies the model, refuses thinking before mutation, and latches an uncertain update", async () => {
  {
    const { sdk, captured } = fakeSdk();
    const adapter = claudeAdapter({}, sdk);
    const handle = await adapter.open({ id: "x", name: "x", cwd: process.cwd(), system: "S", tools: [], runtime, emit() {}, signal: new AbortController().signal });
    await handle.configure!({ model: "claude-opus-4-1" });
    assert.equal(handle.selection?.model, "claude-opus-4-1");
    const calls = (captured.options.allowedTools as string[]).length;
    await assert.rejects(handle.configure!({ thinking: "high" }), (error: unknown) => error instanceof Block && error.code === "capability");
    assert.equal((captured.options.allowedTools as string[]).length, calls);
    handle.dispose();
  }
  {
    const { sdk } = fakeSdk({}, { modelAfter: "claude-sonnet-4-5" });
    const adapter = claudeAdapter({}, sdk);
    const handle = await adapter.open({ id: "x", name: "x", cwd: process.cwd(), system: "S", tools: [], runtime, emit() {}, signal: new AbortController().signal });
    await assert.rejects(handle.configure!({ model: "claude-opus-4-1" }), (error: unknown) => error instanceof Block && error.code === "runtime-invalidated");
    assert.equal(handle.streaming, false);
    await assert.rejects(handle.prompt("again"), (error: unknown) => error instanceof Block && error.code === "runtime-invalidated");
    handle.dispose();
  }
});

test("claude: a refused native settings merge keeps the previous verified model", async () => {
  const { sdk } = fakeSdk({}, { failApply: true });
  const adapter = claudeAdapter({}, sdk);
  const handle = await adapter.open({ id: "x", name: "x", cwd: process.cwd(), system: "S", tools: [], runtime, emit() {}, signal: new AbortController().signal });
  await assert.rejects(handle.configure!({ model: "claude-opus-4-1" }), (error: unknown) => error instanceof Block && error.code === "capability");
  assert.equal(handle.selection?.model, "claude-sonnet-4-5");
  handle.dispose();
});

const direct = (emit: SessionSpec["emit"] = () => {}, signal = new AbortController().signal): SessionSpec => ({
  id: "direct", name: "direct", cwd: process.cwd(), system: "Worq", tools: tools(), signal, runtime, emit,
});

test("claude: startup rejects malformed evidence, EOF and raw worker errors without leaking detail", async () => {
  const secret = "provider-secret";
  const cases: [Overrides, RegExp][] = [
    [{ init: async () => ({ hooks_applied: false }) }, /blocking hooks/],
    [{ mcp: async () => [{ name: "worq", source: "plugin", status: "connected", tools: [] }] }, /SDK-owned Worq/],
    [{ mcp: async () => [{ name: "worq", source: "sdk", status: "connected", tools: [{ name: "echo" }, { name: "echo" }, { name: "boom" }] }] }, /SDK-owned Worq/],
    [{ usage: async () => ({ model: runtime.model, agents: [{ agentType: "Explore", source: "project" }], memoryFiles: [] }) }, /isolated agent/],
    [{ usage: async () => ({ model: runtime.model, agents: [] }) }, /isolated agent/],
    [{ modelAfter: "claude-sonnet-4-6" }, /verify the selected model/],
    [{ init: async () => { throw new Error(secret); } }, /control initialization/],
    [{ eof: true, init: () => new Promise(() => {}) }, /stream ended during startup/],
    [{ startupResult: { type: "result", startup_failure_reason: "config_file_invalid", errors: [secret] } }, /config_file_invalid/],
    [{ startupResult: { type: "result", startup_failure_reason: secret, errors: [secret] } }, /before readiness/],
  ];
  for (const [overrides, message] of cases) {
    const { sdk, captured } = fakeSdk({}, overrides);
    await assert.rejects(claudeAdapter({}, sdk).open(direct()), (error) => error instanceof Block && message.test(error.message) && !error.message.includes(secret));
    assert.equal(captured.closed, 1);
    assert.equal(captured.inputs, 0);
  }
});

test("claude: cancelled and timed-out startup cannot publish a late handle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["cancel", "timeout"]) {
    const controller = new AbortController();
    let late!: (status: unknown) => void;
    const { sdk, captured } = fakeSdk({}, { mcp: () => new Promise((resolve) => { late = resolve; }) });
    const opening = claudeAdapter({}, sdk).open(direct(() => {}, controller.signal));
    const rejected = assert.rejects(opening, action === "cancel" ? /open cancelled/ : /startup .* Worq MCP status/);
    while (!late) await new Promise<void>((resolve) => setImmediate(resolve));
    if (action === "cancel") controller.abort(new Error("raw cancellation"));
    else t.mock.timers.tick(12_000);
    await rejected;
    late([]);
    assert.equal(captured.closed, 1);
    assert.equal(captured.inputs, 0);
  }
});

test("claude: native catalog is bounded/advisory, coalesces and preserves proved options", async () => {
  const { sdk, captured } = fakeSdk();
  const adapter = claudeAdapter({}, sdk);
  await adapter.validateRuntime(runtime, new AbortController().signal);
  assert.equal(captured.queries, 0);
  const pair = await Promise.all([adapter.models(), adapter.models()]);
  assert.deepEqual(pair[0], ["claude-opus-4-1", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]"]);
  assert.deepEqual(pair[1], pair[0]);
  assert.equal(captured.queries, 1);
  assert.equal(captured.inputs, 0);
  assert.equal(captured.closed, 1);
  const unavailable = claudeAdapter({}, fakeSdk({}, { catalog: async () => { throw new Error(); } }).sdk);
  assert.deepEqual(await unavailable.models(), ["sonnet", "opus", "haiku"]);
  const handle = await unavailable.open(direct());
  assert.equal(handle.selection?.model, runtime.model);
  handle.dispose();
});

test("claude: refused prompt cannot become success; partial and subagent streams don't affect cache", async () => {
  const blocked = claudeAdapter({}, fakeSdk({}, { rejectPromptHook: true }).sdk);
  const rejected = await blocked.open(direct());
  assert.equal(await rejected.prompt("original"), "failed", "the SDK success result does not override the hook refusal");
  rejected.dispose();
  const telemetry: import("../src/telemetry.ts").Observation[] = [];
  const handle = await claudeAdapter({}, fakeSdk().sdk).open(direct((event) => { if (event.type === "telemetry") telemetry.push(event.value); }));
  assert.equal(await handle.prompt("wait"), "completed");
  const partial = handle.prompt("hang");
  while (telemetry.filter((value) => "turn" in value).length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
  await handle.abort();
  assert.equal(await partial, "aborted");
  const samples = telemetry.flatMap((value) => "cache" in value ? [value.cache] : []);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].read, 2);
  assert.equal(samples[0].write, undefined);
  assert.ok((samples[0].speed ?? 0) > 0);
  handle.dispose();
});
