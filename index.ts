import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDock } from './src/dock.ts';
import { hasGlance, Inspector } from './src/inspector.ts';
import { Telemetry } from './src/telemetry.ts';
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { AgentEvent } from "./src/agent.ts";
import { confirmOverlay, launchPicker, runtimePicker } from './src/launch-picker.ts';
import type { SessionAction } from './src/dock.ts';
import { loadConfig } from "./src/runtime/config.ts";
import { EMPTY, loadResources } from "./src/runtime/resources.ts";
import { dispatch, ops, serve, type Op } from "./src/control.ts";
import { errorText } from "./src/contracts.ts";
import { createDriver, discoverAdapters } from "./src/sdk/registry.ts";
import { loadPrompts, type Kind } from "./src/prompts.ts";
import { loadCatalog } from "./src/runtime/workflows.ts";
import { clean } from "./src/render.ts";
import type { Driver } from "./src/sdk/contract.ts";
import { statePath } from "./src/workspace.ts";
import { isRef, Worq } from "./src/worq.ts";

export const TOOLS = ["worq_spawn", "worq_list", "worq_send", "worq_cancel"] as const;
const ENABLED = "worq-enabled";
const actionable = (type: AgentEvent["type"] | undefined) => type === "ask" || type === "failed" || type === "parked" || type === "done";

const descriptions: Record<(typeof TOOLS)[number], { op: Op; description: string; guidelines: string[] }> = {
  worq_spawn: {
    op: "spawn",
    description: "Start a background SDK agent from an installed package (kind). Returns an exact readable name. Every agent gets exactly one independent review of its first submission. Runs on Main's model and thinking unless sdk, model or thinking is set.",
    guidelines: [
      "Answer bounded factual lookups directly with primary-source citations unless delegation is explicit. For substantive plans and execution spawn the requested kind with a descriptive 2–4 word title and the original request. Attach plans using attach (exact plan names or repo-relative .agents/plans paths), never inline mentions. Do not infer write permission from a bare request. Set sdk/model/thinking only when the user asks for them.",
    ],
  },
  worq_list: {
    op: "list",
    description: "List Worq agents (no ref) or show one agent in full: plan path, branch, PQs, reviews and recent activity.",
    guidelines: [
      "Drive asks and parked agents without polling. During planning answer from evidence or use conservative provisional assumptions or alternatives; surface unresolved preferences with the reviewed plan.",
      "Even for ‘plan and execute’, present the reviewed plan before execution. Offer execute only (verified candidate, no merge) or execute and merge (verify before landing). Await direction; revisions stay in planning. Execute for that presented plan suffices without another confirmation.",
      "Parked is not a pass. Obtain affirmative verification of the exact candidate before reporting execution success, including execute only. Reverify after changes. Without verification report unverified and leave unmerged; Main merges manually only with explicit merge authority.",
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
    description: "Close a parked agent or cancel a running one (or all): stops it, its PQ subagents and review, removes its worktree and keeps its branch.",
    guidelines: [
      "Worq never merges. If the user authorized landing, verify the candidate before merging it by hand; close or cancel with worq_cancel.",
    ],
  },
};

/** Test seam: replace the Pi SDK driver. */
export function createWorq(options: { driver?: (ctx: ExtensionContext) => Driver; agentDir?: () => string; telemetry?: Telemetry } = {}) {
  return function worq(pi: ExtensionAPI) {
    const prompts = loadPrompts();
    const agentDir = () => options.agentDir?.() ?? getAgentDir();
    // One catalog, read once per extension load (shipped packages are provisioned first): worq_spawn's description is fixed at registration.
    const workflows = loadCatalog(agentDir());
    const adapters = discoverAdapters(agentDir());
    const issues = [...workflows.problems, ...adapters.problems];
    const catalog: ReadonlyMap<string, Kind> = workflows.kinds;
    const spawnable = [...catalog.values()].filter((kind) => !kind.userOnly);
    const table = ops();
    const kinds = spawnable.length
      ? spawnable.map((kind) => `${kind.name} (${kind.access}): ${kind.description}`).join("; ")
      : "none installed for Main; the user can add packages under <agentDir>/workflows/";
    let warned = false;
    let instance: Worq | undefined;
    let starting: Promise<Worq> | undefined;
    let socket: Awaited<ReturnType<typeof serve>> | undefined;
    let off = false;
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
        const dock = agentDock(telemetry, theme, () => folded, toggle, (ref, key) => { if (ui) void inspect(ref ?? '', ui, key); }, () => tui.terminal?.rows ?? 24, (key, action) => { if (ui) void act(ui, key, action); });
        return Object.assign(dock, { dispose() { clearInterval(clock); } });
      } : undefined, { placement: 'belowEditor' });
    };
    const status = () => {
      if (off) enable(false);
      try { syncWidget(); } catch { /* display only */ }
    };
    const notify = (event: AgentEvent) => {
      if (closing) return;
      pi.sendMessage({ customType: "worq", content: event.text, display: true, details: event }, actionable(event.type)
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
        const driver = options.driver?.(ctx) ?? await createDriver({ pi: host }, resources, adapters.records);
        if (closing) throw new Error('Worq closed');
        return instance = new Worq({ telemetry: ctx.mode === 'tui' ? telemetry : undefined, driver, prompts, kinds: catalog, config: { ...config, ignored: [...config.ignored ?? [], ...resources.ignored] }, state: statePath(), cwd: ctx.cwd, notify,
          warn: (text) => { if (ui) say(ui, text, "warning"); } });
      })().finally(() => { starting = undefined; });
      return starting;
    };
    const run = async (ctx: ExtensionContext, op: string, args: unknown, signal?: AbortSignal) => {
      if (off && op === "spawn") throw new Error("Worq is off; re-enable with /worq.");
      const result = await dispatch(await ensure(ctx), table, op, args, signal);
      status();
      return result;
    };

    // Hidden until /worq: zero context cost in sessions that never use Worq.
    for (const name of TOOLS) {
      const { op, description, guidelines } = descriptions[name];
      const body = name === "worq_spawn" ? `${description} Kinds — ${kinds}` : description;
      const parameters: TSchema = table[op];
      pi.registerTool({
        name, label: name, description: body, parameters, promptSnippet: body, defaultActive: false,
        ...(guidelines.length ? { promptGuidelines: guidelines } : {}),
        async execute(_id, params, signal, _update, ctx) {
          const { text, data } = await run(ctx, op, params, signal);
          return { content: [{ type: "text", text: clean(text) }], details: data };
        },
      });
    }
    const enable = (on: boolean) => {
      off = !on;
      const servicing = instance?.all().some(a => !a.ended);
      const active = new Set(pi.getActiveTools());
      for (const name of TOOLS) { if (on || (servicing && name !== "worq_spawn")) active.add(name); else active.delete(name); }
      pi.setActiveTools([...active]);
    };
    const say = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
      if (ctx.mode === "tui") ctx.ui.notify(clean(text), level);
      else process.stderr.write(`${clean(text)}\n`);
    };
    const problems = (ctx: ExtensionContext) => { for (const problem of issues) say(ctx, `! ${problem.path}: ${problem.message}`, "warning"); };
    const enableOnly = async (ctx: ExtensionContext) => {
      enable(true);
      pi.appendEntry(ENABLED, { on: true });
      await ensure(ctx);
      say(ctx, `Worq tools enabled (${TOOLS.join(", ")}). Kinds: ${spawnable.map((kind) => kind.name).join(", ") || "none"}.${ctx.mode === "tui" ? " Launch one yourself: /worq." : ""}`);
    };
    /**
     * The user launch route for every installed package: choose → optional instructions → explicit runtime confirmation.
     * Cancelling at any step changes no tools and creates no agent or worktree. On admission all four Main tools activate
     * before the agent starts, so Main can drive it without another command.
     */
    const launcher = async (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") { await enableOnly(ctx); return; }
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
      const labels = new Map(kinds.map((kind) => [`${kind.name} · ${kind.access}${kind.userOnly ? " · user-only" : ""} · ${kind.description}`, kind]));
      const choice = await ctx.ui.select("Launch SDK agent", [...labels.keys()]);
      const kind = choice === undefined ? undefined : labels.get(choice);
      if (!kind) return;
      const extra = await ctx.ui.input(`Launch ${kind.name}: instructions (optional)`, "Leave empty to run the package as written");
      if (extra === undefined) return;
      const initial = await worq.defaults();
      const runtime = await launchPicker(ctx.ui, { label: kind.name, initial, choices: await worq.launchChoices(initial) });
      if (!runtime) return;
      if (off && !await confirmOverlay(ctx.ui, "Worq is off", `Launching re-enables ${TOOLS.join(", ")} for Main and keeps them on. Continue?`)) return;
      const explicit = runtime.sdk !== initial.sdk || runtime.model !== initial.model || runtime.thinking !== initial.thinking
        ? { sdk: runtime.sdk, ...(runtime.model !== undefined ? { model: runtime.model } : {}), ...(runtime.thinking !== undefined ? { thinking: runtime.thinking } : {}) }
        : {};
      const agent = await worq.launch({ kind: kind.name, task: extra, ...explicit }, {
        caller: "user",
        beforeStart: () => { enable(true); pi.appendEntry(ENABLED, { on: true }); },
      });
      status();
      say(ctx, `Launched ${kind.name} as ${agent.ref}. Main can now drive it; /worq list ${agent.ref} reads its result; /worq send ${agent.ref} <text> steers; /worq cancel ${agent.ref} stops it.`);
    };

    // Passive notices are visible and persisted, but never steer an unrelated Main turn.
    pi.on("context", (event) => {
      const messages = event.messages.filter((message) => {
        if (message.role !== "custom" || message.customType !== "worq") return true;
        const type = (message.details as Partial<AgentEvent> | undefined)?.type;
        return actionable(type);
      });
      if (messages.length !== event.messages.length) return { messages };
    });

    pi.registerCommand("worq", {
      description: "Launch an SDK agent: /worq · enable tools only: /worq on · ask Main: /worq <request> · /worq off · /worq list [ref] · /worq send <ref> <text> · /worq cancel <ref|all> · /worq configure <ref> <model|-> [thinking]",
      async handler(args, ctx) {
        if (closing) return;
        const value = args.trim();
        const [word = "", ref = "", ...rest] = value.split(/\s+/);
        try {
          if (word === "off") {
            enable(false);
            pi.appendEntry(ENABLED, { on: false });
            say(ctx, "New launches disabled. Running agents continue; /worq cancel all stops them.");
            return;
          }
          if (!value || word === "workflow") {
            if (value && value !== "workflow") { say(ctx, "Usage: /worq", "error"); return; }
            await launcher(ctx);
            return;
          }
          if (value === "on") { await enableOnly(ctx); return; }
          if (word === "configure") {
            const [model, thinking] = rest;
            if (!ref || !model) { say(ctx, "Usage: /worq configure <ref> <provider/model|-> [thinking]", "error"); return; }
            say(ctx, (await run(ctx, "configure", { ref, ...(model !== "-" ? { model } : {}), ...(thinking ? { thinking } : {}) })).text);
            return;
          }
          if (word === "list" || word === "send" || word === "cancel") {
            const params = word === "list" ? (ref ? { ref } : {}) : word === "send" ? { ref, text: rest.join(" ") } : { ref };
            say(ctx, (await run(ctx, word, params)).text);
            return;
          }
          if (catalog.has(value)) { say(ctx, `Usage: /worq ${value} <request>, or /worq to launch it yourself`, "error"); return; }
          enable(true);
          pi.appendEntry(ENABLED, { on: true });
          pi.sendUserMessage(value, { deliverAs: "followUp" });
        } catch (error) { say(ctx, errorText(error), "error"); }
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
        const change = await runtimePicker(ctx.ui, { label: session.label, current: { ...runtime, model: runtime.model ?? choices[0]?.model }, choices, pending: session.pending() });
        if (!change) return;
        say(ctx, await instance.configure(key, change));
      } catch (error) { say(ctx, errorText(error), 'error'); }
      finally { acting = false; }
    }

    pi.registerCommand('worq-dock', { description: 'Collapse or expand the agent dock', handler: async () => toggle() });
    async function inspect(args: string, ctx: ExtensionContext, key?: string) {
        if (closing || closeInspector) return;
        const ref = args.trim();
        if (args.trim() && !isRef(ref)) { say(ctx, 'Usage: /worq-inspect [ref]', 'error'); return; }
        if (ctx.mode !== 'tui') { say(ctx, 'Inspector requires a TUI. Use /worq list [ref].'); return; }
        if (ref && ![...telemetry.rows.values()].some(row => row.ref === ref)) { say(ctx, 'No such Worq ref in this session.', 'warning'); return; }
        try {
          await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            redrawInspector = () => tui.requestRender();
            closeInspector = () => { closeInspector = undefined; redrawInspector = undefined; done(undefined); };
            return new Inspector(telemetry, ref || undefined, theme, () => tui.terminal.rows, redrawInspector, closeInspector, key, (k, action) => void act(ctx, k, action));
          }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'center' } });
        } finally { closeInspector = undefined; redrawInspector = undefined; }
    }
    pi.registerCommand('worq-inspect', { description: 'Agent dashboard: /worq-inspect [ref]', handler: inspect });

    pi.registerMessageRenderer("worq", (message, options, theme) => {
      const body = clean(typeof message.content === "string" ? message.content : message.content.map((c) => c.type === "text" ? c.text : "").join(""));
      const [head = "", ...rest] = body.split("\n");
      const type = (message.details as Partial<AgentEvent> | undefined)?.type;
      const tone = type === 'failed' ? 'error' : actionable(type) || type === 'warning' ? 'warning' : 'accent';
      const line = `${theme.fg(tone, "◆")} ${theme.fg(tone, head.replace(/^\[worq ([0-9a-f]{4})\] /, "worq $1 · "))}`;
      return new Text(options.expanded ? `${line}\n${theme.fg("muted", rest.join("\n"))}` : line, 1, 0);
    });

    pi.on("session_start", async (_event, ctx) => {
      ui = ctx;
      // Resume/fork: restore the last /worq choice on this branch.
      const last = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === ENABLED).at(-1);
      if (last && last.type === "custom") enable(Boolean((last.data as { on?: boolean } | undefined)?.on));
      if (!warned && ctx.mode === "tui") { warned = true; problems(ctx); }
      if (socket) return;
      try { socket = await serve(statePath(), (op, args) => run(ctx, op, args)); }
      catch (error) { if (ctx.mode === "tui") say(ctx, `Worq control socket unavailable: ${errorText(error)}`, "warning"); }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      closing = true;
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
