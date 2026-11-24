import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Block, errorText } from "../contracts.ts";
import type { Kind } from "../prompts.ts";
import { exists, loadSkill, outsideCheckout } from "./skills.ts";

/**
 * Workflows are skill packages under `<agentDir>/workflows/<name>/SKILL.md`, read once per extension load.
 * Frontmatter: `name` (= folder), `description` (required), `disable-model-invocation` (true = user-only),
 * `access` (`read` explicit; absent = write). No reviewers.
 */
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export interface WorkflowProblem { path: string; message: string }
export interface Workflows { dir: string; kinds: Map<string, Kind>; problems: WorkflowProblem[] }

function load(root: string, path: string, name: string, builtins: ReadonlyMap<string, Kind>): Kind | string {
  if (!NAME.test(name)) return "folder name must be lowercase letters and digits, hyphen-separated, starting with a letter";
  if (builtins.has(name)) return `"${name}" is a built-in kind; rename the folder`;
  if (!exists(join(path, "SKILL.md"))) return "add SKILL.md";
  const { skill, meta } = loadSkill(root, path);
  if (meta.name !== undefined && meta.name !== name) return `name "${meta.name}" must match the folder name "${name}"`;
  if (!meta.description?.trim()) return "description is required (shown by /worq workflow and worq_spawn)";
  if (Object.hasOwn(meta, "reviewers")) return 'workflows run no reviewers; remove "reviewers"';
  if (Object.hasOwn(meta, "invocation")) return 'use "disable-model-invocation: true" instead of "invocation"';
  const disable = meta["disable-model-invocation"] ?? "false";
  if (disable !== "true" && disable !== "false") return "disable-model-invocation must be true or false";
  const access = meta.access ?? "write";
  if (access !== "read" && access !== "write") return "access must be read or write (absent = write)";
  if (!skill.body) return "SKILL.md body is blank";
  return { name, access, prompt: skill.body, description: skill.description, workflow: { skill, userOnly: disable === "true" } };
}

/** A broken workflow is reported and skipped; its siblings still load. A missing directory is empty. */
export function loadWorkflows(agentDir: string, builtins: ReadonlyMap<string, Kind>): Workflows {
  const dir = join(agentDir, "workflows");
  const kinds = new Map<string, Kind>();
  const problems: WorkflowProblem[] = [];
  if (!exists(dir)) return { dir, kinds, problems };
  let root: string;
  let entries: string[];
  try {
    root = realpathSync(dir);
    outsideCheckout(root);
    entries = readdirSync(root).sort();
  } catch (error) {
    throw error instanceof Block ? error : new Block("workflow-file", `Cannot read ${dir}: ${(error as Error).message}`);
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry.toLowerCase() === "readme.md") continue;
    const path = join(root, entry);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) { problems.push({ path, message: "symlinked workflows are not followed; copy the folder" }); continue; }
      if (!stat.isDirectory()) {
        if (entry.endsWith(".md")) problems.push({ path, message: `move to ${join(dir, entry.slice(0, -3), "SKILL.md")}` });
        continue;
      }
      const result = load(root, path, entry, builtins);
      if (typeof result === "string") problems.push({ path, message: result });
      else kinds.set(result.name, result);
    } catch (error) { problems.push({ path, message: errorText(error) }); }
  }
  return { dir, kinds, problems };
}
