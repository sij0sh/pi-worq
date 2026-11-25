import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { Semaphore } from "../src/subagent.ts";
import { DEFAULT_LIMITS } from "../src/runtime/config.ts";
import { readTools } from "../src/tools.ts";
import { scoped, worktree } from "../src/workspace.ts";
import { fakeDriver, KINDS } from "./fake.ts";

test("log: a long run keeps its opening lines as well as its tail", () => {
  const agent = new Agent({
    driver: fakeDriver({}), limits: DEFAULT_LIMITS, state: "/tmp", root: "/tmp", semaphore: new Semaphore(1),
    notify() {},
  }, { ref: "aaaa", kind: KINDS.get("plan")!, task: "task", attachments: [] });
  for (let i = 0; i < 300; i++) agent.log(`line ${i}`);
  const kept = agent.tail(1000).map((entry) => entry.line);
  assert.equal(kept.length, 200);
  assert.equal(kept[0], "line 0");
  assert.equal(kept[39], "line 39");
  assert.equal(kept.at(-1), "line 299");
});

test("dependencies: a checkout sees the repo's node_modules and stays clean under a directory-only ignore rule", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-deps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await writeFile(join(root, ".gitignore"), ".agents/\nnode_modules/\n");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "export const needle = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const project = { root, baseline: git("rev-parse", "HEAD").toString().trim() };
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const checkout = await worktree(project, agentDir, "worq/test", AbortSignal.timeout(30_000));
  assert.ok((await lstat(join(checkout, "node_modules"))).isDirectory(), "a real directory, so `node_modules/` matches");
  assert.ok((await lstat(join(checkout, "node_modules", "pkg"))).isSymbolicLink());
  assert.equal(execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: checkout }).toString(), "");
  // The link is not a way around the read-path guard: it resolves through the known dependency entry only.
  const out = await readTools(checkout).find((tool) => tool.name === "search")!.run({ pattern: "needle" } as never, AbortSignal.timeout(30_000));
  assert.match(out as string, /node_modules\/pkg\/index\.js:1:export const needle = 1;/);
  await assert.rejects(scoped(checkout, "node_modules/pkg/index.js"), /Symbolic link/);
});
