import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Block, distinct, json, parse, ProfileSchema, type Profile } from "./contracts.ts";
import { cleanEnv, git } from "./process.ts";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function digestFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
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
export async function writeScoped(base: string, path: string, content: string) {
  const target = await scoped(base, path, { missing: true });
  await mkdir(dirname(target), { recursive: true });
  // Replace rather than mutate an existing inode (including hardlinks).
  const info = await lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (info && !info.isFile()) throw new Block("path", `Not a regular file: ${path}`);
  const { rename, mkdtemp, rm } = await import("node:fs/promises");
  const tmp = await mkdtemp(join(dirname(target), ".worq-"));
  try {
    await writeFile(join(tmp, "content"), content, { mode: info?.mode ?? 0o644 });
    await rename(join(tmp, "content"), target);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function readSmall(path: string, max: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) throw new Block("file", `Expected regular file of at most ${max} bytes: ${path}`);
  return readFile(path, "utf8");
}
export function statePath() { return resolve(process.env.WORQ_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-worq")); }
export function profilesPath() { return resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-worq", "profiles"); }
/** Explicit path wins; otherwise the single profile in `dir` whose `repository` is this project. */
export async function findProfile(root: string, explicit: string | undefined, dir: string) {
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Block("no-profile", "WORQ_PROFILE must be an absolute path");
    return explicit;
  }
  const names = await readdir(dir).catch(() => [] as string[]);
  const matches: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(dir, name);
    try {
      const { repository } = json(await readSmall(path, 256 * 1024), "Profile") as { repository?: unknown };
      if (typeof repository === "string" && isAbsolute(repository) && await realpath(repository) === root) matches.push(path);
    } catch { /* unrelated or unreadable profile */ }
  }
  if (matches.length > 1) throw new Block("profile-ambiguous", `Several profiles in ${dir} name this project: ${matches.map((m) => m.slice(dir.length + 1)).join(", ")}`);
  if (!matches.length) throw new Block("no-profile", `No profile for ${root}. Copy examples/cli-profile.json to ${dir}/<name>.json and set "repository"`);
  return matches[0];
}
export async function preflight(cwd: string, profilePath: string | undefined, signal: AbortSignal, profilesDir = profilesPath()) {
  if (process.platform !== "linux") throw new Block("platform", "Worq currently requires Linux");
  const root = await realpath(await git(cwd, signal, "rev-parse", "--show-toplevel"));
  const path = await realpath(await findProfile(root, profilePath, profilesDir));
  if (inside(root, path)) throw new Block("profile-location", "The verification profile must be outside the project");
  const info = await stat(path);
  if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Block("profile-owner", "The profile must be owned by you and not group/world writable");
  const raw = await readSmall(path, 256 * 1024);
  const profile = parse(ProfileSchema, json(raw, "Profile"), "Profile");
  if (!isAbsolute(profile.repository) || await realpath(profile.repository) !== root) throw new Block("profile-project", "The profile authorizes a different repository");
  await validateProfile(profile, root);
  const baseline = await git(root, signal, "rev-parse", "--verify", "HEAD^{commit}");
  if (await git(root, signal, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none")) {
    throw new Block("dirty-baseline", "Commit or remove local changes before starting Worq");
  }
  if (await git(root, signal, "ls-files", "--", ".gitmodules")) throw new Block("submodules", "This slice does not stage projects with submodules");
  return { root, profile, profileDigest: digest(raw), baseline };
}
export type Project = Awaited<ReturnType<typeof preflight>>;
async function validateProfile(profile: Profile, root: string) {
  parts(profile.entry);
  const adapter = profile.surface === "tui" ? "/usr/bin/python3" : undefined;
  for (const executable of [adapter, profile.interpreter, profile.build?.executable, ...(profile.devChecks ?? []).map((cmd) => cmd.executable)]) {
    if (executable === undefined) continue;
    try {
      if (!isAbsolute(executable) || inside(root, await realpath(executable)) || !(await stat(executable)).isFile()) throw new Error("not an external executable file");
      await access(executable, constants.X_OK);
    } catch { throw new Block("profile-executable", `Expected an absolute executable host file outside the project: ${executable}`); }
  }
  distinct(profile.checks.map((x) => x.id), "Profile checks");
  distinct((profile.devChecks ?? []).map((x) => x.id), "Development checks");
  for (const check of profile.checks) {
    distinct(check.scenarios.map((s) => s.id), `Scenarios for ${check.id}`);
    for (const scenario of check.scenarios) {
      if (scenario.fixtures) {
        distinct(scenario.fixtures.map((x) => x.path), "Fixture paths");
        for (const fixture of scenario.fixtures) parts(fixture.path);
      }
      if (profile.surface === "tui") {
        if (scenario.stdin !== undefined || !scenario.steps?.some((x) => x.type === "observe")) throw new Block("profile-tui", `${scenario.id} needs an observe step and must not specify stdin`);
      } else if (scenario.steps) throw new Block("profile-cli", `${scenario.id} must not specify PTY steps`);
      for (const e of scenario.expect) {
        if (profile.surface === "tui" ? e.channel !== "screen" : e.channel === "screen") throw new Block("profile-channel", `Invalid ${e.channel} for ${profile.surface}`);
        if (e.channel === "exit" ? typeof e.value !== "number" || e.op !== "equals" : typeof e.value !== "string" || (e.op === "contains" && !e.value)) throw new Block("profile-expectation", `Invalid ${e.channel} predicate`);
      }
      if (!scenario.expect.some((e) => e.channel !== "exit")) throw new Block("profile-expectation", `${scenario.id} needs observable output, not only an exit code`);
    }
  }
}
export async function builder(project: Project, dir: string, branch: string, signal: AbortSignal) {
  const work = join(dir, "work");
  await git(project.root, signal, "worktree", "add", "-b", branch, work, project.baseline);
  return realpath(work);
}
export async function pin(work: string, signal: AbortSignal) {
  await git(work, signal, "add", "-A", "--", ".");
  if (await git(work, signal, "status", "--porcelain=v1")) await git(work, signal, "commit", "-m", "Worq candidate");
  return git(work, signal, "rev-parse", "--verify", "HEAD^{commit}");
}
export async function snapshot(project: Project, parent: string, commit: string, signal: AbortSignal) {
  const stage = join(parent, "product");
  await git(parent, signal, "clone", "--no-local", "--no-checkout", "--", project.root, stage);
  await git(stage, signal, "checkout", "--detach", commit);
  if (await git(stage, signal, "rev-parse", "HEAD") !== commit) throw new Block("candidate-id", "Verification checkout does not match the candidate");
  await git(stage, signal, "remote", "remove", "origin");
  return stage;
}
export async function runtimeEnv(parent: string): Promise<NodeJS.ProcessEnv> {
  const env = { ...cleanEnv, HOME: join(parent, "home"), XDG_CONFIG_HOME: join(parent, "config"), XDG_STATE_HOME: join(parent, "state"), XDG_CACHE_HOME: join(parent, "cache"), XDG_DATA_HOME: join(parent, "data"), TMPDIR: join(parent, "tmp"), TERM: "xterm-256color" };
  await Promise.all([env.HOME, env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.TMPDIR].map(async (dir) => { await mkdir(dir, { recursive: true, mode: 0o700 }); }));
  return env;
}
export async function runDirectory(base: string, id: string) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realpath(base);
  const info = await stat(root);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Block("state-dir", "WORQ_STATE_DIR must be private and owned by you (mode 0700)");
  const dir = join(root, id);
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}
