import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { dispatch, ops } from "../src/control.ts";
import { Block } from "../src/contracts.ts";
import { runGates } from "../src/gate.ts";
import { cleanEnv } from "../src/process.ts";
import { auditWriteScope, createWriteScope, findScopeOverlap } from "../src/scope.ts";
import { checkSwarm, formatSwarmCheck } from "../src/swarm-check.ts";
import { KINDS, pass, repo, setup } from "./fake.ts";

function makeRepo(dir: string) {
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  return g;
}

test("scope: exact NFA overlap catches nested globs and allows disjoint modules", () => {
  const a = createWriteScope(["src/auth/**"]);
  const b = createWriteScope(["src/billing/**"]);
  const c = createWriteScope(["src/**/token.ts"]);
  const d = createWriteScope(["src/auth/*.test.ts"]);

  assert.equal(findScopeOverlap(a, b), undefined);
  assert.deepEqual(findScopeOverlap(a, c), ["src/auth/**", "src/**/token.ts"]);
  assert.deepEqual(findScopeOverlap(a, d), ["src/auth/**", "src/auth/*.test.ts"]);
  assert.equal(findScopeOverlap(c, d), undefined);

  assert.equal(a.allows("src/auth/jwt/verify.ts"), true);
  assert.equal(a.allows("src/billing/invoice.ts"), false);
  assert.throws(() => a.assertAllowed("package.json"), (e: unknown) => e instanceof Block && e.code === "scope");
});

test("scope: auditWriteScope catches out-of-scope edits, untracked files, and renames", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-scope-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = makeRepo(dir);
  await mkdir(join(dir, "src", "a"), { recursive: true });
  await mkdir(join(dir, "src", "b"), { recursive: true });
  await writeFile(join(dir, "src", "a", "one.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "src", "b", "two.ts"), "export const b = 2;\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  const baseline = g("rev-parse", "HEAD");
  const scope = createWriteScope(["src/a/**"]);

  // In-scope change passes.
  await writeFile(join(dir, "src", "a", "one.ts"), "export const a = 2;\n");
  assert.deepEqual(await auditWriteScope(dir, baseline, scope, AbortSignal.timeout(10_000)), ["src/a/one.ts"]);

  // Out-of-scope write (simulating a run_command escape) fails.
  await writeFile(join(dir, "src", "b", "sneaky.ts"), "bad\n");
  await assert.rejects(
    auditWriteScope(dir, baseline, scope, AbortSignal.timeout(10_000)),
    (e: unknown) => e instanceof Block && e.code === "scope-violation" && /src\/b\/sneaky\.ts/.test(e.message),
  );
  await rm(join(dir, "src", "b", "sneaky.ts"));

  // Committed rename from out-of-scope into in-scope is also caught via --no-renames.
  g("mv", "src/b/two.ts", "src/a/two.ts");
  g("commit", "-qm", "sneaky move");
  await assert.rejects(
    auditWriteScope(dir, baseline, scope, AbortSignal.timeout(10_000)),
    (e: unknown) => e instanceof Block && e.code === "scope-violation" && /src\/b\/two\.ts/.test(e.message),
  );
});

test("gates: fails closed with compact excerpt, passes after fix", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "flag.txt");
  const gates = [{ name: "check-flag", executable: process.execPath, args: ["-e", "const fs=require('fs'); if(fs.readFileSync('flag.txt','utf8').trim()!=='ok'){console.error('expected ok'); process.exit(1);}"] }];

  await writeFile(file, "nope\n");
  await assert.rejects(
    runGates(dir, cleanEnv, gates, AbortSignal.timeout(10_000)),
    (e: unknown) => e instanceof Block && e.code === "gate-failed" && /expected ok/.test(e.message),
  );

  await writeFile(file, "ok\n");
  const passed = await runGates(dir, cleanEnv, gates, AbortSignal.timeout(10_000));
  assert.equal(passed.length, 1);
  assert.equal(passed[0].passed, true);
});

test("swarm-check: git merge-tree verifies clean multi-branch merge and flags true conflicts without touching HEAD", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-merge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = makeRepo(dir);
  await writeFile(join(dir, "shared.txt"), "line1\nline2\nline3\nline4\nline5\n");
  await writeFile(join(dir, "a.txt"), "a0\n");
  await writeFile(join(dir, "b.txt"), "b0\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");

  // Branch A edits a.txt + top of shared.txt.
  g("checkout", "-qb", "worq/worker-a", base);
  await writeFile(join(dir, "a.txt"), "a1\n");
  await writeFile(join(dir, "shared.txt"), "LINE1-A\nline2\nline3\nline4\nline5\n");
  g("add", "-A"); g("commit", "-qm", "worker a");

  // Branch B edits b.txt + bottom of shared.txt (non-overlapping hunk: merges cleanly!).
  g("checkout", "-qb", "worq/worker-b", base);
  await writeFile(join(dir, "b.txt"), "b1\n");
  await writeFile(join(dir, "shared.txt"), "line1\nline2\nline3\nline4\nLINE5-B\n");
  g("add", "-A"); g("commit", "-qm", "worker b");

  // Branch C conflicts with Branch A on line1 of shared.txt.
  g("checkout", "-qb", "worq/worker-c", base);
  await writeFile(join(dir, "shared.txt"), "LINE1-C\nline2\nline3\nline4\nline5\n");
  g("add", "-A"); g("commit", "-qm", "worker c");

  g("checkout", "-q", "main");
  const signal = AbortSignal.timeout(15_000);

  // Clean pair (A + B).
  const cleanRes = await checkSwarm(dir, [
    { ref: "worker-a", branch: "worq/worker-a", baseline: base, gatesPassed: true },
    { ref: "worker-b", branch: "worq/worker-b", baseline: base, gatesPassed: true },
  ], { target: "HEAD", signal });
  assert.equal(cleanRes.clean, true);
  assert.equal(cleanRes.mergeCommands.length, 2);
  assert.deepEqual(cleanRes.sharedCleanFiles, [{ file: "shared.txt", branches: ["worker-a", "worker-b"] }]);

  // Conflicting trio (A + B + C).
  const badRes = await checkSwarm(dir, [
    { ref: "worker-a", branch: "worq/worker-a", baseline: base, gatesPassed: true },
    { ref: "worker-b", branch: "worq/worker-b", baseline: base, gatesPassed: true },
    { ref: "worker-c", branch: "worq/worker-c", baseline: base, gatesPassed: true },
  ], { target: "HEAD", signal });
  assert.equal(badRes.clean, false);
  assert.equal(badRes.mergeCommands.length, 0);
  assert.equal(badRes.branches[2].status, "conflict");
  assert.deepEqual(badRes.branches[2].conflictingFiles, ["shared.txt"]);
  assert.deepEqual(badRes.pairwiseConflicts, [{ a: "worker-a", b: "worker-c", files: ["shared.txt"] }]);
  assert.match(formatSwarmCheck(badRes), /BLOCKED[\s\S]*worker-a <-> worker-c: shared\.txt/);

  // Checkout remains completely untouched.
  assert.equal(g("rev-parse", "HEAD"), base);
  assert.equal(g("status", "--porcelain=v1"), "");
});

test("integration: disjoint writePaths, tool fencing, run_command audit, self-healing gates, worq_list(group) & CLI checker", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(root, "src", "auth"), { recursive: true });
  await mkdir(join(root, "src", "billing"), { recursive: true });
  await writeFile(join(root, "src", "auth", "a.txt"), "init\n");
  await writeFile(join(root, "src", "billing", "b.txt"), "init\n");
  git("add", "-A");
  git("commit", "-qm", "add modules");

  const reviewPayloads: { gates?: { name: string; passed: boolean }[] }[] = [];
  const { worq, next } = setup(root, state, {
    "agent.execute": async (turn) => {
      if (turn.text.startsWith("Your submit call was rejected:")) {
        if (/scope-violation|outside writePaths/.test(turn.text)) {
          // Clean up sneaky out-of-scope file created via run_command.
          await turn.tool("run_command", { executable: process.execPath, args: ["-e", "require('fs').rmSync('src/billing/escaped.txt', { force: true })"] });
          await turn.tool("submit", { summary: "Fixed scope" });
          return;
        }
        if (/Pre-submit gate/.test(turn.text)) {
          // Fix file so gate passes.
          await turn.tool("write_file", { path: "src/auth/a.txt", content: "ok\n" });
          await turn.tool("submit", { summary: "Auth updated and gate passed" });
          return;
        }
      }
      const task = JSON.parse(turn.text).task as string;
      if (task === "auth") {
        // Tool fence blocks out-of-scope write_file immediately.
        assert.match(await turn.tool("write_file", { path: "src/billing/nope.txt", content: "x" }), /outside assigned writePaths/);
        // Write broken in-scope value and also sneak an out-of-scope file via run_command.
        await turn.tool("write_file", { path: "src/auth/a.txt", content: "broken\n" });
        await turn.tool("run_command", { executable: process.execPath, args: ["-e", "require('fs').writeFileSync('src/billing/escaped.txt', 'oops')"] });
        await turn.tool("submit", { summary: "First attempt" });
        return;
      }
      await turn.tool("write_file", { path: "src/billing/b.txt", content: "billed\n" });
      await turn.tool("submit", { summary: "Billing updated" });
    },
    review: async (turn) => {
      reviewPayloads.push(JSON.parse(turn.text));
      await turn.tool("submit", pass);
    },
  });

  // Read kinds reject writePaths / gates.
  await assert.rejects(
    worq.spawn("scout", "x", { title: "Bad scout", writePaths: ["src/**"] }),
    /only valid for access: write/,
  );

  const authGate = {
    name: "auth-ok",
    executable: process.execPath,
    args: ["-e", "const fs=require('fs'); if(fs.readFileSync('src/auth/a.txt','utf8').trim()!=='ok'){console.error('auth not ok'); process.exit(1);}"],
  };

  const a = await worq.spawn("execute", "auth", {
    title: "Auth work", group: "impl", notify: "barrier", expect: 2,
    writePaths: ["src/auth/**"], gates: [authGate],
  });

  // Overlapping scope is rejected at admission before launching a second agent.
  await assert.rejects(
    worq.spawn("execute", "overlap", { title: "Overlap work", group: "impl", writePaths: ["src/**/a.txt"] }),
    (e: unknown) => e instanceof Block && e.code === "scope-conflict",
  );

  // Disjoint scope is admitted in parallel.
  const b = await worq.spawn("execute", "billing", {
    title: "Billing work", group: "impl", notify: "barrier", expect: 2,
    writePaths: ["src/billing/**"],
  });

  const barrier = await next("barrier", "group:impl");
  assert.match(barrier.text, /Group impl settled · 2 members \(expect 2\) \(2 parked\)/);
  assert.equal(a.gateResults.length, 1);
  assert.equal(a.gateResults[0].passed, true);
  assert.equal(b.state, "parked");
  assert.match(worq.list(a.ref), /Write paths: src\/auth\/\*\*[\s\S]*Gates:\n {2}\[pass\] auth-ok/);
  assert.ok(reviewPayloads.some((p) => p.gates?.[0]?.name === "auth-ok" && p.gates[0].passed === true), "reviewer sees gate results");

  // Record persists group and gates for offline CLI inspection.
  const recA = JSON.parse(await readFile(join(state, a.ref, "record.json"), "utf8"));
  assert.equal(recA.group, "impl");
  assert.equal(recA.gates[0].passed, true);

  // worq_list(group) appends deterministic git merge-tree verdict + merge commands.
  const table = ops();
  const groupOut = await dispatch(worq, table, "list", { group: "impl" });
  assert.match(groupOut.text, /Swarm merge-tree check against HEAD.*: CLEAN/);
  assert.match(groupOut.text, /git merge --no-ff/);

  // Standalone bin/worq-check-swarm.mjs works against the repo and state dir.
  const run = promisify(execFile);
  const script = join(import.meta.dirname, "..", "bin", "worq-check-swarm.mjs");
  const cliRes = await run(process.execPath, [script, "--group", "impl", "--json"], {
    cwd: root,
    env: { ...process.env, WORQ_STATE_DIR: state },
  });
  const parsed = JSON.parse(cliRes.stdout);
  assert.equal(parsed.clean, true);
  assert.equal(parsed.branches.length, 2);
  assert.equal(parsed.branches.find((br: { ref: string }) => br.ref === a.ref)?.gatesPassed, true);

  // Package-level gates.json merges with launch-time gates.
  const gatedKind = { ...KINDS.get("execute")!, name: "gated-exec", review: undefined, gates: [authGate] };
  assert.equal(gatedKind.gates.length, 1);

  await worq.cancel("all");
});
