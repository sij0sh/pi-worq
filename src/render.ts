import type { PqAnswer, ReviewReport, Submission, Verdict } from "./contracts.ts";

export const one = (text: string, max = 240) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
export const clean = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g, "");
const bullets = (items?: string[]) => items?.length ? items.map((item) => `- ${item}`).join("\n") : "- None";

export function planMarkdown(input: { ref: string; title?: string; kind: string; final?: boolean; reviewRequired?: boolean; task: string; report: Submission; label?: string }) {
  const { ref, kind, task, report } = input;
  return [
    `# ${input.label ?? "Plan"}: ${input.title ?? ref}`, "", `Worq ${kind} agent · ${input.final ? "final revision after review" : input.reviewRequired === false ? "review not configured" : "submission for independent review"} · ${new Date().toISOString().slice(0, 10)}`, "",
    "## Request", "", task, "", "## Summary", "", report.summary, ...(report.report ? ["", report.report] : []), "",
  ].join("\n");
}
export const reportText = (report: Submission) => [report.summary, report.report].filter(Boolean).join("\n\n");
export function pqMessage(question: string, answer?: PqAnswer, error?: string, cancelled = false) {
  if (!answer) return `[PQ ${cancelled ? "cancelled" : "failed"}] ${question}\n${error ?? "no answer"}\nInvestigate it yourself or proceed without it.`;
  return [`[PQ] ${question}`, `Answer (${answer.basis}): ${answer.answer}`,
    answer.unresolved?.length && `Unresolved:\n${bullets(answer.unresolved)}`, answer.newQuestions?.length && `New questions:\n${bullets(answer.newQuestions)}`,
    "Integrate: what did this resolve, contradict, or newly make material?"].filter(Boolean).join("\n");
}
/** The agent's one review. */
export interface ReviewRecord extends Partial<ReviewReport> { verdict: Verdict; error?: string }
export interface ReviewCaps {
  summary: number; witness: number; change: number; basis: number;
  /** Findings shown; absent means all of them. */
  limit?: number;
  /** Where the hidden ones are, named in the `(N more)` line. */
  label?: string;
}
/** Full text, at the schema's own maxima (contracts.ts:53-55): what `worq_list` shows. */
export const DETAIL: ReviewCaps = { summary: 1600, witness: 800, change: 500, basis: 400 };
/** The parked digest: the four most consequential findings, one line each. */
export const DIGEST: ReviewCaps = { summary: 400, witness: 160, change: 80, basis: 80, limit: 4 };

/** Indices to show, in order: the first `limit`, but never at the cost of a `need` finding. */
function keep(findings: NonNullable<ReviewReport["findings"]>, limit?: number) {
  if (limit === undefined || findings.length <= limit) return findings.map((f, i) => ({ f, i }));
  const slots = new Set(Array.from({ length: limit }, (_, i) => i));
  for (let i = limit; i < findings.length; i++) {
    if (!findings[i].need) continue;
    const victim = [...slots].reverse().find((slot) => !findings[slot].need);
    if (victim === undefined) break;
    slots.delete(victim);
    slots.add(i);
  }
  return [...slots].sort((a, b) => a - b).map((i) => ({ f: findings[i], i }));
}

export function reviewStatus(review?: ReviewRecord) {
  if (!review || review.verdict === "inconclusive") return "review inconclusive";
  return review.verdict === "pass" && !review.findings?.length ? "review passed" : "review findings";
}

export function reviewLines(review: ReviewRecord | undefined, caps: ReviewCaps = DETAIL, reviewRequired = false) {
  if (!review) return [reviewRequired ? "Expected review did not finish: review inconclusive." : "No review configured for this workflow."];
  const findings = review.findings ?? [];
  const shown = keep(findings, caps.limit);
  const dropped = findings.length - shown.length;
  return [
    `review: ${review.verdict}${review.error ? ` (${one(review.error, 200)})` : ""}${review.summary ? ` — ${one(review.summary, caps.summary)}` : ""}`,
    ...shown.flatMap(({ f, i }) => [
      `  ${i + 1}${f.need ? " [need: requester]" : ""}: ${one(f.witness, caps.witness)}${f.change ? ` → ${one(f.change, caps.change)}` : ""}${f.basis ? ` (${one(f.basis, caps.basis)})` : ""}`,
      ...(caps.limit === undefined && f.consequence ? [`    Consequence: ${one(f.consequence, 500)}`] : []),
    ]),
    ...(dropped > 0 ? [`  (${dropped} more: ${caps.label ?? "worq_list"})`] : []),
    ...(review.artifacts ?? []).map((a) => `  artifact: ${a}`),
  ];
}

/** One `delegate_edit` slice. `conflict`: its commit did not merge cleanly onto the wave. */
export interface EditWorker {
  id: string; name?: string; task: string; writePaths: readonly string[];
  state: "queued" | "running" | "done" | "integrated" | "conflict" | "failed" | "cancelled";
  forked?: boolean; sha?: string; recoverySha?: string; files?: string[]; summary?: string; error?: string;
}
/** Parallel edit slices from one pinned base, integrated together. */
export interface EditWave { n: number; base: string; workers: EditWorker[]; integrated?: string; error?: string }

/** The parent's single wake after a wave settles. */
export function editWaveMessage(wave: EditWave, diffstat = "") {
  const tag = (w: EditWorker) => `${w.name ?? w.id} (${w.writePaths.join(", ")})`;
  const merged = wave.workers.filter((w) => w.state === "integrated").length;
  const lines = wave.workers.map((w) => {
    switch (w.state) {
      case "integrated": return `- [integrated] ${tag(w)}: ${one(w.summary ?? "done", 400)}`;
      case "done": return `- [no changes] ${tag(w)}: ${one(w.summary ?? "done", 300)}`;
      case "conflict": return `- [conflict] ${tag(w)} @ ${w.sha}: ${one(w.error ?? "", 300)}. Not merged; apply it yourself (git cherry-pick ${w.sha}) or redo it.`;
      default: return `- [${w.state}] ${tag(w)}: ${one(w.error ?? "no result", 300)}${w.recoverySha ? `. Partial commit ${w.recoverySha} (unverified; git cherry-pick to reuse)` : ""}`;
    }
  });
  return [
    `[EDIT WAVE ${wave.n}] ${merged}/${wave.workers.length} slices integrated from ${wave.base.slice(0, 10)}${wave.integrated ? ` → ${wave.integrated.slice(0, 10)} (your branch is fast-forwarded)` : "; your worktree is unchanged"}`,
    ...lines,
    ...(wave.error ? [`Integration error: ${one(wave.error, 400)}`] : []),
    ...(diffstat ? [diffstat] : []),
    "Your edits and commands are unfenced. Fix cross-slice glue and any failed slice, run the full verification once, then submit.",
  ].join("\n");
}
