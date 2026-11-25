import { Block } from "./contracts.ts";
import { gitRaw } from "./process.ts";

const MAX_PATTERNS = 32;
const MAX_PATTERN_LEN = 256;

export interface WriteScope {
  readonly patterns: readonly string[];
  readonly parsed: readonly (readonly string[])[];
  allows(relPath: string): boolean;
  assertAllowed(relPath: string): void;
}

/** Normalize one repo-relative glob pattern (`src/sdk/**`, `src/*.ts`, `docs/`). */
export function normalizePattern(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PATTERN_LEN) {
    throw new Block("invalid-payload", `Invalid writePaths pattern: ${JSON.stringify(raw)}`);
  }
  const expanded = trimmed.endsWith("/") ? `${trimmed}**` : trimmed;
  if (expanded.startsWith("/") || expanded.includes("\\") || expanded.includes("\0")) {
    throw new Block("invalid-payload", `writePaths must use repo-relative / paths: ${raw}`);
  }
  const rawParts = expanded.split("/");
  const parts: string[] = [];
  for (const part of rawParts) {
    if (!part || part === "." || part === ".." || part.toLowerCase() === ".git") {
      throw new Block("invalid-payload", `Invalid writePaths segment in: ${raw}`);
    }
    // Collapse redundant adjacent ** segments.
    if (part === "**" && parts.at(-1) === "**") continue;
    parts.push(part);
  }
  return parts.join("/");
}

/** Match one filename segment against a single-segment glob (* and ?). */
function matchSegment(pattern: string, segment: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < segment.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === segment[si])) {
      pi++;
      si++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

/** Match normalized path segments against a parsed glob (supporting **). */
function matchPath(pat: readonly string[], segs: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const stride = segs.length + 1;
  const go = (pi: number, si: number): boolean => {
    if (pi === pat.length) return si === segs.length;
    const key = pi * stride + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    if (pat[pi] === "**") {
      ok = go(pi + 1, si) || (si < segs.length && go(pi, si + 1));
    } else if (si < segs.length && matchSegment(pat[pi], segs[si])) {
      ok = go(pi + 1, si + 1);
    }
    memo.set(key, ok);
    return ok;
  };
  return go(0, 0);
}

/** Exact non-empty intersection check for two single-segment globs (* and ?). */
function segmentOverlaps(a: string, b: string): boolean {
  const visited = new Set<number>();
  const q: [number, number, number][] = [];
  const strideB = b.length + 1;
  const push = (i: number, j: number, h: number) => {
    const key = (i * strideB + j) * 2 + h;
    if (!visited.has(key)) { visited.add(key); q.push([i, j, h]); }
  };
  push(0, 0, 0);
  while (q.length) {
    const [i, j, h] = q.pop()!;
    if (i === a.length && j === b.length && h === 1) return true;
    if (i < a.length && a[i] === "*") push(i + 1, j, h);
    if (j < b.length && b[j] === "*") push(i, j + 1, h);
    if (i < a.length && j < b.length) {
      const ca = a[i];
      const cb = b[j];
      const compatible = ca === "*" || cb === "*" || ca === "?" || cb === "?" || ca === cb;
      if (compatible) push(ca === "*" ? i : i + 1, cb === "*" ? j : j + 1, 1);
    }
  }
  return false;
}

/** Exact non-empty intersection check for two parsed path globs. */
function globOverlaps(a: readonly string[], b: readonly string[]): boolean {
  const visited = new Set<number>();
  const q: [number, number, number][] = [];
  const strideB = b.length + 1;
  const push = (i: number, j: number, h: number) => {
    const key = (i * strideB + j) * 2 + h;
    if (!visited.has(key)) { visited.add(key); q.push([i, j, h]); }
  };
  push(0, 0, 0);
  while (q.length) {
    const [i, j, h] = q.pop()!;
    if (i === a.length && j === b.length && h === 1) return true;
    if (i < a.length && a[i] === "**") push(i + 1, j, h);
    if (j < b.length && b[j] === "**") push(i, j + 1, h);
    if (i < a.length && j < b.length) {
      const sa = a[i];
      const sb = b[j];
      if (sa === "**" || sb === "**" || segmentOverlaps(sa, sb)) {
        push(sa === "**" ? i : i + 1, sb === "**" ? j : j + 1, 1);
      }
    }
  }
  return false;
}

export function createWriteScope(rawPatterns: readonly string[]): WriteScope {
  if (!rawPatterns.length || rawPatterns.length > MAX_PATTERNS) {
    throw new Block("invalid-payload", `writePaths must contain 1–${MAX_PATTERNS} patterns`);
  }
  const patterns = [...new Set(rawPatterns.map(normalizePattern))];
  const parsed = patterns.map((p) => p.split("/"));
  const allows = (relPath: string) => {
    const segs = relPath.replace(/^\.\//, "").split("/").filter(Boolean);
    return segs.length > 0 && parsed.some((p) => matchPath(p, segs));
  };
  return {
    patterns,
    parsed,
    allows,
    assertAllowed(relPath: string) {
      if (!allows(relPath)) {
        throw new Block("scope", `Path "${relPath}" is outside assigned writePaths (${patterns.join(", ")})`);
      }
    },
  };
}

export const UNRESTRICTED_SCOPE = createWriteScope(["**"]);

/** Returns the first pair of overlapping patterns, or undefined if completely disjoint. */
export function findScopeOverlap(a: WriteScope, b: WriteScope): [string, string] | undefined {
  for (let i = 0; i < a.parsed.length; i++) {
    for (let j = 0; j < b.parsed.length; j++) {
      if (globOverlaps(a.parsed[i], b.parsed[j])) return [a.patterns[i], b.patterns[j]];
    }
  }
  return undefined;
}

/** Parse `git status --porcelain=v1 -z --untracked-files=all`, including both ends of renames. */
function parsePorcelainZ(raw: string): string[] {
  const out: string[] = [];
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) out.push(path);
    // Porcelain v1 -z emits "XY NEW\0OLD\0" for renames and copies.
    if ((xy.includes("R") || xy.includes("C")) && entries[i + 1]) {
      out.push(entries[++i]);
    }
  }
  return out;
}

/** Collect every tracked, committed, or untracked path touched relative to baseline, and reject violations. */
export async function auditWriteScope(work: string, baseline: string, scope: WriteScope, signal: AbortSignal): Promise<string[]> {
  const [diff, status] = await Promise.all([
    gitRaw(work, signal, "diff", "--no-renames", "--name-only", "-z", baseline),
    gitRaw(work, signal, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
  ]);
  if (diff.code !== 0) throw new Block("git", `Scope audit git diff failed: ${diff.stderr.trim()}`);
  if (status.code !== 0) throw new Block("git", `Scope audit git status failed: ${status.stderr.trim()}`);

  const touched = new Set<string>([
    ...diff.stdout.split("\0").filter(Boolean),
    ...parsePorcelainZ(status.stdout),
  ]);
  const violations = [...touched].filter((file) => !scope.allows(file)).sort();
  if (violations.length) {
    const shown = violations.slice(0, 8).join(", ");
    const more = violations.length > 8 ? ` (+${violations.length - 8} more)` : "";
    throw new Block(
      "scope-violation",
      `Modified files outside writePaths (${scope.patterns.join(", ")}): ${shown}${more}. Revert or remove out-of-scope files before calling submit.`,
    );
  }
  return [...touched].sort();
}
