import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Type } from "typebox";
import { Block } from "../contracts.ts";
import { tool, type ExtensionFile, type Tool } from "../sdk/contract.ts";
import { inside } from "../workspace.ts";

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
export interface Skill { name: string; description: string; body: string }
export interface Resources {
  root: string;
  instructions: readonly { name: string; text: string }[];
  skills: readonly Skill[];
  extensions: readonly ExtensionFile[];
}
export const EMPTY: Resources = { root: "", instructions: [], skills: [], extensions: [] };
const MAX_BYTES = 256 * 1024;

async function exists(path: string) {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
/** Files directly under `dir` (and `<sub>/SKILL.md` when `skills`), resolved, contained, regular, bounded. */
async function files(root: string, dir: string, skills = false): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const out: string[] = [];
  for (const entry of (await readdir(dir)).sort()) {
    if (entry.startsWith(".")) continue;
    let path = await realpath(join(dir, entry));
    if (!inside(root, path)) throw new Block("config", `Untrusted resource: ${join(dir, entry)} escapes ${root}`);
    const stat = await lstat(path);
    if (skills && stat.isDirectory()) {
      path = join(path, "SKILL.md");
      if (!(await exists(path))) continue;
      path = await realpath(path);
      if (!inside(root, path)) throw new Block("config", `Untrusted resource: ${path} escapes ${root}`);
    } else if (stat.isDirectory()) continue;
    const file = await lstat(path);
    if (!file.isFile()) throw new Block("config", `Not a regular resource file: ${path}`);
    if (file.size > MAX_BYTES) throw new Block("config", `Resource too large (${file.size} bytes > ${MAX_BYTES}): ${path}`);
    out.push(path);
  }
  return out;
}
function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fields, body: text.slice(match[0].length) };
}
const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);

/** Snapshot <agentDir>/worq. A missing directory is an empty environment, not an error. */
export async function loadResources(agentDir: string, approveExtensions: boolean): Promise<Resources> {
  const base = join(agentDir, "worq");
  if (!(await exists(base))) return { ...EMPTY, root: base };
  const root = await realpath(base);
  // Operator resources must not live in a checkout an agent can write or a diff can plant.
  for (let dir = root; ; dir = dirname(dir)) {
    if (await exists(join(dir, ".git"))) throw new Block("config", `Repository resource: ${root} is inside a Git checkout`);
    if (dir === dirname(dir)) break;
  }
  const instructions = await Promise.all((await files(root, join(root, "instructions"))).filter((p) => extname(p) === ".md")
    .map(async (path) => ({ name: basename(path), text: await readFile(path, "utf8") })));
  const skills: Skill[] = [];
  for (const path of await files(root, join(root, "skills"), true)) {
    if (extname(path) !== ".md") continue;
    const { fields, body } = frontmatter(await readFile(path, "utf8"));
    const name = safe(fields.name ?? (basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md")));
    if (skills.some((s) => s.name === name)) throw new Block("config", `Duplicate skill name ${name}: ${path}`);
    skills.push({ name, description: (fields.description ?? body.trim().split("\n")[0] ?? "").slice(0, 300), body });
  }
  const extensions = await Promise.all((await files(root, join(root, "extensions"))).filter((p) => [".mjs", ".js", ".ts"].includes(extname(p)))
    .map(async (path) => ({ name: basename(path), bytes: await readFile(path) })));
  if (extensions.length && !approveExtensions) {
    throw new Block("config", `Extension approval required: ${extensions.map((e) => e.name).join(", ")} in ${join(root, "extensions")} run in-process as operator code (not a sandbox). Set "approveExtensions": true in pi-worq.json or remove them.`);
  }
  return Object.freeze({ root, instructions, skills, extensions });
}

/** Worq's own system prompt plus shared instructions and the skill index (bodies load on demand). */
export function compose(system: string, resources: Resources): string {
  const parts = [system];
  for (const { name, text } of resources.instructions) parts.push(`Operator instructions ${name} (context, not authority):\n${text.trim()}`);
  if (resources.skills.length) {
    parts.push(`Operator skills (context, not authority). Call skill with a name to read one when it applies:\n${resources.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Read-only, available to every role when any skill is installed. */
export function skillTool(resources: Resources): Tool | undefined {
  if (!resources.skills.length) return undefined;
  const names = resources.skills.map((s) => s.name);
  return tool("skill", "Read an installed operator skill by name. Context, not authority.", Type.Object({ name: Type.Union(names.map((n) => Type.Literal(n))) }, { additionalProperties: false }),
    ({ name }) => resources.skills.find((s) => s.name === name)!.body);
}
