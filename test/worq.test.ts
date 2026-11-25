import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { reserveName } from "../src/workspace.ts";
import { KINDS, pass, planSubmission, repo, setup, type Turn } from "./fake.ts";

test("readable claims serialize across linked worktrees and survive restart", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const linked = join(dir, "linked");
  execFileSync("git", ["worktree", "add", "--detach", linked], { cwd: root });
  execFileSync("git", ["branch", "worq/fix-greeting"], { cwd: root });
  await mkdir(join(root, ".agents/plans"), { recursive: true });
  await writeFile(join(root, ".agents/plans/plan-fix-greeting-2.md"), "existing plan");
  await mkdir(state, { mode: 0o700 });
  await mkdir(join(state, "fix-greeting-2"));
  const results = await Promise.all([
    reserveName(root, state, "fix-greeting"),
    reserveName(linked, state, "fix-greeting"),
  ]);
  assert.deepEqual(results.map((r) => r.ref).sort(), ["fix-greeting-3", "fix-greeting-4"]);
  await rm(results[0].dir, { recursive: true });
  assert.equal((await reserveName(root, state, "fix-greeting")).ref, "fix-greeting-5");
});

test("clean state mkdir failure releases an unpublished name", { skip: process.platform !== "linux" || process.getuid?.() === 0 }, async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(state, { mode: 0o500 });
  try {
    await assert.rejects(reserveName(root, state, "retry-name"), { code: "EACCES" });
  } finally {
    await chmod(state, 0o700);
  }
  assert.equal((await reserveName(root, state, "retry-name")).ref, "retry-name");
});

test("only explicit plan attachments are loaded, including existing files by path", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plans = join(root, ".agents/plans");
  await mkdir(plans, { recursive: true });
  const legacy = ".agents/plans/e5de-existing-plan.md";
  await writeFile(join(root, legacy), "Existing plan unchanged");
  if (process.platform !== "win32") await symlink(join(root, "app.py"), join(plans, "escape.md"));
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => { await turn.tool("submit", planSubmission); },
    review: async (turn) => { await turn.tool("submit", pass); },
  });
  const spawn = (attach: string[]) => worq.spawn("plan", "Literal @e5de and @other-plan", { title: "Read plan", attach });
  if (process.platform !== "win32") await assert.rejects(spawn([".agents/plans/escape.md"]), /Symbolic link/);
  await assert.rejects(spawn([".agents/plans/../escape.md"]), /repo-relative/);
  await assert.rejects(spawn(["other-plan"]), /No plan/);
  const agent = await spawn([legacy, legacy]);
  assert.equal(agent.ref, "read-plan");
  assert.equal(agent.task, "Literal @e5de and @other-plan");
  assert.deepEqual(agent.attachments, [{ path: legacy, text: "Existing plan unchanged" }]);
  await next("parked", agent.ref);
  await worq.cancel(agent.ref);
  assert.equal(await readFile(join(root, legacy), "utf8"), "Existing plan unchanged");
});

test("duplicate PQ questions retain independent answers while queued", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const question = "Which source establishes the greeting?";
  const answers: string[] = [];
  let started!: () => void, release!: () => void;
  const queued = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => {
      if (turn.text.startsWith("[PQ]")) {
        assert.ok(turn.text.startsWith(`[PQ] ${question}`));
        answers.push(turn.text);
        if (answers.length === 2) await turn.tool("submit", planSubmission);
        return;
      }
      for (let i = 0; i < 2; i++) assert.match(await turn.tool("delegate", { question, why: "independent evidence" }), /Delegated PQ:/);
      started();
    },
    subagent: async (turn) => {
      const call = ++calls;
      if (call === 1) await gate;
      await turn.tool("submit", { answer: `source ${call}`, basis: "observed" });
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  }, { parallel: 1 });
  const agent = await worq.spawn("plan", "Get independent evidence", { title: "Check greeting" });
  await queued;
  try {
    assert.equal(agent.openPqs, 2);
    assert.match(worq.list(agent.ref), /running: Which source[\s\S]+queued: Which source/);
  } finally { release(); }
  await next("parked", agent.ref);
  assert.deepEqual(answers.map((a) => /source \d/.exec(a)?.[0]), ["source 1", "source 2"]);
  assert.doesNotMatch(worq.list(agent.ref), /\bd[12]\b/);
  await worq.cancel(agent.ref);
});

const finding = { witness: "Criterion ignores trailing newline", basis: "observed app.py:1", consequence: "output mismatch", change: "state the newline" };

test("plan agent: PQ delegation, plan saved, one review, parked; Main feedback opens one final revision, then done", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reviews: string[] = [];
  const agentTexts: string[] = [];
  const { worq, next, seen } = setup(root, state, {
    "agent.plan": async (turn: Turn) => {
      agentTexts.push(turn.text);
      if (turn.text.includes('"task"')) {
        assert.match(await turn.tool("read_file", { path: "app.py" }), /hello/);
        assert.match(await turn.tool("write_file", { path: "x", content: "y" }), /No tool/);
        assert.match(await turn.tool("delegate", { name: "evidence", question: "Where is the greeting printed?", why: "decides the edit", context: "Scope is the CLI" }), /Delegated PQ: Where is the greeting printed/);
        assert.match(await turn.tool("submit", planSubmission), /still open/);
        return; // end turn: wait for the PQ
      }
      if (turn.text.startsWith("[PQ]")) { await turn.tool("submit", planSubmission); return; }
      if (turn.text.startsWith("Main: include the newline")) {
        assert.match(turn.text, /final revision[\s\S]*No further review runs/);
        await turn.tool("submit", { ...planSubmission, summary: "Revised: include newline" });
        return;
      }
    },
    "subagent.evidence": async (turn) => {
      assert.equal(turn.spec.name, "subagent.evidence");
      assert.equal(JSON.parse(turn.text).context, "Scope is the CLI");
      assert.match(turn.text, /Where is the greeting printed/);
      assert.deepEqual(turn.spec.tools.map((x) => x.name).sort(), ["list_files", "read_file", "search", "submit"]);
      await turn.tool("submit", { answer: "app.py:1", basis: "observed" });
    },
    review: async (turn) => {
      assert.ok(!turn.spec.tools.some((x) => ["delegate", "ask_main", "write_file", "run_command"].includes(x.name)));
      const payload = JSON.parse(turn.text) as { request: string; submission: string };
      assert.equal(payload.request, "Uppercase the greeting");
      assert.match(payload.submission, /# Plan/);
      reviews.push(payload.submission);
      await turn.tool("submit", { verdict: "findings", summary: "One gap", findings: [finding] });
    },
  });
  const agent = await worq.spawn("plan", "Uppercase the greeting", { title: "Uppercase the greeting" });
  assert.equal(agent.ref, "uppercase-the-greeting");
  const ready = await next("parked", agent.ref);
  assert.equal(agent.state, "parked");
  assert.equal(reviews.length, 1);
  assert.match(ready.text, /review: findings/);
  assert.match(ready.text, /1: Criterion ignores trailing newline/);
  assert.match(ready.text, /parked · review findings/);
  assert.match(ready.text, /does not authorize further action/);
  assert.ok(agent.plan);
  assert.equal(agent.plan.path, `.agents/plans/plan-${agent.ref}.md`);
  const saved = await readFile(join(root, agent.plan.path), "utf8");
  assert.match(saved, /\*\*Criteria:\*\*/);
  assert.equal(agent.delegations[0].state, "answered");
  assert.ok(agentTexts.some((x) => x.includes("Answer (observed): app.py:1")));
  assert.equal([...worq.sessions.keys()].length, 1, "the parked owner keeps its live session");
  assert.ok(!agent.ended);

  // Main's feedback reaches the same SDK session once; the revision is final, unreviewed, and ends the agent.
  assert.match(worq.send(agent.ref, "include the newline"), /Sent feedback[\s\S]*final revision/);
  const done = await next("done", agent.ref);
  assert.match(done.text, /done · final revision submitted/);
  assert.equal(agent.state, "done");
  assert.equal(seen.filter((s) => s.name === "agent.plan").length, 1);
  assert.equal(reviews.length, 1, "no second review");
  assert.equal(agent.review?.verdict, "findings", "the one review stays on record");
  assert.match(await readFile(join(root, agent.plan.path), "utf8"), /Revised: include newline[\s\S]*|final revision after review/);
  assert.equal(worq.sessions.size, 0);
  assert.throws(() => worq.send(agent.ref, "more"), /done/);
  assert.match(worq.list(agent.ref), /Phase: final revision submitted \(not re-reviewed\)/);
  const record = JSON.parse(await readFile(join(state, agent.ref, "record.json"), "utf8"));
  assert.equal(record.state, "done");
  assert.equal(record.review.verdict, "findings");
  assert.equal(record.reviewedDigest, createHash("sha256").update(saved).digest("hex"));
  assert.match(worq.list(agent.ref), new RegExp(`Reviewed digest: ${record.reviewedDigest}`));
  assert.ok(!JSON.stringify(record).includes(agent.id));
});

test("a compact factual answer can be submitted, and compact findings still flag a wrong claim", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.tool("submit", { summary: "The app prints goodbye (app.py:1)." }).then(() => {}),
    review: async (turn) => {
      assert.match(turn.text, /The app prints goodbye/);
      assert.match(await turn.tool("read_file", { path: "app.py" }), /print\('hello'\)/);
      const out = await turn.tool("submit", {
        verdict: "findings", summary: "Greeting is incorrect.",
        findings: [{ witness: "app.py:1 prints hello, not goodbye; the answer reports the wrong greeting." }],
      });
      assert.equal(out, "Submitted.");
    },
  });
  const agent = await worq.spawn("plan", "What does the app print? Cite source.", { title: "What does the" });
  const ready = await next("parked", agent.ref);
  assert.match(ready.text, /review findings/);
  assert.match(worq.list(agent.ref), /1: app.py:1 prints hello, not goodbye/);
  const saved = await readFile(join(root, agent.plan!.path), "utf8");
  assert.match(saved, /## Summary\n\nThe app prints goodbye \(app.py:1\)\.\n$/);
  await worq.cancel(agent.ref);
});

test("execute agent: plan explicitly attached, own worktree and branch, review sees pinned commit, Main merges by hand", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let verifierSaw = "";
  let attached = "";
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.tool("submit", planSubmission).then(() => {}),
    "agent.execute": async (turn) => {
      assert.ok(!turn.spec.tools.some((tool) => tool.name === "delegate"));
      assert.doesNotMatch(turn.system, /question tree|recursive question/i);
      attached = turn.text;
      assert.match(await turn.tool("write_file", { path: "app.py", content: "print('HELLO')\n" }), /Wrote/);
      assert.match(await turn.tool("run_command", { executable: "node", args: ["-e", "process.stdout.write(require('node:fs').readFileSync('app.py'))"] }), /HELLO/);
      await turn.tool("submit", { summary: "Uppercased", report: "Changes: app.py" });
    },
    review: async (turn) => {
      const { commit } = JSON.parse(turn.text) as { commit?: string };
      if (commit) {
        assert.match(commit, /^[0-9a-f]{40}$/);
        verifierSaw = await turn.tool("run_command", { executable: "node", args: ["-e", "process.stdout.write(require('node:fs').readFileSync('app.py'))"] });
      }
      await turn.tool("submit", pass);
    },
  });
  const plan = await worq.spawn("plan", "Uppercase the greeting", { title: "Uppercase the greeting" });
  await next("parked", plan.ref);
  const exec = await worq.spawn("execute", `Implement @${plan.ref}; literal @ffff`, { title: "Implement greeting", attach: [plan.ref] });
  assert.deepEqual(exec.attachments.map((a) => a.path), [plan.plan?.path]);
  const ready = await next("parked", exec.ref);
  assert.match(attached, /Change the greeting to uppercase/);
  assert.match(verifierSaw, /HELLO/);
  assert.match(ready.text, /review: pass/);
  assert.match(ready.text, /parked · review passed/);
  assert.match(ready.text, new RegExp(`Branch worq/${exec.ref}`));
  assert.doesNotMatch(ready.text, /git merge|worq_spawn/);
  assert.equal(await readFile(join(root, "app.py"), "utf8"), "print('hello')\n", "baseline untouched: Worq never merges");
  assert.ok(exec.work, "a parked execute agent keeps its worktree");
  await worq.cancel(exec.ref);
  assert.equal(exec.state, "closed");
  assert.equal(exec.work, undefined, "closing removes the worktree");
  assert.equal(exec.recoverySha, undefined);
  git("merge", "-q", `worq/${exec.ref}`);
  assert.equal(await readFile(join(root, "app.py"), "utf8"), "print('HELLO')\n");
  await worq.cancel(plan.ref);
});

test("ask_main parks the agent until Main answers; steering reaches a running agent", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let answer = "";
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => {
      if (!turn.text.includes('"task"')) return;
      answer = await turn.tool("ask_main", { question: "Title case or upper case?" });
      await turn.tool("submit", planSubmission);
    },
    review: (turn) => turn.tool("submit", pass).then(() => {}),
  }, { agentTurns: 1 });
  const agent = await worq.spawn("plan", "Change the greeting case", { title: "Change the greeting" });
  const ask = await next("ask", agent.ref);
  assert.match(ask.text, /Title case or upper case\?/);
  assert.equal(agent.state, "waiting");
  assert.match(worq.list(), /asks: Title case/);
  assert.match(worq.send(agent.ref, "upper"), /Answered/);
  await next("parked", agent.ref);
  assert.equal(answer, "Main: upper");
  await worq.cancel(agent.ref);
});

test("limits, refusals and failures", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.text.includes('"task"') ? turn.tool("submit", planSubmission).then(() => {}) : undefined,
    "agent.execute": () => {},
    review: () => { throw new Error("reviewer crashed"); },
  }, { agents: 2 });
  const a = await worq.spawn("plan", "One", { title: "One plan" });
  const ready = await next("parked", a.ref);
  assert.match(ready.text, /parked · review inconclusive/);
  assert.match(ready.text, /review: inconclusive \(Review error: reviewer crashed\)/);
  assert.match(worq.list(a.ref), /Review: review inconclusive/);
  await assert.rejects(worq.spawn("plan", "Needs plan", { title: "Needs plan", attach: ["ffff"] }), /exact plan name/);
  await assert.rejects(worq.spawn("review", "x", { title: "Review work" }), /Unknown kind/);

  // Dirty baseline rejects execute at admission.
  await writeFile(join(root, "app.py"), "dirty\n");
  await assert.rejects(worq.spawn("execute", "Do it", { title: "Do it" }), /Commit or stash/);
  execFileSync("git", ["checkout", "app.py"], { cwd: root });

  // Agent that never submits: nudged once, then fails without leaving a worktree.
  const c = await worq.spawn("execute", "Do nothing", { title: "Do nothing" });
  const failedText = (await next("failed", c.ref)).text;
  assert.match(c.error!, /ended without calling submit/);
  assert.match(failedText, /Last activity:\n/);
  assert.equal(c.work, undefined);
  await worq.cancel(a.ref);
  const d = await worq.spawn("plan", "Two", { title: "Two plan" });
  const e = await worq.spawn("plan", "Three", { title: "Three plan" });
  await worq.cancel("all");
  assert.ok([d, e].every((x) => x.ended));
});

test("parked agents hold no slot; resuming one needs a free slot", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => {
      if (turn.text.includes("Hold")) await gate;
      await turn.tool("submit", planSubmission);
    },
    review: (turn) => turn.tool("submit", pass).then(() => {}),
  }, { agents: 1 });
  const parked = await worq.spawn("plan", "One", { title: "One plan" });
  await next("parked", parked.ref);
  const busy = await worq.spawn("plan", "Hold", { title: "Busy plan" });
  assert.throws(() => worq.send(parked.ref, "revise"), /at-capacity|agents are active/);
  release();
  await next("parked", busy.ref);
  assert.match(worq.send(parked.ref, "revise"), /Sent feedback/);
  await next("done", parked.ref);
  await worq.cancel("all");
});

for (const reviewed of [true, false]) test(`budget exhaustion and resume, review enabled: ${reviewed}`, async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next, seen } = setup(root, state, {
    "agent.execute": async (turn) => {
      if (turn.text.startsWith("Main: finish")) { await turn.tool("submit", { summary: "Done" }); return; }
      if (turn.text === "keep going") return;
      await turn.tool("write_file", { path: "app.py", content: "partial\n" });
      turn.spec.emit({ type: "text", text: "Observed greeting; halfway", completed: true });
      turn.steered.push("keep going");
    },
    review: (turn) => turn.tool("submit", pass).then(() => {}),
  }, { agentTurns: 1 }, undefined, reviewed ? KINDS : new Map([["execute", { ...KINDS.get("execute")!, review: undefined }]]));
  const agent = await worq.spawn("execute", "Edit greeting", { title: "Edit greeting" });
  const notice = await next("parked", agent.ref);
  assert.match(notice.text, /turn limit[\s\S]*Nothing was submitted or reviewed/);
  assert.match(notice.text, /Last response: Observed greeting; halfway/);
  assert.equal(agent.candidate, undefined);
  assert.ok(agent.recoverySha);
  assert.equal(git("show", `${agent.recoverySha}:app.py`).toString(), "partial\n");
  assert.equal(seen.filter((s) => s.name === "review").length, 0);
  assert.match(worq.send(agent.ref, "finish"), /Resumed .* with a fresh budget/);
  await next(reviewed ? "parked" : "done", agent.ref, reviewed ? 2 : 1);
  assert.equal(agent.exhausted, undefined);
  assert.ok(agent.candidate);
  assert.equal(agent.review?.verdict, reviewed ? "pass" : undefined);
  await worq.cancel(agent.ref);
});

test("an idle parked agent closes after limits.idleMinutes", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.tool("submit", planSubmission).then(() => {}),
  }, { idleMinutes: 1 });
  const agent = await worq.spawn("plan", "One", { title: "One plan" });
  await next("parked", agent.ref);
  t.mock.timers.tick(60_000);
  await agent.done;
  assert.equal(agent.state, "closed");
});

test("cancel retains uncommitted work when git cannot pin", async t => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next } = setup(root, state, { "agent.execute": async turn => {
    const cwd = turn.spec.cwd;
    await writeFile(join(cwd, "unfinished"), "recover me");
    const lock = execFileSync("git", ["rev-parse", "--git-path", "index.lock"], { cwd, encoding: "utf8" }).trim();
    await writeFile(lock, "held");
    await turn.tool("ask_main", { question: "May I proceed?" });
  } });
  const agent = await worq.spawn("execute", "recoverable work", { title: "recoverable work" });
  await next("ask", agent.ref); await worq.cancel(agent.ref);
  assert.equal(agent.state, "cancelled");
  assert.equal(await readFile(join(agent.work!, "unfinished"), "utf8"), "recover me");
  assert.match(worq.list(agent.ref), /Worktree retained/);
});

test("closing preserves a changed recovery SHA without extending verification", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let worker = "";
  const shas = new Set<string>();
  const { worq, next } = setup(root, state, {
    "agent.execute": async (turn) => {
      worker = turn.spec.cwd;
      await writeFile(join(worker, "app.py"), "reviewed");
      await turn.tool("submit", { summary: "First candidate" });
    },
    review: async (turn) => {
      shas.add(execFileSync("git", ["rev-parse", "HEAD"], { cwd: turn.spec.cwd, encoding: "utf8" }).trim());
      await turn.tool("submit", pass);
    },
  });
  const agent = await worq.spawn("execute", "Change greeting", { title: "Change greeting" });
  await next("parked", agent.ref);
  assert.deepEqual([...shas], [agent.candidate]);
  await writeFile(join(worker, "app.py"), "unreviewed recovery");
  await worq.cancel(agent.ref);
  assert.notEqual(agent.recoverySha, agent.candidate);
  assert.equal(git("rev-parse", agent.branch!).toString().trim(), agent.recoverySha);
  assert.match(worq.list(agent.ref), new RegExp(`Recovery SHA ${agent.recoverySha}: UNVERIFIED / not merge-ready`));
});
