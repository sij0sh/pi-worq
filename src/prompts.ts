import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Block } from "./contracts.ts";

export type Access = "read" | "write";
export type Invocation = "shared" | "user";
export interface Kind {
  name: string;
  access: Access;
  prompt: string;
  description: string;
  invocation: Invocation;
  /** Explicit opt-in roster name; absent means no reviewers. Workflows only. */
  reviewers?: string;
}
export interface Reviewer { name: string; prompt: string }
export interface Prompts {
  dir: string;
  protocol: string;
  guard: string;
  pq: string;
  reviewer: string;
  kinds: Map<string, Kind>;
  reviewers(review: string): Reviewer[];
}

const NAME = /^[a-z][a-z0-9-]*$/;
function read(path: string) {
  let body: string;
  try { body = readFileSync(path, "utf8").trim(); }
  catch (error) { throw new Block("prompt-file", `Cannot read ${path}: ${(error as Error).message}`); }
  if (!body) throw new Block("prompt-file", `${path} is blank`);
  return body;
}
function names(dir: string) {
  try { return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((n) => NAME.test(n)).sort(); }
  catch { return []; }
}
/** `---\nkey: value\n---\nbody`. Only flat string keys. */
export function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
  raw = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

/** Everything that is process lives here as Markdown: kinds, protocol, PQ and reviewer rosters. */
export function loadPrompts(dir = fileURLToPath(new URL("../prompts/", import.meta.url))): Prompts {
  const kinds = new Map<string, Kind>();
  for (const name of names(join(dir, "kinds"))) {
    const path = join(dir, "kinds", `${name}.md`);
    const { meta, body } = frontmatter(read(path));
    if (meta.access !== "read" && meta.access !== "write") throw new Block("prompt-file", `${path}: access must be read or write`);
    kinds.set(name, { name, access: meta.access, prompt: body, description: meta.description || name, invocation: "shared" });
  }
  if (!kinds.size) throw new Block("prompt-file", `No agent kinds in ${join(dir, "kinds")}`);
  const cache = new Map<string, Reviewer[]>();
  return {
    dir,
    protocol: read(join(dir, "protocol.md")),
    guard: read(join(dir, "guard.md")),
    pq: read(join(dir, "pq.md")),
    reviewer: read(join(dir, "reviewer.md")),
    kinds,
    reviewers(review) {
      let roster = cache.get(review);
      if (!roster) {
        const base = join(dir, "reviewers", review);
        roster = names(base).map((name) => ({ name, prompt: read(join(base, `${name}.md`)) }));
        cache.set(review, roster);
      }
      return roster;
    },
  };
}

const WORKFLOW_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** One skipped workflow file and the defect that skipped it. */
export interface WorkflowProblems { path: string; message: string }
export interface Workflows { kinds: Map<string, Kind>; problems: WorkflowProblems[] }

const heading = (line: string) => /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
/** A heading at H1–H3 named `title` with non-blank content before the next same-or-higher heading. */
function section(body: string, title: string) {
  const lines = body.split("\n");
  const wanted = title.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const match = heading(lines[i]);
    if (!match || match[2].trim().toLowerCase() !== wanted) continue;
    const level = match[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = heading(lines[j]);
      if (next) {
        if (next[1].length <= level) break;
        continue;
      }
      if (lines[j].trim()) return true;
    }
  }
  return false;
}

function loadWorkflow(path: string, name: string, prompts: Prompts): Kind | { error: string } {
  if (!WORKFLOW_NAME.test(name)) return { error: `${path}: file name must be lowercase letters and digits, hyphen-separated, starting with a letter` };
  if (prompts.kinds.has(name)) return { error: `${path}: "${name}" is a built-in kind; rename the file` };
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { return { error: `Cannot read ${path}: ${(error as Error).message}` }; }
  if (!raw.trim()) return { error: `${path}: is blank` };
  const { meta, body } = frontmatter(raw);
  if (Object.hasOwn(meta, "invocation")) return { error: `${path}: invocation is decided by the workflows directory; remove "invocation"` };
  if (meta.access !== "read" && meta.access !== "write") return { error: `${path}: access must be read or write` };
  const description = meta.description?.trim();
  if (!description) return { error: `${path}: description is required (shown by /worq workflow)` };
  if (!section(body, "Workflow")) return { error: `${path}: add a "Workflow" section with the steps the agent must follow` };
  if (!section(body, "Recursive question") && !/^recursive question\s*:\s*\S/im.test(body)) {
    return { error: `${path}: add a "Recursive question" section stating what unresolved decision the run must close` };
  }
  let reviewers: string | undefined;
  const value = meta.reviewers?.trim();
  if (value && value !== "none") {
    if (!prompts.reviewers(value).length) return { error: `${path}: reviewers "${value}" is not a packaged roster (plan, execute)` };
    reviewers = value;
  }
  return { name, access: meta.access, prompt: body, description, invocation: "user", ...(reviewers ? { reviewers } : {}) };
}

/** Read `<dir>/<name>.md` workflow files. A broken file is reported and skipped; its siblings still load. */
export function loadWorkflows(dir: string, prompts: Prompts): Workflows {
  const kinds = new Map<string, Kind>();
  const problems: WorkflowProblems[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kinds, problems };
    throw new Block("workflow-file", `Cannot read ${dir}: ${(error as Error).message}`);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name.toLowerCase() === "readme.md" || !entry.name.endsWith(".md") || !entry.isFile()) continue;
    const path = join(dir, entry.name);
    const result = loadWorkflow(path, entry.name.slice(0, -3), prompts);
    if ("error" in result) problems.push({ path, message: result.error });
    else kinds.set(result.name, result);
  }
  return { kinds, problems };
}
