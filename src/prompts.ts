import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Block } from "./contracts.ts";
import type { Skill } from "./runtime/skills.ts";

export type Access = "read" | "write";
/** An SDK agent profile: one installed package under `<agentDir>/workflows/<name>/`. The SKILL.md body is the workflow. */
export interface Kind {
  name: string;
  access: Access;
  prompt: string;
  description: string;
  /** `disable-model-invocation: true`: only the user can launch it (/worq). */
  userOnly: boolean;
  /** The package's own files, indexed and readable alongside shared skills. */
  skill?: Skill;
}
/** Shared process prompts: protocol, PQ and review. Agent kinds come from the installed catalog. */
export interface Prompts {
  dir: string;
  protocol: string;
  pq: string;
  review: string;
}

const flag = (meta: Record<string, string>, key: string, fallback: boolean) => {
  const value = meta[key] ?? String(fallback);
  if (value !== "true" && value !== "false") throw new Block("prompt-file", `${key} must be true or false`);
  return value === "true";
};
/** Package frontmatter: access, disable-model-invocation. Every agent gets exactly one review. */
export function profile(name: string, meta: Record<string, string>, prompt: string, defaults: { access?: Access }, skill?: Skill): Kind {
  const access = meta.access ?? defaults.access;
  if (access !== "read" && access !== "write") throw new Block("prompt-file", "access must be read or write");
  if (!prompt) throw new Block("prompt-file", "body is blank");
  return {
    name, access, prompt, skill, description: meta.description?.trim() || name,
    userOnly: flag(meta, "disable-model-invocation", false),
  };
}

function read(path: string) {
  let body: string;
  try { body = readFileSync(path, "utf8").trim(); }
  catch (error) { throw new Block("prompt-file", `Cannot read ${path}: ${(error as Error).message}`); }
  if (!body) throw new Block("prompt-file", `${path} is blank`);
  return body;
}
/** Process prompts shared by every kind: protocol, PQ and review. */
export function loadPrompts(dir = fileURLToPath(new URL("../prompts/", import.meta.url))): Prompts {
  return {
    dir,
    protocol: read(join(dir, "protocol.md")),
    pq: read(join(dir, "pq.md")),
    review: read(join(dir, "review.md")),
  };
}
