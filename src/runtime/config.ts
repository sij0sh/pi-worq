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
const RuntimeSchema = obj({ sdk: Type.Optional(name), model: modelRef, fallbackModel: modelRef, thinking });
const ROLE = "^(agent|subagent|reviewer)(\\.[a-z][a-z0-9-]*)?$";
/** Every budget. Absent keys use DEFAULT_LIMITS. */
const Limits = obj({
  agents: int(1, 32), subagents: int(0, 64), parallel: int(1, 16), rounds: int(1, 20), asks: int(0, 20),
  agentTurns: int(1, 400), subagentTurns: int(1, 100), reviewerTurns: int(1, 200),
  agentMinutes: int(1, 600), subagentMinutes: int(1, 120), reviewerMinutes: int(1, 240), askMinutes: int(1, 1440),
  checkpointSeconds: int(1, 120), runTurns: int(1, 10000), continuationTurns: int(0, 10000),
  services: int(0, 8),
});
const ConfigSchema = obj({
  /** Runtime used by roles with no `roles` entry. Absent = built-in "main" (Pi, Main's model). */
  default: Type.Optional(name),
  runtimes: Type.Optional(Type.Record(name, RuntimeSchema)),
  /** Role → runtime name. Exact role wins over its family. */
  roles: Type.Optional(Type.Record(Type.String({ pattern: ROLE }), name)),
  /** Approves executing the native extension files installed in the shared resource directory. */
  approveExtensions: Type.Optional(Type.Boolean()),
  limits: Type.Optional(Limits),
});
export const DEFAULT_LIMITS = {
  agents: 4, subagents: 6, parallel: 4, rounds: 3, asks: 3,
  agentTurns: 80, subagentTurns: 16, reviewerTurns: 40,
  agentMinutes: 30, subagentMinutes: 5, reviewerMinutes: 10, askMinutes: 15,
  checkpointSeconds: 15, runTurns: 1000, continuationTurns: 0, services: 2,
} satisfies Required<Static<typeof Limits>>;
export type Limits = typeof DEFAULT_LIMITS;

export const MAIN: Runtime = { name: "main", sdk: "pi", path: "", via: "" };
export interface Config {
  path: string;
  limits: Limits;
  approveExtensions: boolean;
  /** Resolve a role: exact role → role family → default → built-in "main". */
  runtime(role: string): Runtime;
}

const LEGACY = ["agents", "scq", "harness", "harnesses", "model", "fallbackModel", "models"];

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
  if (legacy.length) throw new Block("config", `${path}: ${legacy.join(", ")} ${legacy.length > 1 ? "are" : "is"} from the old Worq format. Declare named presets in "runtimes" ({ "<name>": { "sdk", "model", "fallbackModel", "thinking" } }), map roles to them in "roles" (keys agent, agent.<kind>, subagent, subagent.<name>, reviewer, reviewer.<name>), and set "default". Skills, instructions and extensions are no longer per role: install them under <agentDir>/worq/.`);
  const config = parse(ConfigSchema, data, path);
  const runtimes = config.runtimes ?? {};
  const roles = config.roles ?? {};

  const resolved = new Map<string, Runtime>();
  for (const [key, preset] of Object.entries(runtimes)) {
    const sdk = preset.sdk ?? "pi";
    if (!sdks.includes(sdk)) throw new Block("config", `${path}: /runtimes/${key}/sdk: unknown sdk "${sdk}" (available: ${sdks.join(", ")})`);
    for (const field of ["model", "fallbackModel"] as const) {
      const value = preset[field];
      const pattern = SDKS[sdk]?.modelRef;
      if (value !== undefined && pattern && !pattern.test(value)) throw new Block("config", `${path}: /runtimes/${key}/${field} "${value}" is not a valid ${sdk} model ref (expected ${pattern})`);
    }
    resolved.set(key, { name: key, sdk, path: `/runtimes/${key}`, via: "", ...preset, ...(preset.sdk ? {} : { sdk }) });
  }
  const lookup = (key: string, via: string) => {
    const runtime = resolved.get(key);
    if (!runtime) throw new Block("config", `${path}: ${via}: unknown runtime "${key}" (declared: ${[...resolved.keys()].join(", ") || "none"})`);
    return { ...runtime, via };
  };
  if (config.default) lookup(config.default, "/default");
  for (const [role, key] of Object.entries(roles)) lookup(key, `/roles/${role}`);

  return {
    path,
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    approveExtensions: config.approveExtensions ?? false,
    runtime(role) {
      if (role.startsWith("subagent.") && !Object.hasOwn(roles, role)) throw new Block("config", `Unknown named child ${role}: declare roles["${role}"]`);
      const [family] = role.split(".");
      if (Object.hasOwn(roles, role)) return lookup(roles[role], `/roles/${role}`);
      if (Object.hasOwn(roles, family)) return lookup(roles[family], `/roles/${family}`);
      if (config.default) return lookup(config.default, "/default");
      return { ...MAIN };
    },
  };
}
