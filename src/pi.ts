import {
  createAgentSession, createExtensionRuntime, defineTool, SessionManager, SettingsManager,
  type ExtensionContext, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Block, parse } from "./contracts.ts";
import type { Config } from "./config.ts";
import type { Driver, Handle, Spec, Tool } from "./session.ts";

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
function sdkTool(tool: Tool) {
  return defineTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters, executionMode: "sequential",
    async execute(_id, params, signal) {
      const live = signal ?? new AbortController().signal;
      live.throwIfAborted();
      const out = await tool.run(parse(tool.parameters, params, tool.name), live);
      const value = typeof out === "string" ? { text: out } : out;
      const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [{ type: "text", text: value.text }];
      if (value.image) content.push({ type: "image", ...value.image });
      return { content, details: undefined, terminate: value.terminate ?? false };
    },
  });
}

/** Pi SDK sessions in memory, one per Worq conversation. Models come from pi-worq.json, else Main's model. */
export function piDriver(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, config: Config): Driver {
  const resolve = (ref?: string) => {
    if (!ref) return undefined;
    const slash = ref.indexOf("/");
    const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
    if (!model) throw new Block("config", `${config.path}: Pi does not know model ${ref}`);
    return model;
  };
  return async (spec: Spec): Promise<Handle> => {
    const choice = config.model(spec.name);
    const model = resolve(choice.model) ?? ctx.model;
    let fallback = resolve(choice.fallbackModel);
    if (!model) throw new Block("model", "Select a Pi model or set model in pi-worq.json");
    if (fallback && fallback.provider === model.provider && fallback.id === model.id) fallback = undefined;
    const tools = spec.tools.map(sdkTool);
    const { session } = await createAgentSession({
      cwd: spec.cwd, model, thinkingLevel: "low", resourceLoader: resources(spec.system),
      tools: tools.map((t) => t.name), customTools: tools,
      sessionManager: SessionManager.inMemory(spec.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    let failed = false;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start") spec.turn();
      else if (event.type === "tool_execution_start") spec.log(`→ ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`);
      else if (event.type === "tool_execution_end" && event.isError) {
        const content = event.result?.content as { type: string; text?: string }[] | undefined;
        const message = content?.flatMap((c) => c.type === "text" ? [c.text ?? ""] : []).join(" ") || "error";
        spec.toolError(event.toolName, message);
        spec.log(`✗ ${event.toolName}: ${message.slice(0, 300)}`);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        failed = event.message.stopReason === "error";
        const said = (event.message.content as { type: string; text?: string }[]).flatMap((c) => c.type === "text" && c.text?.trim() ? [c.text] : []).join(" ");
        if (said) spec.log(said);
      }
    });
    return {
      async prompt(text) {
        failed = false;
        let started = false;
        try { await session.prompt(text, { preflightResult: (state) => { started = state === "started"; } }); }
        catch (error) { if (started) throw error; return true; } // preflight failed (e.g. credentials): try the fallback
        return failed;
      },
      async steer(text) { await session.steer(text, undefined, { source: "extension" }); },
      get streaming() { return session.isStreaming; },
      abort: () => session.abort(),
      async fallback() {
        if (!fallback) return false;
        const next = fallback;
        fallback = undefined;
        await session.setModel(next);
        session.setThinkingLevel("low");
        return true;
      },
      dispose() { unsubscribe(); session.dispose(); },
    };
  };
}
