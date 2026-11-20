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
export const Criterion = obj({ id, outcome: text(360), checks: array(id, 4) });
const scope = { outcome: text(480), boundaries: array(text(300), 5), assumptions: array(text(240), 5), criteria: array(Criterion, 6, 1) };
/** Contract C: the user's verbatim request (host-set) plus the scope Plan frames for Execute and Verify. */
export const ContractSchema = obj({ request: text(4000), ...scope });
export const PlanSchema = obj({ contract: obj(scope), summary: text(), steps: array(text(400), 8, 1) });
export const ExecuteSchema = obj({ summary: text() });
export const JourneySchema = obj({ cases: array(obj({ check: id, scenario: id }), 12), blocker: Type.Optional(text(500)) });
export const RouteSchema = obj({ route: Type.Union([Type.Literal("product"), Type.Literal("design"), Type.Literal("intent")]), reason: text(500) });
export type Contract = Static<typeof ContractSchema>;
export type Plan = Static<typeof PlanSchema>;
export type Journey = Static<typeof JourneySchema>;

const args = array(Type.String({ maxLength: 4096 }), 32);
const cmd = obj({ executable: text(1024), args });
const expected = obj({ channel: Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("screen"), Type.Literal("exit")]), op: Type.Union([Type.Literal("equals"), Type.Literal("contains")]), value: Type.Union([Type.String({ maxLength: 2048 }), Type.Integer({ minimum: 0, maximum: 255 })]) });
const action = Type.Union([
  obj({ type: Type.Literal("press"), key: Type.Enum(["enter", "escape", "tab", "backspace", "up", "down", "left", "right", "ctrl-c"] as const) }),
  obj({ type: Type.Literal("type"), text: Type.String({ maxLength: 2048, pattern: "^[^\\x00-\\x1f\\x7f]*$" }) }),
  obj({ type: Type.Literal("resize"), cols: Type.Integer({ minimum: 20, maximum: 240 }), rows: Type.Integer({ minimum: 5, maximum: 80 }) }),
  obj({ type: Type.Literal("observe") }),
  obj({ type: Type.Literal("wait"), ms: Type.Integer({ minimum: 1, maximum: 2000 }) }),
]);
const scenario = obj({ id, name: text(240), args, stdin: Type.Optional(Type.String({ maxLength: 8192 })),
  fixtures: Type.Optional(array(obj({ path: text(1024), content: Type.String({ maxLength: 8192 }) }), 8)),
  steps: Type.Optional(array(action, 16, 1)), expect: array(expected, 6, 1),
});
export const ProfileSchema = obj({
  version: Type.Literal(1), trustLocalCode: Type.Literal(true), repository: text(2048),
  manager: Type.Optional(obj({
    review: Type.Optional(Type.Union([Type.Literal("gates"), Type.Literal("asks-only"), Type.Literal("off")])),
    askSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })), gateSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  })),
  surface: Type.Union([Type.Literal("cli"), Type.Literal("tui")]), entry: text(1024), interpreter: Type.Optional(text(1024)),
  build: Type.Optional(cmd), devChecks: Type.Optional(array(obj({ id, ...cmd.properties }), 6)),
  checks: array(obj({ id, outcome: text(360), scenarios: array(scenario, 4, 1) }), 12, 1),
});
export type Profile = Static<typeof ProfileSchema>;
export type Scenario = Static<typeof scenario>;
export type Action = Static<typeof action>;
export type Command = Static<typeof cmd>;
export function distinct(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length) throw new Block("duplicate-id", `${label} must have unique IDs`);
}
export function coverage(contract: Contract, profile: Profile): string[] {
  distinct(contract.criteria.map((x) => x.id), "Criteria");
  const required = new Set<string>();
  for (const criterion of contract.criteria) {
    distinct(criterion.checks, `Checks for ${criterion.id}`);
    if (!criterion.checks.length || criterion.checks.some((key) => !profile.checks.some((check) => check.id === key))) {
      throw new Block("coverage", `No approved check covers ${criterion.id}: ${criterion.outcome}`);
    }
    criterion.checks.forEach((key) => required.add(key));
  }
  return [...required];
}
