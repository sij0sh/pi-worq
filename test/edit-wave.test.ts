import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent.ts";
import { editWaveMessage } from "../src/render.ts";
import { loadWorkflows } from "../src/runtime/workflows.ts";
import type { Capabilities, Spec } from "../src/sdk/contract.ts";
import { Worq } from "../src/worq.ts";
import { config, fakeDriver, FULL_CAPS, KINDS, repo, type FakeOptions, type Script } from "./fake.ts";

const done = { summary: "Implemented", report: "Checks: none needed" };

test("EDIT.md: loads on write packages, is refused on read ones, and is not a supporting file", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "worq-edit-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const pkg = async (name: string, access: string) => {
    await mkdir(join(agentDir, "workflows", name), { recursive: true });
    await writeFile(join(agentDir, "workflows", name, "SKILL.md"), `---\ndescription: d\naccess: ${access}\n---\nBody`);
    await writeFile(join(agentDir, "workflows", name, "EDIT.md"), "Edit slices.");
  };
  await pkg("writer", "write");
  await pkg("reader", "read");
  const { kinds, problems } = loadWorkflows(agentDir);
  assert.equal(kinds.get("writer")?.edit, "Edit slices.");
  assert.ok(!kinds.get("writer")?.skill.files.includes("EDIT.md"));
  assert.ok(!kinds.has("reader"));
  assert.match(problems.map((p) => p.message).join(), /EDIT\.md is only valid when access is write/);
  assert.ok(KINDS.get("execute")?.edit, "the shipped execute package opts in");
});

async function harness(t: import("node:test").TestContext, scripts: Record<string, Script>, caps: Capabilities = FULL_CAPS, options: FakeOptions = {}) {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen: Spec[] = [];
  const events: AgentEvent[] = [];
  const worq = new Worq({ driver: fakeDriver(scripts, seen, caps, options), kinds: KINDS, config: config(), state, cwd: root, notify: (e) => events.push(e) });
  t.after(() => worq.shutdown());
  const until = async (fn: () => boolean) => { const end = Date.now() + 20_000; while (!fn()) { if (Date.now() > end) throw new Error(JSON.stringify(events.map((e) => `${e.type}: ${e.text.slice(0, 200)}`))); await new Promise((r) => setTimeout(r, 10)); } };
  const worktrees = () => execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).trim().split("\n").length;
  const show = (rev: string, path: string) => execFileSync("git", ["show", `${rev}:${path}`], { cwd: root, encoding: "utf8" });
  return { worq, seen, until, worktrees, show, root };
}

test("edit wave: disjoint slices integrate onto the parent branch in one commit; one coalesced wake; fences hold", async (t) => {
  const texts: string[] = [];
  const { worq, until, worktrees, show } = await harness(t, {
    "agent.execute": async (turn) => {
      texts.push(turn.text);
      if (turn.text.includes('"task"')) {
        assert.match(await turn.tool("write_file", { path: "shared.py", content: "VALUE = 1\n" }), /Wrote/);
        assert.match(await turn.tool("delegate_edit", { name: "alpha", task: "Add a.py", writePaths: ["a.py", "test_a.py"] }), /Delegated edit slice alpha/);
        assert.match(await turn.tool("delegate_edit", { name: "beta", task: "Add b.py", writePaths: ["b/"] }), /Delegated edit slice beta/);
        assert.match(await turn.tool("delegate_edit", { name: "gamma", task: "Overlaps", writePaths: ["b/**/*.py"] }), /overlap slice beta/);
        assert.match(await turn.tool("write_file", { path: "c.py", content: "x" }), /Edit wave in progress/);
        assert.match(await turn.tool("run_command", { executable: "git", args: ["status"] }), /Edit wave in progress/);
        assert.match(await turn.tool("submit", done), /Edit workers are still open/);
        return;
      }
      assert.match(turn.text, /^\[EDIT WAVE 1\] 2\/2 slices integrated/);
      assert.match(await turn.tool("write_file", { path: "glue.py", content: "import a, b\n" }), /Wrote/);
      await turn.tool("submit", done);
    },
    edit: async (turn) => {
      const slice = JSON.parse(turn.text) as { task: string; writePaths: string[] };
      assert.match(await turn.tool("read_file", { path: "shared.py" }), /VALUE = 1/, "workers start from the pinned parent state");
      assert.match(await turn.tool("write_file", { path: "app.py", content: "nope" }), /outside assigned writePaths/);
      if (slice.task === "Add a.py") await turn.tool("write_file", { path: "a.py", content: "A = 1\n" });
      else await turn.tool("write_file", { path: "b/b.py", content: "B = 2\n" });
      await turn.tool("submit", done);
    },
    review: async (turn) => { await turn.tool("submit", { verdict: "pass", summary: "ok", findings: [] }); },
  });
  const agent = await worq.spawn("execute", "Add a and b");
  await until(() => agent.state === "parked" || agent.ended);
  assert.equal(agent.state, "parked", agent.error);
  assert.equal(texts.filter((x) => x.startsWith("[EDIT WAVE")).length, 1);
  const [wave] = agent.editWaves;
  assert.ok(wave.integrated);
  assert.deepEqual(wave.workers.map((w) => [w.name, w.state]), [["alpha", "integrated"], ["beta", "integrated"]]);
  for (const [path, body] of [["shared.py", "VALUE = 1\n"], ["a.py", "A = 1\n"], ["b/b.py", "B = 2\n"], ["glue.py", "import a, b\n"]]) assert.equal(show(agent.candidate!, path), body);
  assert.equal(worktrees(), 2, "only the main checkout and the parked parent's worktree remain");
  assert.ok(agent.view().editWaves?.length === 1);
  assert.match(worq.list(agent.ref), /Edit waves:\n {2}1: .* alpha integrated, beta integrated/);
});

test("edit wave: a failed slice does not block its clean sibling; scope outside the parent's is refused", async (t) => {
  const texts: string[] = [];
  const { worq, until, show } = await harness(t, {
    "agent.execute": async (turn) => {
      texts.push(turn.text);
      if (turn.text.includes('"task"')) {
        assert.match(await turn.tool("delegate_edit", { task: "outside", writePaths: ["docs/"] }), /lie outside your own/);
        await turn.tool("delegate_edit", { name: "good", task: "good", writePaths: ["src/good.py"] });
        await turn.tool("delegate_edit", { name: "bad", task: "bad", writePaths: ["src/bad.py"] });
        return;
      }
      await turn.tool("submit", done);
    },
    edit: async (turn) => {
      const slice = JSON.parse(turn.text) as { task: string };
      if (slice.task === "good") { await turn.tool("write_file", { path: "src/good.py", content: "ok\n" }); await turn.tool("submit", done); return; }
      await turn.tool("write_file", { path: "src/bad.py", content: "half\n" }); // ends without submit: fails
    },
  });
  const agent = await worq.spawn("execute", "Two slices", { writePaths: ["src/"] });
  await until(() => agent.ended || agent.state === "parked");
  const report = texts.find((x) => x.startsWith("[EDIT WAVE"))!;
  assert.match(report, /1\/2 slices integrated/);
  assert.match(report, /\[failed\] bad \(src\/bad\.py\).*Partial commit [0-9a-f]{40}/);
  assert.equal(show(agent.candidate!, "src/good.py"), "ok\n");
  assert.throws(() => show(agent.candidate!, "src/bad.py"));
});

test("edit wave: forked workers mirror the parent's tool definitions; cancelling the parent stops workers and removes their worktrees", async (t) => {
  let parent: Spec | undefined;
  let started = 0;
  const { worq, seen, until, worktrees } = await harness(t, {
    "agent.execute": async (turn) => {
      parent = turn.spec;
      await turn.tool("delegate_edit", { name: "one", task: "t1", writePaths: ["one.py"], fork: true });
      await turn.tool("delegate_edit", { name: "two", task: "t2", writePaths: ["two.py"], fork: true });
    },
    edit: async (turn) => {
      started++;
      assert.match(await turn.tool("delegate_edit", { task: "nested", writePaths: ["x.py"] }), /Disabled in an edit worker/);
      await new Promise(() => {});
    },
  }, { ...FULL_CAPS, contextFork: true }, { snapshot: () => [{ role: "user", content: "parent history" }] });
  const agent = await worq.spawn("execute", "Fork slices");
  await until(() => started === 2);
  const child = seen.find((s) => s.name === "edit.one")!;
  assert.equal(child.system, parent!.system);
  assert.deepEqual(child.tools.map((x) => [x.name, x.description]), parent!.tools.map((x) => [x.name, x.description]));
  assert.deepEqual(child.seed, [{ role: "user", content: "parent history" }]);
  assert.match(String(child.cwd), /edits\/e1\/work$/);
  assert.equal(worktrees(), 4);
  await worq.cancel(agent.ref);
  assert.equal(agent.state, "cancelled");
  await until(() => worktrees() === 1);
});

test("editWaveMessage names conflicts with a recovery command", () => {
  const text = editWaveMessage({ n: 2, base: "a".repeat(40), workers: [{ id: "e1", name: "x", task: "t", writePaths: ["x"], state: "conflict", sha: "b".repeat(40), error: "conflicts on x" }] });
  assert.match(text, /\[EDIT WAVE 2\] 0\/1 slices integrated .*worktree is unchanged/);
  assert.match(text, /git cherry-pick b{40}/);
});
