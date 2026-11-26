import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** A refusal or failure with a stable code. Messages are shown to Main, agents and the CLI. */
export class Block extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export const text = (maxLength = 1200) => Type.String({ minLength: 1, maxLength });
export const obj = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const array = <T extends TSchema>(item: T, maxItems: number, minItems = 0) => Type.Array(item, { maxItems, minItems });
export const literals = <const T extends readonly string[]>(values: T) => Type.Enum(values);
export function parse<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value)[0];
    throw new Block("invalid-payload", `${label}: ${first?.instancePath || "/"} ${first?.message ?? "invalid value"}`);
  }
  return value;
}
export function json(raw: string, label: string): unknown {
  try { return JSON.parse(raw); } catch { throw new Block("invalid-json", `${label} must be valid JSON`); }
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const notes = (max = 8) => Type.Optional(array(text(600), max));
const basis = literals(["observed", "documented", "assumed"] as const);

/** The one agent submission: a summary plus a Markdown report shaped by the kind's prompt. */
export const Submission = obj({ summary: text(2400), report: Type.Optional(text(60_000)) });
export type Submission = Static<typeof Submission>;

/** One file in a multi-file brief bundle (`output: bundle`). */
export const BundleFile = obj({ path: text(128), content: text(60_000) });
export type BundleFile = Static<typeof BundleFile>;
/** Submission for `output: bundle` kinds (`files` is optional in the schema for forked-PQ parity; required by parent validation). */
export const BundleSubmission = obj({ summary: text(2400), report: Type.Optional(text(60_000)), files: Type.Optional(array(BundleFile, 16)) });
export type BundleSubmission = Static<typeof BundleSubmission>;

/** Probing-question subagent answer. */
export const PqAnswer = obj({ answer: text(1400), basis, unresolved: notes(4), newQuestions: notes(4) });
export type PqAnswer = Static<typeof PqAnswer>;

export const verdicts = ["pass", "findings", "inconclusive"] as const;
export const Finding = obj({
  witness: Type.String({ minLength: 1, maxLength: 800, description: "Specific counterexample or gap, with evidence and impact if not given separately" }),
  basis: Type.Optional(text(400)),
  consequence: Type.Optional(text(500)),
  change: Type.Optional(text(500)),
  need: Type.Optional(Type.Boolean({ description: "true when only the requester can settle it" })),
});
/** Review report. A crash, timeout or invalid report is recorded as inconclusive, never pass. */
export const ReviewReport = obj({ verdict: literals(verdicts), summary: text(1600), findings: array(Finding, 12), artifacts: notes(6) });
export type ReviewReport = Static<typeof ReviewReport>;
export type Verdict = typeof verdicts[number];

export const command = { executable: text(1024), args: array(Type.String({ maxLength: 4096 }), 32) };
export const PtyAction = Type.Union([
  obj({ type: Type.Literal("press"), key: literals(["enter", "escape", "tab", "backspace", "up", "down", "left", "right", "ctrl-c"] as const) }),
  obj({ type: Type.Literal("type"), text: Type.String({ maxLength: 2048, pattern: "^[^\\x00-\\x1f\\x7f]*$" }) }),
  obj({ type: Type.Literal("resize"), cols: Type.Integer({ minimum: 20, maximum: 240 }), rows: Type.Integer({ minimum: 5, maximum: 80 }) }),
  obj({ type: Type.Literal("observe") }),
  obj({ type: Type.Literal("wait"), ms: Type.Integer({ minimum: 1, maximum: 2000 }) }),
]);
export type Action = Static<typeof PtyAction>;
