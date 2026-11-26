import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Block, errorText } from "../contracts.ts";
import type { Observation, Outcome } from "../telemetry.ts";
import type { Capabilities, Handle, PromptOutcome, Runtime, SDKAdapter, SessionEvent, SessionSpec, Tool } from "./contract.ts";
import type { HostServices } from "./registry.ts";

const execFileAsync = promisify(execFile);

type MainSelection = { model?: string; thinking?: string };
type RpcMessage = Record<string, unknown>;
type ToolDispatchResult = { text: string; image?: { mimeType: string; data: string }; isError?: boolean };
type ToolDispatcher = (tool: Tool, args: unknown, signal: AbortSignal) => Promise<ToolDispatchResult>;

export interface AntigravityMcpServer {
  readonly url: string;
  readonly token: string;
  close(): Promise<void> | void;
}

export interface AntigravityAcpProcess {
  readonly messages: AsyncIterable<RpcMessage>;
  send(message: RpcMessage): void;
  close(): Promise<void> | void;
}

/** Structural seam: unit and conformance tests inject a fake ACP process and MCP server without spawning `agy`. */
export interface AntigravitySdk {
  spawn(options: { cwd: string; env: Record<string, string> }): AntigravityAcpProcess;
  createMcpServer(tools: readonly Tool[], dispatch: ToolDispatcher): Promise<AntigravityMcpServer>;
  listModels?(env: Record<string, string>): Promise<readonly string[]>;
}

const DEFAULT_MODEL = "gemini-4-neon";
const KNOWN_MODELS = [
  "gemini-4-neon",
  "gemini-4-carbon",
  "gemini-4-argon",
  "gemini-4-hydrogen",
  "gemini-pro-orchestrator-neon",
  "gemini-pro-orchestrator",
  "gemini-pro-orchestrator-argon",
  "gemini-3.8-flash",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "gpt-oss-120b-medium",
] as const;
const THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

const REF = /^(?:gemini-[a-z0-9][a-z0-9._-]*|claude-[a-z0-9][a-z0-9._-]*|gpt-[a-z0-9][a-z0-9._-]*)$/i;
const GEMINI_REF = /^gemini-[a-z0-9][a-z0-9._-]*$/i;
const AG_PREFIX = /^(?:google-antigravity|antigravity|google-gemini-cli)\//i;
const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh)$/i;
const STARTUP_MS = 12_000;
const CONTROL_MS = 5_000;
const PROBE_MS = 5_000;
const CATALOG_TTL_MS = 30_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function mainAntigravityModel(main?: MainSelection): string | undefined {
  const raw = main?.model?.trim();
  if (!raw) return undefined;
  if (AG_PREFIX.test(raw)) {
    const stripped = raw.replace(AG_PREFIX, "");
    return REF.test(stripped) ? stripped : undefined;
  }
  const stripped = raw.replace(/^google\//i, "");
  return GEMINI_REF.test(stripped) ? stripped : undefined;
}

/** Keep native OAuth/keyring and CLI runtime; never inherit unrelated provider keys. */
export function workerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = new Set([
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "SHELL",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "ANTIGRAVITY_CLI",
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && keep.has(key)) env[key] = value;
  return env;
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal, ms: number, problem: () => Block): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(problem());
      timer = setTimeout(abort, ms);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function antigravityAdapter(host: HostServices = {}, injected?: AntigravitySdk): SDKAdapter {
  let pending: Promise<AntigravitySdk> | undefined;
  let catalog: { expires: number; values: Promise<readonly string[]> } | undefined;

  const sdk = (): Promise<AntigravitySdk> => {
    if (injected) return Promise.resolve(injected);
    pending ??= loadRealSdk().catch(() => {
      pending = undefined;
      throw new Block("sdk", "The Antigravity CLI (agy) is not available. Install agy and sign in with your Google account.");
    });
    return pending;
  };
  const model = (runtime: Runtime) => {
    if (!runtime.model || !REF.test(runtime.model)) {
      throw new Block("model", `${runtime.path ? `${runtime.path}/model: ` : ""}Select an Antigravity model (e.g. ${DEFAULT_MODEL})`);
    }
    return runtime.model;
  };
  const defaultModel = () => {
    try { return mainAntigravityModel(host.main?.()) ?? DEFAULT_MODEL; } catch { return DEFAULT_MODEL; }
  };
  const defaultThinking = () => {
    try { return host.main?.().thinking; } catch { return undefined; }
  };

  return {
    async models() {
      const api = await sdk();
      if (!catalog || catalog.expires < Date.now()) {
        catalog = {
          expires: Date.now() + CATALOG_TTL_MS,
          values: api.listModels ? api.listModels(workerEnv()).catch(() => [...KNOWN_MODELS]) : Promise.resolve([...KNOWN_MODELS]),
        };
      }
      return catalog.values;
    },
    defaultModel,
    defaultThinking,
    capabilities(_runtime): Capabilities {
      return {
        switchModel: true,
        thinking: THINKING_LEVELS,
        context: { system: "append", ambientInstructions: false },
      };
    },
    async validateRuntime(runtime, signal) {
      signal.throwIfAborted();
      model(runtime);
      if (runtime.thinking !== undefined && !THINKING_LEVELS.includes(runtime.thinking as (typeof THINKING_LEVELS)[number])) {
        throw new Block("capability", `${runtime.path ? `${runtime.path}/thinking: ` : ""}${runtime.thinking} is not an antigravity thinking level (${THINKING_LEVELS.join(", ")})`);
      }
      await sdk();
      signal.throwIfAborted();
    },
    async open(spec) {
      return open(spec, await sdk());
    },
  };

  async function open(spec: SessionSpec, api: AntigravitySdk): Promise<Handle> {
    const cancelled = () => new Block("cancelled", "Antigravity open cancelled");
    if (spec.signal.aborted) throw cancelled();
    let currentModel = model(spec.runtime);
    let currentThinking = spec.thinking ?? spec.runtime.thinking;
    if (currentThinking !== undefined && !THINKING_LEVELS.includes(currentThinking as (typeof THINKING_LEVELS)[number])) {
      throw new Block("capability", `${currentThinking} is not an antigravity thinking level (${THINKING_LEVELS.join(", ")})`);
    }

    type Active = {
      signal: AbortSignal;
      terminating: boolean;
      stopping?: Promise<void>;
      denied?: PromptOutcome;
      done: Promise<PromptOutcome>;
      resolve(value: PromptOutcome): void;
      responseOpen: boolean;
      text: string;
    };

    let active: Active | undefined;
    let starting = false;
    let closed = false;
    let ending = false;
    let ready = false;
    let fatal: Block | undefined;
    let sessionId = "";
    let nextRpcId = 0;
    let nextCall = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const sessionController = new AbortController();
    const pendingRpc = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const toolNames = new Set(spec.tools.map((t) => t.name));

    const emit = (event: SessionEvent) => { if (!closed) try { spec.emit(event); } catch { /* display only */ } };
    const report = (value: Observation) => emit({ type: "telemetry", value });
    const log = (text: string) => emit({ type: "log", text });

    function usable(turn: Active) {
      return !closed && !ending && !fatal && active === turn && !turn.signal.aborted && !turn.terminating && !turn.stopping && !turn.denied;
    }

    function dispatch(tool: Tool, args: unknown, toolSignal: AbortSignal): Promise<ToolDispatchResult> {
      const turn = active;
      const work = queue.then(async (): Promise<ToolDispatchResult> => {
        if (!turn || !usable(turn) || toolSignal.aborted) {
          return { text: "Worq tool dispatch is closed", isError: true };
        }
        const signal = AbortSignal.any([turn.signal, sessionController.signal, toolSignal]);
        const call = String(++nextCall);
        report({ start: call, name: tool.name });
        emit({ type: "tool-start", name: tool.name, args });
        let outcome: Outcome = { kind: "ok" };
        try {
          const out = await tool.run(args as never, signal, (value) => { outcome = value; });
          const value = typeof out === "string" ? { text: out } : out;
          if (value.terminate) {
            turn.terminating = true;
            void bounded(turn.done, sessionController.signal, 2_000, () => new Block("timeout", "Antigravity submit is still settling"))
              .catch(() => stopTurn(turn));
          }
          return { text: value.text, ...(value.image ? { image: value.image } : {}), isError: false };
        } catch (error) {
          if (error instanceof Block && error.code === "runtime-invalidated") fail(error);
          const message = errorText(error);
          outcome = { kind: "sdk-error" };
          emit({ type: "tool-error", name: tool.name, message });
          return { text: `Error: ${message}`, isError: true };
        } finally {
          report({ end: call, outcome });
        }
      });
      queue = work.catch(() => {});
      return work;
    }

    let mcp: AntigravityMcpServer;
    try {
      mcp = await api.createMcpServer(spec.tools, dispatch);
    } catch {
      throw new Block("sdk-error", "Antigravity could not start its local Worq MCP server");
    }

    let proc: AntigravityAcpProcess;
    try {
      proc = api.spawn({ cwd: spec.cwd, env: workerEnv() });
    } catch {
      await Promise.resolve(mcp.close()).catch(() => {});
      throw new Block("sdk-error", "Antigravity could not start its `agy acp` process");
    }

    let closing: Promise<void> | undefined;
    function closeResources() {
      if (closing) return closing;
      sessionController.abort();
      for (const entry of pendingRpc.values()) entry.reject(fatal ?? new Block("ended", "Antigravity ACP connection closed"));
      pendingRpc.clear();
      closing = Promise.allSettled([Promise.resolve(proc.close()), Promise.resolve(mcp.close())]).then(() => {});
      return closing;
    }

    function flushResponse(turn: Active, completed: boolean) {
      if (!turn.responseOpen) return;
      turn.responseOpen = false;
      emit({ type: "response", completed });
      if (turn.text.trim()) emit({ type: "text", text: turn.text, completed });
      turn.text = "";
    }

    function settle(outcome: PromptOutcome) {
      const turn = active;
      active = undefined;
      if (turn) {
        flushResponse(turn, outcome === "completed");
        turn.resolve(outcome);
      }
      report({ phase: "idle" });
    }

    function close(outcome: PromptOutcome) {
      if (closed) return;
      closed = true;
      spec.signal.removeEventListener("abort", cancel);
      settle(outcome);
      if (ready) try { spec.emit({ type: "telemetry", value: { phase: "closed" } }); } catch { /* display only */ }
      void closeResources();
    }

    function end() {
      if (closed || ending) return;
      ending = true;
      if (active) void stopTurn().then(() => close("aborted"));
      else close("aborted");
    }

    function fail(block: Block) {
      fatal ??= block;
      if (ready) log(fatal.message);
      close("failed");
    }

    function stopTurn(turn = active): Promise<void> {
      if (!turn || turn !== active) return Promise.resolve();
      turn.denied ??= "aborted";
      turn.stopping ??= (async () => {
        if (sessionId) {
          try { proc.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); } catch { /* closed */ }
        }
        try {
          await bounded(turn.done, sessionController.signal, 4_000, () => new Block("runtime-invalidated", "Antigravity did not confirm turn shutdown; start a new session"));
        } catch (error) {
          if (!closed) fail(error as Block);
        }
      })();
      return turn.stopping;
    }

    const cancel = () => { end(); };
    spec.signal.addEventListener("abort", cancel, { once: true });

    function rpc<T = unknown>(method: string, params: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, stage: string): Promise<T> {
      const id = ++nextRpcId;
      const work = new Promise<T>((resolve, reject) => {
        pendingRpc.set(id, { resolve: resolve as (v: unknown) => void, reject });
        try {
          proc.send({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          pendingRpc.delete(id);
          reject(error instanceof Error ? error : new Error(errorText(error)));
        }
      });
      return bounded(work, signal, timeoutMs, () => {
        pendingRpc.delete(id);
        return signal.aborted ? new Block("cancelled", `Antigravity ${stage} cancelled`) : new Block("sdk-error", `Antigravity ${stage} timed out`);
      });
    }

    function isWorqToolPermission(params: Record<string, unknown>): boolean {
      const call = record(params.toolCall);
      const title = string(call?.title);
      const name = string(call?.name) || title;
      const normalized = name.replace(/^(?:mcp__)?worq__(?:tool__)?/i, "").trim();
      if (toolNames.has(normalized)) return true;
      for (const allowed of toolNames) {
        if (title === allowed || title.endsWith(`/${allowed}`) || title.endsWith(`:${allowed}`) || title.includes(`worq__${allowed}`)) return true;
      }
      return false;
    }

    function handlePermissionRequest(id: unknown, params: Record<string, unknown>) {
      const options = Array.isArray(params.options) ? params.options.map(record).filter((o): o is Record<string, unknown> => !!o) : [];
      const allow = isWorqToolPermission(params);
      const chosen = allow
        ? options.find((o) => o.kind === "allow_once" || o.kind === "allow_always")
        : options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
      const outcome = chosen?.optionId
        ? { outcome: "selected", optionId: chosen.optionId }
        : { outcome: "cancelled" };
      if (!allow) log(`Antigravity permission denied for non-Worq tool (${string(record(params.toolCall)?.title) || "unknown"})`);
      try { proc.send({ jsonrpc: "2.0", id, result: { outcome } }); } catch { /* closed */ }
    }

    async function consume() {
      try {
        for await (const msg of proc.messages) {
          if (closed) return;
          // Response to our outbound JSON-RPC request
          if (msg.id !== undefined && msg.method === undefined) {
            const entry = pendingRpc.get(Number(msg.id));
            if (entry) {
              pendingRpc.delete(Number(msg.id));
              const err = record(msg.error);
              if (err) {
                const code = typeof err.code === "number" ? err.code : 0;
                const errObj = Object.assign(new Error(string(err.message) || "ACP error"), { rpcCode: code });
                entry.reject(errObj);
              } else {
                entry.resolve(msg.result);
              }
            }
            continue;
          }
          // Incoming server -> client JSON-RPC request (e.g. session/request_permission)
          if (msg.id !== undefined && typeof msg.method === "string") {
            if (msg.method === "session/request_permission") {
              handlePermissionRequest(msg.id, record(msg.params) ?? {});
            } else {
              try { proc.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported method ${msg.method}` } }); } catch { /* closed */ }
            }
            continue;
          }
          // Incoming notification (session/update)
          if (msg.method === "session/update") {
            const params = record(msg.params);
            const update = record(params?.update);
            const kind = string(update?.sessionUpdate);
            if (kind === "usage_update") {
              const used = number(update?.used);
              const size = number(update?.size);
              if (size && size > 0) {
                report({ context: { percent: used !== undefined ? Math.min(100, (used / size) * 100) : undefined, contextWindow: size } });
              }
              continue;
            }
            const turn = active;
            if (!turn || !usable(turn)) continue;
            if (kind === "agent_message_chunk") {
              if (!turn.responseOpen) {
                turn.responseOpen = true;
                emit({ type: "response-start" });
                emit({ type: "turn" });
                report({ turn: true });
              }
              const chunk = record(update?.content);
              if (chunk?.type === "text" && typeof chunk.text === "string") turn.text += chunk.text;
            } else if (kind === "tool_call" && turn.responseOpen) {
              flushResponse(turn, true);
            }
          }
        }
      } catch { /* Raw ACP stream errors can contain stderr or prompt text. */ }
      if (!closed) fail(new Block("sdk-error", ready ? "Antigravity ACP stream ended" : "Antigravity ACP stream ended during startup"));
    }

    void consume();

    try {
      const initResult = record(await rpc("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "pi-worq", version: "1.0.0" },
      }, spec.signal, STARTUP_MS, "initialize"));
      const caps = record(initResult?.agentCapabilities);
      const agMeta = record(record(caps?._meta)?.antigravity);
      if (record(agMeta?.systemPrompt)?.append !== true) {
        throw new Block("capability", "Antigravity ACP server did not advertise systemPrompt.append support");
      }
      const created = record(await rpc("session/new", {
        cwd: spec.cwd,
        mcpServers: [{
          type: "http",
          name: "worq",
          url: mcp.url,
          headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }],
        }],
        _meta: { antigravity: { systemPrompt: { append: spec.system } } },
      }, spec.signal, STARTUP_MS, "session/new"));
      sessionId = string(created?.sessionId);
      if (!sessionId) throw new Block("sdk-error", "Antigravity ACP session/new returned no sessionId");

      const configOptions = Array.isArray(created?.configOptions) ? created.configOptions.map(record) : [];
      const currentCfg = (id: string) => string(configOptions.find((o) => o?.id === id)?.currentValue);
      if (currentCfg("model") !== currentModel) {
        await rpc("session/set_config_option", { sessionId, configId: "model", value: currentModel }, spec.signal, STARTUP_MS, "model selection");
      }
      if (currentThinking !== undefined && currentCfg("thought_level") !== currentThinking) {
        await rpc("session/set_config_option", { sessionId, configId: "thought_level", value: currentThinking }, spec.signal, STARTUP_MS, "thinking selection");
      } else if (currentThinking === undefined && currentCfg("thought_level")) {
        currentThinking = currentCfg("thought_level");
      }

      if (spec.signal.aborted) throw cancelled();
      if (closed || fatal) throw fatal ?? new Block("sdk-error", "Antigravity ACP process ended during startup");
      ready = true;
      report({ setup: { model: currentModel, ...(currentThinking !== undefined ? { thinking: currentThinking } : {}), skills: [] } });
      report({ phase: "idle" });
    } catch (error) {
      close("failed");
      await bounded(closeResources(), new AbortController().signal, 4_000, () => new Block("sdk-error", "Antigravity startup failed and cleanup timed out")).catch(() => {});
      throw error instanceof Block ? error : new Block("sdk-error", `Antigravity startup failed: ${errorText(error)}`);
    }

    return {
      async prompt(text, signal = new AbortController().signal) {
        if (fatal) throw fatal;
        if (closed || ending) throw new Block("ended", "Antigravity session is closed");
        if (active || starting) throw new Block("busy", "Antigravity session is already streaming");
        if (signal.aborted) return "aborted";
        starting = true;
        try {
          if (spec.beforeRequest) await spec.beforeRequest(signal);
          if (closed || fatal) throw fatal ?? new Block("ended", "Antigravity session closed before its request");
          if (signal.aborted) return "aborted";
          let resolve!: Active["resolve"];
          const done = new Promise<PromptOutcome>((r) => { resolve = r; });
          const turn: Active = { signal, terminating: false, done, resolve, responseOpen: false, text: "" };
          active = turn;
          const onAbort = () => { void stopTurn(turn); };
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            report({ phase: "request" });
            const id = ++nextRpcId;
            const call = new Promise<unknown>((res, rej) => {
              pendingRpc.set(id, { resolve: res, reject: rej });
              try {
                proc.send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } });
              } catch (error) {
                pendingRpc.delete(id);
                rej(error instanceof Error ? error : new Error(errorText(error)));
              }
            });
            call.then((res) => {
              if (active !== turn) return;
              const stopReason = string(record(res)?.stopReason);
              if (turn.terminating) settle("completed");
              else if (turn.denied) settle(turn.denied);
              else if (stopReason === "cancelled") settle("aborted");
              else settle("completed");
            }, (error) => {
              if (active !== turn) return;
              if (turn.terminating) { settle("completed"); return; }
              if (turn.denied) { settle(turn.denied); return; }
              const code = (error as { rpcCode?: number })?.rpcCode;
              if (code === -32000) {
                log("Antigravity authentication required; run `agy` to sign in");
                settle("preflight-failed");
              } else {
                log("Antigravity prompt failed; provider detail omitted");
                settle("failed");
              }
            });
            return await done;
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        } finally {
          starting = false;
        }
      },
      get streaming() { return !!active; },
      abort: () => stopTurn(),
      get selection() { return { model: currentModel, ...(currentThinking !== undefined ? { thinking: currentThinking } : {}) }; },
      async configure(change) {
        if (fatal) throw fatal;
        if (closed) throw new Block("ended", "Antigravity session is closed");
        if (change.model !== undefined) {
          if (!REF.test(change.model)) throw new Block("model", "Select a supported Antigravity model ref");
          if (change.model !== currentModel) {
            await rpc("session/set_config_option", { sessionId, configId: "model", value: change.model }, sessionController.signal, CONTROL_MS, "model switch");
            currentModel = change.model;
          }
        }
        if (change.thinking !== undefined) {
          if (!THINKING_LEVELS.includes(change.thinking as (typeof THINKING_LEVELS)[number])) {
            throw new Block("capability", `${change.thinking} is not an antigravity thinking level (${THINKING_LEVELS.join(", ")})`);
          }
          if (change.thinking !== currentThinking) {
            await rpc("session/set_config_option", { sessionId, configId: "thought_level", value: change.thinking }, sessionController.signal, CONTROL_MS, "thinking switch");
            currentThinking = change.thinking;
          }
        }
        report({ setup: { model: currentModel, ...(currentThinking !== undefined ? { thinking: currentThinking } : {}), skills: [] } });
        report({ context: undefined });
      },
      dispose: end,
    };
  }
}

async function createHttpMcpServer(tools: readonly Tool[], dispatch: ToolDispatcher): Promise<AntigravityMcpServer> {
  const token = randomBytes(24).toString("hex");
  const byName = new Map(tools.map((t) => [t.name, t]));
  const controller = new AbortController();

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = record(JSON.parse(await readBody(req))) ?? {};
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
      return;
    }
    const id = body.id;
    const method = string(body.method);
    if (id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (method === "initialize") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "worq", version: "1.0.0" } },
      });
      return;
    }
    if (method === "tools/list") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) },
      });
      return;
    }
    if (method === "tools/call") {
      const params = record(body.params);
      const name = string(params?.name);
      const tool = byName.get(name);
      if (!tool) {
        sendJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: Unknown tool ${name}` }], isError: true } });
        return;
      }
      const reqAbort = new AbortController();
      req.on("close", () => { if (!res.writableEnded) reqAbort.abort(); });
      const result = await dispatch(tool, params?.arguments ?? {}, AbortSignal.any([controller.signal, reqAbort.signal]));
      const content: unknown[] = [{ type: "text", text: result.text }];
      if (result.image) content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { content, isError: Boolean(result.isError) } });
      return;
    }
    sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    token,
    close() {
      controller.abort();
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function parseAgyModels(stdout: string): readonly string[] {
  const models = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, "").trim();
    const id = line.split(/\s+/)[0];
    if (!id || !REF.test(id)) continue;
    const base = id.replace(EFFORT_SUFFIX, "");
    models.add(REF.test(base) ? base : id);
  }
  return models.size ? [...models] : [...KNOWN_MODELS];
}

async function loadRealSdk(bin = process.env.ANTIGRAVITY_CLI || "agy"): Promise<AntigravitySdk> {
  await execFileAsync(bin, ["--version"], { env: workerEnv(), timeout: PROBE_MS });
  return {
    createMcpServer: createHttpMcpServer,
    async listModels(env) {
      const { stdout } = await execFileAsync(bin, ["models"], { env, timeout: PROBE_MS });
      return parseAgyModels(stdout);
    },
    spawn({ cwd, env }) {
      const child = spawn(bin, ["acp", "--stdio", "--process-per-session", "--disable-telemetry", "--include-default-customizations=false"], {
        cwd, env, stdio: ["pipe", "pipe", "ignore"],
      });
      const rl = createInterface({ input: child.stdout });
      const messages = (async function* (): AsyncGenerator<RpcMessage> {
        try {
          for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = record(JSON.parse(trimmed));
              if (parsed) yield parsed;
            } catch { /* ignore non-JSON lines */ }
          }
        } finally {
          rl.close();
        }
      })();
      return {
        messages,
        send(message) {
          if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        async close() {
          try { child.stdin.end(); } catch { /* already ended */ }
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          await Promise.race([
            new Promise<void>((resolve) => child.once("exit", () => resolve())),
            new Promise<void>((resolve) => setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              resolve();
            }, 1_500).unref()),
          ]);
        },
      };
    },
  };
}
