import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { Block, obj, text } from "../src/contracts.ts";
import { resolveRuntime } from "../src/runtime/launch.ts";
import { EMPTY } from "../src/runtime/resources.ts";
import {
  antigravityAdapter,
  mainAntigravityModel,
  workerEnv,
  type AntigravityAcpProcess,
  type AntigravitySdk,
} from "../src/sdk/antigravity.ts";
import type { Capabilities, Driver, Runtime, SessionSpec, Tool } from "../src/sdk/contract.ts";
import { createDriver } from "../src/sdk/registry.ts";
import { adapterConformance } from "./conformance-suite.ts";
import { FULL_CAPS, type FakeOptions, type Script, type Turn } from "./fake.ts";

const DEFAULT_MODEL = "gemini-4-neon";
const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const runtime: Runtime = { name: "launch", sdk: "antigravity", model: DEFAULT_MODEL, thinking: "medium", path: "", via: "launch request" };
const tools = (): Tool[] => [
  { name: "echo", description: "Echo.", parameters: obj({ value: text(20) }), run: () => ({ text: "ok", image: { mimeType: "image/png", data: "aGk=" } }) },
  { name: "strict", description: "Strict.", parameters: obj({ n: Type.Integer() }), run: () => "ok" },
  { name: "boom", description: "Boom.", parameters: obj({}), run: () => { throw new Block("boom", "boom"); } },
];

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

interface Captured {
  system: string;
  mcpServers: unknown;
  configUpdates: { configId: string; value: string }[];
  permissionReplies: { title: string; outcome: unknown }[];
  aborts: number;
  closed: number;
  mcpClosed: number;
  spec?: SessionSpec;
}

interface Overrides {
  appendSupported?: boolean;
  eofAtStartup?: boolean;
  authError?: boolean;
  models?: readonly string[];
  probePermissions?: string[];
}

function fakeSdk(record: FakeOptions = {}, overrides: Overrides = {}) {
  const captured: Captured = { system: "", mcpServers: undefined, configUpdates: [], permissionReplies: [], aborts: 0, closed: 0, mcpClosed: 0 };
  let dispatchTool!: (tool: Tool, args: unknown, signal: AbortSignal) => Promise<{ text: string; image?: { mimeType: string; data: string }; isError?: boolean }>;
  let registeredTools = new Map<string, Tool>();

  const sdk: AntigravitySdk = {
    ...(overrides.models ? { listModels: async () => overrides.models! } : {}),
    async createMcpServer(list, dispatch) {
      registeredTools = new Map(list.map((t) => [t.name, t]));
      dispatchTool = dispatch;
      return {
        url: "http://127.0.0.1:41234/mcp",
        token: "test-token",
        close() { captured.mcpClosed++; },
      };
    },
    spawn() {
      return fakeAcpProcess(captured, record, overrides, () => registeredTools, () => dispatchTool);
    },
  };
  return { sdk, captured };
}

function fakeAcpProcess(
  captured: Captured,
  record: FakeOptions,
  overrides: Overrides,
  getTools: () => Map<string, Tool>,
  getDispatch: () => (tool: Tool, args: unknown, signal: AbortSignal) => Promise<{ text: string; image?: { mimeType: string; data: string }; isError?: boolean }>,
): AntigravityAcpProcess {
  const queue: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let activePromptRpcId: number | undefined;
  let aborted = false;
  let permId = 1000;
  const pendingPerms = new Map<number, (result: unknown) => void>();

  const push = (msg: Record<string, unknown>) => {
    if (ended) return;
    queue.push(msg);
    wake?.();
    wake = undefined;
  };
  const end = () => {
    if (ended) return;
    ended = true;
    wake?.();
    wake = undefined;
  };

  const askPermission = (title: string) => new Promise<unknown>((resolve) => {
    const id = ++permId;
    pendingPerms.set(id, resolve);
    push({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "acp-sess-1",
        toolCall: { title },
        options: [
          { optionId: "allow-1", kind: "allow_once", name: "Allow" },
          { optionId: "deny-1", kind: "reject_once", name: "Deny" },
        ],
      },
    });
  });

  const runPrompt = async (rpcId: number, promptText: string) => {
    activePromptRpcId = rpcId;
    aborted = false;
    if (overrides.authError) {
      push({ jsonrpc: "2.0", id: rpcId, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    if (promptText.startsWith("fail")) {
      push({ jsonrpc: "2.0", id: rpcId, error: { code: -32603, message: "Model error" } });
      return;
    }
    if (overrides.probePermissions?.length) {
      for (const title of overrides.probePermissions) {
        const res = await askPermission(title) as { outcome?: unknown };
        captured.permissionReplies.push({ title, outcome: res?.outcome });
      }
    }
    push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } } } });
    const turn: Turn = {
      spec: captured.spec!,
      text: promptText,
      system: captured.system,
      steered: [],
      async tool(name, params) {
        if (aborted || ended) return "stopped";
        const tool = getTools().get(name);
        if (!tool) return `No tool ${name}`;
        const reply = await getDispatch()(tool, params, new AbortController().signal);
        if (reply.image) record.images?.push(reply.image);
        return reply.text;
      },
      async admit() { return true; },
    };
    try {
      const work = adapterScript(turn);
      if (promptText !== "hang") await work;
    } catch { /* stopped */ }
    if (!aborted && promptText !== "hang") {
      activePromptRpcId = undefined;
      push({ jsonrpc: "2.0", id: rpcId, result: { stopReason: "end_turn" } });
    }
  };

  return {
    messages: (async function* () {
      for (;;) {
        if (!queue.length) {
          if (ended) return;
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        yield queue.shift()!;
      }
    })(),
    send(msg) {
      if (msg.id !== undefined && msg.method === undefined) {
        const resolve = pendingPerms.get(Number(msg.id));
        if (resolve) {
          pendingPerms.delete(Number(msg.id));
          resolve(msg.result);
        }
        return;
      }
      const method = String(msg.method ?? "");
      const id = msg.id as number | undefined;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (method === "initialize") {
        if (overrides.eofAtStartup) { end(); return; }
        push({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              mcpCapabilities: { http: true },
              _meta: { antigravity: { systemPrompt: { append: overrides.appendSupported ?? true } } },
            },
          },
        });
      } else if (method === "session/new") {
        captured.mcpServers = params.mcpServers;
        const meta = (params._meta as Record<string, Record<string, Record<string, string>>> | undefined)?.antigravity?.systemPrompt;
        captured.system = meta?.append ?? "";
        push({
          jsonrpc: "2.0",
          id,
          result: {
            sessionId: "acp-sess-1",
            configOptions: [
              { id: "model", currentValue: "gemini-4-neon" },
              { id: "thought_level", currentValue: "high" },
            ],
          },
        });
        push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-sess-1", update: { sessionUpdate: "usage_update", used: 0, size: 1048576 } } });
      } else if (method === "session/set_config_option") {
        captured.configUpdates.push({ configId: String(params.configId), value: String(params.value) });
        push({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "session/prompt" && id !== undefined) {
        const blocks = (params.prompt as { text?: string }[] | undefined) ?? [];
        void runPrompt(id, blocks[0]?.text ?? "");
      } else if (method === "session/cancel") {
        captured.aborts++;
        aborted = true;
        if (record.aborts) record.aborts.n++;
        if (activePromptRpcId !== undefined) {
          const rid = activePromptRpcId;
          activePromptRpcId = undefined;
          push({ jsonrpc: "2.0", id: rid, result: { stopReason: "cancelled" } });
        }
      }
    },
    close() {
      captured.closed++;
      end();
    },
  };
}

function driverFor(caps: Capabilities, record: FakeOptions, overrides: Overrides = {}): Driver {
  const { sdk, captured } = fakeSdk(record, overrides);
  const adapter = antigravityAdapter({}, sdk);
  return {
    capabilities: () => caps,
    async open(spec) {
      const full: SessionSpec = { ...spec, runtime };
      captured.spec = full;
      const handle = await adapter.open({
        ...full,
        emit(event) {
          if (event.type === "tool-error") record.toolErrors?.push({ name: event.name, message: event.message });
          spec.emit(event);
        },
      });
      return {
        prompt(text, signal) {
          record.prompts?.push(text);
          return handle.prompt(text, signal);
        },
        get streaming() { return handle.streaming; },
        abort: () => handle.abort(),
        dispose: () => handle.dispose(),
      };
    },
  };
}

test("antigravity ACP adapter passes the full shared conformance suite", async () => {
  const options: FakeOptions = { aborts: { n: 0 }, images: [], toolErrors: [], prompts: [], steer: "none" };
  const full: Capabilities = { ...FULL_CAPS, switchModel: true, thinking: THINKING_LEVELS, context: { system: "append", ambientInstructions: false } };
  const make = (caps: Capabilities) => driverFor(caps, options);
  await adapterConformance("antigravity", make, options, full, true);
});

test("antigravity: Main inheritance, validation, models catalog, and live configure()", async () => {
  assert.equal(mainAntigravityModel({ model: "google-antigravity/gemini-4-neon" }), "gemini-4-neon");
  assert.equal(mainAntigravityModel({ model: "google-antigravity/claude-opus-5-5" }), "claude-opus-5-5");
  assert.equal(mainAntigravityModel({ model: "google/gemini-3.8-flash" }), "gemini-3.8-flash");
  assert.equal(mainAntigravityModel({ model: "anthropic/claude-sonnet-4-5" }), undefined);

  const { sdk, captured } = fakeSdk({}, { models: ["gemini-4-neon", "claude-opus-5-5"] });
  const adapter = antigravityAdapter({ main: () => ({ model: "google-antigravity/gemini-4-carbon", thinking: "high" }) }, sdk);
  assert.equal(adapter.defaultModel?.(), "gemini-4-carbon");
  assert.equal(adapter.defaultThinking?.(), "high");
  assert.deepEqual(await adapter.models(), ["gemini-4-neon", "claude-opus-5-5"]);

  const driver = await createDriver({}, EMPTY, { antigravity: { load: async () => adapter } });
  const signal = new AbortController().signal;
  assert.deepEqual(await resolveRuntime(driver, { sdk: "antigravity" }, signal), {
    name: "launch", sdk: "antigravity", path: "", via: "launch request", model: "gemini-4-carbon", thinking: "high",
  });
  await assert.rejects(resolveRuntime(driver, { sdk: "antigravity", model: "invalid_model!" }, signal), (e: unknown) =>
    e instanceof Block && e.code === "model");
  await assert.rejects(resolveRuntime(driver, { sdk: "antigravity", thinking: "max" }, signal), (e: unknown) =>
    e instanceof Block && e.code === "capability");

  // Live model & thinking switch via ACP session/set_config_option.
  const handle = await adapter.open({
    id: "sess-cfg", name: "agent.plan", cwd: process.cwd(), runtime, thinking: "medium",
    system: "SYS", tools: tools(), emit() {}, signal,
  });
  await handle.configure?.({ model: "claude-opus-5-5", thinking: "xhigh" });
  assert.deepEqual(handle.selection, { model: "claude-opus-5-5", thinking: "xhigh" });
  assert.ok(captured.configUpdates.some((u) => u.configId === "model" && u.value === "claude-opus-5-5"));
  assert.ok(captured.configUpdates.some((u) => u.configId === "thought_level" && u.value === "xhigh"));
  handle.dispose();
  assert.equal(captured.mcpClosed, 1);
});

test("antigravity: permission gate allows Worq MCP tools and denies built-in agy tools", async () => {
  const { sdk, captured } = fakeSdk({}, { probePermissions: ["mcp__worq__echo", "run_command", "write_to_file"] });
  const spec: SessionSpec = {
    id: "sess-perm", name: "agent.plan", cwd: process.cwd(), runtime, thinking: "medium",
    system: "SYS", tools: tools(), emit() {}, signal: new AbortController().signal,
  };
  captured.spec = spec;
  const handle = await antigravityAdapter({}, sdk).open(spec);
  assert.equal(await handle.prompt("submit"), "completed");
  assert.deepEqual(captured.permissionReplies, [
    { title: "mcp__worq__echo", outcome: { outcome: "selected", optionId: "allow-1" } },
    { title: "run_command", outcome: { outcome: "selected", optionId: "deny-1" } },
    { title: "write_to_file", outcome: { outcome: "selected", optionId: "deny-1" } },
  ]);
  handle.dispose();
});

test("antigravity: workerEnv preserves OAuth/XDG vars and strips unrelated provider keys", () => {
  const env = workerEnv({
    PATH: "/usr/bin",
    HOME: "/home/user",
    XDG_CONFIG_HOME: "/home/user/.config",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    ANTIGRAVITY_CLI: "/usr/local/bin/agy",
    ANTHROPIC_API_KEY: "should-strip",
    OPENAI_API_KEY: "should-strip",
    AWS_PROFILE: "prod",
  });
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.XDG_CONFIG_HOME, "/home/user/.config");
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(env.ANTIGRAVITY_CLI, "/usr/local/bin/agy");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_PROFILE, undefined);
});

test("antigravity: startup capability refusal, auth preflight-failed, and missing CLI isolation", async () => {
  const spec = (signal = new AbortController().signal): SessionSpec => ({
    id: "sess-err", name: "agent.plan", cwd: process.cwd(), runtime, thinking: "medium",
    system: "SYS", tools: tools(), emit() {}, signal,
  });

  {
    const { sdk } = fakeSdk({}, { appendSupported: false });
    await assert.rejects(antigravityAdapter({}, sdk).open(spec()), (e: unknown) => e instanceof Block && e.code === "capability");
  }
  {
    const { sdk } = fakeSdk({}, { eofAtStartup: true });
    await assert.rejects(antigravityAdapter({}, sdk).open(spec()), (e: unknown) => e instanceof Block && e.code === "sdk-error");
  }
  {
    const { sdk } = fakeSdk({}, { authError: true });
    const handle = await antigravityAdapter({}, sdk).open(spec());
    assert.equal(await handle.prompt("submit"), "preflight-failed");
    handle.dispose();
  }

  const prev = process.env.ANTIGRAVITY_CLI;
  process.env.ANTIGRAVITY_CLI = "/nonexistent/agy-binary-for-test";
  try {
    const adapter = antigravityAdapter({});
    await assert.rejects(adapter.models(), (e: unknown) => e instanceof Block && e.code === "sdk");
    await assert.rejects(async () => adapter.validateRuntime(runtime, new AbortController().signal), (e: unknown) => e instanceof Block && e.code === "sdk");
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_CLI;
    else process.env.ANTIGRAVITY_CLI = prev;
  }
});
