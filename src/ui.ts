import { getMarkdownTheme, getSelectListTheme, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Markdown, ScrollView, SelectList, Text, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentReport, Run, RunView, State } from "./controller.ts";

const phases = ["Plan", "Execute", "Verify"];
export const STOP_KEY = "alt+x";
export const active = (view: RunView) => ["running", "question", "stopping"].includes(view.state);
export const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const oneLine = (text: string) => clean(text).replace(/\s+/g, " ").trim();
export type Paint = Pick<Theme, "fg" | "bold">;
const plain: Paint = { fg: (_color, text) => text, bold: (text) => text };
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const icons: Record<State, string> = { running: "◆", question: "◆", stopping: "◆", pass: "✔", "report-ready": "✔", fail: "✖", inconclusive: "⚠", cancelled: "■", blocked: "✖", limited: "✖", "cleanup-unconfirmed": "⚠" };
const stateLabel = (state: State) => state.replaceAll("-", " ").toUpperCase();
export function tone(state: State): ThemeColor {
  if (state === "pass" || state === "report-ready") return "success";
  if (state === "question" || state === "inconclusive") return "warning";
  if (state === "running") return "accent";
  return state === "cancelled" || state === "stopping" ? "muted" : "error";
}
export function elapsed(view: RunView, now = Date.now()) {
  if (view.started === undefined) return "";
  const s = Math.max(0, Math.floor(((view.finished ?? now) - view.started) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function headline(view: RunView) {
  return `${stateLabel(view.state)} · ${view.phase}${view.candidate ? ` · ${view.candidate.slice(0, 8)} · not merged` : ""}`;
}
export function agentReportText(entry: AgentReport) {
  const lead = `[worq] ${entry.agent ? `${entry.agent} · ` : ""}${entry.role} · ${entry.verdict ? `${entry.verdict.toUpperCase()} · ` : ""}${oneLine(entry.summary)}`;
  return clean([lead, `Run ${entry.run} · ${entry.phase} · round ${entry.attempt}${entry.commit ? ` · commit ${entry.commit}` : ""}`,
    entry.notes, ...(entry.artifacts ?? []).map((path) => `Artifact: ${path}`)].filter(Boolean).join("\n"));
}
export function report(view: RunView) {
  return clean([`Worq ${view.id} · ${headline(view)}${view.started !== undefined ? ` · ${elapsed(view)}` : ""}`, view.activity, view.code ? `Reason: ${view.code}` : "", view.question,
    view.candidate ? `Candidate ${view.candidate} at ${view.branch}` : "", ...view.reports.map((entry) => `\n${agentReportText(entry)}`),
    view.receipt ? `Legacy evidence: ${view.receipt.path}` : "",
    view.directory ? `\nLocal records: ${view.directory}\nInspect: /worq status ${view.id}` : ""].filter(Boolean).join("\n"));
}
/** One-line outcome for finished runs (widget tail and result entry). */
export function summary(view: RunView, t: Paint = plain, now = Date.now()) {
  const color = tone(view.state);
  const parts = view.state === "pass"
    ? [view.receipt ? "Verified candidate" : "Verify agent accepted", view.candidate && `${view.candidate.slice(0, 8)} on ${view.branch}`, "not merged"]
    : [oneLine(view.activity)];
  const time = elapsed(view, now);
  return `${t.fg(color, icons[view.state])} ${t.bold("worq")} ${t.fg(color, t.bold(stateLabel(view.state)))}`
    + t.fg("muted", ` · ${[...parts.filter(Boolean), time].filter(Boolean).join(" · ")}`);
}
const label: Partial<Record<State, string>> = { question: "needs you", stopping: "stopping" };
/** Live pipeline rail. Pure: `frame` drives the spinner, `now` the timer. */
export function renderRail(view: RunView, width: number, t: Paint = plain, frame = 0, now = Date.now()): string[] {
  if (width < 1) return [];
  if (!active(view)) return [truncateToWidth(summary(view, t, now), width)];
  const color = tone(view.state);
  const fit = (line: string) => truncateToWidth(line, width);
  // Header: ◆ worq ── needs you ────────── round 1/3 · 0:42
  const cue = label[view.state] ?? (view.state === "running" && view.pending?.length ? "waiting on Pi" : undefined);
  const left = `${t.fg(color, "◆")} ${t.bold("worq")}${cue ? ` ${t.fg(color, `── ${cue}`)}` : ""}`;
  const meta = [`round ${view.attempt}/3`, elapsed(view, now)].filter(Boolean);
  let right = meta.join(" · ");
  if (visibleWidth(left) + visibleWidth(right) + 4 > width) right = meta.at(-1) ?? "";
  if (visibleWidth(left) + visibleWidth(right) + 4 > width) right = "";
  const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(right) - (right ? 2 : 1));
  const header = `${left} ${t.fg("borderMuted", "─".repeat(fill))}${right ? ` ${t.fg("muted", right)}` : ""}`;
  // Rail: ✓ Plan ━━ ⠹ Execute ── ○ Verify
  const current = phases.indexOf(view.phase);
  const glyph = (i: number) => i < current ? t.fg("success", "✓")
    : i > current ? t.fg("dim", "○")
    : view.state === "question" ? t.fg("warning", "?") : view.state === "stopping" ? t.fg("muted", "■") : t.fg("accent", spinner[frame % spinner.length]);
  const name = (i: number) => i < current ? t.fg("muted", phases[i]) : i > current ? t.fg("dim", phases[i]) : t.fg(color, t.bold(phases[i]));
  const link = (i: number) => i < current ? t.fg("success", " ━━ ") : t.fg("dim", " ── ");
  let rail = "  " + phases.map((_, i) => `${glyph(i)} ${name(i)}`).reduce((acc, seg, i) => i ? acc + link(i - 1) + seg : seg, "");
  if (visibleWidth(rail) > width) rail = `  ${phases.map((_, i) => glyph(i)).join("")} ${name(current)}`;
  const lines = [header, rail];
  if (view.state === "question" && view.question) {
    const wrapped = wrapTextWithAnsi(oneLine(view.question), Math.max(10, width - 4)).slice(0, 3);
    wrapped.forEach((line, i) => lines.push(`  ${i ? " " : t.fg("warning", "?")} ${t.bold(line)}`));
    lines.push(t.fg("dim", `    ↵ type your answer below · ${STOP_KEY} stops`));
  } else {
    const jobs = view.jobs.filter((j) => j.state === "running").length;
    const fix = view.attempt > 1 && view.phase === "Execute" ? "repair · " : "";
    const detail = `${fix}${oneLine(view.activity)}${jobs ? ` · ${jobs} job${jobs > 1 ? "s" : ""}` : ""}`;
    lines.push(`  ${fix ? t.fg("warning", "↻") : t.fg("dim", "↳")} ${t.fg("muted", detail)}`);
  }
  return lines.map(fit);
}
export function widget(ctx: ExtensionContext, run: Run) {
  ctx.ui.setWidget("worq", (tui, theme) => {
    let frame = 0;
    const timer = setInterval(() => { frame++; if (active(run.view)) tui.requestRender(); }, 100);
    timer.unref?.();
    const unsubscribe = run.subscribe(() => tui.requestRender());
    return {
      dispose() { clearInterval(timer); unsubscribe(); }, invalidate() {},
      render: (width: number) => renderRail(run.view, width, theme, frame),
    };
  });
}
const sections = ["Path", "Contract", "Plan / Lenses", "Execute reports", "Verify reports", "Agents"];
function detail(view: RunView, index: number) {
  if (index === 0) return `${report(view)}\n\nRequest\n${view.request}\n\nPath\n${view.path.join("\n") || "Not started"}`;
  if (index === 1) return view.contract ? JSON.stringify(view.contract, null, 2) : "No change contract";
  if (index === 2) return [view.plan?.verificationNote && `Verify guidance: ${view.plan.verificationNote}`, ...(view.plan?.steps.map((s, i) => `${i + 1}. ${s}`) ?? []),
    ...view.reports.filter((entry) => entry.phase === "Plan").map(agentReportText), ...view.jobs.map((j) => `${j.id} · ${j.kind} · ${j.state}\n${j.task}`)].filter(Boolean).join("\n\n") || "No plan yet";
  if (index === 5) return [...(view.agents ?? []).map((a) => `${a.id} · ${a.role} · ${a.state} · ${a.turns} turns${a.sealed ? " · sealed" : ""}${a.last ? `\n  ${a.last}` : ""}`),
    ...(view.pending?.length ? ["", "Waiting on Pi", ...view.pending.map((p) => `${p.id} · ${p.kind === "ask" ? `${p.agent} asks` : `${p.gate} review`}\n${p.body}`)] : [])].join("\n") || "No agents yet";
  if (index === 4 && view.receipt) return `Legacy evidence: ${view.receipt.path}\nSHA-256: ${view.receipt.digest}`;
  const phase = index === 3 ? "Execute" : "Verify";
  return view.reports.filter((entry) => entry.phase === phase).map(agentReportText).join("\n\n") || "No reports yet";
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
