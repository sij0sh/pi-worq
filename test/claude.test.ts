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

interface Captured { options: Record<string, unknown>; tools: ClaudeServerTool[]; handlers: Map<string, ClaudeServerTool["handler"]>; queries: number; spec?: SessionSpec }
interface Overrides { policy?: ClaudeSdk["resolveSettings"]; modelAfter?: string; failApply?: boolean }

/** A deterministic SDK seam: production adapter code, fake worker stream. */
function fakeSdk(record: FakeOptions = {}, overrides: Overrides = {}) {
  const captured: Captured = { options: {}, tools: [], handlers: new Map(), queries: 0 };
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
  let steered: string[] | undefined;
  const queue = {
    push(message: ClaudeMessage) { if (ended) return; messages.push(message); wake?.(); wake = undefined; },
    end() { ended = true; wake?.(); wake = undefined; },
  };
  const allowed = Array.isArray(options.allowedTools) ? options.allowedTools.map(String) : [];
  const init: ClaudeMessage = {
    type: "system", subtype: "init", model, effort: options.effort, tools: allowed,
    mcp_servers: [{ name: "worq", status: "connected" }], skills: [], slash_commands: [],
    plugins: [{ name: "builtin", path: "builtin" }], permissionMode: "dontAsk",
  };
  const turn = (prompt: string): Turn => ({
    spec: captured.spec!, text: prompt, system: String(options.systemPrompt), steered: steered ?? [],
    async tool(name, params) {
      const handler = captured.handlers.get(name);
      const id = `tool_${++toolNo}`;
      queue.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: params }] } });
      if (!handler) return `No tool ${name}`;
      try {
        const result = await handler(params, { signal: options.abortController instanceof AbortController ? options.abortController.signal : undefined }) as { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
        const content = result.content ?? [];
        for (const block of content) if (block.type === "image" && block.data && block.mimeType) record.images?.push({ mimeType: block.mimeType, data: block.data });
        return content.flatMap((block) => block.type === "text" ? [block.text ?? ""] : []).join(" ");
      } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
    },
    async admit() { return true; },
  });
  const pending: string[] = [];
  let promptWake: (() => void) | undefined;
  // The reader keeps consuming while a script runs, so `priority: "now"` input joins the active turn.
  void (async () => {
    for await (const raw of input) {
      const message = raw as { message?: { content?: { text?: string }[] }; priority?: string };
      const prompt = message.message?.content?.[0]?.text ?? "";
      if (message.priority === "now" && steered) { steered.push(prompt); continue; }
      pending.push(prompt);
      promptWake?.(); promptWake = undefined;
    }
  })().catch(() => {});
  void (async () => {
    for (;;) {
      if (!pending.length) await new Promise<void>((resolve) => { promptWake = resolve; });
      const prompt = pending.shift();
      if (prompt === undefined) return;
      if (prompt.startsWith("fail")) { queue.push({ type: "result", subtype: "error_during_execution", is_error: true }); continue; }
      aborted = false;
      steered = [];
      queue.push({ type: "stream_event", event: { type: "message_start" } });
      try { await adapterScript(turn(prompt)); } catch { /* an adapter refusal ends the turn */ }
      while (steered?.length) { const next = steered.shift()!; try { await adapterScript(turn(next)); } catch { /* same */ } }
      steered = undefined;
      if (!aborted) queue.push({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    }
  })().catch(() => {});
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        yield init;
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
    close() { queue.end(); },
    async applyFlagSettings(settings) {
      if (overrides.failApply) throw new Error("settings merge refused");
      if (settings.model !== undefined) model = String(settings.model);
    },
    async getContextUsage() { return { model: overrides.modelAfter ?? model, percentage: 12, raw_max_tokens: 200_000 }; },
    async supportedModels() { return [{ value: "claude-sonnet-4-5", resolvedModel: "claude-sonnet-4-5" }, { value: "claude-opus-4-1", resolvedModel: "claude-opus-4-1" }]; },
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
        async steer(text) { return handle.steer?.(text); },
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
  const options: FakeOptions = { images: [], toolErrors: [], prompts: [], aborts: { n: 0 }, calls: { n: 0 }, requests: { n: 0 }, earlyTerminate: true };
  const full: Capabilities = { ...FULL_CAPS, requestAdmission: "awaited" };
  const make = (caps: Capabilities): Driver => driverFor(fakeSdk(options).sdk, options, caps);
  await adapterConformance("claude-code", make, options, full, true);
});

test("claude: options keep the worker isolated and only Worq tools", async () => {
  const { sdk, captured } = fakeSdk();
  const adapter = claudeAdapter({ main: () => ({ model: "anthropic/claude-sonnet-4-5" }) }, sdk);
  const handle = await adapter.open({ id: "x", name: "x", cwd: process.cwd(), system: "S", tools: tools(), runtime, emit() {}, signal: new AbortController().signal });
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
  for (const key of ["hooks", "env", "permissions", "plugins", "model"]) {
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
