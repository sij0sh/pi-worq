import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Block, json, literals, obj, parse } from "../contracts.ts";
import type { Runtime } from "../sdk/contract.ts";
import type { WebProviderName } from "../web.ts";

const int = (minimum: number, maximum: number) => Type.Optional(Type.Integer({ minimum, maximum }));
/** Every budget. Absent keys use DEFAULT_LIMITS. */
const Limits = obj({
  agents: int(1, 32), inlineAgents: int(1, 32), subagents: int(0, 64), parallel: int(1, 16), asks: int(0, 20),
  agentTurns: int(1, 400), subagentTurns: int(1, 100), reviewerTurns: int(1, 200),
  agentMinutes: int(1, 600), subagentMinutes: int(1, 120), reviewerMinutes: int(1, 240), askMinutes: int(1, 1440),
  idleMinutes: int(1, 1440), services: int(0, 8),
  edits: int(0, 32), editTurns: int(1, 200), editMinutes: int(1, 120),
});
const WebConfig = obj({
  provider: Type.Optional(literals(["brave", "tavily", "exa"] as const)),
});
const ConfigSchema = obj({ limits: Type.Optional(Limits), web: Type.Optional(WebConfig) });
export const DEFAULT_LIMITS = {
  agents: 4, inlineAgents: 12, subagents: 6, parallel: 4, asks: 3,
  agentTurns: 80, subagentTurns: 16, reviewerTurns: 40,
  agentMinutes: 30, subagentMinutes: 5, reviewerMinutes: 10, askMinutes: 15,
  idleMinutes: 60, services: 2,
  edits: 6, editTurns: 40, editMinutes: 15,
} satisfies Required<Static<typeof Limits>>;
export type Limits = typeof DEFAULT_LIMITS;

/** The default runtime: the current Pi session's model and thinking level. */
export const MAIN: Runtime = { name: "main", sdk: "pi", path: "", via: "" };
export interface Config {
  path: string;
  limits: Limits;
  web?: { provider?: WebProviderName };
  /** Removed settings that must be migrated before any new launch. Management keeps working. */
  migration?: string;
  /** Removed settings (and resource layouts) that are ignored; warned once on first launch use. */
  ignored?: readonly string[];
}

/** Role presets removed in favour of Main's runtime plus explicit launch overrides. */
const PRESETS = ["plan", "execute", "review"];
/** Pre-preset formats. */
const LEGACY = ["default", "runtimes", "roles", "agents", "scq", "harness", "harnesses", "model", "fallbackModel", "models"];

/**
 * Read <agentDir>/pi-worq.json. A missing file means defaults; an invalid supported key fails naming it.
 * Removed keys never throw here: they become findings so list/send/cancel and cleanup stay usable.
 */
export function loadConfig(agentDir: string): Config {
  const path = join(agentDir, "pi-worq.json");
  let raw = "{}";
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Block("config", `Cannot read ${path}: ${(error as Error).message}`);
  }
  const data = json(raw, path);
  const record = data && typeof data === "object" && !Array.isArray(data) ? { ...(data as Record<string, unknown>) } : data;
  let migration: string | undefined;
  const ignored: string[] = [];
  if (record && typeof record === "object") {
    const fields = record as Record<string, unknown>;
    const presets = PRESETS.filter((key) => key in fields).map((key) => `/${key}`);
    const legacy = LEGACY.filter((key) => key in fields).map((key) => `/${key}`);
    const found = [...presets, ...legacy];
    if (found.length) migration = `${path}: ${found.join(", ")} ${found.length > 1 ? "are" : "is"} no longer supported, so new launches are refused until the file is fixed. `
      + "Agents run on the current Pi session's model and thinking unless a launch request sets sdk, model or thinking (worq_spawn, worq spawn --sdk/--model/--thinking, or the /worq runtime step). "
      + "PQ and review subagents inherit their agent's runtime. If you rely on a distinct reviewer runtime, keep the older Worq release until you accept that; otherwise remove the keys and reload Pi.";
    if ("launch" in fields) ignored.push(`${path}: /launch is ignored (the launch countdown was removed; /worq always confirms explicitly). Remove it and reload Pi to silence this warning.`);
    if ("approveExtensions" in fields) ignored.push(`${path}: /approveExtensions is ignored (native harness extensions were removed). Remove it and reload Pi to silence this warning.`);
    for (const key of [...PRESETS, ...LEGACY, "launch", "approveExtensions"]) delete fields[key];
    const limits = fields.limits;
    if (limits && typeof limits === "object" && !Array.isArray(limits) && "scouts" in limits) {
      const { scouts, ...rest } = limits as Record<string, unknown>;
      fields.limits = "inlineAgents" in rest ? rest : { ...rest, inlineAgents: scouts };
      ignored.push(`${path}: /limits/scouts is renamed /limits/inlineAgents (${"inlineAgents" in rest ? "ignored; /limits/inlineAgents is set" : "value applied"}). Rename it and reload Pi to silence this warning.`);
    }
  }
  const config = parse(ConfigSchema, record, path);
  return {
    path,
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    ...(config.web ? { web: config.web as { provider?: WebProviderName } } : {}),
    ...(migration ? { migration } : {}),
    ...(ignored.length ? { ignored } : {}),
  };
}
