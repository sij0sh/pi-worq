import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Block } from "./contracts.ts";
import { gitRaw, gitRawLimited } from "./process.ts";

export type ExploreTier = 1 | 2 | 3;
export type FileCategory = "source" | "test" | "docs" | "fixtures";

export interface ExploreLimits {
  perFileBytes: number;
  maxAvgLineLength: number;
  tier1MaxSourceBytes: number;
  tier1MaxSourceFiles: number;
  tier1PayloadBytes: number;
  tier2MaxSourceBytes: number;
  tier2MaxSourceFiles: number;
  tier2PayloadBytes: number;
  tier3PayloadBytes: number;
  tier3MaxDepth: number;
  lsFilesLimitBytes: number;
  tier1WarmupThresholdBytes: number;
  tier1StaggerMs: number;
}

export const EXPLORE_LIMITS: Readonly<ExploreLimits> = {
  perFileBytes: 128 * 1024,
  maxAvgLineLength: 400,
  tier1MaxSourceBytes: 40 * 1024,
  tier1MaxSourceFiles: 40,
  tier1PayloadBytes: 45 * 1024,
  tier2MaxSourceBytes: 1536 * 1024,
  tier2MaxSourceFiles: 600,
  tier2PayloadBytes: 12 * 1024,
  tier3PayloadBytes: 8 * 1024,
  tier3MaxDepth: 3,
  lsFilesLimitBytes: 8 * 1024 * 1024,
  tier1WarmupThresholdBytes: 4 * 1024,
  tier1StaggerMs: 1500,
};

export interface ExploreStats {
  totalFiles: number;
  sourceFiles: number;
  sourceBytes: number;
  sourceLines: number;
  auxFiles: number;
  auxBytes: number;
  skippedNoise: number;
  skippedBinary: number;
  skippedLarge: number;
  skippedMinified: number;
}

export interface ExploreSnapshot {
  tier: ExploreTier;
  mode: "auto" | "map";
  key: string;
  bytes: number;
  text: string;
  stats: ExploreStats;
}

export interface SymbolEntry {
  line: number;
  text: string;
}

interface StatFile {
  path: string;
  size: number;
  category: FileCategory;
}

interface ReadSourceFile extends StatFile {
  bytes: number;
  lines: number;
  content: string;
}

const NOISE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "coverage",
  "vendor", "third_party", ".next", ".nuxt", ".svelte-kit", ".turbo",
  ".cache", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
  ".pytest_cache", ".ruff_cache", ".gradle", ".idea",
]);

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "shrinkwrap.json",
  "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "Cargo.lock", "uv.lock", "poetry.lock", "Pipfile.lock",
  "Gemfile.lock", "composer.lock", "go.sum", "flake.lock",
  "Podfile.lock", "pubspec.lock", "packages.lock.json",
  "paket.lock", "mix.lock", "deps.edn.lock",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".tif", ".psd", ".avif", ".heic",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".webm", ".mov", ".avi", ".mkv", ".m4a",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".wasm",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".pyc", ".pyo", ".class",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".sqlite", ".sqlite3", ".db", ".bin", ".dat", ".parquet", ".arrow", ".feather",
  ".onnx", ".pt", ".pth", ".safetensors",
]);

const FIXTURE_DIRS = new Set([
  "fixtures", "fixture", "__fixtures__", "testdata", "test-data",
  "mocks", "__mocks__", "snapshots", "__snapshots__", "benchmarks", "benches",
]);

const TEST_DIRS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "e2e", "integration-tests", "unit-tests",
]);

const DOC_DIRS = new Set(["docs", "doc", "documentation"]);
const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

const ROOT_MANIFESTS = new Set(["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "tsconfig.json"]);

const TS_JS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const CLASS_METHOD_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "constructor",
  "super", "new", "throw", "await", "typeof", "delete", "else", "do", "try",
]);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isNoisePath(rel: string): boolean {
  const segments = rel.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (NOISE_DIRS.has(segments[i])) return true;
  }
  const base = segments.at(-1) ?? "";
  if (LOCKFILES.has(base)) return true;
  const lower = base.toLowerCase();
  if (lower.endsWith(".map") || lower.endsWith(".snap")) return true;
  if (/\.min\.[^.]+$/.test(lower) || /\.(bundle|chunk)\.(?:[cm]?js|css)$/.test(lower)) return true;
  return false;
}

function isBinaryExt(rel: string): boolean {
  return BINARY_EXTS.has(extname(rel).toLowerCase());
}

export function categorizePath(rel: string): FileCategory {
  const segments = rel.split("/");
  const base = segments.at(-1) ?? "";
  const lowerBase = base.toLowerCase();
  const ext = extname(lowerBase);
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i].toLowerCase();
    if (FIXTURE_DIRS.has(dir)) return "fixtures";
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i].toLowerCase();
    if (TEST_DIRS.has(dir)) return "test";
  }
  if (/\.(test|spec)\.[^.]+$/i.test(base) || /_test\.[^.]+$/i.test(base) || /^test_[^.]+$/i.test(base) || lowerBase === "conftest.py") {
    return "test";
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i].toLowerCase();
    if (DOC_DIRS.has(dir)) return "docs";
  }
  if (DOC_EXTS.has(ext) || /^(?:license|copying|notice|changelog|authors|contributors)(?:\.[^.]+)?$/i.test(base)) {
    return "docs";
  }
  return "source";
}

function countLines(content: string): number {
  if (!content.length) return 0;
  const rows = content.split(/\r?\n/);
  return rows.at(-1) === "" ? rows.length - 1 : rows.length;
}

function isMinified(bytes: number, lines: number, maxAvgLineLength: number): boolean {
  return bytes > maxAvgLineLength && bytes / Math.max(1, lines) > maxAvgLineLength;
}

function formatParams(raw: string | undefined): string {
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact.startsWith("(")) return "";
  if (!compact.endsWith(")")) return "(...)";
  return compact.length <= 36 ? compact : "(...)";
}

function clipSymbol(value: string, max = 72): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function truncateUtf8(value: string, maxBytes: number, suffix = ""): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffixBytes = utf8Bytes(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);
  const buf = Buffer.from(value, "utf8");
  let end = Math.min(buf.length, budget);
  // Step back across UTF-8 continuation bytes (10xxxxxx) so we never split a code point.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  let sliced = buf.subarray(0, end).toString("utf8");
  const lastNewline = sliced.lastIndexOf("\n");
  if (lastNewline > sliced.length * 0.5) sliced = sliced.slice(0, lastNewline);
  return `${sliced}${suffix}`;
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  const count = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}

/** Zero-dependency line-scanning symbol extractor across common language families. */
export function extractSymbols(path: string, content: string, maxSymbols = 48): SymbolEntry[] {
  const ext = extname(path).toLowerCase();
  const rows = content.split(/\r?\n/);
  const out: SymbolEntry[] = [];
  const push = (line: number, text: string) => {
    if (out.length < maxSymbols) out.push({ line, text: clipSymbol(text) });
  };

  if (TS_JS_EXTS.has(ext)) {
    let inExportedClass = false;
    for (let i = 0; i < rows.length && out.length < maxSymbols; i++) {
      const row = rows[i];
      if (inExportedClass && /^\}/.test(row)) { inExportedClass = false; continue; }
      const top = /^export\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(async\s+)?(function\*?|class|interface|type|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)(.*)/.exec(row);
      if (top) {
        const [, def, asyncKw, kind, name, rest] = top;
        if (kind === "class") inExportedClass = !row.includes("}");
        let sig = `${def ? "default " : ""}${asyncKw ?? ""}${kind} ${name}`;
        if (kind.startsWith("function")) {
          const params = /^\s*(?:<[^>]*>)?\s*(\([^)]*\)?)/.exec(rest)?.[1];
          sig += formatParams(params);
        }
        push(i + 1, sig);
        continue;
      }
      if (/^export\s+default\s+(?:async\s+)?(function|class)\b/.test(row)) {
        const kind = /\bclass\b/.test(row) ? "class" : "function";
        if (kind === "class") inExportedClass = !row.includes("}");
        push(i + 1, `default ${kind}`);
        continue;
      }
      if (inExportedClass) {
        if (/^(?: {2}|\t)(?:private|protected|get\s+|set\s+)\b/.test(row)) continue;
        const method = /^(?: {2}|\t)(?:public\s+)?(static\s+)?(async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(\([^)]*\)?)/.exec(row);
        if (method && !CLASS_METHOD_SKIP.has(method[3])) {
          push(i + 1, `${method[1] ?? ""}${method[2] ?? ""}${method[3]}${formatParams(method[4])}`);
        }
      }
    }
    return out;
  }

  if (PY_EXTS.has(ext)) {
    for (let i = 0; i < rows.length && out.length < maxSymbols; i++) {
      const row = rows[i];
      const def = /^(async\s+)?def\s+([A-Za-z_]\w*\s*\([^)]*\)?)/.exec(row);
      if (def) { push(i + 1, `${def[1] ?? ""}def ${def[2]}`); continue; }
      const cls = /^class\s+([A-Za-z_]\w*(?:\([^)]*\))?)/.exec(row);
      if (cls) { push(i + 1, `class ${cls[1]}`); continue; }
      if (/^__all__\s*=/.test(row)) push(i + 1, row.trim());
    }
    return out;
  }

  if (ext === ".rs") {
    for (let i = 0; i < rows.length && out.length < maxSymbols; i++) {
      const row = rows[i];
      const m = /^\s*pub(?:\s*\([^)]*\))?\s+(async\s+)?(?:unsafe\s+)?(?:const\s+)?(fn|struct|enum|trait|type|mod|static)\s+([A-Za-z_]\w*(?:<[^>]*>)?(?:\([^)]*\)?)?)/.exec(row);
      if (m) push(i + 1, `pub ${m[1] ?? ""}${m[2]} ${m[3]}`);
    }
    return out;
  }

  if (ext === ".go") {
    for (let i = 0; i < rows.length && out.length < maxSymbols; i++) {
      const row = rows[i];
      const fn = /^func\s+(\([^)]+\)\s+)?([A-Z]\w*(?:\[[^\]]+\])?\s*\([^)]*\)?)/.exec(row);
      if (fn) { push(i + 1, `func ${fn[1] ?? ""}${fn[2]}`); continue; }
      const ty = /^type\s+([A-Z]\w*)\s+(struct|interface|\S+)/.exec(row);
      if (ty) push(i + 1, `type ${ty[1]} ${ty[2]}`);
    }
    return out;
  }

  if (ext === ".sql") {
    for (let i = 0; i < rows.length && out.length < maxSymbols; i++) {
      const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|INDEX|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(;]+)/i.exec(rows[i]);
      if (m) push(i + 1, `CREATE ${m[1].toUpperCase()} ${m[2]}`);
    }
    return out;
  }

  if (ext === ".md" || ext === ".mdx") {
    let fence: string | undefined;
    for (let i = 0; i < rows.length && out.length < maxSymbols; i++) {
      const row = rows[i];
      const fenceMatch = /^(`{3,}|~{3,})/.exec(row.trimStart());
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1][0];
        else if (fenceMatch[1][0] === fence) fence = undefined;
        continue;
      }
      if (fence) continue;
      const heading = /^(#{1,2})\s+(.+)$/.exec(row);
      if (heading) push(i + 1, `${heading[1]} ${heading[2].trim()}`);
    }
    return out;
  }

  return out;
}

function summarizePackageJson(content: string): string | undefined {
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const parts: string[] = [];
    const name = typeof pkg.name === "string" ? pkg.name : "";
    const version = typeof pkg.version === "string" ? `@${pkg.version}` : "";
    const modType = typeof pkg.type === "string" ? ` (${pkg.type})` : "";
    if (name) parts.push(`${name}${version}${modType}`);
    if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
      const scripts = Object.keys(pkg.scripts).sort(cmp);
      if (scripts.length) parts.push(`scripts: ${scripts.slice(0, 12).join(", ")}${scripts.length > 12 ? ", …" : ""}`);
    }
    if (typeof pkg.bin === "string") parts.push(`bin: ${pkg.bin}`);
    else if (pkg.bin && typeof pkg.bin === "object" && !Array.isArray(pkg.bin)) {
      const bins = Object.keys(pkg.bin).sort(cmp);
      if (bins.length) parts.push(`bin: ${bins.join(", ")}`);
    }
    for (const [label, key] of [["deps", "dependencies"], ["peerDeps", "peerDependencies"], ["devDeps", "devDependencies"]] as const) {
      const rec = pkg[key];
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        const names = Object.keys(rec).sort(cmp);
        if (names.length) parts.push(`${label}: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` (+${names.length - 10})` : ""}`);
      }
    }
    if (Array.isArray(pkg.workspaces)) {
      parts.push(`workspaces: ${pkg.workspaces.map(String).join(", ")}`);
    }
    return parts.length ? `package.json: ${parts.join(" | ")}` : undefined;
  } catch {
    return undefined;
  }
}

function summarizeTomlManifest(name: string, content: string): string | undefined {
  const parts: string[] = [];
  let section = "";
  const deps: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[([^\]]+)\]/.exec(line);
    if (sec) { section = sec[1].trim(); continue; }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, val] = kv;
    if ((section === "package" || section === "project") && (key === "name" || key === "version" || key === "edition" || key === "requires-python")) {
      parts.push(`${key}=${val.replace(/^["']|["']$/g, "")}`);
    } else if (section === "dependencies" || section === "workspace.dependencies") {
      deps.push(key);
    }
  }
  if (deps.length) parts.push(`deps: ${deps.slice(0, 10).join(", ")}${deps.length > 10 ? ` (+${deps.length - 10})` : ""}`);
  return parts.length ? `${name}: ${parts.join(" | ")}` : undefined;
}

function summarizeGoMod(content: string): string | undefined {
  let mod = "";
  let goVer = "";
  let requires = 0;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("module ")) mod = line.slice(7).trim();
    else if (line.startsWith("go ")) goVer = line.slice(3).trim();
    else if (/^[^\s/]+\.[^\s/]+\/\S+\s+v/.test(line) && !line.includes("// indirect")) requires++;
  }
  const parts = [mod && `module ${mod}`, goVer && `go ${goVer}`, requires > 0 && `${requires} direct requires`].filter(Boolean);
  return parts.length ? `go.mod: ${parts.join(" | ")}` : undefined;
}

async function formatRootManifests(root: string, files: readonly StatFile[], readMap: ReadonlyMap<string, ReadSourceFile>): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) {
    if (!ROOT_MANIFESTS.has(file.path)) continue;
    let content = readMap.get(file.path)?.content;
    if (content === undefined) {
      content = await readFile(join(root, file.path), "utf8").catch(() => undefined);
    }
    if (!content || content.includes("\0")) continue;
    let summary: string | undefined;
    if (file.path === "package.json") summary = summarizePackageJson(content);
    else if (file.path === "Cargo.toml" || file.path === "pyproject.toml") summary = summarizeTomlManifest(file.path, content);
    else if (file.path === "go.mod") summary = summarizeGoMod(content);
    if (summary) out.push(summary);
  }
  return out;
}

function formatAuxSummary(aux: readonly StatFile[], maxBytes: number): string {
  if (!aux.length) return "";
  const byCategory = new Map<FileCategory, StatFile[]>();
  for (const file of aux) {
    const list = byCategory.get(file.category) ?? [];
    list.push(file);
    byCategory.set(file.category, list);
  }
  const order: FileCategory[] = ["test", "docs", "fixtures"];
  const detailedLines: string[] = [];
  for (const cat of order) {
    const list = byCategory.get(cat);
    if (!list?.length) continue;
    const total = list.reduce((sum, f) => sum + f.size, 0);
    detailedLines.push(`${cat} (${list.length} files, ${formatSize(total)}): ${list.map((f) => f.path).join(", ")}`);
  }
  const detailed = detailedLines.join("\n");
  if (utf8Bytes(detailed) <= maxBytes) return detailed;

  // Compact by top-level directory per category.
  const compactLines: string[] = [];
  for (const cat of order) {
    const list = byCategory.get(cat);
    if (!list?.length) continue;
    const byDir = new Map<string, { count: number; bytes: number }>();
    for (const f of list) {
      const slash = f.path.indexOf("/");
      const bucket = slash === -1 ? "." : f.path.slice(0, slash);
      const entry = byDir.get(bucket) ?? { count: 0, bytes: 0 };
      entry.count++;
      entry.bytes += f.size;
      byDir.set(bucket, entry);
    }
    const summary = [...byDir.entries()].sort(([a], [b]) => cmp(a, b))
      .map(([dir, v]) => `${dir} (${v.count}, ${formatSize(v.bytes)})`).join(", ");
    compactLines.push(`${cat} (${list.length} files): ${summary}`);
  }
  return truncateUtf8(compactLines.join("\n"), maxBytes, "\n…");
}

function buildTier1(sources: readonly ReadSourceFile[], aux: readonly StatFile[], stats: ExploreStats, maxBytes: number): string | undefined {
  const header = [
    "## Repository Snapshot (Tier 1: Inline Source)",
    `Static snapshot: ${stats.sourceFiles} source file${stats.sourceFiles === 1 ? "" : "s"} (${formatSize(stats.sourceBytes)}, ${stats.sourceLines} LoC)${aux.length ? `; ${aux.length} test/doc/fixture file${aux.length === 1 ? "" : "s"} listed below` : ""}. All source files are inlined with 1-based line numbers—cite path:line directly when answered; call read_file only for non-inlined files.`,
  ].join("\n");

  const sourceManifest = sources.length
    ? `source:\n${sources.map((f) => `  ${f.path} (${f.lines}L, ${formatSize(f.bytes)})`).join("\n")}`
    : "source: (none)";

  const auxFull = aux.length
    ? ["test", "docs", "fixtures"].map((cat) => {
      const list = aux.filter((f) => f.category === cat);
      return list.length ? `${cat}:\n${list.map((f) => `  ${f.path} (${formatSize(f.size)})`).join("\n")}` : "";
    }).filter(Boolean).join("\n")
    : "";

  const inlined = sources.map((f) => {
    const rows = f.content.split(/\r?\n/);
    if (rows.length > 0 && rows.at(-1) === "") rows.pop();
    const numbered = rows.map((line, i) => `${i + 1}: ${line}`).join("\n");
    return `--- ${f.path} ---\n${numbered}`;
  }).join("\n\n");

  const assemble = (auxSection: string) => [
    header,
    "",
    "### Manifest",
    sourceManifest,
    ...(auxSection ? [auxSection] : []),
    ...(inlined ? ["", "### Source Files", inlined] : []),
  ].join("\n");

  const full = assemble(auxFull);
  if (utf8Bytes(full) <= maxBytes) return full;

  // Try compacting auxiliary manifest before downgrading to Tier 2.
  const compacted = assemble(formatAuxSummary(aux, 2048));
  if (utf8Bytes(compacted) <= maxBytes) return compacted;
  return undefined;
}

function buildTier2(
  sources: readonly ReadSourceFile[],
  aux: readonly StatFile[],
  manifests: readonly string[],
  stats: ExploreStats,
  maxBytes: number,
): string {
  const header = [
    "## Repository Snapshot (Tier 2: Symbol Map)",
    `Static snapshot: ${stats.sourceFiles} source file${stats.sourceFiles === 1 ? "" : "s"} (${formatSize(stats.sourceBytes)}, ${stats.sourceLines} LoC)${aux.length ? `; ${aux.length} test/doc/fixture file${aux.length === 1 ? "" : "s"}` : ""}. Jump directly to read_file(path, offset) or targeted search using the line numbers below.`,
  ].join("\n");

  const manifestBlock = manifests.length
    ? `\n\n### Root Manifest\n${truncateUtf8(manifests.join("\n"), 1536, "\n…")}`
    : "";

  const auxText = formatAuxSummary(aux, 1536);
  const auxBlock = auxText ? `\n\n### Other Files\n${auxText}` : "";

  const extracted = sources.map((f) => ({
    file: f,
    symbols: extractSymbols(f.path, f.content),
  }));

  const formatEntries = (maxSymPerFile: number) => extracted.map(({ file, symbols }) => {
    const head = `${file.path} (${file.lines}L, ${formatSize(file.bytes)})`;
    if (maxSymPerFile <= 0 || !symbols.length) return head;
    const shown = symbols.slice(0, maxSymPerFile);
    const tail = symbols.length > shown.length ? ` | +${symbols.length - shown.length} more` : "";
    return `${head}\n  ${shown.map((s) => `:${s.line} ${s.text}`).join(" | ")}${tail}`;
  }).join("\n");

  for (const cap of [24, 12, 6, 3, 1, 0]) {
    const body = sources.length ? `\n\n### Source Files & Symbols\n${formatEntries(cap)}` : "";
    const candidate = `${header}${manifestBlock}${body}${auxBlock}`;
    if (utf8Bytes(candidate) <= maxBytes) return candidate;
  }

  // Even 0-symbol manifest exceeded budget: fit as many source entries as possible.
  const prefix = `${header}${manifestBlock}\n\n### Source Files & Symbols\n`;
  const suffix = `\n… (truncated to ${formatSize(maxBytes)} budget)${auxBlock}`;
  const budget = maxBytes - utf8Bytes(prefix) - utf8Bytes(suffix);
  const lines: string[] = [];
  let used = 0;
  for (const { file } of extracted) {
    const line = `${file.path} (${file.lines}L, ${formatSize(file.bytes)})`;
    const cost = utf8Bytes(line) + (lines.length ? 1 : 0);
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
  }
  const built = `${prefix}${lines.join("\n")}${suffix}`;
  return utf8Bytes(built) <= maxBytes ? built : truncateUtf8(built, maxBytes, "\n…");
}

function isEntrypoint(path: string): boolean {
  const parts = path.split("/");
  if (parts.length > 3) return false;
  const base = parts.at(-1) ?? "";
  if (parts[0] === "bin" || parts[0] === "cmd") return true;
  return /^(?:index|main|app|server|cli|mod|lib|__main__|manage)\.[a-z0-9]+$/i.test(base);
}

function buildTier3(
  sourceCandidates: readonly StatFile[],
  aux: readonly StatFile[],
  manifests: readonly string[],
  stats: ExploreStats,
  limits: ExploreLimits,
): string {
  const maxBytes = limits.tier3PayloadBytes;
  const header = [
    "## Repository Snapshot (Tier 3: Structural Skeleton)",
    `Static snapshot: ${stats.sourceFiles} source file${stats.sourceFiles === 1 ? "" : "s"} (${formatSize(stats.sourceBytes)}${stats.sourceLines ? `, ${stats.sourceLines} LoC` : ""})${aux.length ? `; ${aux.length} test/doc/fixture file${aux.length === 1 ? "" : "s"}` : ""}. Use search and list_files inside the relevant module below.`,
  ].join("\n");

  const manifestBlock = manifests.length
    ? `\n\n### Root Manifest\n${truncateUtf8(manifests.join("\n"), 1280, "\n…")}`
    : "";

  const entrypoints = sourceCandidates.filter((f) => isEntrypoint(f.path)).slice(0, 20);
  const entryBlock = entrypoints.length
    ? `\n\n### Entrypoints\n${entrypoints.map((f) => `${f.path} (${formatSize(f.size)})`).join(", ")}`
    : "";

  interface Bucket {
    dir: string;
    files: number;
    bytes: number;
    exts: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();
  for (const f of sourceCandidates) {
    const parts = f.path.split("/");
    const dir = parts.length === 1 ? "." : parts.slice(0, Math.min(parts.length - 1, limits.tier3MaxDepth)).join("/");
    let bucket = buckets.get(dir);
    if (!bucket) { bucket = { dir, files: 0, bytes: 0, exts: new Map() }; buckets.set(dir, bucket); }
    bucket.files++;
    bucket.bytes += f.size;
    const ext = extname(f.path).toLowerCase() || "(no-ext)";
    bucket.exts.set(ext, (bucket.exts.get(ext) ?? 0) + 1);
  }

  const formatBucket = (b: Bucket) => {
    const topExts = [...b.exts.entries()]
      .sort((a, c) => c[1] - a[1] || cmp(a[0], c[0]))
      .slice(0, 3)
      .map(([ext, n]) => `${ext}:${n}`)
      .join(", ");
    return `${b.dir} (${b.files} file${b.files === 1 ? "" : "s"}, ${formatSize(b.bytes)}; ${topExts})`;
  };

  const auxText = formatAuxSummary(aux, 1024);
  const auxBlock = auxText ? `\n\n### Other Files\n${auxText}` : "";

  const allSorted = [...buckets.values()].sort((a, b) => cmp(a.dir, b.dir));
  const fullRollup = `${header}${manifestBlock}${entryBlock}\n\n### Directory Rollup (depth <= ${limits.tier3MaxDepth})\n${allSorted.map(formatBucket).join("\n")}${auxBlock}`;
  if (utf8Bytes(fullRollup) <= maxBytes) return fullRollup;

  // Keep largest modules within budget, then present them in deterministic path order.
  const byWeight = [...buckets.values()].sort((a, b) => b.bytes - a.bytes || cmp(a.dir, b.dir));
  const prefix = `${header}${manifestBlock}${entryBlock}\n\n### Directory Rollup (depth <= ${limits.tier3MaxDepth})\n`;
  const suffix = `\n… (truncated to ${formatSize(maxBytes)} budget)${auxBlock}`;
  const budget = maxBytes - utf8Bytes(prefix) - utf8Bytes(suffix);

  const chosen: Bucket[] = [];
  let used = 0;
  for (const b of byWeight) {
    const cost = utf8Bytes(formatBucket(b)) + (chosen.length ? 1 : 0);
    if (used + cost > budget) continue;
    chosen.push(b);
    used += cost;
  }
  chosen.sort((a, b) => cmp(a.dir, b.dir));
  const built = `${prefix}${chosen.map(formatBucket).join("\n")}${suffix}`;
  return utf8Bytes(built) <= maxBytes ? built : truncateUtf8(built, maxBytes, "\n…");
}

function parseStatusPaths(porcelainZ: string): string[] {
  const entries = porcelainZ.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path) paths.push(path);
    // Renames and copies emit the original path as the next NUL-delimited field.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return paths;
}

/** Fast, deterministic repo-state key (HEAD + status + dirty file mtimes/sizes). */
export async function repoStateKey(root: string, signal: AbortSignal): Promise<string> {
  const headRes = await gitRaw(root, signal, "rev-parse", "--verify", "HEAD");
  const head = headRes.code === 0 ? headRes.stdout.trim() : "unborn";
  const statusRes = await gitRawLimited(root, signal, 2 * 1024 * 1024, "status", "--porcelain=v1", "--untracked-files=all", "-z");
  if (statusRes.code !== 0) throw new Block("git", `git status: ${statusRes.stderr.trim().slice(0, 400) || `exit ${statusRes.code}`}`);
  if (!statusRes.stdout) return head;

  const hash = createHash("sha256");
  hash.update(head);
  hash.update("\0");
  hash.update(statusRes.stdout);
  const dirtyPaths = [...new Set(parseStatusPaths(statusRes.stdout))].sort(cmp);
  const sample = dirtyPaths.slice(0, 200);
  const stats = await mapBounded(sample, 32, async (rel) => {
    const info = await lstat(join(root, rel)).catch(() => undefined);
    return info ? `${rel}:${info.size}:${Math.trunc(info.mtimeMs)}` : `${rel}:missing`;
  });
  for (const s of stats) { hash.update("\0"); hash.update(s); }
  return `${head.slice(0, 12)}-${hash.digest("hex").slice(0, 16)}`;
}

/** Build a deterministic, byte-budgeted 3-tier exploration snapshot of `root`. */
export async function exploreRepo(
  root: string,
  mode: "auto" | "map",
  signal: AbortSignal,
  options: { key?: string; limits?: Partial<ExploreLimits> } = {},
): Promise<ExploreSnapshot> {
  const limits: ExploreLimits = { ...EXPLORE_LIMITS, ...options.limits };
  const key = options.key ?? await repoStateKey(root, signal);
  const listed = await gitRawLimited(root, signal, limits.lsFilesLimitBytes, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
  if (listed.code !== 0) {
    throw new Block("git", `git ls-files: ${listed.stderr.trim().slice(0, 400) || `exit ${listed.code}`}`);
  }
  const rawPaths = [...new Set(listed.stdout.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")))].sort(cmp);

  const stats: ExploreStats = {
    totalFiles: rawPaths.length,
    sourceFiles: 0,
    sourceBytes: 0,
    sourceLines: 0,
    auxFiles: 0,
    auxBytes: 0,
    skippedNoise: 0,
    skippedBinary: 0,
    skippedLarge: 0,
    skippedMinified: 0,
  };

  const keptPaths: string[] = [];
  for (const rel of rawPaths) {
    if (isNoisePath(rel)) { stats.skippedNoise++; continue; }
    if (isBinaryExt(rel)) { stats.skippedBinary++; continue; }
    keptPaths.push(rel);
  }

  signal.throwIfAborted();
  const statResults = await mapBounded(keptPaths, 32, async (rel): Promise<StatFile | "large" | undefined> => {
    const info = await lstat(join(root, rel)).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isFile()) return undefined;
    if (info.size > limits.perFileBytes) return "large";
    return { path: rel, size: info.size, category: categorizePath(rel) };
  });

  const sourceCandidates: StatFile[] = [];
  const auxFiles: StatFile[] = [];
  let candidateSourceBytes = 0;
  for (const item of statResults) {
    if (item === "large") { stats.skippedLarge++; continue; }
    if (!item) continue;
    if (item.category === "source") {
      sourceCandidates.push(item);
      candidateSourceBytes += item.size;
    } else {
      auxFiles.push(item);
      stats.auxFiles++;
      stats.auxBytes += item.size;
    }
  }

  // Fast path for Tier 3: skip reading thousands of files when clearly above Tier 2 thresholds.
  const clearlyTier3 = sourceCandidates.length > limits.tier2MaxSourceFiles || candidateSourceBytes > limits.tier2MaxSourceBytes * 1.5;
  if (clearlyTier3) {
    stats.sourceFiles = sourceCandidates.length;
    stats.sourceBytes = candidateSourceBytes;
    const manifests = await formatRootManifests(root, sourceCandidates, new Map());
    const text = buildTier3(sourceCandidates, auxFiles, manifests, stats, limits);
    return { tier: 3, mode, key, bytes: utf8Bytes(text), text, stats };
  }

  signal.throwIfAborted();
  const readResults = await mapBounded(sourceCandidates, 32, async (file): Promise<ReadSourceFile | "binary" | "minified" | undefined> => {
    const buf = await readFile(join(root, file.path)).catch(() => undefined);
    if (!buf) return undefined;
    if (buf.includes(0)) return "binary";
    const content = buf.toString("utf8");
    const bytes = buf.length;
    const lines = countLines(content);
    if (isMinified(bytes, lines, limits.maxAvgLineLength)) return "minified";
    return { ...file, bytes, lines, content };
  });

  const sources: ReadSourceFile[] = [];
  const readMap = new Map<string, ReadSourceFile>();
  for (const item of readResults) {
    if (item === "binary") { stats.skippedBinary++; continue; }
    if (item === "minified") { stats.skippedMinified++; continue; }
    if (!item) continue;
    sources.push(item);
    readMap.set(item.path, item);
    stats.sourceFiles++;
    stats.sourceBytes += item.bytes;
    stats.sourceLines += item.lines;
  }

  // Tier 1: Inline Source (only in "auto" mode and within both byte and file caps).
  if (mode === "auto" && stats.sourceFiles <= limits.tier1MaxSourceFiles && stats.sourceBytes <= limits.tier1MaxSourceBytes) {
    const tier1 = buildTier1(sources, auxFiles, stats, limits.tier1PayloadBytes);
    if (tier1 !== undefined) {
      return { tier: 1, mode, key, bytes: utf8Bytes(tier1), text: tier1, stats };
    }
  }

  const manifests = await formatRootManifests(root, sources, readMap);

  // Tier 2: Symbol Map.
  if (stats.sourceFiles <= limits.tier2MaxSourceFiles && stats.sourceBytes <= limits.tier2MaxSourceBytes) {
    const text = buildTier2(sources, auxFiles, manifests, stats, limits.tier2PayloadBytes);
    return { tier: 2, mode, key, bytes: utf8Bytes(text), text, stats };
  }

  // Tier 3: Structural Skeleton.
  const text = buildTier3(sources, auxFiles, manifests, stats, limits);
  return { tier: 3, mode, key, bytes: utf8Bytes(text), text, stats };
}
