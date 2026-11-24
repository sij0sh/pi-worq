import {
  createAgentSession, createExtensionRuntime, defineTool, SessionManager, SettingsManager,
  type ExtensionContext, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Block } from "../contracts.ts";
import { label, type Outcome } from "../telemetry.ts";
import type { Capabilities, Handle, Runtime, SDKAdapter, SessionSpec, Tool } from "./contract.ts";

/** Main's live selection and model registry, plus the agent dir for auth. */
export type PiHost = Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel"> & { agentDir?: string };

const REF = /^[^/\s]+\/\S+$/;
const CORE_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const EXTRA_LEVELS = ["xhigh", "max"] as const;
type Level = (typeof CORE_LEVELS)[number] | (typeof EXTRA_LEVELS)[number];
type Leveled = { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> };
/** The same list `getSupportedThinkingLevels` derives: ["off"] when the model cannot reason, [] when it cannot be told. */
export function thinkingLevels(model: Leveled | undefined): string[] {
  if (!model) return [];
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return [...CORE_LEVELS.filter((level) => map[level] !== null), ...EXTRA_LEVELS.filter((level) => map[level] != null)];
}

/** Only the prepared system prompt and tools: no ambient discovery, no extensions. */
function loader(prompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
}
function sdkTool(tool: Tool, outcomes: Map<string, Outcome>) {
  return defineTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters, executionMode: "sequential",
    async execute(id, params, signal) {
      const live = signal ?? new AbortController().signal;
      if (live.aborted) outcomes.set(id, { kind: "cancelled" });
      live.throwIfAborted();
      const out = await tool.run(params, live, (value) => { outcomes.set(id, value); });
      const value = typeof out === "string" ? { text: out } : out;
      const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [{ type: "text", text: value.text }];
      if (value.image) content.push({ type: "image", ...value.image });
      return { content, details: undefined, terminate: value.terminate ?? false };
    },
  });
}

/** Pi SDK sessions in memory, one per Worq conversation. Runtime model, else Main's model. */
export function piAdapter(host: PiHost | undefined): SDKAdapter {
  if (!host) throw new Block("config", "The pi sdk needs a Pi host (Main's model registry)");
  const find = (ref: string, key: string) => {
    if (!REF.test(ref)) throw new Block("model", `${key}: ${ref} is not a Pi model ref (provider/model)`);
    const slash = ref.indexOf("/");
    const model = host.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
    if (!model) throw new Block("model", `${key}: Pi does not know model ${ref}`);
    return model;
  };
  const at = (runtime: Runtime) => runtime.path ? `${runtime.path}/model` : "model";
  const primary = (runtime: Runtime) => runtime.model ? find(runtime.model, at(runtime)) : host.model;
  // Main's model runtime carries extension-registered providers and auth; share it when the host exposes it.
  const modelRuntime = (host.modelRegistry as unknown as { runtime?: unknown }).runtime;

  return {
    async models() { return host.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`); },
    defaultModel() { const m = host.model; return m && `${m.provider}/${m.id}`; },
    defaultThinking() { return host.thinkingLevel; },
    capabilities(runtime): Capabilities {
      return {
        switchModel: true, thinking: thinkingLevels(primary(runtime)), turnUnit: "request",
        context: { system: "replace", ambientInstructions: false },
      };
    },
    /** Registry lookup only: no session, request or credential probe. */
    validateRuntime(runtime) {
      if (!primary(runtime)) throw new Block("model", "Select a Pi model in this session or pass a model (provider/model)");
    },
    async open(spec: SessionSpec): Promise<Handle> {
      const { runtime } = spec;
      const model = primary(runtime);
      if (!model) throw new Block("model", "Select a Pi model in this session or pass a model (provider/model)");
      const level = spec.thinking as Level | undefined;
      const outcomes = new Map<string, Outcome>();
      const calls = new Map<string, string>();
      let nextCall = 0;
      const tools = spec.tools.map((tool) => sdkTool(tool, outcomes));
      const names = new Set(tools.map((tool) => tool.name));
      const report = (value: import("../telemetry.ts").Observation) => spec.emit({ type: "telemetry", value });
      const resources = loader(spec.system);
      spec.signal.throwIfAborted();
      spec.emit({ type: "log", text: `Pi model ${model.provider}/${model.id}` });
      const { session } = await createAgentSession({
        cwd: spec.cwd, model, ...(level ? { thinkingLevel: level } : {}), resourceLoader: resources,
        tools: tools.map((t) => t.name), customTools: tools,
        ...(host.agentDir ? { agentDir: host.agentDir } : {}),
        ...(modelRuntime ? { modelRuntime: modelRuntime as never } : {}),
        sessionManager: SessionManager.inMemory(spec.cwd),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      const beforeRequest = spec.beforeRequest;
      if (beforeRequest) {
        const prepare = session.agent.prepareRequest;
        // Pi's prepareRequest reads session state for every request, after previous tools settle.
        session.agent.prepareRequest = async (request, signal) => {
          await beforeRequest(signal ?? spec.signal);
          return (await prepare?.(request, signal)) ?? undefined;
        };
      }
      const selection = () => ({ model: session.model && `${session.model.provider}/${session.model.id}`, thinking: session.thinkingLevel });
      const setup = () => { try { const { model, thinking } = selection(); report({ setup: { model: label(model), thinking: label(thinking), skills: [] } }); } catch { /* display only */ } };
      const context = () => {
        try {
          const usage = session.getContextUsage();
          report({ context: usage && {
            percent: typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : undefined,
            contextWindow: usage.contextWindow,
          } });
        } catch { report({ context: undefined }); }
      };
      const seen = new WeakSet<object>();
      let started: number | undefined;
      let failed = false;
      setup();
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_start") { report({ phase: "request" }); context(); report({ turn: true }); spec.emit({ type: "turn" }); }
        if (event.type === "tool_execution_start") {
          const id = String(++nextCall);
          calls.set(event.toolCallId, id);
          report({ start: id, name: names.has(event.toolName) ? event.toolName : "unknown tool" });
          spec.emit({ type: "tool-start", name: event.toolName, args: event.args });
        }
        if (event.type === "tool_execution_end") {
          const id = calls.get(event.toolCallId);
          if (id) report({ end: id, outcome: outcomes.get(event.toolCallId) ?? { kind: event.isError ? "sdk-error" : "ok" } });
          calls.delete(event.toolCallId);
          outcomes.delete(event.toolCallId);
          if (event.isError) {
            const content = event.result?.content as { type: string; text?: string }[] | undefined;
            spec.emit({ type: "tool-error", name: event.toolName, message: content?.flatMap((c) => c.type === "text" ? [c.text ?? ""] : []).join(" ") || "error" });
          }
        }
        if (event.type === "message_start" && event.message.role === "assistant") started = performance.now();
        if (event.type === "message_end" && event.message.role === "assistant" && !seen.has(event.message)) {
          seen.add(event.message);
          const { usage, stopReason } = event.message;
          const completed = stopReason !== "error" && stopReason !== "aborted";
          failed = stopReason === "error";
          if (failed) {
            // Record a bounded status code only; provider bodies can contain credentials or prompt text.
            const status = event.message.errorMessage?.match(/^(?:HTTP(?: error)?\s+)?([45]\d{2})(?:\b|:)/i)?.[1];
            spec.emit({ type: "log", text: status ? `Pi assistant error (reported HTTP status ${status})` : "Pi assistant ended with stopReason=error" });
          }
          if (completed) report({ cache: { read: usage?.cacheRead, write: usage?.cacheWrite, input: usage?.input, speed: started !== undefined && usage?.output > 0 ? usage.output * 1000 / Math.max(1, performance.now() - started) : undefined } });
          const said = (event.message.content as { type: string; text?: string }[]).flatMap((c) => c.type === "text" && c.text?.trim() ? [c.text] : []).join(" ");
          if (said) spec.emit({ type: "text", text: said, completed });
        }
        if (event.type === "agent_end") { outcomes.clear(); calls.clear(); }
        if (event.type === "agent_end" || event.type === "compaction_end") { report({ phase: "idle" }); context(); }
      });
      return {
        async prompt(text) {
          failed = false;
          let began = false;
          try { await session.prompt(text, { preflightResult: (state) => { began = state === "started"; } }); }
          catch {
            spec.emit({ type: "log", text: began ? "Pi prompt threw after request admission" : "Pi prompt threw before request admission" });
            if (began) throw new Block("model", "Pi prompt failed after request admission");
            return "preflight-failed";
          }
          return failed ? "failed" : "completed";
        },
        async steer(text) {
          const outcome = await session.steer(text, undefined, { source: "extension" });
          if (outcome !== "queued") throw new Block("steer", `Pi did not queue the message (${outcome})`);
        },
        get streaming() { return session.isStreaming; },
        abort: () => session.abort(),
        get selection() { return selection(); },
        async configure(change) {
          const next = change.model !== undefined ? find(change.model, at(runtime)) : undefined;
          const level = (change.thinking ?? session.thinkingLevel) as Level;
          // setModel keeps the conversation, tool results and session identity.
          if (next) await session.setModel(next);
          session.setThinkingLevel(level);
          setup(); report({ context: undefined });
        },
        dispose() { report({ phase: "closed" }); outcomes.clear(); calls.clear(); unsubscribe(); session.dispose(); },
      };
    },
  };
}
