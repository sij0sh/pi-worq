import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EXPLORE_LIMITS, exploreRepo, extractSymbols, repoStateKey } from "../src/explore.ts";
import { loadWorkflows } from "../src/runtime/workflows.ts";
import { Worq } from "../src/worq.ts";
import { config, fakeDriver, KINDS, pass, planSubmission, repo, setup } from "./fake.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function initRepo(t: { after(fn: () => unknown): void }, files: Record<string, string | Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), "worq-explore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  git("config", "core.autocrlf", "false");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, root, state: join(dir, "state"), git };
}

test("extractSymbols: covers TS/JS, Python, Rust, Go, SQL and Markdown with exact line numbers", () => {
  const ts = extractSymbols("src/worq.ts", [
    "import { x } from './x.ts';",
    "export interface WorqDeps { cwd: string }",
    "export type Mode = 'auto' | 'map';",
    "export const MAX = 10;",
    "export class Worq {",
    "  private hidden() {}",
    "  async launch(req: string) {",
    "    if (req) return;",
    "  }",
    "  list(ref?: string) { return ref; }",
    "}",
    "export async function helper(a: number) { return a; }",
  ].join("\n"));
  assert.deepEqual(ts, [
    { line: 2, text: "interface WorqDeps" },
    { line: 3, text: "type Mode" },
    { line: 4, text: "const MAX" },
    { line: 5, text: "class Worq" },
    { line: 7, text: "async launch(req: string)" },
    { line: 10, text: "list(ref?: string)" },
    { line: 12, text: "async function helper(a: number)" },
  ]);

  const py = extractSymbols("app.py", [
    "__all__ = ['Engine', 'run']",
    "class Engine(Base):",
    "    def inner(self): pass",
    "async def run(cfg):",
    "    pass",
    "def sync_fn():",
    "    return 1",
  ].join("\n"));
  assert.deepEqual(py, [
    { line: 1, text: "__all__ = ['Engine', 'run']" },
    { line: 2, text: "class Engine(Base)" },
    { line: 4, text: "async def run(cfg)" },
    { line: 6, text: "def sync_fn()" },
  ]);

  const rs = extractSymbols("src/lib.rs", [
    "mod internal;",
    "pub mod api;",
    "pub(crate) struct Store<T> {",
    "    items: Vec<T>,",
    "}",
    "impl<T> Store<T> {",
    "    pub async fn fetch(&self) {}",
    "    fn private_helper(&self) {}",
    "}",
    "pub trait Runner {}",
  ].join("\n"));
  assert.deepEqual(rs, [
    { line: 2, text: "pub mod api" },
    { line: 3, text: "pub struct Store<T>" },
    { line: 7, text: "pub async fn fetch(&self)" },
    { line: 10, text: "pub trait Runner" },
  ]);

  const go = extractSymbols("server.go", [
    "package server",
    "type Config struct {}",
    "type privateCfg struct {}",
    "func helper() {}",
    "func New(c Config) *Server { return nil }",
    "func (s *Server) Start(ctx Context) error { return nil }",
  ].join("\n"));
  assert.deepEqual(go, [
    { line: 2, text: "type Config struct" },
    { line: 5, text: "func New(c Config)" },
    { line: 6, text: "func (s *Server) Start(ctx Context)" },
  ]);

  const sql = extractSymbols("schema.sql", [
    "CREATE TABLE IF NOT EXISTS users (id int);",
    "create or replace view active_users as select * from users;",
    "CREATE FUNCTION get_user(id int) RETURNS int AS $$ SELECT id $$ LANGUAGE SQL;",
  ].join("\n"));
  assert.deepEqual(sql, [
    { line: 1, text: "CREATE TABLE users" },
    { line: 2, text: "CREATE VIEW active_users" },
    { line: 3, text: "CREATE FUNCTION get_user" },
  ]);

  const md = extractSymbols("README.md", [
    "# Title",
    "```bash",
    "# comment inside fence",
    "## also fenced",
    "```",
    "## Real Section",
    "### Ignored H3",
  ].join("\n"));
  assert.deepEqual(md, [
    { line: 1, text: "# Title" },
    { line: 6, text: "## Real Section" },
  ]);
});

test("exploreRepo: deterministic filtering, noise/binary/minified/large exclusions, and source vs test separation", async (t) => {
  const { root } = await initRepo(t, {
    ".gitignore": "ignored.ts\n",
    "src/core.ts": "export function greet(name: string) {\n  return 'hi ' + name;\n}\n",
    "ignored.ts": "export const SECRET = 1;\n",
    "package-lock.json": '{"lockfileVersion": 3}\n',
    "Cargo.lock": "# lock\n",
    "dist/bundle.js": "console.log('dist');\n",
    "src/app.min.js": "var a=1;var b=2;\n",
    "src/app.js.map": '{"version":3}\n',
    "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    "src/blob.ts": Buffer.from("header\0binary-payload"),
    "src/generated.js": `${"a=1;".repeat(200)}\n`, // 800 bytes on 1 line -> avg line > 400
    "src/huge.ts": "export const x = 1;\n".repeat(7000), // > 128 KB
    // Heavy test suite (> 50 KB) must NOT push small source out of Tier 1.
    "test/big.test.ts": "// test line\n".repeat(4500),
    "docs/guide.md": "# Guide\nSome docs.\n",
    "fixtures/sample.json": '{"ok":true}\n',
  });
  if (process.platform !== "win32") {
    await symlink(join(root, "src/core.ts"), join(root, "src/link.ts"));
  }

  const snap = await exploreRepo(root, "auto", AbortSignal.timeout(10_000));
  assert.equal(snap.tier, 1, "heavy test suite does not push small source out of Tier 1");
  assert.equal(snap.stats.sourceFiles, 2, ".gitignore + src/core.ts");
  assert.equal(snap.stats.auxFiles, 3);
  assert.ok(snap.stats.skippedNoise >= 5, "drops lockfiles, dist, min.js, .map");
  assert.ok(snap.stats.skippedBinary >= 2, "drops .png and NUL-byte file");
  assert.equal(snap.stats.skippedLarge, 1, "drops > 128 KB file");
  assert.equal(snap.stats.skippedMinified, 1, "drops minified avg-line > 400 file");
  assert.match(snap.text, /--- src\/core\.ts ---\n1: export function greet/);
  assert.match(snap.text, /test\/big\.test\.ts/);
  assert.match(snap.text, /docs\/guide\.md/);
  assert.match(snap.text, /fixtures\/sample\.json/);
  assert.doesNotMatch(snap.text, /SECRET|--- ignored\.ts|package-lock\.json|Cargo\.lock|bundle\.js|blob\.ts|generated\.js|huge\.ts|link\.ts/);
  assert.ok(snap.bytes <= EXPLORE_LIMITS.tier1PayloadBytes);

  // `map` mode on the same small repo produces Tier 2 (never full inline).
  const mapSnap = await exploreRepo(root, "map", AbortSignal.timeout(10_000));
  assert.equal(mapSnap.tier, 2);
  assert.match(mapSnap.text, /Tier 2: Symbol Map/);
  assert.match(mapSnap.text, /src\/core\.ts[\s\S]*:1 function greet\(name: string\)/);
  assert.doesNotMatch(mapSnap.text, /return 'hi ' \+ name/);
  assert.ok(mapSnap.bytes <= EXPLORE_LIMITS.tier2PayloadBytes);
});

test("exploreRepo: Tier 2 and Tier 3 triggers enforce hard UTF-8 byte caps", async (t) => {
  // Build a repo with 45 source files (exceeds tier1MaxSourceFiles=40 -> Tier 2).
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "demo-pkg", version: "1.2.3", type: "module", scripts: { test: "node --test" }, dependencies: { foo: "1.0.0" } }, null, 2),
    "index.ts": "export function main() { return 1; }\n",
  };
  for (let i = 0; i < 45; i++) {
    const dir = `src/mod-${String(i % 6).padStart(2, "0")}/sub-${String(i % 3)}`;
    files[`${dir}/file-${String(i).padStart(2, "0")}.ts`] = `${[
      `export interface Spec${i} { id: number }`,
      `export async function handle${i}(input: Spec${i}) { return input.id; }`,
      `export const CONST_${i} = ${i};`,
    ].join("\n")}\n`;
  }
  const { root } = await initRepo(t, files);

  const tier2 = await exploreRepo(root, "auto", AbortSignal.timeout(10_000));
  assert.equal(tier2.tier, 2);
  assert.ok(tier2.bytes <= EXPLORE_LIMITS.tier2PayloadBytes, `Tier 2 ${tier2.bytes} <= ${EXPLORE_LIMITS.tier2PayloadBytes}`);
  assert.match(tier2.text, /package\.json: demo-pkg@1\.2\.3/);
  assert.match(tier2.text, /index\.ts[\s\S]*:1 function main\(\)/);

  // Trigger Tier 3 via tighter limits override (e.g., > 20 source files -> Tier 3).
  const tier3 = await exploreRepo(root, "auto", AbortSignal.timeout(10_000), {
    limits: { tier2MaxSourceFiles: 20, tier3PayloadBytes: 2048 },
  });
  assert.equal(tier3.tier, 3);
  assert.ok(tier3.bytes <= 2048, `Tier 3 ${tier3.bytes} <= 2048`);
  assert.match(tier3.text, /Tier 3: Structural Skeleton/);
  assert.match(tier3.text, /### Entrypoints[\s\S]*index\.ts/);
  assert.match(tier3.text, /### Directory Rollup \(depth <= 3\)/);
  assert.match(tier3.text, /src\/mod-00\/sub-0/);

  // Tight Tier 2 cap truncates cleanly within byte cap even with multi-byte UTF-8.
  const tightTier2 = await exploreRepo(root, "map", AbortSignal.timeout(10_000), {
    limits: { tier2PayloadBytes: 1800 },
  });
  assert.equal(tightTier2.tier, 2);
  assert.ok(Buffer.byteLength(tightTier2.text, "utf8") <= 1800);
});

test("exploreRepo: benchmark against pi-worq itself produces a compact Tier 2 symbol map", async () => {
  const autoSnap = await exploreRepo(REPO_ROOT, "auto", AbortSignal.timeout(10_000));
  const mapSnap = await exploreRepo(REPO_ROOT, "map", AbortSignal.timeout(10_000));
  assert.equal(autoSnap.tier, 2, "pi-worq itself triggers Tier 2");
  assert.equal(mapSnap.tier, 2);
  assert.equal(autoSnap.text, mapSnap.text, "auto and map produce identical Tier 2 prefix for pi-worq");
  assert.ok(autoSnap.bytes <= EXPLORE_LIMITS.tier2PayloadBytes, `pi-worq map ${autoSnap.bytes} <= 12 KB`);
  assert.match(autoSnap.text, /package\.json: pi-worq@/);
  assert.match(autoSnap.text, /src\/worq\.ts[\s\S]*class Worq/);
  assert.match(autoSnap.text, /src\/explore\.ts[\s\S]*exploreRepo/);
  assert.match(autoSnap.text, /### Other Files[\s\S]*test \(/);
});

test("workflow loader: validates explore frontmatter (auto | map | none)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-wf-explore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writePkg = async (name: string, explore?: string) => {
    await mkdir(join(dir, "workflows", name), { recursive: true });
    const line = explore !== undefined ? `explore: ${explore}\n` : "";
    await writeFile(join(dir, "workflows", name, "SKILL.md"), `---\nname: ${name}\ndescription: Desc\naccess: read\n${line}---\nBody.\n`);
  };
  await writePkg("default-map");
  await writePkg("auto-pkg", "auto");
  await writePkg("map-pkg", "map");
  await writePkg("none-pkg", "none");
  await writePkg("bad-pkg", "full");

  const { kinds, problems } = loadWorkflows(dir);
  assert.equal(kinds.get("default-map")!.explore, "map");
  assert.equal(kinds.get("auto-pkg")!.explore, "auto");
  assert.equal(kinds.get("map-pkg")!.explore, "map");
  assert.equal(kinds.get("none-pkg")!.explore, "none");
  assert.equal(kinds.has("bad-pkg"), false);
  assert.match(problems[0]?.message ?? "", /explore must be auto, map or none/);
});

test("workflow loader: write kinds default to map and reject explore: auto", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-wf-explore-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writePkg = async (name: string, explore?: string) => {
    await mkdir(join(dir, "workflows", name), { recursive: true });
    const line = explore !== undefined ? `explore: ${explore}\n` : "";
    await writeFile(join(dir, "workflows", name, "SKILL.md"), `---\nname: ${name}\ndescription: Desc\naccess: write\n${line}---\nBody.\n`);
  };
  await writePkg("write-default");
  await writePkg("write-none", "none");
  await writePkg("write-auto", "auto");
  const { kinds, problems } = loadWorkflows(dir);
  assert.equal(kinds.get("write-default")!.explore, "map");
  assert.equal(kinds.get("write-none")!.explore, "none");
  assert.equal(kinds.has("write-auto"), false);
  assert.match(problems.map((p) => p.message).join("\n"), /explore: auto is only valid when access is read/);
});

test("Worq: cross-swarm prefix caching, repo-state invalidation, and execute map default", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const systems = new Map<string, string>();
  const { worq, next } = setup(root, state, {
    "agent.scout": async (turn) => {
      const task = JSON.parse(turn.text).task as string;
      systems.set(task, turn.system);
      await turn.tool("submit", { summary: `Done ${task}` });
    },
    "agent.plan": async (turn) => {
      systems.set("plan", turn.system);
      await turn.tool("submit", planSubmission);
    },
    "agent.execute": async (turn) => {
      systems.set("execute", turn.system);
      await turn.tool("submit", { summary: "Done exec" });
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  });

  // 3 parallel scouts with different tasks share one cached snapshot and byte-identical spec.system.
  const [s1, s2, s3] = await Promise.all([
    worq.spawn("scout", "Find greeting", { title: "Scout one", group: "wave", notify: "barrier", expect: 3 }),
    worq.spawn("scout", "Check entrypoints", { title: "Scout two", group: "wave", notify: "barrier", expect: 3 }),
    worq.spawn("scout", "Audit imports", { title: "Scout three", group: "wave", notify: "barrier", expect: 3 }),
  ]);
  await next("barrier", "group:wave");

  assert.ok(s1.explore && s1.explore.tier === 1);
  assert.strictEqual(s1.explore, s2.explore, "parallel scouts reuse cached snapshot object");
  assert.strictEqual(s2.explore, s3.explore, "all parallel scouts reuse cached snapshot object");
  assert.equal(systems.get("Find greeting"), systems.get("Check entrypoints"), "spec.system is byte-identical across tasks");
  assert.equal(systems.get("Check entrypoints"), systems.get("Audit imports"));
  assert.match(systems.get("Find greeting")!, /## Repository Snapshot \(Tier 1: Inline Source\)/);
  assert.match(systems.get("Find greeting")!, /1: print\('hello'\)/);
  assert.match(worq.list(s1.ref), /Explore: tier 1/);

  // Plan uses explore: map -> Tier 2 Symbol Map.
  const plan = await worq.spawn("plan", "Plan greeting", { title: "Plan greeting" });
  await next("parked", plan.ref);
  assert.equal(plan.explore?.tier, 2);
  assert.match(systems.get("plan")!, /## Repository Snapshot \(Tier 2: Symbol Map\)/);
  await worq.cancel(plan.ref);

  // Execute inherits the explore: map default and reuses plan's cached baseline snapshot.
  const exec = await worq.spawn("execute", "Edit greeting", { title: "Edit greeting" });
  await next("parked", exec.ref);
  assert.equal(exec.explore?.tier, 2);
  assert.strictEqual(exec.explore, plan.explore, "execute reuses plan's snapshot on the same baseline");
  assert.match(systems.get("execute")!, /## Repository Snapshot \(Tier 2: Symbol Map\)/);
  // Shared prefix: AUTHORITY + snapshot are byte-identical across kinds; skill body follows.
  const shared = `${systems.get("plan")!.split(plan.explore!.text)[0]}${plan.explore!.text}`;
  assert.ok(systems.get("execute")!.startsWith(shared), "plan and execute share the AUTHORITY + snapshot prefix");
  await worq.cancel(exec.ref);

  // Dirty edit (and a second edit to the same dirty file!) invalidates the snapshot cache.
  await writeFile(join(root, "app.py"), "print('updated-1')\n");
  const key1 = await repoStateKey(root, AbortSignal.timeout(5000));
  const s4 = await worq.spawn("scout", "After edit 1", { title: "Scout four" });
  await next("done", s4.ref);
  assert.notStrictEqual(s4.explore, s1.explore);
  assert.match(systems.get("After edit 1")!, /1: print\('updated-1'\)/);

  await writeFile(join(root, "app.py"), "print('updated-2-longer')\n");
  const key2 = await repoStateKey(root, AbortSignal.timeout(5000));
  assert.notEqual(key1, key2, "second edit to already-dirty file changes repoStateKey");
  const s5 = await worq.spawn("scout", "After edit 2", { title: "Scout five" });
  await next("done", s5.ref);
  assert.notStrictEqual(s5.explore, s4.explore);
  assert.match(systems.get("After edit 2")!, /1: print\('updated-2-longer'\)/);
  await worq.cancel("all");
});

test("Worq: Tier 1 parallel group staggers siblings until cache warmup and cancels cleanly", async (t) => {
  // Create a Tier 1 repo >= 4 KB so cold-cache warmup staggering activates.
  const bigModule = `${Array.from({ length: 140 }, (_, i) => `export const item_${i} = "value-${i}-padding-for-cache";`).join("\n")}\n`;
  const { root, state } = await initRepo(t, { "src/items.ts": bigModule });

  const starts: { task: string; at: number }[] = [];
  let releaseFirst!: () => void;
  const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const events: import("../src/agent.ts").AgentEvent[] = [];
  let wake: (() => void) | undefined;

  const worq = new Worq({
    driver: fakeDriver({
      "agent.scout": async (turn) => {
        const task = JSON.parse(turn.text).task as string;
        const first = starts.length === 0;
        starts.push({ task, at: Date.now() });
        if (first) await firstHold;
        await turn.tool("submit", { summary: `ok ${task}` });
      },
    }),
    kinds: KINDS,
    config: config(),
    state,
    cwd: root,
    exploreStaggerMs: 120,
    notify: (event) => { events.push(event); wake?.(); },
  });

  const [a, b, c] = await Promise.all([
    worq.spawn("scout", "s1", { title: "Warm one", group: "warm", notify: "barrier", expect: 3 }),
    worq.spawn("scout", "s2", { title: "Warm two", group: "warm", notify: "barrier", expect: 3 }),
    worq.spawn("scout", "s3", { title: "Warm three", group: "warm", notify: "barrier", expect: 3 }),
  ]);
  assert.equal(a.explore?.tier, 1);
  assert.ok(a.explore!.bytes >= EXPLORE_LIMITS.tier1WarmupThresholdBytes);

  // Wait for both siblings to start after the stagger window, while the first warmer scout is still held.
  for (let i = 0; i < 60 && starts.length < 3; i++) await new Promise((r) => setTimeout(r, 15));
  assert.equal(starts.length, 3);
  const delta2 = starts[1].at - starts[0].at;
  const delta3 = starts[2].at - starts[0].at;
  assert.ok(delta2 >= 90, `second scout waited for warmup stagger (got ${delta2}ms)`);
  assert.ok(delta3 >= 90, `third scout waited for warmup stagger (got ${delta3}ms)`);
  assert.ok(Math.abs(starts[2].at - starts[1].at) < 80, "siblings fire together once warm");

  releaseFirst();
  for (let i = 0; i < 60 && !events.some((e) => e.type === "barrier"); i++) {
    await new Promise<void>((r) => { wake = r; setTimeout(r, 20); });
  }
  assert.ok(events.some((e) => e.type === "barrier" && e.group === "warm"));
  assert.equal(a.state, "done");
  assert.equal(b.state, "done");
  assert.equal(c.state, "done");
  await worq.shutdown();
});

test("grouped scoped writers share the system prefix and release siblings on a tool-only response", async (t) => {
  const bigModule = Array.from({ length: 140 }, (_, i) => `export const item_${i} = "value-${i}-padding-for-cache";`).join("\n");
  const { root, state } = await initRepo(t, { "src/items.ts": bigModule });
  const kinds = new Map(KINDS);
  kinds.set("execute", { ...kinds.get("execute")!, explore: "auto", review: undefined });
  const systems: string[] = [];
  const paths: string[][] = [];
  let firstResponse!: () => void;
  const response = new Promise<void>(resolve => { firstResponse = resolve; });
  let finishLeader!: () => void;
  const stay = new Promise<void>(resolve => { finishLeader = resolve; });
  const worq = new Worq({ cwd: root, state, kinds, config: config(), exploreStaggerMs: 60_000, notify() {}, driver: fakeDriver({
    "agent.execute": async (turn) => {
      systems.push(turn.system);
      paths.push(JSON.parse(turn.text).writePaths);
      if (systems.length === 1) {
        turn.spec.emit({ type: "response", completed: false });
        await response;
        turn.spec.emit({ type: "response", completed: true });
        await stay;
      }
      await turn.tool("submit", { summary: "ready" });
    },
  }) });
  try {
    const options = { group: "writers", notify: "barrier" as const, expect: 2 };
    const leader = await worq.spawn("execute", "lead", { ...options, title: "Lead writer", writePaths: ["src/lead.ts"] });
    const sibling = await worq.spawn("execute", "follow", { ...options, title: "Next writer", writePaths: ["src/next.ts"] });
    assert.strictEqual(leader.explore, sibling.explore);
    assert.ok(leader.explore!.bytes >= EXPLORE_LIMITS.tier1WarmupThresholdBytes);
    for (let i = 0; i < 100 && systems.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(paths, [["src/lead.ts"]]);
    firstResponse();
    for (let i = 0; i < 100 && systems.length < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(paths, [["src/lead.ts"], ["src/next.ts"]]);
    assert.equal(systems[0], systems[1]);
    assert.doesNotMatch(systems[0], /src\/(lead|next)\.ts/);
    assert.equal(leader.state, "running", "the sibling starts before the leader submits");
  } finally { firstResponse(); finishLeader(); await worq.shutdown(); }
});
