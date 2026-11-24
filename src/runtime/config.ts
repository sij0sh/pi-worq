import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Block, json, obj, parse } from "../contracts.ts";
import type { Runtime } from "../sdk/contract.ts";
import { SDKS } from "../sdk/registry.ts";

const int = (minimum: number, maximum: number) => Type.Optional(Type.Integer({ minimum, maximum }));
/** Ref format is per SDK (registry `modelRef`); this only rejects non-strings. */
const modelRef = Type.Optional(Type.String({ maxLength: 200 }));
const name = Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9-]*$" });
const thinking = Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z]+$" }));
const RuntimeSchema = obj({ sdk: Type.Optional(name), model: modelRef, thinking });
const presets = ["plan", "execute", "review"] as const;
/** Every budget. Absent keys use DEFAULT_LIMITS. */
const Limits = obj({
  agents: int(1, 32), subagents: int(0, 64), parallel: int(1, 16), asks: int(0, 20),
  agentTurns: int(1, 400), subagentTurns: int(1, 100), reviewerTurns: int(1, 200),
  agentMinutes: int(1, 600), subagentMinutes: int(1, 120), reviewerMinutes: int(1, 240), askMinutes: int(1, 1440),
  idleMinutes: int(1, 1440), services: int(0, 8),
});
const ConfigSchema = obj({
  plan: Type.Optional(RuntimeSchema),
  execute: Type.Optional(RuntimeSchema),
  review: Type.Optional(RuntimeSchema),
  launch: Type.Optional(obj({ countdownSeconds: int(0, 120), interactive: Type.Optional(Type.Boolean()) })),
  /** Approves executing the native extension files installed in the shared resource directory. */
  approveExtensions: Type.Optional(Type.Boolean()),
  limits: Type.Optional(Limits),
});
export const DEFAULT_LIMITS = {
  agents: 4, subagents: 6, parallel: 4, asks: 3,
  agentTurns: 80, subagentTurns: 16, reviewerTurns: 40,
  agentMinutes: 30, subagentMinutes: 5, reviewerMinutes: 10, askMinutes: 15,
  idleMinutes: 60, services: 2,
} satisfies Required<Static<typeof Limits>>;
export type Limits = typeof DEFAULT_LIMITS;

export const MAIN: Runtime = { name: "main", sdk: "pi", path: "", via: "" };
export interface Config {
  path: string;
  limits: Limits;
  launch?: { countdownSeconds: number; interactive: boolean };
  approveExtensions: boolean;
  /** SDKs named by declared presets (the router preloads them). */
  sdks: string[];
  /** Return the override for Plan, Execute or Review, otherwise the built-in Pi runtime. */
  runtime(role: string): Runtime;
}

const LEGACY = ["default", "runtimes", "roles", "agents", "scq", "harness", "harnesses", "model", "fallbackModel", "models"];

/** Read <agentDir>/pi-worq.json. A missing file means defaults; an invalid one fails naming the key. */
export function loadConfig(agentDir: string, sdks: string[] = Object.keys(SDKS)): Config {
  const path = join(agentDir, "pi-worq.json");
  let raw = "{}";
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Block("config", `Cannot read ${path}: ${(error as Error).message}`);
  }
  const data = json(raw, path);
  const legacy = data && typeof data === "object" ? LEGACY.filter((key) => key in data) : [];
  if (legacy.length) throw new Block("config", `${path}: ${legacy.join(", ")} ${legacy.length > 1 ? "are" : "is"} from the old Worq format. Remove those keys and put any SDK, model or thinking overrides directly in "plan", "execute" or "review" (each takes { "sdk", "model", "thinking" }). Other roles use the current Pi session. Shared resources belong under <agentDir>/worq/.`);
  const config = parse(ConfigSchema, data, path);
  const resolved = new Map<string, Runtime>();
  for (const key of presets) {
    const preset = config[key];
    if (!preset) continue;
    const sdk = preset.sdk ?? "pi";
    const location = `/${key}`;
    if (!sdks.includes(sdk)) throw new Block("config", `${path}: ${location}/sdk: unknown sdk "${sdk}" (available: ${sdks.join(", ")})`);
    const pattern = SDKS[sdk]?.modelRef;
    if (preset.model !== undefined && pattern && !pattern.test(preset.model)) throw new Block("config", `${path}: ${location}/model "${preset.model}" is not a valid ${sdk} model ref (expected ${pattern})`);
    resolved.set(key, { ...preset, name: key, sdk, path: location, via: location });
  }

  return {
    path,
    launch: { countdownSeconds: 5, interactive: true, ...config.launch },
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    approveExtensions: config.approveExtensions ?? false,
    sdks: [...new Set([...resolved.values()].map((r) => r.sdk))],
    runtime(role) {
      const key = role === "agent.plan" ? "plan" : role === "agent.execute" ? "execute" : role === "review" ? "review" : "";
      return { ...(resolved.get(key) ?? MAIN) };
    },
  };
}
