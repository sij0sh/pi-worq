import { label, observe, type Outcome } from './telemetry.ts';
import { applyResources } from "./resources.ts";
import {
  createAgentSession, createExtensionRuntime, defineTool, SessionManager, SettingsManager,
  type ExtensionContext, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Block, parse } from "./contracts.ts";
import type { Config } from "./config.ts";
import type { Capabilities, Driver, Handle, Spec, Tool } from "./session.ts";

const CORE_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const EXTRA_LEVELS = ["xhigh", "max"] as const;
/** The level strings Pi accepts; Pi clamps a level the chosen model does not support. */
type Level = (typeof CORE_LEVELS)[number] | (typeof EXTRA_LEVELS)[number];
type Leveled = { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> };
/** The same list `getSupportedThinkingLevels` derives: ["off"] when the model cannot reason, [] when it cannot be told. */
export function thinkingLevels(model: Leveled | undefined): string[] {
  if (!model) return [];
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return [...CORE_LEVELS.filter((level) => map[level] !== null), ...EXTRA_LEVELS.filter((level) => level in map)];
}

/** Only Worq's own system prompt and tools: no extensions, skills, AGENTS.md or prompt templates. */
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
function sdkTool(tool: Tool, outcomes: Map<string, Outcome>) {
  return defineTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters, executionMode: "sequential",
    async execute(id, params, signal) {
      const live = signal ?? new AbortController().signal;
      if (live.aborted) outcomes.set(id, { kind: 'cancelled' });
      live.throwIfAborted();
      const out = await tool.run(parse(tool.parameters, params, tool.name), live, value => { outcomes.set(id, value); });
      const value = typeof out === "string" ? { text: out } : out;
      const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [{ type: "text", text: value.text }];
      if (value.image) content.push({ type: "image", ...value.image });
      return { content, details: undefined, terminate: value.terminate ?? false };
    },
  });
}

/** Pi SDK sessions in memory, one per Worq conversation. Models come from pi-worq.json, else Main's model. */
export function piDriver(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, config: Config): Driver {
  const resolve = (ref?: string, key?: string) => {
    if (!ref) return undefined;
    const slash = ref.indexOf("/");
    const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
    if (!model) throw new Block("config", `${config.path}: Pi does not know model ${ref}${key ? ` (${key})` : ""}`);
    return model;
  };
  const effective = (name: string) => {
    const choice = config.model(name);
    return { choice, model: resolve(choice.model, choice.from.model) ?? ctx.model };
  };
  const capabilities = (name: string): Capabilities => {
    const { model } = effective(name);
    return {
      resources: ["skills", "instructions", "extensions"], fallback: true,
      thinking: thinkingLevels(model),
      context: { system: "replace", ambientInstructions: false },
    };
  };
  const driver = (async (spec: Spec): Promise<Handle> => {
    const { choice, model } = effective(spec.name);
    const level: Level = (choice.thinking as Level | undefined) ?? "low";
    let fallback = resolve(choice.fallbackModel);
    if (!model) throw new Block("model", "Select a Pi model or set model in pi-worq.json");
    if (fallback && fallback.provider === model.provider && fallback.id === model.id) fallback = undefined;
    let nextCall = 0;
    const calls = new Map<string, string>();
    const outcomes = new Map<string, Outcome>();
    const tools = spec.tools.map(tool => sdkTool(tool, outcomes));
    const names = new Set(tools.map(tool => tool.name));
    const report = (value: import('./telemetry.ts').Observation) => observe(spec.observe, value);
    const loader = resources(spec.system);
    const skills = await applyResources(loader, spec.system, config.path, choice.resources);
    spec.log(`Role ${spec.name}: ${model.provider}/${model.id}, thinking ${level}; sources ${JSON.stringify(choice.from)}`);
    const { session } = await createAgentSession({
      cwd: spec.cwd, model, thinkingLevel: level, resourceLoader: loader,
      tools: tools.map((t) => t.name), customTools: tools,
      sessionManager: SessionManager.inMemory(spec.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    const setup = () => { try { report({ setup: { model: label(session.model && session.model.provider + '/' + session.model.id), thinking: label(session.thinkingLevel), skills } }); } catch { /* display only */ } };
    const context = () => {
      if (!spec.observe) return;
      try {
        const usage = session.getContextUsage();
        report({ context: usage && {
          percent: typeof usage.percent === 'number' && Number.isFinite(usage.percent) ? usage.percent : undefined,
          contextWindow: usage.contextWindow,
        } });
      } catch { report({ context: undefined }); }
    };
    const seen = new WeakSet<object>();
    let started: number | undefined;
    setup();
    let failed = false;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'turn_start') { report({ phase: 'request' }); context(); }
      if (event.type === 'tool_execution_start') {
        const id = String(++nextCall);
        calls.set(event.toolCallId, id);
        report({ start: id, name: names.has(event.toolName) ? event.toolName : 'unknown tool' });
      }
      if (event.type === 'tool_execution_end') {
        const id = calls.get(event.toolCallId);
        if (id) report({ end: id, outcome: outcomes.get(event.toolCallId) ?? { kind: event.isError ? 'sdk-error' : 'ok' } });
        calls.delete(event.toolCallId);
        outcomes.delete(event.toolCallId);
      }
      if (event.type === 'message_start' && event.message.role === 'assistant') started = performance.now();
      if (event.type === 'message_end' && event.message.role === 'assistant' && !seen.has(event.message)) {
        seen.add(event.message);
        const { usage, stopReason } = event.message;
        if (stopReason !== 'error' && stopReason !== 'aborted') report({ cache: { read: usage?.cacheRead, write: usage?.cacheWrite, input: usage?.input, speed: started !== undefined && usage?.output > 0 ? usage.output * 1000 / Math.max(1, performance.now() - started) : undefined } });
      }
      if (event.type === 'agent_end') { outcomes.clear(); calls.clear(); }
      if (event.type === 'agent_end' || event.type === 'compaction_end') { report({ phase: 'idle' }); context(); }
      if (event.type === "turn_start") { report({ turn: true }); spec.turn(); }
      else if (event.type === "tool_execution_start") spec.log(`→ ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`);
      else if (event.type === "tool_execution_end" && event.isError) {
        const content = event.result?.content as { type: string; text?: string }[] | undefined;
        const message = content?.flatMap((c) => c.type === "text" ? [c.text ?? ""] : []).join(" ") || "error";
        spec.toolError(event.toolName, message);
        spec.log(`✗ ${event.toolName}: ${message.slice(0, 300)}`);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        failed = event.message.stopReason === "error";
        const said = (event.message.content as { type: string; text?: string }[]).flatMap((c) => c.type === "text" && c.text?.trim() ? [c.text] : []).join(" ");
        if (said) {
          spec.log(said);
          if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") spec.completedText?.(said);
        }
      }
    });
    return {
      async prompt(text, options) {
        if (options?.toolFree) session.setActiveToolsByName([]);
        failed = false;
        let started = false;
        try { await session.prompt(text, { preflightResult: (state) => { started = state === "started"; } }); }
        catch (error) { if (started) throw error; return true; } // preflight failed (e.g. credentials): try the fallback
        return failed;
      },
      async steer(text) {
        const outcome = await session.steer(text, undefined, { source: "extension" });
        if (outcome !== "queued") throw new Block("steer", `Pi did not queue the message (${outcome})`);
      },
      get streaming() { return session.isStreaming; },
      abort: () => session.abort(),
      async fallback() {
        if (!fallback) return false;
        const next = fallback;
        fallback = undefined;
        await session.setModel(next);
        session.setThinkingLevel(level);
        setup(); report({ context: undefined });
        // A fallback model that cannot take the level is a documented degradation, not an error.
        const supported = thinkingLevels(next);
        if (!supported.includes(level)) spec.log(`thinking level ${level} is not supported by fallback model ${next.provider}/${next.id} (${supported.join(", ")}); Pi clamps it`);
        return true;
      },
      dispose() { report({ phase: 'closed' }); outcomes.clear(); calls.clear(); unsubscribe(); session.dispose(); },
    };
  }) as Driver;
  driver.capabilities = capabilities;
  return driver;
}
