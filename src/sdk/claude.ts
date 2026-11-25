import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Block, errorText } from "../contracts.ts";
import type { Observation } from "../telemetry.ts";
import type { Capabilities, Handle, PromptOutcome, Runtime, SDKAdapter, SessionEvent, SessionSpec, Tool } from "./contract.ts";
import type { HostServices } from "./registry.ts";

export interface MainSelection { model?: string; thinking?: string }
export interface ClaudeHost extends HostServices { main?(): MainSelection }

/** Structural seam: the native test replaces only process spawn, not the query, schema or MCP implementation. */
export interface ClaudeSdk {
  query(args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): ClaudeQuery;
  createServer(options: { name: string; version?: string; timeout?: number; tools: ClaudeServerTool[] }): unknown;
  resolveSettings(options: { cwd?: string; settingSources?: string[] }): Promise<ClaudeSettings>;
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
  [Symbol.asyncDispose]?(): Promise<void>;
  initializationResult(): Promise<unknown>;
  mcpServerStatus(): Promise<unknown>;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  getContextUsage(options: { detail: "summary" }): Promise<unknown>;
  supportedModels(): Promise<unknown>;
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

const ID = /^claude-[a-z0-9][a-z0-9._-]*$/i;
const ALIASES = ["sonnet", "opus", "haiku"];
const REF = /^(?:claude-[a-z0-9][a-z0-9._-]*|sonnet|opus|haiku|fable|default)(?:\[1m\])?$/i;
const LONG = "[1m]";
const SUMMARY = { detail: "summary" } as const;
const STARTUP_MS = 12_000;
const CATALOG_MS = 3_000;
const CONTROL_MS = 2_000;
export const BILLING_HEADER = /^x-anthropic-billing-header:/;
export const AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string => typeof value === "string" ? value : "";
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
const sameNames = (actual: unknown, expected: readonly string[]) => Array.isArray(actual)
  && actual.length === expected.length && new Set(actual).size === expected.length && expected.every((name) => actual.includes(name));
const long = (ref: string) => ref.toLowerCase().endsWith(LONG);
const base = (ref: string) => long(ref) ? ref.slice(0, -LONG.length) : ref;

export function mainClaudeModel(main: MainSelection | undefined): string | undefined {
  const ref = main?.model?.replace(/^anthropic\//, "");
  return ref && REF.test(ref) ? ref : undefined;
}
export function claudeThinking(_model: string | undefined): readonly string[] { return []; }

/** Keep native identity/login; never inherit provider, model or harness controls. */
export function workerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = new Set([
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "SHELL",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && keep.has(key)) env[key] = value;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_MAX_RETRIES = "0";
  // The pin has separate same-model refusal retry and fallback-model controls.
  env.CLAUDE_CODE_DISABLE_REFUSAL_RETRY = "1";
  env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = "1";
  env.DISABLE_TELEMETRY = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.ENABLE_TOOL_SEARCH = "false";
  return env;
}

/** Separate machine files, not entries in the settings cascade. They can take effect at worker startup. */
export async function managedFilesProblem(root = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
  : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode" : "/etc/claude-code"): Promise<string | undefined> {
  for (const name of ["managed-mcp.json", "CLAUDE.md"]) {
    try { await lstat(join(root, name)); return `machine policy provides ${name}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "machine policy files could not be inspected"; }
  }
  return undefined;
}

/** The one tier `settingSources: []` cannot remove. Unknown policy isn't assumed inert. */
export async function policyProblem(sdk: ClaudeSdk, cwd: string): Promise<string | undefined> {
  if (typeof sdk.resolveSettings !== "function") return "this Claude SDK cannot inspect managed policy, so isolation cannot be guaranteed";
  const files = await managedFilesProblem();
  if (files) return files;
  // The resolver runs in the host, but these overrides are stripped from the worker. Don't inspect a different policy.
  if (["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MANAGED_SETTINGS_PATH", "CLAUDE_CODE_REMOTE_SETTINGS_PATH", "CLAUDE_CODE_MOCK_REMOTE_SETTINGS"]
    .some((key) => process.env[key])) return "host configuration redirects managed policy inspection";
  let resolved: ClaudeSettings;
  try { resolved = await sdk.resolveSettings({ cwd, settingSources: [] }); }
  catch { return "managed policy could not be read"; }
  if (resolved?.machinePolicy?.didNotLoad !== false || !Array.isArray(resolved.sources)) return "managed policy could not be read, so isolation cannot be guaranteed";
  if (resolved.sources.some((source) => !record(source?.settings) || Object.keys(source.settings!).length)) return "managed settings could change Claude isolation";
  return undefined;
}

interface VerifiedModel { wire: string; selection: string }
function wireFor(ref: string, models: unknown): string {
  if (ID.test(base(ref))) return base(ref);
  if (!Array.isArray(models)) return "";
  const matches = models.map(record).filter((row) => string(row?.value).toLowerCase() === ref.toLowerCase());
  const rows = matches.length ? matches : long(ref) ? models.map(record).filter((row) => string(row?.value).toLowerCase() === base(ref).toLowerCase()) : [];
  const ids = new Set(rows.map((row) => string(row?.resolvedModel)));
  const id = [...ids][0];
  return ids.size === 1 && ID.test(id) ? id : "";
}
function verifiedModel(ref: string, models: unknown, value: unknown): VerifiedModel | undefined {
  const wire = wireFor(ref, models);
  const usage = record(value);
  if (!wire || usage?.model !== wire || (long(ref) && (windowSize(usage) ?? 0) < 1_000_000)) return undefined;
  return { wire, selection: long(ref) ? ref : wire };
}
const windowSize = (usage: Record<string, unknown> | undefined) => number(usage?.rawMaxTokens) ?? number(usage?.raw_max_tokens);

const STARTUP_REASONS = new Set([
  "org_pin_api_key_conflict", "provider_not_allowed", "org_verify_failed", "org_pin_mismatch", "managed_settings_invalid",
  "remote_settings_required_unavailable", "gateway_signin_required", "gateway_access_denied", "proxy_invalid", "temp_dir_unusable",
  "cwd_unavailable", "shell_tool_missing", "session_held_by_background", "worktree_resume_refused", "worktree_unverified",
  "cli_version_too_old", "bypass_root", "org_config_required_unavailable", "org_config_refused", "sandbox_required_unavailable",
  "initialize_not_first", "config_file_invalid", "managed_settings_not_delivered", "initialize_fields_not_delivered", "sideload_flags_disabled",
]);
const ASSISTANT_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error",
  "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens", "cloud_credential_error"]);
const known = (value: unknown, names: Set<string>) => names.has(string(value)) ? ` (${value})` : "";

/** Controls use one shared open deadline. Disarm each race as soon as the stage settles. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal, ms: number, problem: () => Block): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(problem());
      timer = setTimeout(abort, ms);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

function worker(api: ClaudeSdk, spec: SessionSpec, hooks: Record<string, unknown>, tools: ClaudeServerTool[]) {
  const input = messageQueue();
  const controller = new AbortController();
  let query: ClaudeQuery;
  try {
    const server = api.createServer({ name: "worq", version: "1.0.0", timeout: 24 * 60 * 60 * 1000, tools });
    query = api.query({ prompt: input.stream, options: { ...claudeOptions(spec, server, workerEnv()), abortController: controller, hooks } });
  } catch { input.end(); controller.abort(); throw new Block("sdk-error", "Claude could not start its worker or Worq MCP server"); }
  let closing: Promise<void> | undefined;
  return {
    input, query, signal: controller.signal,
    close() {
      if (closing) return closing;
      input.end();
      controller.abort();
      closing = (async () => {
        try {
          const dispose = query[Symbol.asyncDispose];
          if (dispose) await dispose.call(query);
          else query.close();
        } catch { try { query.close(); } catch { /* already dead */ } }
      })();
      return closing;
    },
  };
}

const hook = (callback: (input: unknown, id: unknown, options: { signal: AbortSignal }) => Promise<object>) =>
  [{ onFailure: "block", timeout: 12, hooks: [callback] }];
const blocked = { continue: false, stopReason: "Worq did not authorize this Claude request" };

export function claudeAdapter(host: HostServices = {}, injected?: ClaudeSdk): SDKAdapter {
  let pending: Promise<ClaudeSdk> | undefined;
  const sdk = (): Promise<ClaudeSdk> => {
    if (injected) return Promise.resolve(injected);
    pending ??= loadRealSdk().catch(() => {
      pending = undefined;
      throw new Block("sdk", "The Claude Agent SDK or its Zod dependency is not available. Install the pinned optional dependencies.");
    });
    return pending;
  };
  const model = (runtime: Runtime) => {
    if (!runtime.model || !REF.test(runtime.model)) throw new Block("model", `${runtime.path ? `${runtime.path}/model: ` : ""}Select a Claude model (claude-…, sonnet, opus or haiku; optional [1m])`);
    return runtime.model;
  };
  const defaultModel = () => { try { return mainClaudeModel(host.main?.()); } catch { return undefined; } };
  const checkPolicy = async (api: ClaudeSdk, cwd: string) => {
    const problem = await policyProblem(api, cwd);
    if (problem) throw new Block("policy", `Claude isolation refused: ${problem}`);
  };
  let catalog: { expires: number; values: Promise<readonly string[]> } | undefined;
  return {
    async models() {
      const api = await sdk(); // missing package: not a loadable backend
      if (!catalog || catalog.expires < Date.now()) {
        catalog = { expires: Date.now() + 30_000, values: listModels(api) };
      }
      return catalog.values;
    },
    defaultModel,
    capabilities(runtime): Capabilities {
      return { switchModel: true, thinking: claudeThinking(runtime.model), turnUnit: "request", requestAdmission: "awaited", context: { system: "replace", ambientInstructions: false } };
    },
    async validateRuntime(runtime, signal) {
      signal.throwIfAborted();
      model(runtime);
      if (runtime.thinking !== undefined) throw new Block("capability", `${runtime.path ? `${runtime.path}/thinking: ` : ""}Claude has no verified thinking-level control; omit thinking`);
      await checkPolicy(await sdk(), process.cwd());
      signal.throwIfAborted();
    },
    async open(spec) { return open(spec, await sdk()); },
  };

  async function listModels(api: ClaudeSdk): Promise<readonly string[]> {
    const cwd = process.cwd();
    const signal = AbortSignal.timeout(CATALOG_MS);
    let session: ReturnType<typeof worker> | undefined;
    const choices = new Set<string>();
    try {
      await bounded(checkPolicy(api, cwd), signal, CATALOG_MS, () => new Block("policy", "Claude policy inspection timed out"));
      if (signal.aborted) return ALIASES;
      session = worker(api, { cwd, signal, tools: [], system: "Worq model catalog (no prompts)", id: "catalog", name: "catalog", emit() {},
        runtime: { name: "launch", sdk: "claude-code", model: defaultModel() ?? "opus", via: "catalog", path: "" } },
      { UserPromptSubmit: hook(async () => blocked), PostToolBatch: hook(async () => blocked) }, []);
      const { query } = session;
      // EOF/failure must not leave the catalog waiting on dead controls.
      const eof = (async () => { for await (const _ of query) { /* no turn */ } throw new Error(); })();
      const control = <T>(p: Promise<T>) => bounded(Promise.race([p, eof]), signal, CATALOG_MS, () => new Block("timeout", "Claude model catalog timed out"));
      await control(query.initializationResult());
      const rows = await control(query.supportedModels());
      if (!Array.isArray(rows)) return ALIASES;
      for (const row of rows.map(record)) {
        const ref = string(row?.value), resolved = string(row?.resolvedModel);
        if (!REF.test(ref) || !ID.test(resolved) || (ID.test(base(ref)) && base(ref) !== resolved)) continue;
        if (!long(ref)) choices.add(resolved);
      }
      for (const row of rows.map(record)) {
        const ref = string(row?.value), resolved = string(row?.resolvedModel);
        if (!REF.test(ref) || !long(ref) || wireFor(ref, rows) !== resolved || !resolved || !query.applyFlagSettings) continue;
        await control(query.applyFlagSettings({ model: ref }));
        if (verifiedModel(ref, rows, await control(query.getContextUsage(SUMMARY)))) choices.add(ref);
      }
    } catch { /* advisory only; keep any verified choices */ }
    finally { void session?.close(); }
    return choices.size ? [...choices] : ALIASES;
  }

  async function open(spec: SessionSpec, api: ClaudeSdk): Promise<Handle> {
    const cancelled = () => new Block("cancelled", "Claude open cancelled");
    if (spec.signal.aborted) throw cancelled();
    const requested = model(spec.runtime);
    if (spec.thinking !== undefined || spec.runtime.thinking !== undefined) throw new Block("capability", "Claude has no verified thinking-level control; omit thinking");
    const deadline = performance.now() + STARTUP_MS;
    const timed = (stage: string) => new Block("sdk-error", `Claude startup could not verify ${stage} before its deadline`);
    await bounded(checkPolicy(api, spec.cwd), spec.signal, STARTUP_MS, () => spec.signal.aborted ? cancelled() : timed("managed policy"));
    if (spec.signal.aborted) throw cancelled();

    type Active = {
      signal: AbortSignal; text: string; entered: boolean; terminating: boolean; stopping?: Promise<void>;
      gate?: boolean; denied?: PromptOutcome; sessionId?: string; promptId?: string; done: Promise<PromptOutcome>; resolve(value: PromptOutcome): void;
      views: Set<string>; sample?: Sample;
    };
    type Sample = { start: number; input?: number; read?: number; write?: number; output?: number; ended: boolean };
    let active: Active | undefined;
    let latest: Active | undefined;
    let starting = false;
    let closed = false;
    let ending = false;
    const endingSignal = new AbortController();
    let ready = false;
    let fatal: Block | undefined;
    let setup: VerifiedModel;
    let models: unknown;
    let nextCall = 0;
    let queue: Promise<unknown> = Promise.resolve();
    let rejectStartup!: (error: Block) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStartup = reject; });
    void stopped.catch(() => {});
    const bare = spec.tools.map((tool) => tool.name);
    const qualified = bare.map((name) => `mcp__worq__${name}`);
    const emit = (event: SessionEvent) => { if (!closed) try { spec.emit(event); } catch { /* display only */ } };
    const report = (value: Observation) => emit({ type: "telemetry", value });
    const log = (text: string) => emit({ type: "log", text });

    const refuse = (turn: Active | undefined, outcome: PromptOutcome = "failed") => {
      if (turn && active === turn) { turn.denied ??= outcome; turn.sample = undefined; }
      return blocked;
    };
    const session = worker(api, spec, {
      UserPromptSubmit: hook(async (input, _, { signal }) => {
        const turn = active, data = record(input);
        // The pinned worker passes the whole prompt trimmed to UserPromptSubmit. Do not
        // normalize the hook payload, change the submitted text, or ignore interior whitespace.
        if (!ready || !turn || turn.entered || !usable(turn, signal) || data?.hook_event_name !== "UserPromptSubmit"
          || data.prompt !== turn.text.trim() || data.permission_mode !== "dontAsk" || !string(data.session_id) || !string(data.prompt_id)
          || data.agent_id !== undefined || data.agent_type !== undefined
          || (data.source !== undefined && data.source !== "sdk" && data.source !== "user")) return refuse(turn);
        turn.sessionId = string(data.session_id);
        turn.promptId = string(data.prompt_id);
        turn.entered = true;
        return {};
      }),
      PostToolBatch: hook(async (input, _, { signal }) => {
        const turn = active, data = record(input);
        if (!turn?.entered || !usable(turn, signal) || turn.gate || data?.hook_event_name !== "PostToolBatch"
          || data.session_id !== turn.sessionId || data.prompt_id !== turn.promptId || data.permission_mode !== "dontAsk"
          || data.agent_id !== undefined || data.agent_type !== undefined || !Array.isArray(data.tool_calls) || !data.tool_calls.length) return refuse(turn, turn?.terminating || turn?.signal.aborted ? "aborted" : "failed");
        turn.gate = true;
        try {
          const result = spec.admitRequest ? await bounded(spec.admitRequest(turn.signal), AbortSignal.any([signal, turn.signal, endingSignal.signal, session.signal]),
            8_000, () => new Block("admission", "Claude continuation admission did not complete")) : { allowed: true };
          if (!result.allowed || !usable(turn, signal)) {
            log("Claude continuation refused by request admission");
            return refuse(turn, "aborted");
          }
          return {};
        } catch {
          log("Claude continuation stopped while awaiting request admission");
          return refuse(turn, turn.signal.aborted ? "aborted" : "failed");
        } finally { turn.gate = false; }
      }),
    }, spec.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters,
      handler: (args, extra) => dispatch(active, tool, args, extra?.signal) })));
    const { input, query } = session;
    const cancel = () => {
      if (!ready) rejectStartup(cancelled());
      end();
    };
    spec.signal.addEventListener("abort", cancel, { once: true });
    void consume();

    try {
      const control = async <T>(stage: string, get: () => Promise<T>) => {
        const expired = timed(stage);
        try { return await bounded(Promise.race([get(), stopped]), spec.signal, Math.max(0, deadline - performance.now()), () => expired); }
        catch (error) {
          if (spec.signal.aborted) throw cancelled();
          if (fatal) throw fatal;
          if (error === expired) throw expired;
          throw new Block("sdk-error", `Claude startup failed during ${stage}`);
        }
      };
      const init = record(await control("control initialization", () => query.initializationResult()));
      if (init?.hooks_applied !== true || init.hook_on_failure_supported !== true || init.current_permission_mode !== "dontAsk" || !empty(init.commands)) {
        throw new Block("capability", "Claude did not verify blocking hooks, dontAsk permission and an empty command inventory");
      }
      models = init.models;
      const servers = await control("Worq MCP status", () => query.mcpServerStatus());
      if (!exactMcp(servers, bare)) throw new Block("capability", "Claude did not verify the exact SDK-owned Worq MCP tools");
      const usage = record(await control("isolated model/context read-back", () => query.getContextUsage(SUMMARY)));
      if (!usage || !empty(usage.memoryFiles) || !empty(usage.agents)
        || (usage.systemTools !== undefined && !empty(usage.systemTools)) || (usage.deferredBuiltinTools !== undefined && !empty(usage.deferredBuiltinTools))
        || (usage.skills !== undefined && record(usage.skills)?.totalSkills !== 0)) {
        throw new Block("capability", "Claude did not verify isolated agent, memory and tool context");
      }
      const checked = verifiedModel(requested, models, usage);
      if (!checked) throw new Block("model", "Claude could not verify the selected model and context option");
      if (spec.signal.aborted) throw cancelled();
      if (closed || fatal) throw fatal ?? new Block("sdk-error", "Claude worker ended during startup");
      setup = checked;
      ready = true;
      report({ setup: { model: setup.wire, skills: [] } });
      report({ phase: "idle" });
      if (spec.signal.aborted) throw cancelled();
    } catch (error) {
      close("failed");
      await bounded(session.close(), new AbortController().signal, 4_000, () => new Block("sdk-error", "Claude startup failed and worker shutdown was not confirmed")).catch(() => {});
      throw error;
    }

    function usable(turn: Active, signal?: AbortSignal) {
      return !closed && !ending && !fatal && active === turn && !turn.signal.aborted && !signal?.aborted && !turn.terminating && !turn.stopping && !turn.denied;
    }
    function settle(outcome: PromptOutcome) {
      const turn = active;
      active = undefined;
      if (turn) { turn.sample = undefined; turn.resolve(outcome); }
      report({ phase: "idle" });
    }
    function close(outcome: PromptOutcome) {
      if (closed) return;
      closed = true;
      spec.signal.removeEventListener("abort", cancel);
      settle(outcome);
      if (ready) try { spec.emit({ type: "telemetry", value: { phase: "closed" } }); } catch { /* display only */ }
      void session.close();
    }
    function end() {
      if (closed || ending) return;
      ending = true;
      endingSignal.abort();
      // Give an outstanding hook the chance to send its stop verdict before closing stdio.
      // The worker can treat loss of the control transport differently from a hook refusal.
      if (active) void stopTurn().then(() => close("aborted"));
      else close("aborted");
    }
    function fail(block: Block) {
      fatal ??= block;
      if (!ready) rejectStartup(fatal);
      else log(fatal.message);
      if (active?.gate && !ending) end();
      else close("failed");
    }
    function stopTurn(turn = active): Promise<void> {
      if (!turn || turn !== active) return Promise.resolve();
      turn.sample = undefined;
      turn.denied ??= "aborted";
      turn.stopping ??= (async () => {
        // In a PostToolBatch callback, returning a stop verdict is the interrupt. Otherwise interrupt now,
        // but only release the prompt after the matching result (never on the interrupt ACK).
        if (!turn.gate) void query.interrupt().catch(() => {});
        try { await bounded(turn.done, session.signal, 4_000, () => new Block("runtime-invalidated", "Claude did not confirm turn shutdown; start a new session")); }
        catch (error) { if (!closed) fail(error as Block); }
      })();
      return turn.stopping;
    }

    function dispatch(turn: Active | undefined, tool: Tool, args: unknown, toolSignal?: AbortSignal): Promise<unknown> {
      const work = queue.then(async () => {
        if (!turn?.entered || !usable(turn, toolSignal)) return { isError: true, content: [{ type: "text", text: "Worq tool dispatch is closed" }] };
        const signal = AbortSignal.any([turn.signal, session.signal, ...(toolSignal ? [toolSignal] : [])]);
        const call = String(++nextCall);
        report({ start: call, name: tool.name });
        emit({ type: "tool-start", name: tool.name, args });
        let outcome: import("../telemetry.ts").Outcome = { kind: "ok" };
        try {
          const out = await tool.run(args, signal, (value) => { outcome = value; });
          const value = typeof out === "string" ? { text: out } : out;
          const content = [{ type: "text", text: value.text }, ...(value.image ? [{ type: "image", ...value.image }] : [])];
          if (value.terminate) {
            // Tools may run before message_stop. Fence siblings now; the batch hook stops the
            // continuation without cutting off the terminal response's usage. Backstop a stuck turn.
            turn.terminating = true;
            void bounded(turn.done, session.signal, 2_000, () => new Block("timeout", "Claude submit is still settling"))
              .catch(() => stopTurn(turn));
          }
          return { content };
        } catch (error) {
          if (error instanceof Block && error.code === "runtime-invalidated") fail(error);
          const message = errorText(error);
          outcome = { kind: "sdk-error" };
          emit({ type: "tool-error", name: tool.name, message });
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        } finally { report({ end: call, outcome }); }
      });
      queue = work.catch(() => {});
      return work;
    }

    async function consume() {
      try {
        for await (const message of query) {
          if (closed) return;
          if (!ready) {
            if (message.type === "result") fail(new Block("sdk-error", `Claude worker ended before readiness${known(message.startup_failure_reason, STARTUP_REASONS)}`));
            continue;
          }
          const turn = active;
          if (message.type === "system" && message.subtype === "api_retry") {
            fail(new Block("runtime-invalidated", "Claude requested a native API retry despite retry controls; worker closed"));
          } else if (turn && message.type === "system" && message.subtype === "init") {
            const servers = message.mcp_servers;
            if (base(string(message.model)) !== setup.wire || message.permissionMode !== "dontAsk" || !sameNames(message.tools, qualified)
              || !Array.isArray(servers) || servers.length !== 1 || record(servers[0])?.source !== "sdk" || record(servers[0])?.name !== "worq"
              || record(servers[0])?.status !== "connected" || !empty(message.skills) || !empty(message.slash_commands) || !builtinPlugins(message.plugins)) {
              fail(new Block("runtime-invalidated", "Claude turn metadata contradicted verified isolation or model"));
            }
          } else if (turn && message.type === "stream_event" && message.parent_tool_use_id === null) {
            const event = record(message.event);
            if (event && turn.entered && !turn.signal.aborted && !turn.stopping && !turn.denied) response(turn, event);
          } else if (turn && message.type === "assistant" && message.parent_tool_use_id === null) {
            if (message.error) {
              log(`Claude response failed${known(message.error, ASSISTANT_ERRORS)}`);
              refuse(turn);
            } else if (usable(turn)) {
              const content = record(message.message)?.content;
              if (Array.isArray(content)) for (const item of content) {
                const block = record(item);
                if (block?.type === "text" && string(block.text).trim()) emit({ type: "text", text: string(block.text), completed: true });
              }
            }
          } else if (turn && message.type === "result") {
            if (message.is_error === true && !turn.denied) log(`Claude request failed${known(message.startup_failure_reason, STARTUP_REASONS)}; provider detail omitted`);
            const outcome = turn.denied ?? (!turn.entered || message.is_error !== false ? "failed" : "completed");
            settle(outcome);
            if (outcome === "completed" || turn.terminating) void context(turn);
          }
        }
      } catch { /* Raw SDK errors can contain stderr, credentials, or prompt text. */ }
      if (!closed) fail(new Block("sdk-error", ready ? "Claude worker stream ended" : "Claude worker stream ended during startup"));
    }
    function response(turn: Active, event: Record<string, unknown>) {
      if (event.type === "message_start") {
        const message = record(event.message), id = string(message?.id);
        if (!id || turn.views.has(id)) return;
        turn.views.add(id);
        const usage = record(message?.usage);
        turn.sample = { start: performance.now(), input: number(usage?.input_tokens), read: number(usage?.cache_read_input_tokens),
          write: number(usage?.cache_creation_input_tokens), ended: false };
        emit({ type: "response-start" });
        emit({ type: "turn" });
        report({ turn: true });
      } else if (event.type === "message_delta" && turn.sample) {
        const reason = string(record(event.delta)?.stop_reason);
        if (reason) {
          turn.sample.ended = reason === "end_turn" || reason === "tool_use" || reason === "stop_sequence";
          turn.sample.output = number(record(event.usage)?.output_tokens);
        }
      } else if (event.type === "message_stop" && turn.sample) {
        const { start, input, read, write, output, ended } = turn.sample;
        turn.sample = undefined;
        emit({ type: "response", completed: ended });
        if (ended && (input !== undefined || read !== undefined || write !== undefined || output !== undefined)) {
          report({ cache: { read, write, input, speed: output === undefined ? undefined : output / Math.max(0.001, (performance.now() - start) / 1000) } });
        }
      }
    }
    async function context(turn: Active) {
      const snapshot = setup;
      try {
        const value = record(await bounded(query.getContextUsage(SUMMARY), session.signal, CONTROL_MS, () => new Block("timeout", "Claude context unavailable")));
        const contextWindow = windowSize(value);
        if (!active && latest === turn && setup === snapshot && value?.model === snapshot.wire && contextWindow) {
          report({ context: { percent: number(value?.percentage), contextWindow } });
        }
      } catch { /* Advisory measurement. */ }
    }

    return {
      async prompt(text, signal = new AbortController().signal) {
        if (fatal) throw fatal;
        if (closed || ending) throw new Block("ended", "Claude session is closed");
        if (active || starting) throw new Block("busy", "Claude session is already streaming");
        if (signal.aborted) return "aborted";
        starting = true;
        try {
          if (spec.admitRequest && !(await spec.admitRequest(signal)).allowed) {
            log("Claude request refused by admission; nothing was released");
            return "aborted";
          }
          if (closed || fatal) throw fatal ?? new Block("ended", "Claude session closed before its request");
          if (signal.aborted) return "aborted";
          let resolve!: Active["resolve"];
          const done = new Promise<PromptOutcome>((r) => { resolve = r; });
          const turn: Active = { text, signal, entered: false, terminating: false, done, resolve, views: new Set() };
          active = turn;
          latest = turn;
          const abort = () => { void stopTurn(turn); };
          signal.addEventListener("abort", abort, { once: true });
          try {
            report({ phase: "request" });
            if (usable(turn)) input.push(userMessage(text));
            else if (active === turn) settle("aborted");
            return await done;
          } finally { signal.removeEventListener("abort", abort); }
        } finally { starting = false; }
      },
      get streaming() { return !!active; },
      abort: () => stopTurn(),
      get selection() { return { model: setup.selection }; },
      async configure(change) {
        if (fatal) throw fatal;
        if (closed) throw new Block("ended", "Claude session is closed");
        if (change.thinking !== undefined) throw new Block("capability", "Claude cannot verify a live thinking-level change");
        if (!change.model || !REF.test(change.model)) throw new Block("model", "Select a supported Claude model ref");
        if (change.model === setup.selection) return;
        if (!wireFor(change.model, models) || !query.applyFlagSettings) throw new Block("model", "Claude cannot verify the requested live model ref");
        const next = change.model;
        const previous = setup;
        const boundedControl = <T>(p: Promise<T>) => bounded(p, session.signal, CONTROL_MS, () => new Block("timeout", "Claude model control timed out"));
        let rejected = false;
        try { await boundedControl(query.applyFlagSettings({ model: next })); } catch (error) {
          if (!(error instanceof Block && error.code === "timeout")) rejected = true;
          else { const problem = new Block("runtime-invalidated", "Claude model switch did not confirm application; worker closed"); fail(problem); throw problem; }
        }
        const applied = await boundedControl(query.getContextUsage(SUMMARY)).catch(() => undefined);
        if (!closed && rejected && verifiedModel(previous.selection, models, applied)) throw new Block("capability", "Claude refused the model switch; the previous selection is still in effect");
        const verified = !closed && !rejected && verifiedModel(next, models, applied);
        if (!verified) {
          const problem = new Block("runtime-invalidated", "Claude could not verify the live model switch; worker closed");
          report({ setup: { model: undefined, skills: [] } });
          fail(problem);
          throw problem;
        }
        setup = verified;
        report({ setup: { model: setup.wire, skills: [] } });
        report({ context: undefined });
      },
      dispose: end,
    };
  }
}

function builtinPlugins(value: unknown) {
  return Array.isArray(value) && value.every((item) => {
    const plugin = record(item), name = string(plugin?.name);
    return name && plugin?.path === "builtin" && plugin.source === `${name}@builtin`;
  });
}

function exactMcp(value: unknown, names: string[]) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const server = record(value[0]);
  return server?.name === "worq" && server.source === "sdk" && server.status === "connected" && Array.isArray(server.tools)
    && sameNames(server.tools.map((tool: unknown) => record(tool)?.name), names);
}

/** Shared by conversation and catalog workers. No CLI tools, default prompt or ambient settings. */
export function claudeOptions(spec: SessionSpec, server: unknown, env: Record<string, string>): Record<string, unknown> {
  const allowed = spec.tools.map((tool) => `mcp__worq__${tool.name}`);
  return {
    cwd: spec.cwd, env, settingSources: [], systemPrompt: spec.system, tools: [],
    mcpServers: { worq: server }, strictMcpConfig: true, plugins: [], agents: {}, skills: [],
    permissionMode: "dontAsk", permissionPrompts: "none", allowedTools: allowed,
    canUseTool: async (name: string, input: Record<string, unknown>) => allowed.includes(name)
      ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Not a Worq tool" },
    persistSession: false, includePartialMessages: true, model: spec.runtime.model,
    settings: { autoCompactEnabled: false, precomputeCompactionEnabled: false, idleCompaction: false, switchModelsOnFlag: false },
    verbatimPrompts: true, extraArgs: { "disable-slash-commands": null },
  };
}

function userMessage(text: string): unknown {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null };
}
function messageQueue() {
  const items: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    stream: (async function* () {
      while (!ended) {
        if (!items.length) await new Promise<void>((resolve) => { wake = resolve; });
        if (!ended) yield items.shift();
      }
    })(),
    push(item: unknown) { if (ended) throw new Block("ended", "Claude input is closed"); items.push(item); wake?.(); wake = undefined; },
    end() { ended = true; items.length = 0; wake?.(); wake = undefined; },
  };
}

/** Load optional packages lazily. `spawn` is a local-only fixture seam, never taken from config. */
export async function loadRealSdk(spawn?: import("@anthropic-ai/claude-agent-sdk").Options["spawnClaudeCodeProcess"]): Promise<ClaudeSdk> {
  const [sdk, z] = await Promise.all([import("@anthropic-ai/claude-agent-sdk"), import("zod/v4")]);
  type ToolFactory = (name: string, description: string, schema: unknown, handler: (args: unknown, extra?: unknown) => Promise<unknown>) => unknown;
  const tool = sdk.tool as unknown as ToolFactory;
  return {
    query: ({ prompt, options }) => sdk.query({ prompt, options: { ...options, ...(spawn ? { spawnClaudeCodeProcess: spawn } : {}) } } as never) as unknown as ClaudeQuery,
    resolveSettings: (options) => sdk.resolveSettings(options as never) as unknown as Promise<ClaudeSettings>,
    createServer: (options) => sdk.createSdkMcpServer({
      name: options.name, version: options.version, timeout: options.timeout,
      tools: options.tools.map((entry) => tool(entry.name, entry.description, z.fromJSONSchema(entry.inputSchema as never), entry.handler as never)) as never,
    }),
  };
}
