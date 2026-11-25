import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { Block } from "../contracts.ts";
import { inside } from "../workspace.ts";

/**
 * One owner for operator-installed skill packages: shared skills (`<agentDir>/worq/skills`) and
 * workflows (`<agentDir>/workflows`) use the same format, parser and containment rules.
 *
 *   <name>/SKILL.md              frontmatter (name, description, …) + body
 *   <name>/references|scripts|…  supporting files: listed in the prompt, read on demand, never executed
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Package folder; absent for a flat `<name>.md` skill. */
  root?: string;
  /** Supporting files, package-relative with `/` separators. */
  files: readonly string[];
}
export const MAX_BYTES = 256 * 1024;
const MAX_FILES = 200;
const MAX_DEPTH = 4;

export function exists(path: string) {
  try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
/** Resolve `path` and require it to stay under `root`. */
export function contained(root: string, path: string) {
  const real = realpathSync(path);
  if (!inside(root, real)) throw new Block("config", `Untrusted resource: ${path} escapes ${root}`);
  return real;
}
/** A regular file within the size bound, read as text. */
export function readBounded(path: string, strictText = false) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Block("config", `Not a regular resource file: ${path}`);
  if (stat.size > MAX_BYTES) throw new Block("config", `Resource too large (${stat.size} bytes > ${MAX_BYTES}): ${path}`);
  const bytes = readFileSync(path);
  if (!strictText) return bytes.toString("utf8");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Block("binary", `Invalid UTF-8: ${path}`); }
}
/** Operator resources must not live in a checkout an agent can write or a diff can plant. */
export function outsideCheckout(root: string) {
  for (let dir = root; ; dir = dirname(dir)) {
    if (exists(join(dir, ".git"))) throw new Block("config", `Repository resource: ${root} is inside a Git checkout`);
    if (dir === dirname(dir)) return;
  }
}

/** `---\nkey: value\n---\nbody`. Flat string keys (hyphens allowed), optional quotes. */
export function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
  raw = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-zA-Z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
/** Package-relative supporting files (SKILL.md excluded), contained, bounded, dotfiles skipped. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".") || out.length >= MAX_FILES) continue;
      const path = contained(root, join(dir, entry));
      const stat = lstatSync(path);
      if (stat.isDirectory()) { if (depth < MAX_DEPTH) walk(path, depth + 1); continue; }
      const rel = relative(root, path).split(sep).join("/");
      if (stat.isFile() && rel !== "SKILL.md") out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

/** Load `<dir>/SKILL.md` (package) or a flat `<name>.md`. `trusted` is the containment root. */
export function loadSkill(trusted: string, path: string): { skill: Skill; meta: Record<string, string> } {
  const real = contained(trusted, path);
  const folder = lstatSync(real).isDirectory();
  const file = folder ? contained(trusted, join(real, "SKILL.md")) : real;
  const { meta, body } = frontmatter(readBounded(file));
  const name = safe(meta.name ?? (folder ? basename(path) : basename(path, ".md")));
  const description = (meta.description ?? body.split("\n")[0] ?? "").trim().slice(0, 1024);
  return { meta, skill: { name, description, body, ...(folder ? { root: real, files: listFiles(real) } : { files: [] }) } };
}

/** Read one supporting file of a package: contained, regular, bounded, text. */
export function readSkillFile(skill: Skill, path: string): string {
  if (!skill.root || !skill.files.includes(path)) throw new Block("unknown-file", `${skill.name} has no file ${path}${skill.files.length ? ` (files: ${skill.files.join(", ")})` : ""}`);
  const text = readBounded(contained(skill.root, join(skill.root, path)));
  if (text.includes("\0")) throw new Block("binary", "Binary files are not exposed");
  return text;
}

/** One index line per skill, with its supporting files. */
export const indexLine = (s: Skill) => `- ${s.name}: ${s.description}${s.files.length ? ` (files: ${s.files.join(", ")})` : ""}`;
