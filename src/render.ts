import type { PlanReport, PqAnswer, ReviewReport, Verdict, WorkReport } from "./contracts.ts";

export const one = (text: string, max = 240) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
export const clean = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g, "");
export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-").slice(0, 48) || "plan";
const bullets = (items?: string[]) => items?.length ? items.map((item) => `- ${item}`).join("\n") : "- None";

export function planMarkdown(input: { ref: string; kind: string; round: number; task: string; report: PlanReport }) {
  const { ref, kind, round, task, report } = input;
  const decisions = report.decisions.length
    ? report.decisions.map((d) => `### ${d.id}\n\n- **Choice:** ${d.choice}\n- **Basis:** ${d.basis}\n- **Alternative:** ${d.alternative}\n- **Tradeoff:** ${d.tradeoff}\n- **Revisit:** ${d.revisit}`).join("\n\n")
    : "None consequential.";
  return [
    `# Plan ${ref}`, "", `Worq ${kind} agent · round ${round} · ${new Date().toISOString().slice(0, 10)}`, "",
    "## Request", "", task, "", "## Summary", "", report.summary, "", "## Criteria", "", bullets(report.criteria), "",
    "## Decisions", "", decisions, "", "## Assumptions", "", bullets(report.assumptions),
    ...(report.tree ? ["", "## Thought tree", "", report.tree] : []),
    ...(report.document ? ["", "## Detail", "", report.document] : []),
    "",
  ].join("\n");
}
export function workText(report: WorkReport) {
  return [report.summary, report.changes?.length && `Changes:\n${bullets(report.changes)}`, report.checksRun?.length && `Checks run:\n${bullets(report.checksRun)}`,
    report.assumptions?.length && `Assumptions:\n${bullets(report.assumptions)}`, report.concerns?.length && `Concerns:\n${bullets(report.concerns)}`].filter(Boolean).join("\n\n");
}
export function pqMessage(id: string, question: string, answer?: PqAnswer, error?: string) {
  if (!answer) return `[PQ ${id} failed] ${question}\n${error ?? "no answer"}\nInvestigate it yourself or proceed without it.`;
  return [`[PQ ${id}] ${question}`, `Answer (${answer.basis}): ${answer.answer}`,
    answer.unresolved?.length && `Unresolved:\n${bullets(answer.unresolved)}`, answer.newQuestions?.length && `New questions:\n${bullets(answer.newQuestions)}`,
    "Integrate: what did this resolve, contradict, or newly make material?"].filter(Boolean).join("\n");
}
export interface ReviewRecord extends Partial<ReviewReport> { name: string; verdict: Verdict; error?: string }
export interface ReviewCaps {
  summary: number; witness: number; change: number; basis: number;
  /** Findings shown per reviewer; absent means all of them. */
  limit?: number;
  /** Where the hidden ones are, named in the `(N more)` line. */
  label?: string;
}
/** Full text, at the schema's own maxima (contracts.ts:53-55): what `worq_list` shows. */
export const DETAIL: ReviewCaps = { summary: 1600, witness: 800, change: 500, basis: 400 };
/** The round digest: the four most consequential findings per reviewer, one line each. */
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

export function reviewLines(reviews: ReviewRecord[], caps: ReviewCaps = DETAIL) {
  if (!reviews.length) return ["No reviewers configured for this kind: the result is unverified."];
  return reviews.flatMap((r) => {
    const findings = r.findings ?? [];
    const shown = keep(findings, caps.limit);
    const dropped = findings.length - shown.length;
    return [
      `${r.name}: ${r.verdict}${r.error ? ` (${one(r.error, 200)})` : ""}${r.summary ? ` — ${one(r.summary, caps.summary)}` : ""}`,
      ...shown.map(({ f, i }) => `  ${r.name}-${i + 1}${f.need ? " [need: requester]" : ""}: ${one(f.witness, caps.witness)} → ${one(f.change, caps.change)} (${one(f.basis, caps.basis)})`),
      ...(dropped > 0 ? [`  (${dropped} more: ${caps.label ?? "worq_list"})`] : []),
      ...(r.artifacts ?? []).map((a) => `  artifact: ${a}`),
    ];
  });
}
