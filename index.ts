import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { glance, hasGlance, Inspector } from './src/inspector.ts';
import { Telemetry } from './src/telemetry.ts';
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { AgentEvent } from "./src/agent.ts";
import { loadConfig } from "./src/config.ts";
import { dispatch, ops, serve, type Op } from "./src/control.ts";
import { errorText } from "./src/contracts.ts";
import { createDriver } from "./src/harness.ts";
import { loadPrompts } from "./src/prompts.ts";
import { clean } from "./src/render.ts";
import type { Driver } from "./src/session.ts";
import { statePath } from "./src/workspace.ts";
import { isRef, Worq } from "./src/worq.ts";

export const TOOLS = ["worq_spawn", "worq_list", "worq_send", "worq_cancel"] as const;
const ENABLED = "worq-enabled";
const actionable = (type: AgentEvent["type"] | undefined) => type === "ask" || type === "checkpoint" || type === "failed" || type === "review-ready";

const descriptions: Record<(typeof TOOLS)[number], { op: Op; description: string; guidelines: string[] }> = {
  worq_spawn: {
    op: "spawn",
    description: "Start a background Pi SDK agent of a kind. Returns a ref at once; independent reviewers run automatically on submit unless the spawn sets verify:false.",
    guidelines: [
      "Answer bounded factual lookups directly with primary-source citations unless delegation is explicit. For substantive plans and execution spawn the requested kind with the original request and independent review. Do not infer write permission from a bare request.",
    ],
  },
  worq_list: {
    op: "list",
    description: "List Worq agents (no ref) or show one agent in full: plan path, branch, PQs, reviews and recent activity.",
    guidelines: [
      "Drive asks, checkpoints, review and authorized repair without polling. During planning answer from evidence or use conservative provisional assumptions or alternatives; surface unresolved preferences with the reviewed plan.",
      "Even for ‘plan and execute’, present the reviewed plan before execution. Offer execute only (verified candidate, no merge) or execute and merge (verify before landing). Await direction; revisions stay in planning. Execute for that presented plan suffices without another confirmation.",
      "Review-ready is not a pass. Obtain affirmative verification of the exact candidate before reporting execution success, including execute only. Reverify after changes. Without verification report unverified and leave unmerged; Main merges manually only with explicit merge authority.",
    ],
  },
  worq_send: {
    op: "send",
    description: "Send text to an agent: steers it while running, answers its open question while waiting, or starts its next round when review-ready.",
    guidelines: [
      "Before delivering a Worq result, read the findings with worq_list. Adjudicate material findings on evidence, never by count. Correct them within authorized scope or explicitly report them as unresolved. worq_send on a review-ready ref starts another round; do not use it without authority to continue.",
    ],
  },
  worq_cancel: {
    op: "cancel",
    description: "Close or cancel an agent (or all): stops it, its PQ subagents and reviewers, removes its worktree and keeps its branch.",
    guidelines: [
      "Worq never merges. If the user authorized landing, verify the candidate before merging it by hand; close or cancel with worq_cancel.",
    ],
  },
};

/** Test seam: replace the Pi SDK driver. */
export function createWorq(options: { driver?: (ctx: ExtensionContext) => Driver; agentDir?: () => string } = {}) {
  return function worq(pi: ExtensionAPI) {
    const prompts = loadPrompts();
    const table = ops([...prompts.kinds.keys()]);
    const kinds = [...prompts.kinds.values()].map((kind) => `${kind.name}: ${kind.description}`).join("; ");
    let instance: Worq | undefined;
    let socket: Awaited<ReturnType<typeof serve>> | undefined;
    let off = false;
    let closing = false;
    let ui: ExtensionContext | undefined;

    const telemetry = new Telemetry();
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
        let cached: { width: number; second: number; lines: string[] } | undefined;
        redrawWidget = () => { cached = undefined; tui.requestRender(); };
        return {
          render(width) {
            const second = Math.floor(Date.now() / 1000);
            if (!cached || cached.width !== width || cached.second !== second) cached = { width, second, lines: glance(telemetry, width, theme) };
            return cached.lines;
          },
          invalidate() { cached = undefined; },
        };
      } : undefined);
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
    const ensure = (ctx: ExtensionContext) => {
      ui = ctx;
      if (instance) return instance;
      const config = loadConfig(options.agentDir?.() ?? getAgentDir());
      const driver = options.driver?.(ctx) ?? createDriver({ host: ctx }, config);
      instance = new Worq({ telemetry: ctx.mode === 'tui' ? telemetry : undefined, driver, prompts, config, state: statePath(), cwd: ctx.cwd, notify });
      return instance;
    };
    const run = async (ctx: ExtensionContext, op: string, args: unknown) => {
      if (off && op === "spawn") throw new Error("Worq is off; re-enable with /worq.");
      const result = await dispatch(ensure(ctx), table, op, args);
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
        async execute(_id, params, _signal, _update, ctx) {
          const { text, data } = await run(ctx, op, params);
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
      description: "Enable tools or ask Main: /worq [plan|execute] <request> · /worq off · /worq list [ref] · /worq send <ref> <text> · /worq cancel <ref|all>",
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
          if (word === "list" || word === "send" || word === "cancel") {
            const params = word === "list" ? (ref ? { ref } : {}) : word === "send" ? { ref, text: rest.join(" ") } : { ref };
            say(ctx, (await run(ctx, word, params)).text);
            return;
          }
          enable(true);
          pi.appendEntry(ENABLED, { on: true });
          if (!value) {
            ensure(ctx);
            say(ctx, `Worq tools enabled (${TOOLS.join(", ")}). Kinds: ${[...prompts.kinds.keys()].join(", ")}.`);
            return;
          }
          if (prompts.kinds.has(value)) { say(ctx, `Usage: /worq ${value} <request>`, "error"); return; }
          pi.sendUserMessage(value, { deliverAs: "followUp" });
        } catch (error) { say(ctx, errorText(error), "error"); }
      },
    });

    pi.registerCommand('worq-inspect', {
      description: 'Read-only session inspector: /worq-inspect [ref]',
      async handler(args, ctx) {
        if (closing || closeInspector) return;
        const ref = args.trim().replace(/^@/, '').toLowerCase();
        if (args.trim() && !isRef(ref)) { say(ctx, 'Usage: /worq-inspect [ref]', 'error'); return; }
        if (ctx.mode !== 'tui') { say(ctx, 'Inspector requires a TUI. Use /worq list [ref].'); return; }
        if (ref && ![...telemetry.rows.values()].some(row => row.ref === ref)) { say(ctx, 'No such Worq ref in this session.', 'warning'); return; }
        try {
          await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            redrawInspector = () => tui.requestRender();
            closeInspector = () => { closeInspector = undefined; redrawInspector = undefined; done(undefined); };
            return new Inspector(telemetry, ref || undefined, theme, () => tui.terminal.rows, redrawInspector, closeInspector);
          });
        } finally { closeInspector = undefined; redrawInspector = undefined; }
      },
    });

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
