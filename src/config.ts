import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Block, json, obj, parse } from "./contracts.ts";

const int = (minimum: number, maximum: number) => Type.Optional(Type.Integer({ minimum, maximum }));
const modelRef = Type.Optional(Type.String({ pattern: "^[^/\\s]+/[^\\s]+$" }));
const choice = obj({ model: modelRef, fallbackModel: modelRef });
/** Every budget. Absent keys use DEFAULT_LIMITS. */
const Limits = obj({
  agents: int(1, 32), subagents: int(0, 64), parallel: int(1, 16), rounds: int(1, 20), asks: int(0, 20),
  agentTurns: int(1, 400), subagentTurns: int(1, 100), reviewerTurns: int(1, 200),
  agentMinutes: int(1, 600), subagentMinutes: int(1, 120), reviewerMinutes: int(1, 240), askMinutes: int(1, 1440),
  services: int(0, 8),
});
const ConfigSchema = obj({
  ...choice.properties,
  /** Keys: agent, agent.<kind>, subagent, reviewer, reviewer.<name>. Most specific wins. */
  models: Type.Optional(Type.Record(Type.String({ pattern: "^(agent|subagent|reviewer)(\\.[a-z][a-z0-9-]*)?$" }), choice)),
  limits: Type.Optional(Limits),
});
export const DEFAULT_LIMITS = {
  agents: 4, subagents: 6, parallel: 4, rounds: 3, asks: 3,
  agentTurns: 80, subagentTurns: 16, reviewerTurns: 40,
  agentMinutes: 30, subagentMinutes: 5, reviewerMinutes: 10, askMinutes: 15,
  services: 2,
} satisfies Required<Static<typeof Limits>>;
export type Limits = typeof DEFAULT_LIMITS;
export interface ModelChoice { model?: string; fallbackModel?: string }
export interface Config { path: string; limits: Limits; model(name: string): ModelChoice }

/** Read <agentDir>/pi-worq.json. A missing file means defaults; an invalid one fails naming the key. */
export function loadConfig(agentDir: string): Config {
  const path = join(agentDir, "pi-worq.json");
  let raw = "{}";
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Block("config", `Cannot read ${path}: ${(error as Error).message}`);
  }
  const data = json(raw, path);
  const legacy = data && typeof data === "object" ? ["agents", "scq"].filter((key) => key in data) : [];
  if (legacy.length) throw new Block("config", `${path}: ${legacy.join(" and ")} ${legacy.length > 1 ? "are" : "is"} from the old Worq format. Move model choices to "models" (keys agent, agent.<kind>, subagent, reviewer, reviewer.<name>) or delete ${legacy.length > 1 ? "them" : "it"}.`);
  const config = parse(ConfigSchema, data, path);
  const models = config.models ?? {};
  return {
    path,
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    model(name) {
      const [profile] = name.split(".");
      const pick = models[name] ?? models[profile] ?? {};
      return { model: pick.model ?? config.model, fallbackModel: pick.fallbackModel ?? config.fallbackModel };
    },
  };
}
