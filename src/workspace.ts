import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Block } from "./contracts.ts";
import { cleanEnv, git } from "./process.ts";

export function inside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function parts(path: string, allowRoot = false): string[] {
  if (allowRoot && path === ".") return [];
  const names = path.split("/");
  if (isAbsolute(path) || names.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes("\0"))) {
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
export async function writeScoped(base: string, path: string, content: string | Buffer) {
  const target = await scoped(base, path, { missing: true });
  await mkdir(dirname(target), { recursive: true });
  const info = await lstat(target).catch((error) => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (info && !info.isFile()) throw new Block("path", `Not a regular file: ${path}`);
  // Replace rather than mutate an existing inode (including hardlinks).
  const tmp = await mkdtemp(join(dirname(target), ".worq-"));
  try {
    await writeFile(join(tmp, "content"), content, { mode: info?.mode ?? 0o644 });
    await rename(join(tmp, "content"), target);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function readSmall(path: string, max: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) throw new Block("file", `Expected a regular file of at most ${max} bytes: ${path}`);
  return readFile(path, "utf8");
}
export function statePath() {
  return resolve(process.env.WORQ_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-worq"));
}
export async function repository(cwd: string, signal: AbortSignal) {
  if (process.platform !== "linux") throw new Block("platform", "Worq requires Linux");
  return realpath(await git(cwd, signal, "rev-parse", "--show-toplevel"));
}
/** Private agent directory under the state dir (0700, owned by you). */
export async function agentDirectory(base: string, id: string) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realpath(base);
  const info = await stat(root);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Block("state-dir", `${root} must be private and owned by you (mode 0700)`);
  const dir = join(root, id);
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

export interface Project { root: string; baseline: string }
/** Execute agents start from a clean, committed baseline. */
export async function baselineProject(root: string, signal: AbortSignal): Promise<Project> {
  const dirty = await git(root, signal, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none");
  // Plans written by read agents live in .agents/plans and do not block execution.
  if (dirty.split("\n").some((line) => line && !/^\?\? \.agents\/plans\//.test(line))) {
    throw new Block("dirty-baseline", "Commit or stash local changes before spawning an execute agent");
  }
  if (await git(root, signal, "ls-files", "--", ".gitmodules")) throw new Block("submodules", "Worq does not stage projects with submodules");
  return { root, baseline: await git(root, signal, "rev-parse", "--verify", "HEAD^{commit}") };
}
export async function branchExists(root: string, branch: string, signal: AbortSignal) {
  return git(root, signal, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false);
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
    for (const entry of await readdir(source)) await symlink(join(source, entry), join(target, entry)).catch(() => {});
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
export interface Runtime { env: NodeJS.ProcessEnv; tmp: string }
/**
 * Environment for agent commands. TMPDIR is a short 0700 directory under the system temporary
 * directory, because unix socket paths are limited to ~108 bytes, so it is not covered by the
 * state directory's privacy guarantee. The caller removes `tmp` when the box closes.
 */
export async function runtimeEnv(parent: string): Promise<Runtime> {
  const tmp = await mkdtemp(join(tmpdir(), "worq-"));
  await chmod(tmp, 0o700);
  const env = { ...cleanEnv, HOME: join(parent, "home"), XDG_CONFIG_HOME: join(parent, "config"), XDG_STATE_HOME: join(parent, "state"),
    XDG_CACHE_HOME: join(parent, "cache"), XDG_DATA_HOME: join(parent, "data"), TMPDIR: tmp, TERM: "xterm-256color" };
  await Promise.all([env.HOME, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]
    .map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })));
  return { env, tmp };
}
