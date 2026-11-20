import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Block } from "./contracts.ts";

export type Access = "read" | "write";
export interface Kind { name: string; access: Access; review: string; prompt: string; description: string }
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
    const review = meta.review || name;
    if (!NAME.test(review)) throw new Block("prompt-file", `${path}: invalid review roster ${review}`);
    kinds.set(name, { name, access: meta.access, review, prompt: body, description: meta.description || name });
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
