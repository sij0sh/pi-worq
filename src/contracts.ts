import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export class Block extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export const text = (maxLength = 1200) => Type.String({ minLength: 1, maxLength });
export const id = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,39}$" });
export const obj = <T extends Record<string, TSchema>>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const array = <T extends TSchema>(item: T, maxItems: number, minItems = 0) => Type.Array(item, { maxItems, minItems });
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
export const Criterion = obj({ id, outcome: text(360) });
const scope = { outcome: text(480), boundaries: array(text(300), 5), assumptions: array(text(240), 5), criteria: array(Criterion, 6, 1) };
const report = { summary: text(1600), notes: Type.Optional(text(4000)) };
/** Contract C: intent and scope, not a test specification. */
export const ContractSchema = obj({ request: text(6000), ...scope });
export const PlanSchema = obj({ ...report, mode: Type.Enum(["report", "change"] as const), contract: Type.Optional(obj(scope)),
  steps: Type.Optional(array(text(400), 8)), verificationNote: Type.Optional(text(1600)) });
export const ExecuteSchema = obj(report);
export const VerifySchema = obj({ ...report, verdict: Type.Enum(["pass", "fail", "inconclusive"] as const) });
export type Contract = Static<typeof ContractSchema>;
export type Verdict = Static<typeof VerifySchema>["verdict"];

export const command = { executable: text(1024), args: array(Type.String({ maxLength: 4096 }), 32) };
export const PtyAction = Type.Union([
  obj({ type: Type.Literal("press"), key: Type.Enum(["enter", "escape", "tab", "backspace", "up", "down", "left", "right", "ctrl-c"] as const) }),
  obj({ type: Type.Literal("type"), text: Type.String({ maxLength: 2048, pattern: "^[^\\x00-\\x1f\\x7f]*$" }) }),
  obj({ type: Type.Literal("resize"), cols: Type.Integer({ minimum: 20, maximum: 240 }), rows: Type.Integer({ minimum: 5, maximum: 80 }) }),
  obj({ type: Type.Literal("observe") }),
  obj({ type: Type.Literal("wait"), ms: Type.Integer({ minimum: 1, maximum: 2000 }) }),
]);
export type Action = Static<typeof PtyAction>;
