import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Block, errorText } from "../contracts.ts";
import { inside } from "../workspace.ts";
import { exists, outsideCheckout } from "./skills.ts";

/**
 * Operator resource files that ship as inert templates and are installed once per profile:
 *
 *   <agentDir>/worq/AGENTS.md           appended to every system prompt
 *   <agentDir>/worq/SPAWN-GUIDANCE.md   the shortlist Main may choose a worker runtime from
 *   <agentDir>/worq/routing.json        automated quota/condition-based runtime routing rules and per-role budgets
 *   <agentDir>/worq/ROUTING.md          agent-facing schema and editing guide for routing.json
 *
 * These are operator-owned data, not shipped assets: a file is written only when it is missing, so updates and
 * re-installs never touch an existing copy. There is no marker file, so a deleted file comes back on the next load.
 */
export const TEMPLATE_SEEDS = fileURLToPath(new URL("../../templates/worq/", import.meta.url));
export const TEMPLATES = ["AGENTS.md", "SPAWN-GUIDANCE.md", "routing.json", "ROUTING.md"] as const;
export interface TemplateProblem { path: string; message: string }

/** The deepest existing ancestor, so a Git checkout is detected before anything is created in it. */
function existing(path: string): string {
  let dir = path;
  while (!exists(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/**
 * Create the missing templates in `<agentDir>/worq/`. Never throws and never modifies an existing entry: a regular
 * file (operator-owned), a directory, or a symlink is left exactly as it is. A symlink is reported, because Worq
 * will not follow one, and anything that resolves outside the profile or inside a Git checkout is refused.
 */
export function provisionTemplates(agentDir: string, seeds = TEMPLATE_SEEDS): { problems: TemplateProblem[] } {
  const dir = join(agentDir, "worq");
  let root: string;
  try {
    outsideCheckout(realpathSync(existing(agentDir)));
    mkdirSync(dir, { recursive: true });
    const profile = realpathSync(agentDir);
    if (lstatSync(dir).isSymbolicLink()) throw new Block("config", `${dir} is a symlink; templates are only written to a real directory`);
    root = realpathSync(dir);
    outsideCheckout(root);
    if (root === profile || !inside(profile, root)) throw new Block("config", `${dir} resolves outside ${profile}`);
  } catch (error) {
    const targets = TEMPLATES.map((name) => join(dir, name)).join(", ");
    return { problems: [{ path: dir, message: `Default resources not installed: ${errorText(error)}. Create ${targets} by hand, or copy ${seeds}.` }] };
  }
  const problems: TemplateProblem[] = [];
  for (const name of TEMPLATES) {
    const target = join(root, name);
    const seed = join(seeds, name);
    try {
      if (exists(target)) {
        if (lstatSync(target).isSymbolicLink()) {
          problems.push({ path: target, message: `Default resource not installed: it is a symlink, so it was neither modified nor followed. Replace it with a regular file, or copy ${seed}.` });
        }
        continue;
      }
      writeFileSync(target, readFileSync(seed), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      problems.push({ path: target, message: `Default resource not installed: ${errorText(error)}. Create ${target} by hand, or copy ${seed}.` });
    }
  }
  return { problems };
}
