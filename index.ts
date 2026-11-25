import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { agentDock } from './src/dock.ts';
import { hasGlance, Inspector } from './src/inspector.ts';
import { Telemetry } from './src/telemetry.ts';
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { AgentEvent } from "./src/agent.ts";
import { confirmOverlay, launchPanel, runtimePicker } from './src/launch-picker.ts';
import type { SessionAction } from './src/dock.ts';
import { loadConfig } from "./src/runtime/config.ts";
import { EMPTY, loadResources } from "./src/runtime/resources.ts";
import { dispatch, ops, serve, type Op } from "./src/control.ts";
import { errorText } from "./src/contracts.ts";
import { createDriver, discoverAdapters } from "./src/sdk/registry.ts";
import { loadCatalog, type Kind } from "./src/runtime/workflows.ts";
import { clean } from "./src/render.ts";
import type { Driver, Runtime } from "./src/sdk/contract.ts";
import { hintLoader } from "./src/runtime/hints.ts";
import { loadSpawnGuidance, spawnRuntimeRule } from "./src/runtime/spawn-guidance.ts";
import { provisionTemplates } from "./src/runtime/templates.ts";
import { createUsageTracker, formatUsageForPrompt, type UsageTracker } from "./src/runtime/usage.ts";
import { statePath } from "./src/workspace.ts";
import { Worq } from "./src/worq.ts";

const MANAGEMENT_TOOLS = ["worq_list", "worq_send", "worq_cancel"] as const;
export const TOOLS = ["worq_spawn", ...MANAGEMENT_TOOLS] as const;
const actionable = (event: Partial<AgentEvent> | undefined) => {
  if (!event) return false;
  if (event.wake !== undefined) return event.wake;
  return event.type === "ask" || event.type === "failed" || event.type === "parked" || event.type === "done" || event.type === "barrier";
};

const descriptions: Record<(typeof TOOLS)[number], { op: Op; description: string; guidelines: string[] }> = {
  worq_spawn: {
    op: "spawn",
    description:
      "Primary delegation tool: offload planning, implementation, codebase investigation, and any multi-step or non-trivial work to a background SDK agent (kind) instead of doing it directly in Main. Returns an exact readable ref; runs one automatic independent review on first submission when the package includes REVIEW.md. Omitted runtime fields follow configured defaults, then Main or the adapter.",
    guidelines: [
      "DEFAULT TO DELEGATION: Use `worq_spawn` for planning, code changes, refactors, audits, and multi-file investigation. Only skip spawning for trivial single-turn factual lookups (answer with primary-source citations) or when the user explicitly tells you to work directly in Main.",
      "ROUTE BY WORK TYPE: Match the task to the right installed `kind` — `plan` for design/architecture/ambiguous work, `execute` for code changes (never infer write permission from a read/plan request), `scout` for recon, or any other installed package whose description fits. Pass a concise 2-4 word `title` and the user's full original request in `task`.",
      spawnRuntimeRule,
      "SWARMS, ATTACHMENTS & PARALLEL WRITES: When a request spans 2+ areas of the repo, start with a 2-4 `scout` barrier wave in one turn (`group`, `notify: \"barrier\"`, `expect: <exact count>`) before launching `plan` or `execute`. Pass scout refs and plans via `attach` (exact plan names, inline refs, or `.agents/plans/...` paths), never inline mentions. For parallel write agents, assign disjoint `writePaths` globs and deterministic pre-submit `gates`. Stay free after spawning; wait for Worq notices instead of polling.",
    ],
  },
  worq_list: {
    op: "list",
    description: "List Worq agents (no args), inspect one group (group, including merge-tree verification for write branches), or show one agent in full: plan path, branch, gates, PQs, reviews and recent activity.",
    guidelines: [
      "Drive asks and parked agents without polling. Surface unresolved user choices with the plan.",
      "Even for ‘plan and execute’, present the plan and its review status before execution. Offer execute only (no merge) or execute and merge (verify before landing). Await direction; revisions stay in planning. Execute for that presented plan suffices without another confirmation.",
      "A clean automatic review pass applies to the exact reviewed submission: accept and close with worq_cancel. For a reviewless workflow, done is ready to continue. Address findings or inconclusive reviews explicitly. After feedback, inspect the incremental diff and gate results directly if needed. Do not spawn an additional agent solely to re-review. Main merges manually only with explicit merge authority.",
    ],
  },
  worq_send: {
    op: "send",
    description: "Send text to an agent: steers it while running, answers its open question while waiting; while parked after its review, delivers your feedback for its one final revision (no further review; it ends as done on submit), or resumes an out-of-budget agent with a fresh budget.",
    guidelines: [
      "A parked agent keeps its session (and worktree) until closed. Main alone decides what follows its review: accept and close (worq_cancel); send filtered feedback once (worq_send) — the agent makes one final revision without another review and ends as done; spawn a fresh agent for a fundamentally different approach; or ask the user to settle a decision. After an out-of-budget park, worq_send only resumes with a fresh budget.",
    ],
  },
  worq_cancel: {
    op: "cancel",
    description: "Close a parked agent or cancel a running one (ref, group:<id>, or all): stops it, its PQ subagents and review, removes its worktree and keeps its branch.",
    guidelines: [
      "Worq never merges. If the user authorized landing, verify the candidate before merging it by hand; close or cancel with worq_cancel.",
    ],
  },
};

/** Test seam: replace the Pi SDK driver. */
export function createWorq(options: { driver?: (ctx: ExtensionContext) => Driver; agentDir?: () => string; telemetry?: Telemetry; usage?: UsageTracker } = {}) {
  return function worq(pi: ExtensionAPI) {
    const agentDir = () => options.agentDir?.() ?? getAgentDir();
    const usage = options.usage ?? createUsageTracker();
    // Operator resource files come first, so the catalog and guidance reads below see them; each is created only when missing.
    const templates = provisionTemplates(agentDir());
    // One catalog, read once per extension load (shipped packages are provisioned first): worq_spawn's description is fixed at registration.
    const workflows = loadCatalog(agentDir());
    const adapters = discoverAdapters(agentDir());
    const issues = [...templates.problems, ...workflows.problems, ...adapters.problems];
    const catalog: ReadonlyMap<string, Kind> = workflows.kinds;
    const spawnable = [...catalog.values()].filter((kind) => !kind.userOnly);
    const table = ops();
    const spawnGuidance = loadSpawnGuidance(agentDir(), table.spawn);
    const kinds = spawnable.length
      ? spawnable.map((kind) => `${kind.name} (${kind.access}): ${kind.description}`).join("; ")
      : "none installed for Main; the user can add packages under <agentDir>/workflows/";
    let warned = false;
    let instance: Worq | undefined;
    let starting: Promise<Worq> | undefined;
    let socket: Awaited<ReturnType<typeof serve>> | undefined;
    let closing = false;
    let ui: ExtensionContext | undefined;

    const telemetry = options.telemetry ?? new Telemetry();
    let folded = false;
    const toggle = () => { folded = !folded; redrawWidget?.(); };
    let closeInspector: (() => void) | undefined;
    let redrawWidget: (() => void) | undefined;
    let redrawInspector: (() => void) | undefined;
    let dirty = false;
    let widget = false;
    const stop = telemetry.subscribe(() => {
      if (dirty || closing) return;
      dirty = true;
      queueMicrotask(() => {
        dirty = false;
        if (closing) return;
        try { syncWidget(); redrawWidget?.(); redrawInspector?.(); } catch { /* display only */ }
      });
    });
    const syncWidget = () => {
      if (ui?.mode !== 'tui') return;
      const live = hasGlance(telemetry);
      if (live === widget) return;
      widget = live;
      redrawWidget = undefined;
      ui.ui.setWidget?.('worq', live ? (tui, theme) => {
        redrawWidget = () => tui.requestRender();
        const clock = setInterval(redrawWidget, 1000).unref();
        const dock = agentDock(telemetry, theme, () => folded, toggle, (ref, key) => { if (ui) void inspect(ui, ref, key); }, () => tui.terminal?.rows ?? 24, (key, action) => { if (ui) void act(ui, key, action); });
        return Object.assign(dock, { dispose() { clearInterval(clock); } });
      } : undefined, { placement: 'belowEditor' });
    };
    const status = () => {
      try { syncWidget(); } catch { /* display only */ }
    };
    const notify = (event: AgentEvent) => {
      if (closing) return;
      pi.sendMessage({ customType: "worq", content: event.text, display: true, details: event }, actionable(event)
        ? { triggerTurn: true, deliverAs: "followUp" }
        : { triggerTurn: false });
      status();
    };
    /** One Worq per Pi session: config, shared resource snapshot and SDK router are built once. */
    const ensure = async (ctx: ExtensionContext): Promise<Worq> => {
      ui = ctx;
      if (instance) return instance;
      starting ??= (async () => {
        const dir = agentDir();
        const config = loadConfig(dir);
        const resources = options.driver ? EMPTY : await loadResources(dir);
        const host = { get model() { return ctx.model; }, get thinkingLevel() { return ctx.thinkingLevel; }, modelRegistry: ctx.modelRegistry, agentDir: dir };
        const driver = options.driver?.(ctx) ?? await createDriver({ pi: host, main: () => ({ model: host.model && `${host.model.provider}/${host.model.id}`, thinking: host.thinkingLevel }) }, resources, adapters.records);
        if (closing) throw new Error('Worq closed');
        return instance = new Worq({ telemetry: ctx.mode === 'tui' ? telemetry : undefined, driver, kinds: catalog, config: { ...config, ignored: [...config.ignored ?? [], ...resources.ignored] }, state: statePath(), cwd: ctx.cwd, notify, hints: hintLoader(dir), onAgentsChanged: syncTools,
          warn: (text) => { if (ui) say(ui, text, "warning"); } });
      })().finally(() => { starting = undefined; });
      return starting;
    };
    const run = async (ctx: ExtensionContext, op: string, args: unknown, signal?: AbortSignal) => {
      const result = await dispatch(await ensure(ctx), table, op, args, signal);
      status();
      return result;
    };

    function registerTool(name: (typeof TOOLS)[number], active: boolean) {
      const { op, description, guidelines } = descriptions[name];
      const body = name === "worq_spawn" ? `${description} Kinds — ${kinds}` : description;
      const parameters: TSchema = table[op];
      pi.registerTool({
        name, label: name, description: body, parameters, promptSnippet: body,
        exposure: active ? "direct" : "hidden", defaultActive: active,
        ...(guidelines.length ? { promptGuidelines: guidelines } : {}),
        async execute(_id, params, signal, _update, ctx) {
          const { text, data } = await run(ctx, op, params, signal);
          return { content: [{ type: "text", text: clean(text) }], details: data };
        },
      });
    }
    let managementActive = false;
    function syncTools() {
      if (closing) return;
      const active = instance?.hasNonCancelledAgents() ?? false;
      if (active === managementActive) return;
      managementActive = active;
      // Withdraw at the registry level: subtracting restored tools with setActiveTools
      // would also discard unrelated tools still pending registration in Pi.
      for (const name of MANAGEMENT_TOOLS) registerTool(name, active);
    }
    for (const name of TOOLS) registerTool(name, name === "worq_spawn");

    const say = (ctx: ExtensionContext, text: string, level: 'info' | 'warning' | 'error' = 'info') => {
      if (ctx.mode === "tui") ctx.ui.notify(clean(text), level);
      else process.stderr.write(`${clean(text)}\n`);
    };
    const problems = (ctx: ExtensionContext) => { for (const problem of issues) say(ctx, `! ${problem.path}: ${problem.message}`, "warning"); };
    const launcher = async (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") { say(ctx, "Launch panel requires the TUI."); return; }
      problems(ctx);
      const worq = await ensure(ctx);
      worq.gate();
      if (!catalog.size) {
        say(ctx, `No agent packages installed. Add ${join(workflows.dir, "<name>", "SKILL.md")} with name and description frontmatter, then restart Pi.`);
        return;
      }
      const kinds = [
        catalog.get("plan"),
        catalog.get("execute"),
        ...[...catalog.values()].filter((kind) => kind.name !== "plan" && kind.name !== "execute"),
      ].filter((kind) => kind !== undefined);
      const fallback = await worq.defaults();
      const initials = new Map<string, Runtime>();
      for (const kind of kinds) initials.set(kind.name, await worq.defaults(undefined, kind.name).catch(() => fallback));
      void usage.refresh();
      const result = await launchPanel(ctx.ui, { kinds, initial: fallback, initials, choices: await worq.launchChoices(fallback, [...initials.values()]), usage });
      if (!result || closing) return;
      const { kind, instructions: extra, runtime } = result;
      const initial = initials.get(kind.name) ?? fallback;
      const explicit = runtime.sdk !== initial.sdk || runtime.model !== initial.model || runtime.thinking !== initial.thinking
        ? { sdk: runtime.sdk, ...(runtime.model !== undefined ? { model: runtime.model } : {}), ...(runtime.thinking !== undefined ? { thinking: runtime.thinking } : {}) }
        : {};
      const agent = await worq.launch({ kind: kind.name, task: extra, ...explicit }, {
        caller: "user",
      });
      status();
      say(ctx, `Launched ${kind.name} as ${agent.ref}.`);
    };

    // Passive notices are visible and persisted, but never steer an unrelated Main turn.
    pi.on("context", (event) => {
      const messages = event.messages.filter((message) => {
        if (message.role !== "custom" || message.customType !== "worq") return true;
        const details = message.details as Partial<AgentEvent> | undefined;
        return actionable(details);
      });
      if (messages.length !== event.messages.length) return { messages };
    });

    pi.registerCommand("worq", {
      description: "Launch an SDK agent",
      async handler(args, ctx) {
        if (closing) return;
        if (args.trim()) return say(ctx, "Usage: /worq", "error");
        try { await launcher(ctx); } catch (error) { say(ctx, errorText(error), "error"); }
      },
    });

    /** Dashboard controls for one live session (owner, PQ or review). One dialog at a time. */
    let acting = false;
    async function act(ctx: ExtensionContext, key: string, action: SessionAction) {
      if (closing || acting || ctx.mode !== 'tui' || !instance) return;
      acting = true;
      try {
        const session = instance.session(key);
        if (action === 'cancel') {
          if (!await confirmOverlay(ctx.ui, `Cancel ${session.label}?`, session.consequence)) return;
          say(ctx, await instance.sessions.get(key)?.cancel() ?? 'Session already ended');
          status();
          return;
        }
        const choices = await instance.choices(key);
        const runtime = session.runtime() ?? { name: 'main', sdk: choices[0]?.sdk ?? 'pi', path: '', via: '' };
        // choices[0] is the current runtime with Main's model resolved.
        void usage.refresh();
        const change = await runtimePicker(ctx.ui, { label: session.label, current: { ...runtime, model: runtime.model ?? choices[0]?.model }, choices, pending: session.pending(), usage });
        if (!change) return;
        say(ctx, await instance.configure(key, change));
      } catch (error) { say(ctx, errorText(error), 'error'); }
      finally { acting = false; }
    }

    async function inspect(ctx: ExtensionContext, ref?: string, key?: string) {
        if (closing || closeInspector) return;
        if (ref && ![...telemetry.rows.values()].some(row => row.ref === ref)) { say(ctx, 'No such Worq ref in this session.', 'warning'); return; }
        try {
          await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            redrawInspector = () => tui.requestRender();
            closeInspector = () => { closeInspector = undefined; redrawInspector = undefined; done(undefined); };
            return new Inspector(telemetry, ref, theme, () => tui.terminal.rows, redrawInspector, closeInspector, key, (k, action) => void act(ctx, k, action));
          }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'center' } });
        } finally { closeInspector = undefined; redrawInspector = undefined; }
    }

    pi.registerMessageRenderer("worq", (message, options, theme) => {
      const body = clean(typeof message.content === "string" ? message.content : message.content.map((c) => c.type === "text" ? c.text : "").join(""));
      const [head = "", ...rest] = body.split("\n");
      const details = message.details as Partial<AgentEvent> | undefined;
      const type = details?.type;
      const tone = type === "failed"
        ? "error"
        : type === "barrier"
          ? (/\[(failed|parked)\]/.test(body) ? "warning" : "accent")
          : actionable(details) || type === "warning"
            ? "warning"
            : "accent";
      const line = `${theme.fg(tone, "◆")} ${theme.fg(tone, head.replace(/^\[worq ([0-9a-f]{4})\] /, "worq $1 · "))}`;
      return new Text(options.expanded ? `${line}\n${theme.fg("muted", rest.join("\n"))}` : line, 1, 0);
    });

    const guidance = spawnGuidance.section;
    if (guidance) {
      let runPrompt: NormalizedBuildSystemPromptOptions | undefined;
      pi.on("before_agent_start", ({ systemPromptOptions }) => {
        // Keep the shared options: Pi finalizes the selection and hidden declarations after all start hooks.
        runPrompt = systemPromptOptions;
        void usage.refresh();
      });
      pi.on("context_with_system", ({ messages }) => {
        // Pi projects hidden tool declarations out *after* this hook, so check the run's hidden list too.
        if (!runPrompt || runPrompt.forceSystemPrompt !== undefined || runPrompt.hiddenTools.includes("worq_spawn") ||
            !getCurrentTools(messages).some(tool => tool.name === "worq_spawn")) return;
        const [head, ...tail] = messages;
        if (head?.role !== "system") return;
        const usageNote = formatUsageForPrompt(usage.current());
        const body = usageNote ? `${guidance}\n\n${usageNote}` : guidance;
        const sections = { ...head.sections, worq_spawn_guidance: `<worq_spawn_guidance>\n${body}\n</worq_spawn_guidance>` };
        return { messages: [{ ...head, sections }, ...tail] };
      });
    }
    pi.on("session_tree", () => {
      if (closing || !managementActive) return;
      // Pi has restored the branch's loadout, which may predate the current agents.
      const active = pi.getActiveTools();
      const missing = MANAGEMENT_TOOLS.filter((name) => !active.includes(name));
      if (missing.length) pi.setActiveTools([...active, ...missing]);
    });
    let guidanceWarned = false;
    pi.on("session_start", async (_event, ctx) => {
      ui = ctx;
      void usage.refresh();
      if (spawnGuidance.warning && !guidanceWarned) {
        guidanceWarned = true;
        say(ctx, spawnGuidance.warning, "warning");
      }
      if (!warned && ctx.mode === "tui") { warned = true; problems(ctx); }
      if (socket) return;
      try { socket = await serve(statePath(), (op, args) => run(ctx, op, args)); }
      catch (error) { if (ctx.mode === "tui") say(ctx, `Worq control socket unavailable: ${errorText(error)}`, "warning"); }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      closing = true;
      usage.dispose();
      if (ctx.mode === 'tui') ctx.ui.setWidget('worq-launch', undefined);
      stop();
      closeInspector?.();
      redrawWidget = undefined;
      await instance?.shutdown();
      await socket?.close().catch(() => {});
      socket = undefined;
      if (ctx.mode === "tui") ctx.ui.setWidget?.('worq', undefined);
    });
  };
}
export default createWorq();
