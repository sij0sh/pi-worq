import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Block } from "./contracts.ts";
import { frontmatter, type Skill } from "./runtime/skills.ts";

export type Access = "read" | "write";
/** An SDK agent profile: built-in kind or installed workflow. The Markdown body is the workflow. */
export interface Kind {
  name: string;
  access: Access;
  prompt: string;
  description: string;
  /** Submission triggers one independent review. */
  review: boolean;
  /** `disable-model-invocation: true`: only the user can launch it (/worq workflow). */
  userOnly: boolean;
  /** A workflow's own skill package. */
  skill?: Skill;
}
export interface Prompts {
  dir: string;
  protocol: string;
  guard: string;
  pq: string;
  review: string;
  kinds: Map<string, Kind>;
}

const flag = (meta: Record<string, string>, key: string, fallback: boolean) => {
  const value = meta[key] ?? String(fallback);
  if (value !== "true" && value !== "false") throw new Block("prompt-file", `${key} must be true or false`);
  return value === "true";
};
/** Profile frontmatter shared by built-in kinds and workflows: access, review, disable-model-invocation. */
export function profile(name: string, meta: Record<string, string>, prompt: string, defaults: { access?: Access; review: boolean }, skill?: Skill): Kind {
  const access = meta.access ?? defaults.access;
  if (access !== "read" && access !== "write") throw new Block("prompt-file", "access must be read or write");
  if (!prompt) throw new Block("prompt-file", "body is blank");
  return {
    name, access, prompt, skill, description: meta.description?.trim() || name,
    review: flag(meta, "review", defaults.review), userOnly: flag(meta, "disable-model-invocation", false),
  };
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
/** Everything that is process lives here as Markdown: kinds, protocol, PQ and review. */
export function loadPrompts(dir = fileURLToPath(new URL("../prompts/", import.meta.url))): Prompts {
  const kinds = new Map<string, Kind>();
  for (const name of names(join(dir, "kinds"))) {
    const path = join(dir, "kinds", `${name}.md`);
    const { meta, body } = frontmatter(read(path));
    try { kinds.set(name, profile(name, meta, body, { review: false })); }
    catch (error) { throw new Block("prompt-file", `${path}: ${(error as Error).message}`); }
  }
  if (!kinds.size) throw new Block("prompt-file", `No agent kinds in ${join(dir, "kinds")}`);
  return {
    dir,
    protocol: read(join(dir, "protocol.md")),
    guard: read(join(dir, "guard.md")),
    pq: read(join(dir, "pq.md")),
    review: read(join(dir, "review.md")),
    kinds,
  };
}
