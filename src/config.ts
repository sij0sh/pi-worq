import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { HARNESSES, KNOWN_HARNESSES } from "./harness.ts";
import { Block, json, obj, parse } from "./contracts.ts";

const int = (minimum: number, maximum: number) => Type.Optional(Type.Integer({ minimum, maximum }));
/** Ref format is per harness: each record carries its own validator. This only rejects non-strings. */
const modelRef = Type.Optional(Type.String({ maxLength: 200 }));
const name = Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9-]*$" });
const thinking = Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z]+$" }));
const pin = obj({ path: Type.String({ minLength: 1 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) });
const pins = Type.Optional(Type.Array(pin, { maxItems: 32 }));
const choice = obj({ harness: Type.Optional(name), model: modelRef, fallbackModel: modelRef, thinking, skills: pins, instructions: pins, extensions: pins, approveExecutables: Type.Optional(Type.Boolean()) });
const harnessBlock = obj({ model: modelRef, fallbackModel: modelRef, thinking });
/** Every budget. Absent keys use DEFAULT_LIMITS. */
const Limits = obj({
  agents: int(1, 32), subagents: int(0, 64), parallel: int(1, 16), rounds: int(1, 20), asks: int(0, 20),
  agentTurns: int(1, 400), subagentTurns: int(1, 100), reviewerTurns: int(1, 200),
  agentMinutes: int(1, 600), subagentMinutes: int(1, 120), reviewerMinutes: int(1, 240), askMinutes: int(1, 1440),
  checkpointSeconds: int(1, 120), runTurns: int(1, 10000), continuationTurns: int(0, 10000),
  services: int(0, 8),
});
const ConfigSchema = obj({
  harness: Type.Optional(name),
  model: modelRef,
  fallbackModel: modelRef,
  /** Per-harness defaults: the second step of the resolution walk. */
  harnesses: Type.Optional(Type.Record(name, harnessBlock)),
  /** Keys: agent, agent.<kind>, subagent, subagent.<name>, reviewer, reviewer.<name>. Each field inherits independently. */
  models: Type.Optional(Type.Record(Type.String({ pattern: "^(agent|subagent|reviewer)(\\.[a-z][a-z0-9-]*)?$" }), choice)),
  limits: Type.Optional(Limits),
});
export const DEFAULT_LIMITS = {
  agents: 4, subagents: 6, parallel: 4, rounds: 3, asks: 3,
  agentTurns: 80, subagentTurns: 16, reviewerTurns: 40,
  agentMinutes: 30, subagentMinutes: 5, reviewerMinutes: 10, askMinutes: 15,
  checkpointSeconds: 15, runTurns: 1000, continuationTurns: 0, services: 2,
} satisfies Required<Static<typeof Limits>>;
export type Limits = typeof DEFAULT_LIMITS;

/** One role's resolved model choice. `from` is the JSON path each field came from (absent = harness default). */
export interface ModelChoice {
  harness: string;
  model?: string;
  fallbackModel?: string;
  thinking?: string;
  resources?: Partial<Record<"skills" | "instructions" | "extensions", Static<typeof pin>[]>>;
  from: Partial<Record<"harness" | "model" | "fallbackModel" | "thinking" | "skills" | "instructions" | "extensions", string>>;
}
export interface Config { path: string; limits: Limits; model(name: string): ModelChoice }

/** Read <agentDir>/pi-worq.json. A missing file means defaults; an invalid one fails naming the key. */
export function loadConfig(agentDir: string, harnesses: string[] = KNOWN_HARNESSES): Config {
  const path = join(agentDir, "pi-worq.json");
  let raw = "{}";
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Block("config", `Cannot read ${path}: ${(error as Error).message}`);
  }
  const data = json(raw, path);
  const legacy = data && typeof data === "object" ? ["agents", "scq"].filter((key) => key in data) : [];
  if (legacy.length) throw new Block("config", `${path}: ${legacy.join(" and ")} ${legacy.length > 1 ? "are" : "is"} from the old Worq format. Move model choices to "models" (keys agent, agent.<kind>, subagent, subagent.<name>, reviewer, reviewer.<name>) or delete ${legacy.length > 1 ? "them" : "it"}.`);
  const config = parse(ConfigSchema, data, path);
  const top = config as { harness?: string; model?: string; fallbackModel?: string };
  const models = config.models ?? {};
  const blocks = config.harnesses ?? {};

  const known = (harness: string) => harnesses.includes(harness);
  const unknown = (harness: string) => {
    if (!known(harness)) throw new Block("config", `${path}: unknown harness "${harness}" (available: ${harnesses.join(", ")})`);
    return harness;
  };
  const ref = (harness: string, value: string | undefined, key: string) => {
    if (value === undefined) return;
    const record = HARNESSES[harness];
    if (!record || !record.modelRef.test(value)) {
      throw new Block("config", `${path}: ${key} "${value}" is not a valid ${harness} model ref (expected ${record?.modelRef ?? "a registered harness"})`);
    }
  };
  /** The harness a models layer's own fields resolve against, before role-level resolution narrows it. */
  const layerHarness = (key: string) => {
    const [profile] = key.split(".");
    return models[key]?.harness ?? (profile !== key ? models[profile]?.harness : undefined) ?? top.harness ?? "pi";
  };

  if (top.harness) unknown(top.harness);
  for (const harness of Object.keys(blocks)) unknown(harness);
  for (const layer of Object.values(models)) if (layer.harness) unknown(layer.harness);
  const topHarness = top.harness ?? "pi";
  ref(topHarness, top.model, "/model");
  ref(topHarness, top.fallbackModel, "/fallbackModel");
  for (const [harness, block] of Object.entries(blocks)) {
    ref(harness, block.model, `/harnesses/${harness}/model`);
    ref(harness, block.fallbackModel, `/harnesses/${harness}/fallbackModel`);
  }
  for (const [key, layer] of Object.entries(models)) {
    ref(layerHarness(key), layer.model, `/models/${key}/model`);
    ref(layerHarness(key), layer.fallbackModel, `/models/${key}/fallbackModel`);
  }

  return {
    path,
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    model(role) {
      if (role.startsWith("subagent.") && !Object.hasOwn(models, role)) throw new Block("config", `Unknown named child ${role}`);
      const [profile] = role.split(".");
      const layers: { path: string; layer: typeof models[string] }[] = [];
      if (models[role]) layers.push({ path: `/models/${role}`, layer: models[role] });
      if (profile !== role && models[profile]) layers.push({ path: `/models/${profile}`, layer: models[profile] });
      let harness = top.harness ?? "pi";
      let harnessFrom: string | undefined = top.harness ? "/harness" : undefined;
      for (const entry of layers) {
        if (!entry.layer.harness) continue;
        harness = entry.layer.harness;
        harnessFrom = `${entry.path}/harness`;
        break;
      }
      const from: ModelChoice["from"] = {};
      if (harnessFrom) from.harness = harnessFrom;
      const pick = (field: "model" | "fallbackModel" | "thinking") => {
        for (const entry of layers) {
          // A layer declaring another harness lends nothing to this role.
          if (entry.layer.harness && entry.layer.harness !== harness) continue;
          const value = entry.layer[field];
          if (value !== undefined) return [value, `${entry.path}/${field}`] as const;
        }
        const block = blocks[harness];
        if (block?.[field] !== undefined) return [block[field]!, `/harnesses/${harness}/${field}`] as const;
        // The top-level step applies only when the role resolves to the top-level harness; thinking has no top-level form.
        if (field !== "thinking" && (top.harness ?? "pi") === harness && top[field] !== undefined) return [top[field]!, `/${field}`] as const;
        return [undefined, undefined] as const;
      };
      const [model, modelFrom] = pick("model");
      const [fallbackModel, fallbackFrom] = pick("fallbackModel");
      const [level, thinkingFrom] = pick("thinking");
      if (modelFrom) from.model = modelFrom;
      if (fallbackFrom) from.fallbackModel = fallbackFrom;
      if (thinkingFrom) from.thinking = thinkingFrom;
      const resources: ModelChoice["resources"] = {};
      for (const key of ["skills", "instructions", "extensions"] as const) {
        const source = layers.find(e => (!e.layer.harness || e.layer.harness === harness) && e.layer[key] !== undefined);
        if (!source) continue;
        if (key === "extensions" && source.layer.extensions?.length && !models[role]?.approveExecutables) throw new Block("config", `Executable approval required on ${role}`);
        resources[key] = source.layer[key]; from[key] = `${source.path}/${key}`;
      }
      return { ...(Object.keys(resources).length ? { resources } : {}), harness, model, fallbackModel, thinking: level, from };
    },
  };
}
