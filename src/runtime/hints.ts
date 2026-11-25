import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorText } from "../contracts.ts";
import { contained, exists, outsideCheckout, readBounded } from "./skills.ts";

/**
 * Advisory runtime hints per role: `<agentDir>/worq/RUNTIMES.md`, one GFM table
 * (`| role | sdk | model | thinking | max-turns | max-minutes |`). Prose, comments and fenced blocks are ignored.
 * Explicit launch fields always win; a hint only fills omitted fields. Re-read when its mtime or size changes.
 */
export interface RuntimeHint { sdk?: string; model?: string; thinking?: string; maxTurns?: number; maxMinutes?: number }
export interface RuntimeHints {
  path: string;
  rows: ReadonlyMap<string, RuntimeHint>;
  /** Malformed rows or cells, skipped; warned once per file version. */
  problems: readonly string[];
  /** `${mtimeMs}:${size}`, absent when the file does not exist. */
  stamp?: string;
}

/** Canonical rank order (matches sdk/pi.ts). Levels outside it only match exactly. */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ROLE = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)$/;
const SDK = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const THINKING = /^(<=)?([a-z][a-z0-9-]*)$/;
const COLUMNS = { role: "role", sdk: "sdk", model: "model", thinking: "thinking", "max-turns": "maxTurns", "max-minutes": "maxMinutes" } as const;
const RANGES = { maxTurns: [1, 400], maxMinutes: [1, 600] } as const;

export const hintsPath = (agentDir: string) => join(agentDir, "worq", "RUNTIMES.md");
const empty = (path: string, problems: string[] = [], stamp?: string): RuntimeHints => ({ path, rows: new Map(), problems, ...(stamp ? { stamp } : {}) });

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim().replace(/^`(.*)`$/, "$1"));

/** Parse the first table whose header has a `role` column. Bad cells skip only themselves; bad roles skip the row. */
export function parseHints(raw: string, path = "RUNTIMES.md"): RuntimeHints {
  const text = raw.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const rows = new Map<string, RuntimeHint>();
  const problems: string[] = [];
  let header: (keyof typeof COLUMNS | undefined)[] | undefined;
  let fenced = false;
  let done = false;
  text.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced || done) return;
    const at = `${path}:${index + 1}`;
    if (!line.trim().startsWith("|")) { if (header) done = true; return; }
    const values = cells(line);
    if (!header) {
      const names = values.map((v) => v.toLowerCase());
      if (names.includes("role")) header = names.map((n) => (n in COLUMNS ? n as keyof typeof COLUMNS : undefined));
      return;
    }
    if (values.every((v) => /^:?-{3,}:?$/.test(v))) return;
    const hint: RuntimeHint = {};
    let role: string | undefined;
    header.forEach((column, i) => {
      const value = values[i]?.trim() ?? "";
      if (!column || value === "" || value === "-") return;
      if (column === "role") { role = value; return; }
      const key = COLUMNS[column];
      if (key === "sdk") { if (SDK.test(value)) hint.sdk = value; else problems.push(`${at}: sdk "${value}" is not an sdk id`); return; }
      if (key === "model") { if (!/\s/.test(value) && value.length <= 200) hint.model = value; else problems.push(`${at}: model "${value}" is not a model ref`); return; }
      if (key === "thinking") { if (THINKING.test(value)) hint.thinking = value; else problems.push(`${at}: thinking "${value}" must be a level or <=level`); return; }
      const [min, max] = RANGES[key];
      const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (Number.isSafeInteger(n) && n >= min && n <= max) hint[key] = n;
      else problems.push(`${at}: ${column} must be an integer ${min}..${max}`);
    });
    if (role === undefined) { problems.push(`${at}: row has no role`); return; }
    if (!ROLE.test(role)) { problems.push(`${at}: role "${role}" must be *, a kind, or dotted kind.child names`); return; }
    if (rows.has(role)) problems.push(`${at}: duplicate role ${role}; the later row wins`);
    rows.set(role, hint);
  });
  return { path, rows, problems };
}

/**
 * Hot-reloading loader. Same containment rules as other operator resources: outside any Git checkout,
 * no symlink escape, bounded size. A missing file means no hints (existing behaviour, unchanged).
 */
export function hintLoader(agentDir: string): () => RuntimeHints {
  const path = hintsPath(agentDir);
  let cached: RuntimeHints = empty(path);
  const load = (): RuntimeHints => {
    if (!exists(path)) return empty(path);
    const stat = lstatSync(path);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cached.stamp === stamp) return cached;
    try {
      const base = realpathSync(dirname(path));
      outsideCheckout(base);
      return { ...parseHints(readBounded(contained(base, path), true), path), stamp };
    } catch (error) {
      return empty(path, [`${path}: ignored (${errorText(error)})`], stamp);
    }
  };
  return () => {
    try { cached = load(); }
    catch (error) { cached = empty(path, [`${path}: ignored (${errorText(error)})`]); }
    return cached;
  };
}

/** Field-level merge from broadest to most specific role. */
export function matchHint(hints: RuntimeHints | undefined, chain: readonly string[]): RuntimeHint | undefined {
  if (!hints?.rows.size) return undefined;
  let merged: RuntimeHint | undefined;
  for (const role of chain) {
    const row = hints.rows.get(role);
    if (row) merged = { ...merged, ...row };
  }
  return merged && Object.keys(merged).length ? merged : undefined;
}

/** Role chains, broad → specific. */
export const chains = {
  agent: (kind: string) => ["*", kind],
  pq: (kind: string, name?: string) => ["*", "pq", `${kind}.pq`, ...(name ? [`${kind}.pq.${name}`] : [])],
  review: (kind: string) => ["*", "review", `${kind}.review`],
  edit: (kind: string, name?: string) => ["*", "edit", `${kind}.edit`, ...(name ? [`${kind}.edit.${name}`] : [])],
};

const rank = (level: string | undefined) => level === undefined ? -1 : (LEVELS as readonly string[]).indexOf(level);
/**
 * `level`: that level, snapped down to the highest supported one. `<=level`: the inherited level capped at `level`
 * (never upgraded), snapped down likewise. No level control (`[]`) drops the hint.
 */
export function hintThinking(hint: string, inherited: string | undefined, supported: readonly string[]): string | undefined {
  if (!supported.length) return undefined;
  const [, cap, level] = THINKING.exec(hint) ?? [];
  if (!level) return supported.includes(inherited ?? "") ? inherited : undefined;
  const target = cap && inherited !== undefined && rank(inherited) >= 0 && rank(inherited) <= rank(level) ? inherited : level;
  if (supported.includes(target)) return target;
  const want = rank(target);
  if (want < 0) return supported.includes(inherited ?? "") ? inherited : undefined;
  return [...supported].filter((l) => rank(l) >= 0 && rank(l) <= want).sort((a, b) => rank(b) - rank(a))[0];
}
