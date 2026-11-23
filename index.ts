import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { Worq } from "./src/worq.ts";

export const TOOLS = ["worq_spawn", "worq_list", "worq_send", "worq_cancel"] as const;
const ENABLED = "worq-enabled";
const actionable = (type: AgentEvent["type"] | undefined) => type === "ask" || type === "checkpoint";

const descriptions: Record<(typeof TOOLS)[number], { op: Op; description: string; guidelines: string[] }> = {
  worq_spawn: {
    op: "spawn",
    description: "Start a background Pi SDK agent of a kind. Returns a ref at once; independent reviewers run automatically on submit unless the spawn sets verify:false.",
    guidelines: [
      "For small, deterministic edits, prefer doing the edit directly and checking the exact diff unless the user requested Worq. If asked to use Worq, call worq_spawn and confirm the returned ref; never substitute a direct answer. Use mode fast for bounded Worq work and thorough for consequential ambiguity; neither mode changes the review roster.",
      "Put the user's ask in the worq_spawn task verbatim. A plan or review is not permission to execute, write, repair, or merge. Stop at the requested deliverable. Worq displays completion without waking Main; use worq_list for the full result when asked to assess or continue it.",
    ],
  },
  worq_list: {
    op: "list",
    description: "List Worq agents (no ref) or show one agent in full: plan path, branch, PQs, reviews and recent activity.",
    guidelines: [],
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
    let closing = false;
    let ui: ExtensionContext | undefined;

    const status = () => {
      if (ui?.mode !== "tui" || !instance) return;
      const live = instance.all().filter((a) => !a.ended);
      ui.ui.setStatus("worq", live.length ? `worq ${live.map((a) => `${a.ref}:${a.state}`).join(" ")}` : undefined);
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
      instance = new Worq({ driver, prompts, config, state: statePath(), cwd: ctx.cwd, notify });
      return instance;
    };
    const run = async (ctx: ExtensionContext, op: string, args: unknown) => {
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
      const active = new Set(pi.getActiveTools());
      for (const name of TOOLS) { if (on) active.add(name); else active.delete(name); }
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
      description: "Enable tools or spawn: /worq [plan|execute] <request> · /worq off · /worq list [ref] · /worq send <ref> <text> · /worq cancel <ref|all>",
      async handler(args, ctx) {
        if (closing) return;
        const value = args.trim();
        const [word = "", ref = "", ...rest] = value.split(/\s+/);
        try {
          if (word === "off") {
            enable(false);
            pi.appendEntry(ENABLED, { on: false });
            say(ctx, "Worq tools hidden. Running agents continue; /worq cancel all stops them.");
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
          const explicit = prompts.kinds.has(word);
          // A bare request is read-only; only an explicit write kind authorizes worktree writes.
          const kind = explicit ? word : "plan";
          const task = explicit ? value.slice(word.length).trimStart() : value;
          if (!task) { say(ctx, `Usage: /worq ${kind} <request>`, "error"); return; }
          const result = await run(ctx, "spawn", { kind, task });
          pi.sendMessage({ customType: "worq", content: clean(result.text), display: true, details: result.data }, { triggerTurn: false });
        } catch (error) { say(ctx, errorText(error), "error"); }
      },
    });

    pi.registerMessageRenderer("worq", (message, options, theme) => {
      const body = clean(typeof message.content === "string" ? message.content : message.content.map((c) => c.type === "text" ? c.text : "").join(""));
      const [head = "", ...rest] = body.split("\n");
      const line = `${theme.fg("accent", "◆")} ${theme.fg("muted", head.replace(/^\[worq ([0-9a-f]{4})\] /, "worq $1 · "))}`;
      return new Text(options.expanded ? `${line}\n${theme.fg("muted", rest.join("\n"))}` : line, 1, 0);
    });

    pi.on("session_start", async (_event, ctx) => {
      ui = ctx;
      // Resume/fork: restore the last /worq choice on this branch.
      const last = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === ENABLED).at(-1);
      if (last && last.type === "custom" && (last.data as { on?: boolean } | undefined)?.on) enable(true);
      if (socket) return;
      try { socket = await serve(statePath(), (op, args) => run(ctx, op, args)); }
      catch (error) { if (ctx.mode === "tui") say(ctx, `Worq control socket unavailable: ${errorText(error)}`, "warning"); }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      closing = true;
      await instance?.shutdown();
      await socket?.close().catch(() => {});
      socket = undefined;
      if (ctx.mode === "tui") ctx.ui.setStatus("worq", undefined);
    });
  };
}
export default createWorq();
