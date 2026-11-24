import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Block, errorText } from "../contracts.ts";
import { profile, type Kind } from "../prompts.ts";
import { exists, loadSkill, outsideCheckout } from "./skills.ts";

/**
 * The one agent catalog: skill packages under `<agentDir>/workflows/<name>/SKILL.md`, read once per extension load.
 * Frontmatter: `name` (= folder), `description` (required), `disable-model-invocation` (true = user-only),
 * `access` (`read` explicit; absent = write). Every agent gets exactly one review; a `review` key is ignored.
 * Plan and Execute ship as ordinary packages (`SEEDS`), provisioned once per profile and then owned by the operator.
 */
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SEEDS = fileURLToPath(new URL("../../workflows/", import.meta.url));
/** Written once every shipped package is present; Worq never seeds that profile again. */
export const SEEDED = ".worq-seeded";
export interface WorkflowProblem { path: string; message: string }
export interface Workflows { dir: string; kinds: Map<string, Kind>; problems: WorkflowProblem[] }

function load(root: string, path: string, name: string): Kind | string {
  if (!NAME.test(name)) return "folder name must be lowercase letters and digits, hyphen-separated, starting with a letter";
  if (!exists(join(path, "SKILL.md"))) return "add SKILL.md";
  const { skill, meta } = loadSkill(root, path);
  if (meta.name !== undefined && meta.name !== name) return `name "${meta.name}" must match the folder name "${name}"`;
  if (!meta.description?.trim()) return "description is required (shown by /worq and worq_spawn)";
  if (!skill.body) return "SKILL.md body is blank";
  try { return profile(name, meta, skill.body, { access: "write" }, skill); }
  catch (error) { return errorText(error); }
}

/** Regular files and folders only, byte-identical. A symlink anywhere is never "the same". */
function same(a: string, b: string): boolean {
  const sa = lstatSync(a), sb = lstatSync(b);
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) return false;
  if (sa.isDirectory() && sb.isDirectory()) {
    const ea = readdirSync(a).sort(), eb = readdirSync(b).sort();
    return ea.length === eb.length && ea.every((e, i) => e === eb[i] && same(join(a, e), join(b, e)));
  }
  return sa.isFile() && sb.isFile() && readFileSync(a).equals(readFileSync(b));
}
function copy(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const stat = lstatSync(source);
    if (stat.isDirectory()) copy(source, join(to, entry));
    else if (stat.isFile()) copyFileSync(source, join(to, entry));
  }
}

/**
 * Install the shipped packages once per profile, never over existing contents. Each folder is staged and renamed
 * into place, so a concurrent start either wins or finds an identical folder. A differing folder with a shipped name
 * is a conflict: it is withheld until the operator resolves it, and the profile is not marked complete.
 */
export function provision(agentDir: string, seeds = SEEDS): { conflicts: string[]; problems: WorkflowProblem[] } {
  const dir = join(agentDir, "workflows");
  const conflicts: string[] = [];
  try {
    if (exists(join(dir, SEEDED))) return { conflicts, problems: [] };
    mkdirSync(dir, { recursive: true });
    const root = realpathSync(dir);
    outsideCheckout(root);
    for (const name of readdirSync(seeds).sort()) {
      const seed = join(seeds, name);
      if (!lstatSync(seed).isDirectory()) continue;
      const target = join(root, name);
      if (!exists(target)) {
        const staging = mkdtempSync(join(root, `.seed-${name}-`));
        try {
          copy(seed, staging);
          renameSync(staging, target);
          continue;
        } catch (error) {
          rmSync(staging, { recursive: true, force: true });
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
        }
      }
      if (!same(seed, target)) conflicts.push(name);
    }
    if (!conflicts.length) {
      try { writeFileSync(join(root, SEEDED), `${JSON.stringify({ seeded: new Date().toISOString() })}\n`, { flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    return { conflicts, problems: [] };
  } catch (error) {
    return { conflicts, problems: [{ path: dir, message: `Default packages not installed: ${errorText(error)}. Copy ${seeds}<name>/ to ${dir}/<name>/ by hand.` }] };
  }
}

/** A broken package is reported and skipped; its siblings still load. A missing directory is empty. */
export function loadWorkflows(agentDir: string, withheld: readonly string[] = []): Workflows {
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
    if (withheld.includes(entry)) {
      problems.push({ path, message: `differs from the shipped "${entry}" package, so it was not used. Move it aside and restart Pi to install the shipped package, then replace that folder deliberately if you want your version.` });
      continue;
    }
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) { problems.push({ path, message: "symlinked workflows are not followed; copy the folder" }); continue; }
      if (!stat.isDirectory()) {
        if (entry.endsWith(".md")) problems.push({ path, message: `move to ${join(dir, entry.slice(0, -3), "SKILL.md")}` });
        continue;
      }
      const result = load(root, path, entry);
      if (typeof result === "string") problems.push({ path, message: result });
      else kinds.set(result.name, result);
    } catch (error) { problems.push({ path, message: errorText(error) }); }
  }
  return { dir, kinds, problems };
}

/** First use: provision the shipped packages, then snapshot the installed catalog. Never throws. */
export function loadCatalog(agentDir: string, seeds = SEEDS): Workflows {
  const { conflicts, problems } = provision(agentDir, seeds);
  try {
    const loaded = loadWorkflows(agentDir, conflicts);
    return { ...loaded, problems: [...problems, ...loaded.problems] };
  } catch (error) {
    const dir = join(agentDir, "workflows");
    return { dir, kinds: new Map(), problems: [...problems, { path: dir, message: errorText(error) }] };
  }
}
