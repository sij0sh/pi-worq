import { getMarkdownTheme, getSelectListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, ScrollView, SelectList, Text, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Run, RunView } from "./controller.ts";

const phases = ["Orient", "Plan", "Execute", "Verify"];
export const active = (view: RunView) => ["running", "question", "stopping"].includes(view.state);
export const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const oneLine = (text: string) => clean(text).replace(/\s+/g, " ").trim();
export function headline(view: RunView) {
  const observed = view.contract?.criteria.filter((c) => view.evidence.some((e) => e.criterion === c.id) && view.evidence.every((e) => e.criterion !== c.id || e.pass)).length;
  return `${view.state.toUpperCase()} · ${view.phase}${view.state === "pass" ? ` · ${observed}/${view.contract?.criteria.length ?? 0} observed` : ""}${view.candidate ? ` · ${view.candidate.slice(0, 8)} · not merged` : ""}`;
}
export function report(view: RunView) {
  return clean([`Worq ${view.id} · ${headline(view)}`, view.activity, view.code ? `Reason: ${view.code}` : "", view.question,
    view.candidate ? `Candidate ${view.candidate} at ${view.branch}` : "", view.receipt ? `Evidence: ${view.receipt.path}\nSHA-256: ${view.receipt.digest}` : "",
    view.directory ? `Local records: ${view.directory}` : ""].filter(Boolean).join("\n"));
}
export function widget(ctx: ExtensionContext, run: Run) {
  ctx.ui.setWidget("worq", (tui, theme) => ({
    dispose: run.subscribe(() => tui.requestRender()), invalidate() {},
    render(width) {
      const view = run.view;
      const phase = phases.indexOf(view.phase);
      const long = `Worq ${view.id.slice(0, 8)}  ${phases.map((item, index) => `${index < phase || view.state === "pass" ? "✓" : index === phase ? "●" : "·"} ${item}`).join("  ")}`;
      const short = `Worq ${view.phase} · ${view.state}`;
      const hint = view.state === "question" ? "/worq answer" : "/worq status";
      const title = visibleWidth(long) < width && active(view) ? long : short;
      const detail = oneLine(view.question ?? view.activity);
      const activity = `Round ${view.attempt} · ${detail}`;
      const remaining = width - visibleWidth(hint) - 3;
      const next = remaining > 9 ? `${truncateToWidth(activity, remaining)} · ${hint}` : hint;
      return [theme.fg(view.state === "pass" ? "success" : "accent", truncateToWidth(title, width)), theme.fg("muted", truncateToWidth(next, width))];
    },
  }));
}
const sections = ["Path", "Contract", "Plan / Jobs", "Execute checks", "Verify evidence"];
function detail(view: RunView, index: number) {
  if (index === 0) return `${report(view)}\n\nRequest\n${view.request}\n\nPath\n${view.path.join("\n") || "Not started"}`;
  if (index === 1) return [view.contract && `Accepted contract\n${JSON.stringify(view.contract, null, 2)}`,
    view.proposedContract && `Proposed contract\n${JSON.stringify(view.proposedContract, null, 2)}`, view.question].filter(Boolean).join("\n\n") || "No contract yet";
  if (index === 2) return [view.plan?.summary, ...(view.plan?.steps.map((s, i) => `${i + 1}. ${s}`) ?? []), "", "Jobs", ...(view.jobs.map((j) => `${j.id} · ${j.kind} · ${j.state}\n${j.task}`))].filter(Boolean).join("\n");
  if (index === 3) return view.selfChecks.join("\n\n") || "No development checks recorded";
  return [view.receipt?.path, ...view.evidence.map((e) => `${e.pass ? "PASS" : "MISMATCH"} · ${e.criterion} · ${e.check}/${e.scenario} · step ${e.traceStep}\nExpected: ${e.expected}\nObserved: ${e.observed}`)].filter(Boolean).join("\n\n") || "No verification evidence yet";
}
export async function inspect(ctx: ExtensionContext, get: () => RunView, subscribe?: Run["subscribe"], setCloser?: (close?: () => void) => void) {
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let index: number | undefined;
    let dirty = true;
    const title = new Markdown("**Worq status**", 0, 0, getMarkdownTheme());
    const menu = new SelectList(sections.map((label, i) => ({ label, value: `${i}` })), sections.length, getSelectListTheme());
    const body = new Text("", 0, 0);
    const scroll = new ScrollView(body, { scrollbar: "hidden" });
    const refresh = () => { dirty = true; tui.requestRender(); };
    const dispose = subscribe?.(refresh);
    setCloser?.(() => done());
    menu.onSelect = (item) => { index = Number(item.value); scroll.scrollToStart(); refresh(); };
    menu.onCancel = () => done();
    return {
      capturesViewportInput: true,
      dispose() { dispose?.(); setCloser?.(); },
      invalidate() { dirty = true; title.invalidate(); menu.invalidate(); body.invalidate(); },
      handleInput(data: string) {
        if (index === undefined) menu.handleInput(data);
        else if (keys.matches(data, "tui.select.cancel")) { index = undefined; refresh(); }
        else if (keys.matches(data, "tui.select.up")) scroll.scrollBy(-1);
        else if (keys.matches(data, "tui.select.down")) scroll.scrollBy(1);
        else if (keys.matches(data, "tui.select.pageUp")) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
        else if (keys.matches(data, "tui.select.pageDown")) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
      },
      render(width: number) {
        if (width < 1) return [];
        if (index === undefined) {
          return [...title.render(width), theme.fg("muted", truncateToWidth(headline(get()), width)), ...menu.render(width), truncateToWidth("↑↓ Choose · Enter Open · Esc Close", width)];
        }
        if (dirty) { body.setText(clean(detail(get(), index))); dirty = false; }
        const lines = scroll.render(width);
        const height = Math.max(2, Math.min(14, Math.floor(tui.terminal.rows / 2) - 2));
        scroll.updateLayout(lines.length, height, () => tui.requestRender());
        return [theme.fg("accent", truncateToWidth(sections[index], width)), ...lines.slice(scroll.scrollTop, scroll.scrollTop + height),
          theme.fg("muted", truncateToWidth("↑↓ Scroll · PgUp/PgDn Page · Esc Back", width))];
      },
    };
  });
}
