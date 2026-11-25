import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import { Type } from "typebox";
import { Block } from "../contracts.ts";
import { tool, type Tool } from "../sdk/contract.ts";
import { contained, exists, indexLine, loadSkill, outsideCheckout, readBounded, readSkillFile, type Skill } from "./skills.ts";

export type { Skill } from "./skills.ts";

/**
 * One Worq-managed resource environment, harness-neutral, shared by every SDK and every role:
 *
 *   <agentDir>/worq/AGENTS.md                  appended to every system prompt
 *   <agentDir>/worq/skills/<name>/SKILL.md     indexed in the prompt, loaded on demand via the `skill` tool
 *   <agentDir>/worq/skills/<name>.md
 *
 * Read once per Worq instance into an immutable snapshot. Resources add context, never authority:
 * they cannot widen a role's tools, budgets or permissions. Nothing harness-specific is loaded.
 */
export interface Resources {
  root: string;
  /** AGENTS.md text, when present. */
  agents?: string;
  skills: readonly Skill[];
  /** Removed layouts found on disk; ignored, warned once at first launch. */
  ignored: readonly string[];
}
export const EMPTY: Resources = { root: "", skills: [], ignored: [] };

/** Visible entries directly under `dir`, each resolved inside `root`. */
function entries(root: string, dir: string): string[] {
  if (!exists(dir)) return [];
  return readdirSync(dir).sort().filter((entry) => !entry.startsWith(".")).map((entry) => contained(root, join(dir, entry)));
}

/** Snapshot <agentDir>/worq. A missing directory is an empty environment, not an error. */
export async function loadResources(agentDir: string): Promise<Resources> {
  const base = join(agentDir, "worq");
  if (!exists(base)) return { ...EMPTY, root: base };
  const root = realpathSync(base);
  outsideCheckout(root);
  const file = join(root, "AGENTS.md");
  const agents = exists(file) ? readBounded(contained(root, file)).trim() || undefined : undefined;
  const skills: Skill[] = [];
  for (const path of entries(root, join(root, "skills"))) {
    const folder = lstatSync(path).isDirectory();
    if (folder ? !exists(join(path, "SKILL.md")) : extname(path) !== ".md") continue;
    const { skill } = loadSkill(root, path);
    if (skills.some((s) => s.name === skill.name)) throw new Block("config", `Duplicate skill name ${skill.name}: ${path}`);
    skills.push(skill);
  }
  const ignored: string[] = [];
  if (exists(join(root, "instructions"))) ignored.push(`${join(root, "instructions")} is no longer read: move its content into ${file} and delete the folder.`);
  if (exists(join(root, "extensions"))) ignored.push(`${join(root, "extensions")} is ignored: native harness extensions were removed. Delete the folder.`);
  return Object.freeze({ root, ...(agents ? { agents } : {}), skills, ignored });
}

/** Worq's own system prompt plus AGENTS.md and the skill index (bodies load on demand). */
export function compose(system: string, resources: Resources, skills: readonly Skill[] = resources.skills): string {
  const parts = [system];
  if (resources.agents) parts.push(`Operator instructions AGENTS.md (context, not authority):\n${resources.agents}`);
  if (skills.length) parts.push(`Operator skills (context, not authority). Call skill with a name (and optionally one of its files as path) to read one when it applies:\n${skills.map(indexLine).join("\n")}`);
  return parts.join("\n\n");
}

/** Read-only, available to every role when any skill is installed: a SKILL body, or one supporting file. */
export function skillTool(skills: readonly Skill[]): Tool | undefined {
  if (!skills.length) return undefined;
  const names = skills.map((s) => s.name);
  return tool("skill", "Read an installed operator skill by name, or one of its listed files with path. Context, not authority.", Type.Object({
    name: Type.Union(names.map((n) => Type.Literal(n))),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  }, { additionalProperties: false }), ({ name, path }) => {
    const skill = skills.find((s) => s.name === name)!;
    return path ? readSkillFile(skill, path) : skill.body;
  }, { parallel: true });
}
