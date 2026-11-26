import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Block } from "./contracts.ts";
import { cleanEnv, git } from "./process.ts";
import { windows } from "./platform.mjs";
export { statePath } from "./platform.mjs";

let tempSequence = 0;
/** Exclusive, short scratch paths without random tokens in exposed names. */
export async function temporaryDirectory(parent: string, prefix: string) {
  for (let attempt = 0; attempt < 256; attempt++) {
    const path = join(parent, `${prefix}${process.pid.toString(36)}-${(++tempSequence >>> 0).toString(36)}`);
    try { await mkdir(path, { mode: 0o700 }); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new Block("temp-dir", "Could not allocate a private scratch directory");
}

export function inside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function parts(path: string, allowRoot = false): string[] {
  if (allowRoot && path === ".") return [];
  const names = path.split("/");
  const invalidWindowsName = (part: string) => windows && (
    /[\\<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])(?: |\.|$)/i.test(part) || /^git~[0-9]+$/i.test(part)
  );
  if (isAbsolute(path) || names.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes("\0") || invalidWindowsName(part))) {
    throw new Block("path", `Invalid relative path: ${path}`);
  }
  return names;
}
/** Resolve a relative path under base, refusing traversal, .git and symlinks. */
export async function scoped(base: string, path: string, options: { missing?: boolean; root?: boolean } = {}) {
  let cursor = base;
  for (const part of parts(path, options.root)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Block("path", `Symbolic link is not allowed: ${path}`);
    } catch (error) {
      if (!options.missing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return cursor;
}
export async function writeScoped(base: string, path: string, content: string | Buffer, options: { create?: boolean } = {}) {
  const target = await scoped(base, path, { missing: true });
  await mkdir(dirname(target), { recursive: true });
  const info = await lstat(target).catch((error) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (info && !info.isFile()) throw new Block("path", `Not a regular file: ${path}`);
  // Replace rather than mutate an existing inode (including hardlinks).
  const tmp = await temporaryDirectory(dirname(target), ".worq-");
  try {
    await writeFile(join(tmp, "content"), content, { mode: info?.mode ?? 0o644 });
    if (options.create) await link(join(tmp, "content"), target);
    else await rename(join(tmp, "content"), target);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function readSmall(path: string, max: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) throw new Block("file", `Expected a regular file of at most ${max} bytes: ${path}`);
  return readFile(path, "utf8");
}
export async function repository(cwd: string, signal: AbortSignal) {
  if (!windows && process.platform !== "linux") throw new Block("platform", "Worq requires Linux or Windows");
  return realpath(await git(cwd, signal, "rev-parse", "--show-toplevel"));
}
/** Private agent directory. Windows inherits ACLs from the user state directory. */
async function privateState(base: string) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realpath(base);
  const info = await stat(root);
  if (!windows && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new Block("state-dir", `${root} must be private and owned by you (mode 0700)`);
  return root;
}
export async function agentDirectory(base: string, name: string) {
  const dir = join(await privateState(base), name);
  await mkdir(dir, { mode: 0o700 });
  if (!windows) await chmod(dir, 0o700);
  return dir;
}

/** Permanent ledger shared by controllers and linked worktrees. */
export async function reserveName(root: string, state: string, base: string) {
  const signal = AbortSignal.timeout(10_000);
  const common = resolve(root, await git(root, signal, "rev-parse", "--git-common-dir"));
  const stateRoot = await privateState(state);
  const ledger = join(common, "worq-names");
  await mkdir(ledger, { recursive: true, mode: 0o700 });
  const branches = (await git(root, signal, "for-each-ref", "--format=%(refname)", "refs/heads/worq")).toLowerCase().split("\n");
  for (let suffix = 1; ; suffix++) {
    const ref = suffix === 1 ? base : `${base}-${suffix}`;
    const branch = `refs/heads/worq/${ref}`;
    if (branches.some((b) => b === branch || b.startsWith(`${branch}/`) || b === "refs/heads/worq")) {
      if (branches.includes("refs/heads/worq")) throw new Block("branch", "Branch worq blocks the worq/ namespace");
      continue;
    }
    const path = await scoped(root, `.agents/plans/plan-${ref}.md`, { missing: true });
    const existing = await lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (existing) continue;
    const briefDir = await scoped(root, `.agents/briefs/${ref}`, { missing: true });
    const existingBrief = await lstat(briefDir).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (existingBrief) continue;
    const claim = join(ledger, ref);
    try { await mkdir(claim, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    const dir = join(stateRoot, ref);
    try { await mkdir(dir, { mode: 0o700 }); return { ref, dir }; }
    catch (error) {
      // Existing state or a failed allocation of uncertain outcome must not be reused.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code && ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EROFS", "ENOSPC", "EDQUOT"].includes(code)) await rmdir(claim);
      throw error;
    }
  }
}

export async function readPlan(root: string, path: string) {
  if (!/^\.agents\/plans\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(path)) throw new Block("plan", "Expected a repo-relative .agents/plans/*.md path");
  try {
    const target = await scoped(root, path);
    // Open without following a swapped leaf; verify what was opened against a
    // fresh scoped lookup before reading, also catching a swapped parent.
    const file = await open(target, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const info = await file.stat();
      const current = await lstat(await scoped(root, path));
      const resolved = await realpath(target);
      if (!inside(root, resolved) || info.dev !== current.dev || info.ino !== current.ino || !info.isFile() || info.size > 1024 * 1024) {
        throw new Block("plan", `Expected a regular local plan of at most 1 MiB: ${path}`);
      }
      return await file.readFile("utf8");
    } finally { await file.close(); }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Block("plan", `No plan at ${path}`);
    throw error;
  }
}

export const MAX_BUNDLE_FILES = 16;
export const MAX_BUNDLE_FILE_CHARS = 60_000;
export const MAX_BUNDLE_BYTES = 256 * 1024;
const BUNDLE_MAX_DEPTH = 3;
const BUNDLE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BRIEF_REF = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])(?: |\.|$)|^git~[0-9]+$/i;

/** Validate a bundle-relative file path (under `.agents/briefs/<ref>/`). */
export function validateBundlePath(relPath: string): string {
  if (!relPath || relPath.length > 128 || isAbsolute(relPath) || relPath.includes("\\") || relPath.includes("\0")) {
    throw new Block("bundle-path", `Invalid bundle file path: ${relPath}`);
  }
  const segments = relPath.split("/");
  if (segments.length > BUNDLE_MAX_DEPTH) {
    throw new Block("bundle-path", `Bundle file path exceeds max depth (${BUNDLE_MAX_DEPTH}): ${relPath}`);
  }
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith(".") || seg.endsWith(".") || !BUNDLE_SEGMENT.test(seg) || WINDOWS_RESERVED.test(seg)) {
      throw new Block("bundle-path", `Invalid bundle file path: ${relPath}`);
    }
  }
  return relPath;
}

/** Validate `files` for an `output: bundle` submission before writing to disk. */
export function validateBundleFiles(files: readonly { path: string; content: string }[] | undefined): readonly { path: string; content: string }[] {
  if (!files || !files.length) throw new Block("bundle", "Bundle submission requires at least one file in files");
  if (files.length > MAX_BUNDLE_FILES) throw new Block("bundle", `Bundle submission exceeds ${MAX_BUNDLE_FILES} files`);
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    validateBundlePath(file.path);
    if (file.content.length > MAX_BUNDLE_FILE_CHARS) {
      throw new Block("bundle", `Bundle file ${file.path} exceeds ${MAX_BUNDLE_FILE_CHARS} characters`);
    }
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Block("bundle", `Duplicate bundle file path: ${file.path}`);
    seen.add(key);
    totalBytes += Buffer.byteLength(file.content, "utf8");
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw new Block("bundle", `Bundle files exceed ${MAX_BUNDLE_BYTES} bytes total`);
    }
  }
  return files;
}

export async function readBriefFile(root: string, path: string) {
  const prefix = ".agents/briefs/";
  if (!path.startsWith(prefix)) throw new Block("brief", "Expected a repo-relative .agents/briefs/<ref>/<file> path");
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  const ref = slash > 0 ? rest.slice(0, slash) : "";
  const relPath = slash > 0 ? rest.slice(slash + 1) : "";
  if (!BRIEF_REF.test(ref)) throw new Block("brief", "Expected a repo-relative .agents/briefs/<ref>/<file> path");
  validateBundlePath(relPath);
  try {
    const target = await scoped(root, path);
    const file = await open(target, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const info = await file.stat();
      const current = await lstat(await scoped(root, path));
      const resolved = await realpath(target);
      if (!inside(root, resolved) || info.dev !== current.dev || info.ino !== current.ino || !info.isFile() || info.size > MAX_BUNDLE_BYTES) {
        throw new Block("brief", `Expected a regular local brief file of at most ${MAX_BUNDLE_BYTES} bytes: ${path}`);
      }
      return await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Block("brief", `No brief file at ${path}`);
    throw error;
  }
}

/** Enumerate regular, non-dotfile, non-symlink files up to depth 3 under `.agents/briefs/<ref>/`. */
export async function listBriefFiles(root: string, ref: string): Promise<string[]> {
  if (!BRIEF_REF.test(ref)) return [];
  const baseRel = `.agents/briefs/${ref}`;
  let baseDir: string;
  try {
    baseDir = await scoped(root, baseRel);
    const info = await lstat(baseDir);
    if (!info.isDirectory()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  const walk = async (relPrefix: string, depth: number) => {
    const dir = relPrefix ? await scoped(root, `${baseRel}/${relPrefix}`) : baseDir;
    const entries = (await readdir(dir)).sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      const full = join(dir, entry);
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (depth < BUNDLE_MAX_DEPTH) await walk(rel, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      try {
        validateBundlePath(rel);
        out.push(rel);
      } catch { /* skip non-conforming files */ }
    }
  };
  await walk("", 1);
  return out.sort();
}

export interface Project { root: string; baseline: string }
/** Execute agents start from a clean, committed baseline. */
export async function baselineProject(root: string, signal: AbortSignal): Promise<Project> {
  const dirty = await git(root, signal, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none");
  // Plans and briefs written by read agents live in .agents/plans and .agents/briefs and do not block execution.
  if (dirty.split("\n").some((line) => line && !/^\?\? \.agents\/(?:plans|briefs)\//.test(line))) {
    throw new Block("dirty-baseline", "Commit or stash local changes before spawning an execute agent");
  }
  if (await git(root, signal, "ls-files", "--", ".gitmodules")) throw new Block("submodules", "Worq does not stage projects with submodules");
  return { root, baseline: await git(root, signal, "rev-parse", "--verify", "HEAD^{commit}") };
}
export async function worktree(project: Project, dir: string, branch: string, signal: AbortSignal) {
  const work = join(dir, "work");
  await git(project.root, signal, "worktree", "add", "-b", branch, work, project.baseline);
  const checkout = await realpath(work);
  await linkDependencies(project.root, checkout, signal);
  return checkout;
}
/**
 * Make the repository's dependencies visible in a checkout without staging them. A single
 * `node_modules` symlink is invisible to a directory-only ignore rule (`node_modules/`); a real
 * directory of per-entry links is not, so every git command stays blind to it. Fails closed.
 */
export async function linkDependencies(root: string, checkout: string, signal: AbortSignal): Promise<boolean> {
  const source = join(root, "node_modules");
  if (!(await lstat(source).catch(() => undefined))?.isDirectory()) return false;
  const target = join(checkout, "node_modules");
  if (await lstat(target).catch(() => undefined)) return false;
  const unlink = () => rm(target, { recursive: true, force: true }).catch(() => {});
  try {
    await mkdir(target);
    for (const entry of await readdir(source)) {
      const from = join(source, entry), to = join(target, entry);
      const directory = windows && (await stat(from).catch(() => undefined))?.isDirectory();
      await symlink(from, to, directory ? "junction" : undefined).catch(() => {});
    }
    if (await git(checkout, signal, "status", "--porcelain=v1", "--untracked-files=all")) {
      await unlink();
      return false;
    }
    return true;
  } catch {
    await unlink();
    return false;
  }
}
/** Detached checkout of `commit` (no branch), with the repository's dependencies linked. */
export async function detachedWorktree(root: string, dir: string, commit: string, signal: AbortSignal) {
  const work = join(dir, "work");
  await git(root, signal, "worktree", "add", "--detach", work, commit);
  const checkout = await realpath(work);
  await linkDependencies(root, checkout, signal);
  return checkout;
}
/** Commit `tree` on top of `base` and fast-forward the clean checkout `work` (at `base`) to it. */
export async function integrateTree(work: string, base: string, tree: string, message: string, signal: AbortSignal) {
  if (await git(work, signal, "rev-parse", "--verify", "HEAD^{commit}") !== base) throw new Block("integrate", "Worktree moved off the wave base");
  if (await git(work, signal, "status", "--porcelain=v1", "--untracked-files=all")) throw new Block("integrate", "Worktree has uncommitted changes");
  const commit = await git(work, signal, "commit-tree", tree, "-p", base, "-m", message);
  await git(work, signal, "merge", "--ff-only", "--quiet", commit);
  return commit;
}
export async function removeWorktree(root: string, work: string) {
  await git(root, AbortSignal.timeout(30_000), "worktree", "remove", "--force", work);
}
/** Commit everything in the worktree and return the pinned commit. */
export async function pin(work: string, signal: AbortSignal, message: string) {
  await git(work, signal, "add", "-A", "--", ".");
  if (await git(work, signal, "status", "--porcelain=v1")) await git(work, signal, "commit", "-m", message);
  return git(work, signal, "rev-parse", "--verify", "HEAD^{commit}");
}
/** Fresh, detached clone of one commit for a reviewer. */
export async function snapshot(root: string, parent: string, commit: string, signal: AbortSignal) {
  const stage = join(parent, "product");
  await git(parent, signal, "clone", "--no-local", "--no-checkout", "--", root, stage);
  await git(stage, signal, "checkout", "--detach", commit);
  if (await git(stage, signal, "rev-parse", "HEAD") !== commit) throw new Block("candidate-id", "Review checkout does not match the candidate");
  await git(stage, signal, "remote", "remove", "origin");
  await linkDependencies(root, stage, signal);
  return stage;
}
/** True when the checkout still holds exactly `commit` with no tracked changes. */
export async function intact(stage: string, commit: string, signal: AbortSignal) {
  return await git(stage, signal, "rev-parse", "HEAD") === commit && !await git(stage, signal, "status", "--porcelain=v1", "--untracked-files=no");
}
async function toolPath(checkouts: readonly string[]) {
  const canonical = (path: string) => realpath(path).catch(() => resolve(path));
  const roots = await Promise.all(checkouts.map(canonical));
  const key = (path: string) => windows ? path.toLowerCase() : path;
  const trusted = (cleanEnv.PATH ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(await Promise.all(trusted.map(async (entry) => key(await canonical(entry)))));
  const paths = [...new Map(trusted.map((entry) => [key(entry), entry])).values()];
  for (const raw of (process.env.PATH ?? "").split(delimiter)) {
    const entry = windows ? raw.replace(/^"|"$/g, "") : raw;
    if (!isAbsolute(entry)) continue;
    const actual = await realpath(entry).catch(() => undefined);
    if (!actual || seen.has(key(actual)) || !(await stat(actual).catch(() => undefined))?.isDirectory()) continue;
    if ([resolve(entry), actual].some((path) => path.split(sep).some((part) => part.toLowerCase() === ".git") || roots.some((root) => inside(root, path)))) continue;
    seen.add(key(actual));
    paths.push(actual);
  }
  return paths.join(delimiter);
}
export interface Runtime { env: NodeJS.ProcessEnv; tmp: string }
/**
 * Environment for agent commands. TMPDIR is a short 0700 directory under the system temporary
 * directory, because unix socket paths are limited to ~108 bytes, so it is not covered by the
 * state directory's privacy guarantee. The caller removes `tmp` when the box closes.
 */
export async function runtimeEnv(parent: string, checkouts: readonly string[]): Promise<Runtime> {
  const tmp = await temporaryDirectory(tmpdir(), "worq-");
  if (!windows) await chmod(tmp, 0o700);
  const env = { ...cleanEnv, PATH: await toolPath(checkouts), ...(process.env.VIRTUAL_ENV ? { VIRTUAL_ENV: process.env.VIRTUAL_ENV } : {}), HOME: join(parent, "home"), XDG_CONFIG_HOME: join(parent, "config"), XDG_STATE_HOME: join(parent, "state"),
    XDG_CACHE_HOME: join(parent, "cache"), XDG_DATA_HOME: join(parent, "data"), TMPDIR: tmp, TERM: "xterm-256color",
    ...(windows ? { USERPROFILE: join(parent, "home"), APPDATA: join(parent, "config"), LOCALAPPDATA: join(parent, "data"), TEMP: tmp, TMP: tmp } : {}) };
  await Promise.all([env.HOME, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]
    .map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
  return { env, tmp };
}
