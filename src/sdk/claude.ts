import { Block, errorText } from "../contracts.ts";
import type { Observation, Outcome } from "../telemetry.ts";
import type { Capabilities, Handle, PromptOutcome, RequestDecision, Runtime, RuntimeChange, SDKAdapter, SessionEvent, SessionSpec, Tool, ToolOutput } from "./contract.ts";
import type { HostServices } from "./registry.ts";

/**
 * The Claude Agent SDK adapter. The SDK and its Zod peer are imported lazily, only when this adapter is
 * selected: a missing optional package fails this SDK alone and never Pi or management.
 *
 * Isolation is enforced with `settingSources: []`, an empty native tool list, an in-process MCP server holding
 * only Worq's prepared tools, no plugins/agents/skills, and `strictMcpConfig`. Model policy, system prompt,
 * tools and budgets stay Worq's. Claude's fixed SDK framing (a billing header and a one-line agent identity)
 * is not ambient user/project content; managed policy that could add behavior is refused before a worker starts.
 */

export interface MainSelection { model?: string; thinking?: string }
export interface ClaudeHost extends HostServices { main?(): MainSelection }

/** Structural seam over the SDK release, so deterministic tests exercise this adapter rather than a stand-in. */
export interface ClaudeSdk {
  query(args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): ClaudeQuery;
  createServer(options: { name: string; version?: string; timeout?: number; tools: ClaudeServerTool[] }): unknown;
  resolveSettings(options: { cwd?: string; settingSources?: string[]; managedSettings?: unknown }): Promise<ClaudeSettings>;
}
export interface ClaudeServerTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler(args: unknown, extra?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  getContextUsage?(options?: { detail?: "summary" | "full" }): Promise<{ model?: string; percentage?: number; raw_max_tokens?: number; rawMaxTokens?: number } | undefined>;
  supportedModels?(): Promise<readonly { value: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }[]>;
}
export interface ClaudeMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}
export interface ClaudeSettings {
  sources?: readonly { source?: string; settings?: Record<string, unknown>; policyOrigin?: unknown }[];
  machinePolicy?: { didNotLoad?: false | string[] };
}

const CLAUDE_MODEL = /^(?:claude-[a-z0-9][a-z0-9._-]*|sonnet|opus|haiku)$/i;
/** Fixed SDK framing: a custom system prompt still gets these two constant blocks. Not settings-derived. */
export const BILLING_HEADER = /^x-anthropic-billing-header:/;
export const AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/** Behavior-affecting managed-policy keys this adapter cannot fence; any of them refuses the launch. */
const POLICY_KEYS = new Set([
  "hooks", "env", "apiKeyHelper", "model", "modelSettings", "permissions", "enableAllProjectMcpServers",
  "enabledPlugins", "extraKnownMarketplaces", "plugins", "outputStyle", "statusLine", "agents", "skills",
  "forceLoginMethod", "forceLoginOrgUUID", "awsAuthRefresh", "apiProvider", "policyHelper", "sandbox",
  "autoCompactEnabled", "precomputeCompactionEnabled", "idleCompaction", "switchModelsOnFlag",
  "disableSideloadFlags", "allowedProviders", "deniedModels", "availableModels", "effortLevel",
]);

/** Main's Claude-family reference, if there is a defensible equivalent. Never invented for another provider. */
export function mainClaudeModel(main: MainSelection | undefined): string | undefined {
  const ref = main?.model;
  if (!ref) return undefined;
  const slash = ref.indexOf("/");
  if (slash < 0) return CLAUDE_MODEL.test(ref) ? ref : undefined;
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  return provider === "anthropic" && CLAUDE_MODEL.test(id) ? id : undefined;
}

/**
 * No level control: the pinned SDK accepts `effort` but its stdio init never reports the applied value, so a
 * level would be an unverified claim. Main's level is not inherited; an explicit level is refused, not guessed.
 */
export function claudeThinking(_model: string | undefined): readonly string[] { return []; }

/**
 * An explicit allowlist for the worker environment. Main's home/profile and native credentials survive;
 * ambient model, effort, endpoint, config-dir and harness switches do not. Hardcoded controls follow.
 */
export function workerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = new Set([
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "SHELL",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && keep.has(key)) env[key] = value;
  // Adapter controls, not operator preferences: no auto memory, no retries bypassing admission, no ambient traffic.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_MAX_RETRIES = "0";
  env.DISABLE_TELEMETRY = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

/** Managed policy is the one settings tier `settingSources: []` cannot remove; refuse anything behavior-affecting. */
export async function policyProblem(sdk: ClaudeSdk, cwd: string): Promise<string | undefined> {
  if (typeof sdk.resolveSettings !== "function") return "this Claude SDK cannot inspect managed policy, so isolation cannot be guaranteed";
  let resolved: ClaudeSettings;
  try { resolved = await sdk.resolveSettings({ cwd, settingSources: [] }); }
  catch (error) { return `managed policy could not be read (${errorText(error)})`; }
  if (!resolved || resolved.machinePolicy?.didNotLoad !== false) return "managed policy could not be read, so isolation cannot be guaranteed";
  for (const source of resolved.sources ?? []) {
    if (source.source !== "managed" && source.policyOrigin === undefined) continue;
    const keys = Object.keys(source.settings ?? {}).filter((key) => POLICY_KEYS.has(key));
    if (keys.length) return `managed policy sets ${keys.slice(0, 4).join(", ")}`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function textOf(value: unknown): string { return typeof value === "string" ? value : ""; }

/** One turn's request counters and text, normalized from the SDK stream. */
interface Live {
  generation: number;
  streaming: boolean;
  terminating: boolean;
  requests: number;
  model?: string;
  ready: boolean;
}

export function claudeAdapter(host: HostServices = {}, injected?: ClaudeSdk): SDKAdapter {
  let pending: Promise<ClaudeSdk> | undefined;
  const sdk = (): Promise<ClaudeSdk> => {
    if (injected) return Promise.resolve(injected);
    pending ??= loadRealSdk().catch((error) => {
      pending = undefined;
      throw new Block("sdk", `The Claude Agent SDK is not available: ${errorText(error)}. Install @anthropic-ai/claude-agent-sdk (optional dependency).`);
    });
    return pending;
  };
  const at = (runtime: Runtime) => runtime.path ? `${runtime.path}/model` : "model";
  const model = (runtime: Runtime) => {
    if (!runtime.model) throw new Block("model", `${runtime.path ? `${runtime.path}/model: ` : ""}Select a Claude model or pass a model (claude-...)`);
    if (!CLAUDE_MODEL.test(runtime.model)) throw new Block("model", `${at(runtime)}: ${runtime.model} is not a Claude model ref (claude-..., sonnet, opus or haiku)`);
    return runtime.model;
  };
  const selection = (): MainSelection | undefined => { try { return host.main?.(); } catch { return undefined; } };

  return {
    // Advisory picker choices: the SDK's own stable aliases. A full claude-* id still passes preflight.
    async models() { return ["sonnet", "opus", "haiku"]; },
    defaultModel() { return mainClaudeModel(selection()); },
    // No inherited thinking: the pinned SDK does not report the applied effort, so a level would be unverified.
    defaultThinking() { return undefined; },
    capabilities(runtime): Capabilities {
      return {
        switchModel: true, thinking: claudeThinking(runtime.model), turnUnit: "request",
        requestAdmission: "awaited", context: { system: "replace", ambientInstructions: false },
      };
    },
    /** Local syntax/preflight and a managed-policy read. No session, model list, credential probe or request. */
    async validateRuntime(runtime, signal) {
      signal.throwIfAborted();
      model(runtime);
      if (runtime.thinking !== undefined) {
        throw new Block("capability", `${runtime.path ? `${runtime.path}/thinking: ` : ""}Claude has no verified thinking-level control; omit thinking`);
      }
      const problem = await policyProblem(await sdk(), process.cwd());
      signal.throwIfAborted();
      if (problem) throw new Block("policy", `Claude isolation refused: ${problem}`);
    },
    async open(spec) { return open(spec, await sdk()); },
  };

  async function open(spec: SessionSpec, api: ClaudeSdk): Promise<Handle> {
    spec.signal.throwIfAborted();
    const problem = await policyProblem(api, spec.cwd);
    if (problem) throw new Block("policy", `Claude isolation refused: ${problem}`);
    const requested = model(spec.runtime);
    if (spec.thinking !== undefined) throw new Block("capability", `Claude has no verified thinking-level control; omit thinking`);

    const live: Live = { generation: 0, streaming: false, terminating: false, requests: 0, model: requested, ready: false };
    const outcomes = new Map<string, Outcome>();
    const calls = new Map<string, string>();
    let nextCall = 0;
    let queue: Promise<unknown> = Promise.resolve();
    let disposed = false;
    let fatal: Block | undefined;
    let q: ClaudeQuery | undefined;
    let current: { resolve(outcome: PromptOutcome): void; signal: AbortSignal; id: number } | undefined;
    let aborting = false;
    /** Tool calls from the current assistant response not yet answered; the last one gates the continuation. */
    let pendingToolCalls = 0;

    const emit = (event: SessionEvent) => { if (!disposed) try { spec.emit(event); } catch { /* display only */ } };
    const report = (value: Observation) => emit({ type: "telemetry", value });
    const allowed = new Set(spec.tools.map((tool) => `mcp__worq__${tool.name}`));
    const fail = (error: unknown) => {
      const block = error instanceof Block ? error : new Block("sdk-error", errorText(error));
      if (block.code === "runtime-invalidated") fatal ??= block;
      return block;
    };
    const settle = (outcome: PromptOutcome) => {
      const active = current;
      current = undefined;
      live.streaming = false;
      report({ phase: idlePhase() });
      active?.resolve(outcome);
    };
    const idlePhase = (): "idle" | "closed" => disposed ? "closed" : "idle";

    /** One MCP callback at a time; generation and cancellation are rechecked after the wait. */
    const dispatch = (tool: Tool, args: unknown, extra: { signal?: AbortSignal } | undefined, generation: number): Promise<unknown> => {
      const work = queue.then(async () => {
        const signal = AbortSignal.any([spec.signal, ...(extra?.signal ? [extra.signal] : []), ...(current ? [current.signal] : [])]);
        if (disposed || fatal) throw fatal ?? new Block("ended", "Claude session is closed");
        if (generation !== live.generation || signal.aborted) throw signal.reason ?? new Block("stale", "Claude tool call from an earlier prompt");
        const call = String(++nextCall);
        calls.set(call, tool.name);
        report({ start: call, name: tool.name });
        emit({ type: "tool-start", name: tool.name, args });
        let out: ToolOutput;
        try {
          out = await tool.run(args, signal, (value) => outcomes.set(call, value));
        } catch (error) {
          const block = fail(error);
          const message = errorText(block);
          outcomes.set(call, { kind: "sdk-error" });
          emit({ type: "tool-error", name: tool.name, message });
          report({ end: call, outcome: { kind: "sdk-error" } });
          calls.delete(call);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
        const value = typeof out === "string" ? { text: out } : out;
        const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [{ type: "text", text: value.text }];
        if (value.image) content.push({ type: "image", mimeType: value.image.mimeType, data: value.image.data });
        report({ end: call, outcome: outcomes.get(call) ?? { kind: "ok" } });
        outcomes.delete(call);
        calls.delete(call);
        if (value.terminate) {
          // Commit first (the core's submit already did), then stop this turn before any sibling or continuation.
          live.terminating = true;
          await stopTurn();
          return { content };
        }
        pendingToolCalls = Math.max(0, pendingToolCalls - 1);
        if (pendingToolCalls === 0 && spec.admitRequest) {
          // The last tool result of this response is held until the core admits the continuation.
          let decision: RequestDecision;
          // Admission is keyed to the core's prompt-scoped signal, not the combined tool signal.
          const admissionSignal = current?.signal ?? signal;
          try { decision = await spec.admitRequest(admissionSignal); }
          catch (error) {
            const block = fail(error);
            await stopTurn();
            throw block;
          }
          if (!decision.allowed) {
            emit({ type: "log", text: "Claude continuation refused by admission; the last tool result was not released" });
            await stopTurn();
            throw new Block("admission", "Claude continuation refused by request admission");
          }
        }
        return { content };
      });
      queue = work.catch(() => {});
      return work;
    };

    const create = api.createServer({
      name: "worq", version: "1.0.0", timeout: 24 * 60 * 60 * 1000,
      tools: spec.tools.map((tool) => ({
        name: tool.name, description: tool.description, inputSchema: tool.parameters,
        handler: (args: unknown, extra?: { signal?: AbortSignal }) => dispatch(tool, args, extra, live.generation),
      })),
    });

    const input = messageQueue();
    const options = claudeOptions(spec, create, workerEnv());
    q = api.query({ prompt: input.stream, options });
    const query = q;
    // Start consuming before waiting for init: the iterator is what delivers the init message.
    void consume();

    let readyResolve!: (value: ClaudeMessage) => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<ClaudeMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Block("model", "Claude did not finish initializing (no init within 30s)")), 30_000);
      timer.unref?.();
      const abort = () => { clearTimeout(timer); reject(spec.signal.reason ?? new Block("cancelled", "Claude open cancelled")); };
      if (spec.signal.aborted) abort(); else spec.signal.addEventListener("abort", abort, { once: true });
      readyResolve = (value) => { clearTimeout(timer); spec.signal.removeEventListener("abort", abort); resolve(value); };
      readyReject = (error) => { clearTimeout(timer); spec.signal.removeEventListener("abort", abort); reject(error); };
    });
    const init = await ready;
    await verifyInit(query, init, requested);
    live.ready = true;
    report({ setup: { model: String(init.model ?? requested), thinking: undefined, skills: [] } });
    report({ phase: "idle" });

    async function consume() {
      try {
        for await (const message of query) {
          if (disposed) break;
          if (message.type === "system" && message.subtype === "init") {
            if (!live.ready) readyResolve(message);
            continue;
          }
          if (message.type === "stream_event") {
            const event = isRecord(message.event) ? message.event : undefined;
            if (event?.type === "message_start") { pendingToolCalls = 0; live.requests++; report({ phase: "request" }); emit({ type: "turn" }); }
            continue;
          }
          if (message.type === "assistant") {
            const inner = isRecord(message.message) ? message.message : undefined;
            const content = Array.isArray(inner?.content) ? inner.content : [];
            for (const block of content) {
              if (!isRecord(block)) continue;
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) emit({ type: "text", text: block.text, completed: true });
              if (block.type === "tool_use" && typeof block.id === "string") { pendingToolCalls++; calls.set(block.id, String(block.name ?? "tool")); }
            }
            continue;
          }
          if (message.type === "result") {
            const usage = isRecord(message.usage) ? message.usage : undefined;
            const cacheRead = typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined;
            const cacheWrite = typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined;
            const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
            if (cacheRead !== undefined || cacheWrite !== undefined || inputTokens !== undefined) report({ cache: { read: cacheRead, write: cacheWrite, input: inputTokens } });
            const failed = message.is_error === true && !live.terminating && !aborting;
            if (failed) emit({ type: "log", text: `Claude request failed (${String(message.subtype ?? "error")}); provider detail omitted` });
            settle(failed ? "failed" : live.terminating || aborting ? "aborted" : "completed");
            void context();
            continue;
          }
          if (message.type === "system" && message.subtype === "api_retry") {
            // CLAUDE_CODE_MAX_RETRIES=0 should prevent this; a retry would be an unadmitted request.
            emit({ type: "log", text: "Claude requested an API retry; the adapter disables retries, so this is treated as a request failure" });
            settle("failed");
          }
        }
        if (!disposed && current) settle(aborting ? "aborted" : "failed");
      } catch (error) {
        if (disposed) return;
        const block = fail(error);
        emit({ type: "log", text: `Claude stream ended: ${errorText(block)}` });
        if (!live.ready) readyReject(block);
        if (current) settle(aborting ? "aborted" : "failed");
      }
    }

    async function context() {
      try {
        const usage = await query.getContextUsage?.({ detail: "summary" });
        if (usage && typeof usage === "object" && "percentage" in usage) {
          const percent = typeof usage.percentage === "number" ? usage.percentage : undefined;
          // The shipped SDK reports camelCase; older/alternate shapes used snake_case.
          const contextWindow = typeof usage.rawMaxTokens === "number" ? usage.rawMaxTokens : typeof usage.raw_max_tokens === "number" ? usage.raw_max_tokens : undefined;
          report({ context: contextWindow ? { percent, contextWindow } : undefined });
        }
      } catch { /* unavailable measurements are omitted */ }
    }

    async function stopTurn() {
      if (!live.streaming) return;
      aborting = true;
      try { await Promise.race([query.interrupt(), new Promise<void>((resolve) => { const timer = setTimeout(resolve, 4000); timer.unref?.(); })]); }
      catch { /* a turn that will not stop leaves dispose to fence it */ }
      aborting = false;
      live.streaming = false;
      settle("aborted");
    }

    async function invalidate(error: Block) {
      if (fatal) return;
      fatal = error;
      live.streaming = false;
      emit({ type: "log", text: `Claude runtime invalidated: ${errorText(error)}` });
      report({ setup: { model: undefined, thinking: undefined, skills: [] } });
      try { query.close(); } catch { /* fenced below */ }
      settle("failed");
    }

    async function verifyInit(api: ClaudeQuery, message: ClaudeMessage, requested: string) {
      const tools = Array.isArray(message.tools) ? message.tools.map(String).sort() : [];
      const expected = [...allowed].sort();
      if (tools.join("\n") !== expected.join("\n")) {
        throw new Block("capability", `Claude exposed unexpected tools (${tools.join(", ") || "none"}); refusing the session`);
      }
      const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers.filter(isRecord) : [];
      if (servers.length !== 1 || servers[0].name !== "worq" || servers[0].status !== "connected") {
        throw new Block("capability", "Claude did not connect exactly the Worq MCP server; refusing the session");
      }
      const skills = Array.isArray(message.skills) ? message.skills : [];
      if (skills.length) throw new Block("capability", `Claude loaded ambient skills (${skills.join(", ")}); refusing the session`);
      const commands = Array.isArray(message.slash_commands) ? message.slash_commands : [];
      if (commands.length) throw new Block("capability", `Claude exposed slash commands (${commands.slice(0, 4).join(", ")}); refusing the session`);
      const plugins = Array.isArray(message.plugins) ? message.plugins.filter(isRecord) : [];
      const ambient = plugins.filter((plugin) => plugin.path !== "builtin");
      if (ambient.length) throw new Block("capability", `Claude loaded ambient plugins (${ambient.map((p) => String(p.name)).join(", ")}); refusing the session`);
      const agents = Array.isArray(message.agents) ? message.agents : [];
      if (agents.length) throw new Block("capability", `Claude loaded ambient agents (${agents.join(", ")}); refusing the session`);
      if (message.permissionMode !== "dontAsk") throw new Block("capability", `Claude permission mode is ${String(message.permissionMode)}; refusing the session`);
      const resolved = await expectedModel(api, requested);
      const actual = textOf(message.model);
      if (actual && actual !== requested && actual !== resolved) {
        throw new Block("model", `Claude resolved ${requested} to ${actual}, not the selected model`);
      }
      live.model = actual || requested;
    }

    async function expectedModel(api: ClaudeQuery, requested: string): Promise<string | undefined> {
      try {
        const models = await api.supportedModels?.();
        const row = models?.find((entry) => entry.value === requested || entry.resolvedModel === requested);
        return row?.resolvedModel ?? row?.value;
      } catch { return undefined; }
    }

    return {
      async prompt(text, signal) {
        if (fatal) throw fatal;
        if (disposed) throw new Block("ended", "Claude session is closed");
        if (live.streaming) throw new Block("busy", "Claude session is already streaming");
        const liveSignal = signal ?? new AbortController().signal;
        spec.signal.throwIfAborted();
        if (liveSignal.aborted) return "aborted";
        const decision: RequestDecision = spec.admitRequest
          ? await spec.admitRequest(liveSignal)
          : { allowed: true };
        if (!decision.allowed) {
          emit({ type: "log", text: "Claude request refused by admission; nothing was released" });
          return "aborted";
        }
        if (disposed || fatal) throw fatal ?? new Block("ended", "Claude session closed before its request");
        if (liveSignal.aborted) return "aborted";
        const id = ++live.generation;
        live.streaming = true;
        live.terminating = false;
        report({ phase: "request" });
        emit({ type: "log", text: `Claude request ${live.requests + 1} admitted` });
        const outcome = new Promise<PromptOutcome>((resolve) => { current = { resolve, signal: liveSignal, id }; });
        const abort = () => { void stopTurn(); };
        liveSignal.addEventListener("abort", abort, { once: true });
        try { input.push(userMessage(text)); }
        catch (error) { settle("preflight-failed"); throw error; }
        const settled = await outcome;
        liveSignal.removeEventListener("abort", abort);
        return settled;
      },
      get streaming() { return live.streaming; },
      async steer(text) {
        if (!live.streaming) throw new Block("steer", "Claude has no active turn to steer");
        // The SDK folds a `priority: "now"` user message into the running turn at its next boundary.
        input.push({ ...(userMessage(text) as Record<string, unknown>), priority: "now" });
      },
      async abort() { aborting = true; try { await stopTurn(); } finally { aborting = false; } },
      get selection() { return { model: live.model }; },
      async configure(change: RuntimeChange) {
        if (fatal) throw fatal;
        if (disposed) throw new Block("ended", "Claude session is closed");
        if (change.model === undefined && change.thinking === undefined) throw new Block("invalid-payload", "Nothing to change");
        if (change.model !== undefined && !CLAUDE_MODEL.test(change.model)) throw new Block("model", `${change.model} is not a Claude model ref (claude-..., sonnet, opus or haiku)`);
        const nextModel = change.model ?? live.model;
        const nextLevel = change.thinking;
        if (nextLevel !== undefined && nextLevel !== spec.thinking) {
          // The pinned SDK exposes no verified read-back for effort after a live change. Fail closed before
          // mutation rather than leave a mixed model/thinking pair behind.
          throw new Block("capability", "Claude cannot verify a live thinking-level change; start a new session with the new pair");
        }
        if (change.model === undefined || change.model === live.model) {
          report({ setup: { model: live.model, thinking: spec.thinking, skills: [] } });
          return;
        }
        if (!query.applyFlagSettings) throw new Block("capability", "This Claude SDK cannot change a live model");
        try {
          // One native control call: model and effort (unchanged here) apply together or the call rejects.
          await query.applyFlagSettings({ model: nextModel });
        } catch (error) {
          // The SDK documents a rejected flag-settings merge as all-or-nothing; keep the previous verified pair.
          throw new Block("capability", `Claude refused the model switch: ${errorText(error)}`);
        }
        let actual: string | undefined;
        try { actual = (await withTimeout(query.getContextUsage?.({ detail: "summary" }), 5000))?.model; }
        catch { actual = undefined; }
        if (!actual || (actual !== change.model && actual !== await expectedModel(query, change.model))) {
          const error = new Block("runtime-invalidated", `Claude reported ${actual ?? "no model"} after switching to ${nextModel}; the live runtime is invalid`);
          await invalidate(error);
          throw error;
        }
        live.model = actual;
        report({ setup: { model: actual, thinking: spec.thinking, skills: [] } });
        report({ context: undefined });
        emit({ type: "log", text: `Claude model now ${actual}` });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        live.streaming = false;
        current?.resolve("aborted");
        current = undefined;
        input.end();
        try { query.close(); } catch { /* idempotent */ }
        report({ phase: "closed" });
      },
    };
  }
}

/** The exact options the production adapter passes to the pinned worker. Exported for tests and a real-worker harness. */
export function claudeOptions(spec: SessionSpec, server: unknown, env: Record<string, string>): Record<string, unknown> {
  const allowed = spec.tools.map((tool) => `mcp__worq__${tool.name}`);
  return {
    cwd: spec.cwd,
    env,
    abortController: new AbortController(),
    settingSources: [],
    systemPrompt: spec.system,
    tools: [],
    mcpServers: { worq: server },
    strictMcpConfig: true,
    plugins: [],
    agents: {},
    skills: [],
    permissionMode: "dontAsk",
    permissionPrompts: "none",
    allowedTools: allowed,
    canUseTool: async (name: string, input: Record<string, unknown>) => allowed.includes(name)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `Not a Worq tool: ${name}` },
    persistSession: false,
    includePartialMessages: true,
    model: spec.runtime.model,
    settings: { autoCompactEnabled: false, precomputeCompactionEnabled: false, idleCompaction: false, switchModelsOnFlag: false },
    verbatimPrompts: true,
    extraArgs: { "disable-slash-commands": null },
  };
}

function userMessage(text: string): unknown {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null };
}
function messageQueue() {
  const items: (unknown | undefined)[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    stream: (async function* () {
      for (;;) {
        if (!items.length) await new Promise<void>((resolve) => { wake = resolve; });
        const item = items.shift();
        if (item === undefined) return;
        yield item;
      }
    })(),
    push(item: unknown) { if (ended) throw new Block("ended", "Claude input is closed"); items.push(item); wake?.(); wake = undefined; },
    end() { ended = true; items.push(undefined); wake?.(); wake = undefined; },
  };
}
function withTimeout<T>(value: Promise<T> | undefined, ms: number): Promise<T> {
  if (!value) return Promise.reject(new Block("timeout", "not supported"));
  return Promise.race([value, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Block("timeout", "measurement timed out")), ms); timer.unref?.(); })]);
}

/** Load the optional SDK and its Zod peer lazily. Nothing here runs unless the adapter is selected. */
async function loadRealSdk(): Promise<ClaudeSdk> {
  const [sdk, z] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk").catch((error) => { throw new Error(errorText(error)); }),
    import("zod/v4").catch((error) => { throw new Error(`zod is required by the Claude adapter: ${errorText(error)}`); }),
  ]);
  type ToolFactory = (name: string, description: string, schema: unknown, handler: (args: unknown, extra?: unknown) => Promise<unknown>) => unknown;
  const tool = sdk.tool as unknown as ToolFactory;
  return {
    query: (args) => sdk.query(args as never) as unknown as ClaudeQuery,
    resolveSettings: (options) => sdk.resolveSettings(options as never) as unknown as Promise<ClaudeSettings>,
    createServer: (options) => sdk.createSdkMcpServer({
      name: options.name, version: options.version, timeout: options.timeout,
      tools: options.tools.map((entry) => tool(entry.name, entry.description, z.fromJSONSchema(entry.inputSchema as never), entry.handler as never)) as never,
    }),
  };
}
