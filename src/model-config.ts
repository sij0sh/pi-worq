import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Block, json, obj, parse } from "./contracts.ts";

const roles = ["plan", "execute", "verify"] as const;
export type AgentRole = typeof roles[number];
const ref = Type.Optional(Type.String({ pattern: "^[^/\\s]+/[^\\s]+$" }));
const choice = obj({ model: ref, fallbackModel: ref });

export function loadModelConfig(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, lenses: Iterable<string>) {
  const path = join(getAgentDir(), "pi-worq.json");
  let raw = "{}";
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Block("model-config", `Cannot read ${path}: ${(error as Error).message}`);
  }
  const overrides = (names: Iterable<string>) => Type.Optional(obj(Object.fromEntries(
    Array.from(names, (name) => [name, Type.Optional(choice)] as const),
  )));
  const config = parse(obj({ ...choice.properties, agents: overrides([...roles, "journey", "route"]), scq: overrides(lenses) }), json(raw, path), path);
  const resolve = (ref: string) => {
    const slash = ref.indexOf("/");
    const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
    if (!model) throw new Block("model-config", `${path}: Pi does not know model ${ref}`);
    return model;
  };
  const defaults = {
    model: config.model ? resolve(config.model) : ctx.model,
    fallback: config.fallbackModel ? resolve(config.fallbackModel) : undefined,
  };
  const selections = (entries: typeof config.agents) => new Map(Object.entries(entries ?? {}).map(([name, entry]) => [name, {
    model: entry?.model ? resolve(entry.model) : defaults.model,
    fallback: entry?.fallbackModel ? resolve(entry.fallbackModel) : defaults.fallback,
  }]));
  // Before Verify was a single role, `journey` selected its model and `route` selected a separate agent.
  const { journey, route: _unused, verify = journey, ...others } = config.agents ?? {};
  const agents = selections({ ...others, ...(verify ? { verify } : {}) }), scq = selections(config.scq);
  return (role: AgentRole | "lens", lens?: string) => (role === "lens" ? scq.get(lens ?? "") : agents.get(role)) ?? defaults;
}
