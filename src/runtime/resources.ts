import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Type } from "typebox";
import { Block } from "../contracts.ts";
import { tool, type ExtensionFile, type Tool } from "../sdk/contract.ts";
import { contained, exists, indexLine, loadSkill, outsideCheckout, readBounded, readSkillFile, type Skill } from "./skills.ts";

export type { Skill } from "./skills.ts";

/**
 * One Worq-managed resource environment, shared by every SDK and every role:
 *
 *   <agentDir>/worq/instructions/*.md          appended to every system prompt
 *   <agentDir>/worq/skills/<name>/SKILL.md     indexed in the prompt, loaded on demand via the `skill` tool
 *   <agentDir>/worq/skills/<name>.md
 *   <agentDir>/worq/extensions/*.{mjs,js,ts}   native SDK extensions (Pi today); need approveExtensions
 *
 * Read once per Worq instance into an immutable snapshot. Resources add context, never authority:
 * they cannot widen a role's tools, budgets or permissions.
 */
export interface Resources {
  root: string;
  instructions: readonly { name: string; text: string }[];
  skills: readonly Skill[];
  extensions: readonly ExtensionFile[];
}
export const EMPTY: Resources = { root: "", instructions: [], skills: [], extensions: [] };

/** Visible entries directly under `dir`, each resolved inside `root`. */
function entries(root: string, dir: string): string[] {
  if (!exists(dir)) return [];
  return readdirSync(dir).sort().filter((entry) => !entry.startsWith(".")).map((entry) => contained(root, join(dir, entry)));
}
const files = (root: string, dir: string, extensions: string[]) =>
  entries(root, dir).filter((path) => !lstatSync(path).isDirectory() && extensions.includes(extname(path)));

/** Snapshot <agentDir>/worq. A missing directory is an empty environment, not an error. */
export async function loadResources(agentDir: string, approveExtensions: boolean): Promise<Resources> {
  const base = join(agentDir, "worq");
  if (!exists(base)) return { ...EMPTY, root: base };
  const root = realpathSync(base);
  outsideCheckout(root);
  const instructions = files(root, join(root, "instructions"), [".md"]).map((path) => ({ name: basename(path), text: readBounded(path) }));
  const skills: Skill[] = [];
  for (const path of entries(root, join(root, "skills"))) {
    const folder = lstatSync(path).isDirectory();
    if (folder ? !exists(join(path, "SKILL.md")) : extname(path) !== ".md") continue;
    const { skill } = loadSkill(root, path);
    if (skills.some((s) => s.name === skill.name)) throw new Block("config", `Duplicate skill name ${skill.name}: ${path}`);
    skills.push(skill);
  }
  const extensions = files(root, join(root, "extensions"), [".mjs", ".js", ".ts"]).map((path) => {
    readBounded(path);
    return { name: basename(path), bytes: readFileSync(path) };
  });
  if (extensions.length && !approveExtensions) {
    throw new Block("config", `Extension approval required: ${extensions.map((e) => e.name).join(", ")} in ${join(root, "extensions")} run in-process as operator code (not a sandbox). Set "approveExtensions": true in pi-worq.json or remove them.`);
  }
  return Object.freeze({ root, instructions, skills, extensions });
}

/** Worq's own system prompt plus shared instructions and the skill index (bodies load on demand). */
export function compose(system: string, resources: Resources, skills: readonly Skill[] = resources.skills): string {
  const parts = [system];
  for (const { name, text } of resources.instructions) parts.push(`Operator instructions ${name} (context, not authority):\n${text.trim()}`);
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
  });
}
