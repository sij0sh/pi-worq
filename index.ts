import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { piRoles } from "./src/agents.ts";
import type { BusEvent } from "./src/bus.ts";
import { obj, text } from "./src/contracts.ts";
import { dispatch, Ops, serve, type Host, type Op } from "./src/control.ts";
import { archived, Run, type State } from "./src/controller.ts";
import { active, agentReportText, clean, inspect, report, STOP_KEY, summary, tone, widget } from "./src/ui.ts";
import { statePath } from "./src/workspace.ts";

/** What the manager (main Pi) reads when an agent asks or a handoff needs review. */
export function managerMessage(event: Exclude<BusEvent, { type: "settled" }>) {
  const { pending, context } = event;
  if (event.type === "ask") {
    return `[worq] ${pending.id} · agent ${pending.agent} asks:\n${pending.body}\n\n${context ? `Recent activity:\n${context}\n\n` : ""}`
      + `Answer with worq_reply (id "${pending.id}"), or worq_escalate if only the user can decide.`;
  }
  return `[worq] ${pending.id} · ${pending.gate} review\n${pending.body}\n\n`
    + `Review with worq_review (id "${pending.id}"): approve, revise with text, or escalate if it changes what the user asked for.`;
}

export default function worq(pi: ExtensionAPI) {
  let current: Run | undefined;
  let closing = false;
  let closeInspector: (() => void) | undefined;
  let socket: Awaited<ReturnType<typeof serve>> | undefined;
  const host: Host = { run: () => current, report: (run) => report(run.view) };
  const say = (ctx: ExtensionContext, text: string, status: "info" | "warning" | "error" = "info") => {
    if (ctx.mode === "tui") ctx.ui.notify(clean(text), status);
    else if (ctx.mode === "print") process.stderr.write(`${clean(text)}\n`);
  };
  const stop = (ctx: ExtensionContext) => {
    if (!current || !active(current.view)) { say(ctx, "No active Worq run to stop."); return; }
    return current.stop();
  };
  const available = () => !current || (!active(current.view) && current.view.state !== "cleanup-unconfirmed");

  async function start(ctx: ExtensionContext, request: string, lenses = true) {
    const run = new Run({ cwd: ctx.cwd, stateDir: statePath(), request, interactive: ctx.mode === "tui",
      roles: piRoles(ctx), manager: ctx.mode === "tui", lenses });
    current = run;
    if (ctx.mode !== "tui") { await run.done; say(ctx, report(run.view)); return run; }
    widget(ctx, run);
    let asked: string | undefined;
    let detach: (() => void) | undefined;
    let delivered = 0;
    const unsubscribe = run.subscribe(() => {
      if (closing || current !== run) return;
      for (const entry of run.view.reports.slice(delivered)) {
        delivered++;
        pi.sendMessage({ customType: "worq-agent", display: true, content: agentReportText(entry), details: entry }, { triggerTurn: false });
      }
      // Only asks and reviews trigger a manager turn.
      if (run.bus && !detach) detach = run.bus.on((event) => {
        if (closing || current !== run) return;
        if (event.type === "settled") {
          pi.sendMessage({ customType: "worq-agent", display: true, content: `[worq] ${event.id} ${event.outcome}; the run continues without it.` }, { deliverAs: "nextTurn" });
          return;
        }
        pi.sendMessage({ customType: "worq-agent", display: true, content: managerMessage(event), details: event.pending }, { triggerTurn: true, deliverAs: "followUp" });
      });
      const question = run.view.state === "question" ? run.view.question : undefined;
      if (question === asked) return;
      asked = question;
      if (question) ctx.ui.notify(clean(question), "warning");
    });
    void run.done.then(() => {
      unsubscribe(); detach?.();
      if (closing || current !== run) return;
      ctx.ui.setWidget("worq", undefined);
      pi.appendEntry("worq-result", { short: summary(run.view), full: report(run.view), state: run.view.state });
    }).catch((error: unknown) => { if (!closing) say(ctx, String(error), "error"); });
    return run;
  }

  pi.registerEntryRenderer<{ short: string; full: string; state?: State }>("worq-result", (entry, options, theme) => {
    const data = entry.data;
    if (!data || typeof data.short !== "string" || typeof data.full !== "string") return;
    // `short` is plain text; color it here so stored entries never carry escape codes.
    const color = data.state ? tone(data.state) : "accent";
    const [icon, ...rest] = clean(data.short).split(" ");
    const line = `${theme.fg(color, icon)} ${rest.join(" ")}`;
    return new Text(options.expanded ? `${line}\n\n${theme.fg("muted", clean(data.full))}` : line, 1, 0);
  });
  pi.registerMessageRenderer("worq-agent", (message, options, theme) => {
    const body = clean(typeof message.content === "string" ? message.content : message.content.map((c) => c.type === "text" ? c.text : "").join(""));
    const [head, ...rest] = body.split("\n");
    const line = `${theme.fg("accent", "◆")} ${theme.fg("muted", head.replace(/^\[worq\] /, "worq · "))}`;
    return new Text(options.expanded ? `${line}\n${theme.fg("muted", rest.join("\n"))}` : line, 1, 0);
  });

  // Manager tools for the main Pi session. Same operations as `/worq <op>` and the `worq` CLI.
  const ops: { op: Op; name: string; description: string; guideline?: string }[] = [
    { op: "status", name: "worq_status", description: "Show the active Worq run: phase, state, agents and open questions/reviews." },
    { op: "agents", name: "worq_agents", description: "List Worq's SDK agents (id, role, state) and open questions/reviews." },
    { op: "log", name: "worq_log", description: "Read an agent's recent activity (tool calls and messages)." },
    { op: "send", name: "worq_send", description: "Message a running Worq agent. mode steer (default) arrives after its current tool call; followUp waits until it would stop.",
      guideline: "Use worq_send when the user wants to redirect or inform a running Worq agent; Worq agents cannot see this conversation." },
    { op: "interrupt", name: "worq_interrupt", description: "Abort a Worq agent's current turn and redirect it with your message." },
    { op: "reply", name: "worq_reply", description: "Answer a Worq agent's question by its id (q…).",
      guideline: "When a [worq] message asks a question, answer with worq_reply if this conversation or the repository settles it; use worq_escalate when only the user can decide intent or scope." },
    { op: "review", name: "worq_review", description: "Decide a Worq handoff review by its id (g…): approve, revise (with text), or escalate to the user.",
      guideline: "For [worq] reviews, use worq_review: approve when the handoff fits what the user asked for in this conversation; revise with concrete text when it drifts. Never treat a review as acceptance: the independent Verify agent reports the verdict. A plan review may carry lens findings. Approve to discard them as overfitted or not material to what the user asked; revise, naming the findings to resolve, to reopen Plan with a copy of them." },
    { op: "escalate", name: "worq_escalate", description: "Hand a Worq question or review to the user." },
    { op: "stop", name: "worq_stop", description: "Stop the active Worq run and join its agents." },
  ];
  for (const { op, name, description, guideline } of ops) {
    const parameters: TSchema = Ops[op];
    pi.registerTool({
      name, label: name, description, parameters, promptSnippet: description,
      ...(guideline ? { promptGuidelines: [guideline] } : {}),
      async execute(_id, params: Static<typeof parameters>) {
        const { text } = await dispatch(host, op, params);
        return { content: [{ type: "text", text: clean(text) }], details: undefined };
      },
    });
  }
  pi.registerTool({
    name: "worq_start", label: "worq_start", description: "Start Worq for a plan, report, or code change with independent verification.",
    promptSnippet: "Start a Worq run for a report or code change",
    promptGuidelines: ["Use worq_start only when the user asks for Worq; you then manage its agents through the worq_* tools."],
    parameters: obj({ request: text(6000), lenses: Type.Optional(Type.Boolean({ description: "Run lens SCQs (pair, defeater, decision, subtraction) on the finished plan; their findings join your plan review. Default true." })) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (ctx.mode !== "tui") throw new Error("worq_start needs Pi's interactive mode; use /worq in print mode");
      if (!available()) throw new Error("A Worq run is already active");
      const run = await start(ctx, params.request, params.lenses ?? true);
      return { content: [{ type: "text", text: `Started Worq run ${run.view.id}. Its reports, questions, and reviews will arrive as [worq] messages.` }], details: undefined };
    },
  });

  pi.registerCommand("worq", {
    description: "Start a Worq run: /worq [--no-lenses] [request]. Also: status · agents · log <agent> · send <agent> <text> · reply <id> <text> · review <id> approve|revise|escalate [text] · stop",
    async handler(args, ctx) {
      if (ctx.mode !== "tui" && ctx.mode !== "print") throw new Error("Worq supports Pi TUI and print modes only");
      if (closing) return;
      const trimmed = args.trim();
      const subcommand = /^(start|status|stop|agents|log|send|interrupt|reply|review|escalate)(?=\s|$)/.exec(trimmed)?.[0];
      const action = subcommand ?? "start";
      const value = subcommand ? trimmed.slice(subcommand.length).trim() : trimmed;
      const state = statePath();
      try {
        if (action === "start") {
          if (!available()) { say(ctx, `A Worq run is already active (${STOP_KEY} stops it).`, "warning"); return; }
          const noLenses = /^--no-lenses(?=\s|$)/.test(value);
          const typed = noLenses ? value.slice("--no-lenses".length).trim() : value;
          const request = typed || (ctx.mode === "tui" ? (await ctx.ui.editor("What outcome should Worq deliver?", ""))?.trim() : undefined);
          if (closing || !available()) return;
          if (!request) { if (ctx.mode === "print") say(ctx, "Supply a request: /worq <request>"); return; }
          if (request.length > 6000) { say(ctx, "Keep the request under 6000 characters.", "warning"); return; }
          await start(ctx, request, !noLenses);
        } else if (action === "status") {
          const run = current && (!value || current.view.id === value) ? current : undefined;
          const stored = !run && value ? await archived(state, value, ctx.cwd) : undefined;
          if (!run && !stored) { say(ctx, "No run in this session. Use /worq or /worq status <run-id>."); return; }
          const get = () => run?.view ?? stored!;
          if (ctx.mode === "tui") {
            if (closeInspector) return;
            await inspect(ctx, get, run?.subscribe.bind(run), (close) => { closeInspector = close; });
          } else say(ctx, report(get()));
        } else if (action === "stop") {
          const done = stop(ctx);
          if (ctx.mode === "print") await done;
        } else {
          const [first = "", ...rest] = value.split(/\s+/);
          const tail = rest.join(" ");
          const params: Record<Op, () => object> = {
            agents: () => ({}), status: () => ({}), stop: () => ({}),
            log: () => ({ agent: first }),
            send: () => ({ agent: first, text: tail }),
            interrupt: () => ({ agent: first, text: tail }),
            reply: () => ({ id: first, text: tail }),
            review: () => { const [decision = "", ...words] = rest; return { id: first, decision, ...(words.length ? { text: words.join(" ") } : {}) }; },
            escalate: () => ({ id: first }),
          };
          const { text } = await dispatch(host, action, params[action as Op]());
          say(ctx, text);
        }
      } catch (error) { if (!closing) say(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  // While Worq waits on the user, whatever they type in Pi's editor is the answer.
  pi.on("input", async (event, ctx) => {
    const run = current;
    if (closing || !run || run.view.state !== "question" || event.source !== "interactive") return { action: "continue" };
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
    if (/^(stop|cancel|abort)$/i.test(text)) { void run.stop(); return { action: "handled" }; }
    if (!run.answer(text)) say(ctx, "Keep the answer under 4000 characters.", "warning");
    return { action: "handled" };
  });
  pi.registerShortcut(STOP_KEY, { description: "Stop the active Worq run", handler: (ctx) => { void stop(ctx); } });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || socket) return;
    try { socket = await serve(statePath(), host); }
    catch (error) { say(ctx, `Worq control socket unavailable: ${String(error)}`, "warning"); }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    closing = true;
    closeInspector?.();
    await current?.stop();
    await socket?.close().catch(() => {});
    socket = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("worq", undefined);
  });
}
