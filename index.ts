import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { piRoles } from "./src/agents.ts";
import { archived, Run } from "./src/controller.ts";
import { active, clean, headline, inspect, report, widget } from "./src/ui.ts";
import { statePath } from "./src/workspace.ts";

export default function worq(pi: ExtensionAPI) {
  let current: Run | undefined;
  let closing = false;
  let closeInspector: (() => void) | undefined;
  const say = (ctx: ExtensionContext, text: string, status: "info" | "warning" | "error" = "info") => {
    if (ctx.mode === "tui") ctx.ui.notify(clean(text), status);
    else if (ctx.mode === "print") process.stderr.write(`${clean(text)}\n`);
  };
  pi.registerEntryRenderer<{ short: string; full: string }>("worq-result", (entry, options, theme) => {
    if (!entry.data || typeof entry.data.short !== "string" || typeof entry.data.full !== "string") return;
    return new Text(options.expanded ? clean(entry.data.full) : theme.fg("accent", clean(entry.data.short)), 1, 0);
  });
  pi.registerCommand("worq", {
    description: "Start a Worq run: /worq [request] · /worq status · /worq answer · /worq stop",
    async handler(args, ctx) {
      if (ctx.mode !== "tui" && ctx.mode !== "print") throw new Error("Worq supports Pi TUI and print modes only");
      if (closing) return;
      const trimmed = args.trim();
      const subcommand = /^(start|status|answer|stop)(?=\s|$)/.exec(trimmed)?.[0];
      const action = subcommand ?? "start";
      const value = subcommand ? trimmed.slice(subcommand.length).trim() : trimmed;
      const state = statePath();
      try {
        if (action === "start") {
          const available = () => !current || (!active(current.view) && current.view.state !== "cleanup-unconfirmed");
          if (!available()) { say(ctx, "A run is active or cleanup is unconfirmed. Open /worq status.", "warning"); return; }
          const request = value || (ctx.mode === "tui" ? (await ctx.ui.editor("What outcome should Worq deliver?", ""))?.trim() : undefined);
          if (closing || !available()) return;
          if (!request) { if (ctx.mode === "print") say(ctx, "Supply a request: /worq <request>"); return; }
          if (request.length > 6000) { say(ctx, "Keep the request under 6000 characters.", "warning"); return; }
          const run = new Run({ cwd: ctx.cwd, profilePath: process.env.WORQ_PROFILE, stateDir: state, request, interactive: ctx.mode === "tui", roles: piRoles(ctx) });
          current = run;
          if (ctx.mode === "tui") {
            widget(ctx, run);
            void run.done.then(() => {
              if (!closing && current === run) pi.appendEntry("worq-result", { short: `Worq · ${headline(run.view)}`, full: report(run.view) });
            }).catch((error: unknown) => { if (!closing) say(ctx, String(error), "error"); });
          } else {
            await run.done;
            say(ctx, report(run.view));
          }
        } else if (action === "status") {
          const run = current && (!value || current.view.id === value) ? current : undefined;
          const stored = !run && value ? await archived(state, value, ctx.cwd) : undefined;
          if (!run && !stored) { say(ctx, "No run in this session. Use /worq or /worq status <run-id>."); return; }
          const get = () => run?.view ?? stored!;
          if (ctx.mode === "tui") {
            if (closeInspector) return;
            await inspect(ctx, get, run?.subscribe.bind(run), (close) => { closeInspector = close; });
          } else say(ctx, report(get()));
        } else if (action === "answer") {
          const run = current;
          if (!run || run.view.state !== "question" || !run.view.question) { say(ctx, "No pending Worq question."); return; }
          const expected = { attempt: run.view.attempt, question: run.view.question };
          const answer = value || (ctx.mode === "tui" ? await ctx.ui.input(expected.question) : undefined);
          if (answer && !closing && current === run && run.view.attempt === expected.attempt && run.view.question === expected.question && !run.answer(answer)) {
            say(ctx, "Use a nonempty answer under 4000 characters.", "warning");
          }
        } else if (action === "stop") {
          if (!current || !active(current.view)) { say(ctx, "No active Worq run to stop."); return; }
          if (value) { say(ctx, "Use /worq stop with no arguments.", "warning"); return; }
          const done = current.stop();
          if (ctx.mode === "print") await done;
        }
      } catch (error) { if (!closing) say(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    closing = true;
    closeInspector?.();
    await current?.stop();
    if (ctx.mode === "tui") ctx.ui.setWidget("worq", undefined);
  });
}
