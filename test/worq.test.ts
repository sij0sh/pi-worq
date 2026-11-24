import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { reserveName } from "../src/workspace.ts";
import { loadPrompts } from "../src/prompts.ts";
import { pass, planSubmission, repo, setup, type Turn } from "./fake.ts";

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
    reviewer: async (turn) => { await turn.tool("report", pass); },
  });
  const spawn = (attach: string[]) => worq.spawn("plan", "Literal @e5de and @other-plan", { title: "Read plan", attach });
  if (process.platform !== "win32") await assert.rejects(spawn([".agents/plans/escape.md"]), /Symbolic link/);
  await assert.rejects(spawn([".agents/plans/../escape.md"]), /repo-relative/);
  await assert.rejects(spawn(["other-plan"]), /No plan/);
  const agent = await spawn([legacy, legacy]);
  assert.equal(agent.ref, "read-plan");
  assert.equal(agent.task, "Literal @e5de and @other-plan");
  assert.deepEqual(agent.attachments, [{ path: legacy, text: "Existing plan unchanged" }]);
  await next("review-ready", agent.ref);
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
      await turn.tool("answer", { answer: `source ${call}`, basis: "observed" });
    },
    reviewer: async (turn) => { await turn.tool("report", pass); },
  }, { parallel: 1 });
  const agent = await worq.spawn("plan", "Get independent evidence", { title: "Check greeting" });
  await queued;
  try {
    assert.equal(agent.openPqs, 2);
    assert.match(worq.list(agent.ref), /running: Which source[\s\S]+queued: Which source/);
  } finally { release(); }
  await next("review-ready", agent.ref);
  assert.deepEqual(answers.map((a) => /source \d/.exec(a)?.[0]), ["source 1", "source 2"]);
  assert.doesNotMatch(worq.list(agent.ref), /\bd[12]\b/);
  await worq.cancel(agent.ref);
});

const finding = { witness: "Criterion D1 ignores trailing newline", basis: "observed app.py:1", consequence: "output mismatch", change: "state the newline" };

test("plan agent: PQ delegation, plan saved to .agents/plans, parallel reviewers, sealed handoff", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reviewers: string[] = [];
  const agentTexts: string[] = [];
  const { worq, next, seen } = setup(root, state, {
    "agent.plan": async (turn: Turn) => {
      agentTexts.push(turn.text);
      if (turn.text.includes('"task"')) {
        assert.match(await turn.tool("read_file", { path: "app.py" }), /hello/);
        assert.match(await turn.tool("write_file", { path: "x", content: "y" }), /No tool/);
        assert.match(await turn.tool("delegate", { name: "evidence", question: "Where is the greeting printed?", why: "decides the edit" }), /Delegated PQ: Where is the greeting printed/);
        assert.match(await turn.tool("submit", planSubmission), /still open/);
        return; // end turn: wait for the PQ
      }
      if (turn.text.startsWith("[PQ]")) { await turn.tool("submit", planSubmission); return; }
      if (turn.text.includes("another round")) { await turn.tool("submit", { ...planSubmission, summary: "Revised: include newline" }); return; }
    },
    "subagent.evidence": async (turn) => {
      assert.equal(turn.spec.name, "subagent.evidence");
      assert.match(turn.text, /Where is the greeting printed/);
      assert.deepEqual(turn.spec.tools.map((x) => x.name).sort(), ["answer", "list_files", "read_file", "search"]);
      await turn.tool("answer", { answer: "app.py:1", basis: "observed" });
    },
    reviewer: async (turn) => {
      reviewers.push(turn.spec.name);
      assert.ok(!turn.spec.tools.some((x) => ["delegate", "ask_main", "write_file", "run_command"].includes(x.name)));
      const payload = JSON.parse(turn.text) as { request: string; submission: string };
      assert.equal(payload.request, "Uppercase the greeting");
      assert.match(payload.submission, /# Plan/);
      await turn.tool("report", turn.spec.name === "reviewer.defeater" ? { verdict: "fail", summary: "One gap", findings: [finding] } : pass);
    },
  });
  const agent = await worq.spawn("plan", "Uppercase the greeting", { title: "Uppercase the greeting" });
  assert.equal(agent.ref, "uppercase-the-greeting");
  const ready = await next("review-ready", agent.ref);
  assert.equal(agent.state, "review-ready");
  assert.deepEqual(reviewers.sort(), ["reviewer.decision", "reviewer.defeater", "reviewer.pair", "reviewer.subtraction"]);
  assert.match(ready.text, /defeater: fail/);
  assert.match(ready.text, /defeater-1: Criterion D1 ignores trailing newline/);
  assert.match(ready.text, /review-ready · unresolved review issues/);
  assert.match(ready.text, /does not authorize further action/);
  assert.doesNotMatch(ready.text, /worq_spawn|worq_send|git merge/);
  assert.ok(agent.plan);
  assert.equal(agent.plan.path, `.agents/plans/plan-${agent.ref}.md`);
  const saved = await readFile(join(root, agent.plan.path), "utf8");
  assert.match(saved, /## Decisions[\s\S]*D1/);
  assert.match(saved, /## Thought tree/);
  assert.ok(!agentTexts[0].includes('"verify"'), "read kinds carry no verify key");
  assert.equal(agent.delegations[0].state, "answered");
  assert.ok(agentTexts.some((x) => x.includes("Answer (observed): app.py:1")));
  assert.equal(seen.find((s) => s.name === "agent.plan")?.name.split(".")[0], "agent");

  assert.equal(agent.batch, "complete", "a substantive failure still completes the batch");
  assert.ok(agent.ended);
  assert.equal(worq.sessions.size, 0);
  assert.equal(agent.round, 1);
  assert.throws(() => worq.send(agent.ref, "more"), /review-ready/);
  assert.equal(await readFile(join(root, agent.plan.path), "utf8"), saved);
  const record = JSON.parse(await readFile(join(state, agent.ref, "record.json"), "utf8"));
  assert.equal(record.state, "review-ready");
  assert.ok(!JSON.stringify(record).includes(agent.id));
  assert.doesNotMatch(JSON.stringify(record), /\bd1\b/);
});

test("material pivot claims the sealed planning checkpoint once and writes only a separate unreviewed plan", async t => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let payload: any;
  let reviews = 0;
  const { worq, next } = setup(root, state, {
    "agent.plan": async turn => {
      if (turn.spec.checkpoint) {
        assert.equal(turn.spec.checkpoint, "fake-active-branch");
        payload = JSON.parse(turn.text);
      }
      await turn.tool("submit", planSubmission);
    },
    reviewer: async turn => { reviews++; await turn.tool("report", { verdict: "fail", summary: "Material pivot", findings: [{ witness: "The alternate direction changes the scope." }] }); },
  });
  const agent = await worq.spawn("plan", "Plan it", { title: "Pivot plan" });
  await next("review-ready", agent.ref);
  const original = await readFile(join(root, agent.plan!.path), "utf8");
  const command = { materialPivot: true, directionSettled: true, independentReviewRequired: false, reviewedDigest: agent.reviewedDigest, decision: "Use the new direction", unresolved: ["Check ownership"] };
  const send = (data: unknown) => worq.send(agent.ref, `/finalize ${JSON.stringify(data)}`);
  assert.throws(() => send({ ...command, independentReviewRequired: true }), /Main must confirm/);
  assert.throws(() => send({ ...command, reviewedDigest: "wrong" }), /digest mismatch/);
  assert.equal(agent.batch, "complete", "substantive fail is a complete review");
  const before = reviews;
  assert.match(send(command), /Finalizing/);
  assert.throws(() => send(command), /unused checkpoint/);
  await next("review-ready", agent.ref, 2);
  assert.equal(agent.finalization?.status, "unreviewed");
  assert.equal(reviews, before);
  assert.equal(payload.reviewed, original);
  assert.deepEqual(payload.findings, agent.reviews);
  assert.equal(payload.decision, command.decision);
  assert.equal(await readFile(join(root, agent.plan!.path), "utf8"), original);
  assert.match(await readFile(join(root, agent.finalization!.path!), "utf8"), /NOT INDEPENDENTLY REVIEWED[\s\S]*Check ownership/);
});

test("incomplete review and discarded continuity cannot reopen a sealed plan", async t => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let incomplete = true;
  const { worq, next } = setup(root, state, {
    "agent.plan": async turn => { if (turn.spec.checkpoint) throw new Error("finalization model unavailable"); await turn.tool("submit", planSubmission); },
    "reviewer.pair": async turn => { if (incomplete) throw new Error("offline reviewer"); await turn.tool("report", pass); },
    reviewer: async turn => { await turn.tool("report", pass); },
  });
  const finalize = (agent: Awaited<ReturnType<typeof worq.spawn>>) => worq.send(agent.ref, `/finalize ${JSON.stringify({ materialPivot: true, directionSettled: true, independentReviewRequired: false, reviewedDigest: agent.reviewedDigest, decision: "Pivot", unresolved: [] })}`);
  const partial = await worq.spawn("plan", "Plan it", { title: "Partial batch" });
  await next("review-ready", partial.ref);
  assert.equal(partial.batch, "incomplete");
  assert.throws(() => finalize(partial), /complete planning batch/);
  assert.match(worq.list(partial.ref), /decision: pass[\s\S]*Reviewer error: offline reviewer/);
  incomplete = false;
  const complete = await worq.spawn("plan", "Plan it", { title: "Complete batch" });
  await next("review-ready", complete.ref);
  await worq.cancel(complete.ref);
  assert.throws(() => finalize(complete), /checkpoint unavailable or expired/);
  const failure = await worq.spawn("plan", "Plan it", { title: "Failed pivot" });
  await next("review-ready", failure.ref);
  const original = await readFile(join(root, failure.plan!.path), "utf8");
  finalize(failure);
  await next("review-ready", failure.ref, 2);
  assert.equal(failure.finalization?.status, "failed");
  assert.match(failure.finalization?.error ?? "", /finalization model unavailable/);
  assert.equal(await readFile(join(root, failure.plan!.path), "utf8"), original);
  assert.equal(failure.batch, "complete");
  assert.throws(() => finalize(failure), /unused checkpoint/);
});

test("a compact factual answer can be submitted, and compact findings still flag a wrong claim", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.tool("submit", { summary: "The app prints goodbye (app.py:1)." }).then(() => {}),
    "reviewer.defeater": async (turn) => {
      assert.match(turn.text, /The app prints goodbye/);
      assert.match(await turn.tool("read_file", { path: "app.py" }), /print\('hello'\)/);
      const out = await turn.tool("report", {
        verdict: "fail", summary: "Greeting is incorrect.",
        findings: [{ witness: "app.py:1 prints hello, not goodbye; the answer reports the wrong greeting." }],
      });
      assert.equal(out, "Submitted.");
    },
    reviewer: (turn) => turn.tool("report", pass).then(() => {}),
  });
  const agent = await worq.spawn("plan", "What does the app print? Cite source.", { title: "What does the" });
  const ready = await next("review-ready", agent.ref);
  assert.match(ready.text, /unresolved review issues/);
  assert.match(worq.list(agent.ref), /defeater-1: app.py:1 prints hello, not goodbye/);
  const saved = await readFile(join(root, agent.plan!.path), "utf8");
  assert.match(saved, /## Summary\n\nThe app prints goodbye \(app.py:1\)\./);
  assert.doesNotMatch(saved, /## (Criteria|Decisions|Thought tree)/);
  await worq.cancel(agent.ref);
});

test("execute agent: plan explicitly attached, own worktree and branch, verifier sees pinned commit, Main merges by hand", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let verifierSaw = "";
  let attached = "";
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.tool("submit", planSubmission).then(() => {}),
    "agent.execute": async (turn) => {
      attached = turn.text;
      assert.match(await turn.tool("write_file", { path: "app.py", content: "print('HELLO')\n" }), /Wrote/);
      assert.match(await turn.tool("run_command", { executable: "node", args: ["-e", "process.stdout.write(require('node:fs').readFileSync('app.py'))"] }), /HELLO/);
      await turn.tool("submit", { summary: "Uppercased", changes: ["app.py"] });
    },
    "reviewer.intent": async (turn) => {
      const { commit } = JSON.parse(turn.text) as { commit: string };
      assert.match(commit, /^[0-9a-f]{40}$/);
      verifierSaw = await turn.tool("run_command", { executable: "node", args: ["-e", "process.stdout.write(require('node:fs').readFileSync('app.py'))"] });
      await turn.tool("report", pass);
    },
    reviewer: (turn) => turn.tool("report", pass).then(() => {}),
  });
  const plan = await worq.spawn("plan", "Uppercase the greeting", { title: "Uppercase the greeting" });
  await next("review-ready", plan.ref);
  const exec = await worq.spawn("execute", `Implement @${plan.ref}; literal @ffff`, { title: "Implement greeting", mode: "fast", attach: [plan.ref] });
  assert.deepEqual(exec.attachments.map((a) => a.path), [plan.plan?.path]);
  const ready = await next("review-ready", exec.ref);
  assert.match(attached, /Change the greeting to uppercase/);
  assert.match(attached, /"verify": true/);
  assert.match(verifierSaw, /HELLO/);
  assert.match(ready.text, /intent: pass/);
  assert.match(ready.text, /review-ready · no review issues reported/);
  assert.match(ready.text, new RegExp(`Branch worq/${exec.ref}`));
  assert.doesNotMatch(ready.text, /git merge|worq_spawn|worq_send/);
  assert.equal(await readFile(join(root, "app.py"), "utf8"), "print('hello')\n", "baseline untouched: Worq never merges");
  assert.ok(exec.ended);
  assert.equal(exec.work, undefined, "worktree removed before terminal notice");
  git("merge", "-q", `worq/${exec.ref}`);
  assert.equal(await readFile(join(root, "app.py"), "utf8"), "print('HELLO')\n");
});

test("execute with verify:false: no reviewer runs and the digest says the diff is unread", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const texts: string[] = [];
  const { worq, next, seen } = setup(root, state, {
    "agent.execute": async (turn) => {
      texts.push(turn.text);
      await turn.tool("write_file", { path: "app.py", content: "print('HELLO')\n" });
      await turn.tool("submit", { summary: "Uppercased", changes: ["app.py"], checksRun: ["cat app.py"] });
    },
  });
  const exec = await worq.spawn("execute", "Uppercase the greeting", { title: "Uppercase the greeting", verify: false, mode: "fast" });
  const ready = await next("review-ready", exec.ref);
  assert.match(texts[0], /"verify": false/);
  assert.equal(seen.filter((s) => s.name.startsWith("reviewer.")).length, 0, "no reviewer ran");
  assert.match(ready.text, /No reviewers ran: this result is unverified/);
  assert.match(ready.text, /review-ready · unverified/);
  assert.match(worq.list(exec.ref), /Reviews: unverified/);
  assert.match(exec.diffstat!, /app\.py/);
  await worq.cancel(exec.ref);
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
    reviewer: (turn) => turn.tool("report", pass).then(() => {}),
  }, { agentTurns: 1 });
  const agent = await worq.spawn("plan", "Change the greeting case", { title: "Change the greeting" });
  const ask = await next("ask", agent.ref);
  assert.match(ask.text, /Title case or upper case\?/);
  assert.equal(agent.state, "waiting");
  assert.match(worq.list(), /asks: Title case/);
  assert.match(worq.send(agent.ref, "upper"), /Answered/);
  await next("review-ready", agent.ref);
  assert.equal(answer, "Main: upper");
});

test("limits, refusals and failures", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.text.includes('"task"') || turn.text.includes("another round") ? turn.tool("submit", planSubmission).then(() => {}) : undefined,
    "agent.execute": () => {},
    "reviewer.pair": () => { throw new Error("reviewer crashed"); },
    reviewer: (turn) => turn.tool("report", pass).then(() => {}),
  }, { rounds: 1, agents: 2 });
  const a = await worq.spawn("plan", "One", { title: "One plan" });
  const ready = await next("review-ready", a.ref);
  assert.match(ready.text, /review-ready · unresolved review issues/);
  assert.throws(() => worq.send(a.ref, "/finalize {}"), /complete planning batch/);
  assert.match(ready.text, /pair: unknown \(Reviewer error: reviewer crashed\)/);
  assert.match(worq.list(a.ref), /Reviews: unresolved review issues/);
  assert.throws(() => worq.send(a.ref, "again"), /review-ready/);
  await assert.rejects(worq.spawn("plan", "Needs plan", { title: "Needs plan", attach: ["ffff"] }), /exact plan name/);
  await assert.rejects(worq.spawn("review", "x", { title: "Review work" }), /Unknown kind/);

  // Dirty baseline rejects execute at admission.
  await writeFile(join(root, "app.py"), "dirty\n");
  await assert.rejects(worq.spawn("execute", "Do it", { title: "Do it" }), /Commit or stash/);
  execFileSync("git", ["checkout", "app.py"], { cwd: root });

  // Agent that never submits: nudged once, then fails without leaving a worktree.
  const c = await worq.spawn("execute", "Do nothing", { title: "Do nothing" });
  await next("failed", c.ref);
  assert.match(c.error!, /ended without calling submit/);
  const failedText = (await next("failed", c.ref)).text;
  assert.match(failedText, /Last activity:\n/);
  assert.equal(c.work, undefined);
  await worq.cancel(a.ref);
  const d = await worq.spawn("plan", "Two", { title: "Two plan" });
  const e = await worq.spawn("plan", "Three", { title: "Three plan" });
  await worq.cancel("all");
  assert.ok([d, e].every((x) => x.ended));
});

test("fast plans use a focused reviewer and fall back to the configured roster", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompts = loadPrompts();
  const { worq, next, seen } = setup(root, state, {
    "agent.plan": turn => turn.tool("submit", planSubmission).then(() => {}),
    reviewer: turn => turn.tool("report", pass).then(() => {}),
  }, {}, undefined, {
    ...prompts,
    reviewers: kind => prompts.reviewers(kind).filter(r => r.name !== "subtraction"),
  });
  const fallback = await worq.spawn("plan", "Fallback plan", { title: "Fallback plan", mode: "fast" });
  await next("review-ready", fallback.ref);
  assert.deepEqual(fallback.reviews.map(r => r.name), ["decision", "defeater", "pair"]);
  assert.match(worq.list(fallback.ref), /review: kind roster/);
  assert.ok(seen.filter(s => s.name.startsWith("reviewer.")).every(s => !s.system.includes("only reviewer on this fast plan")));
  await worq.cancel(fallback.ref);

  const failed = setup(root, state, {
    "agent.plan": turn => turn.tool("submit", planSubmission).then(() => {}),
    "reviewer.subtraction": () => { throw new Error("reviewer failed"); },
  });
  const agent = await failed.worq.spawn("plan", "Focused reviewer fails", { title: "Focused reviewer fails", mode: "fast" });
  const notice = await failed.next("review-ready", agent.ref);
  assert.match(notice.text, /subtraction: unknown \(Reviewer error: reviewer failed\)/);
  assert.match(notice.text, /unresolved review issues/);
  assert.deepEqual(agent.reviews.map(r => r.name), ["subtraction"]);
  await failed.worq.cancel(agent.ref);
});

test("run turn checkpoints share the full roster budget", async (t) => {
  for (const approve of [false, true]) {
    const { dir, root, state } = await repo();
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { worq, next } = setup(root, state, {
      "agent.plan": async turn => { assert.match(turn.text, /"route": "thorough"/); await gate; await turn.tool("submit", planSubmission); },
      reviewer: turn => turn.tool("report", pass).then(() => {}),
    }, { checkpointSeconds: 1, runTurns: 1, continuationTurns: 4 });
    const agent = await worq.spawn("plan", "plan it", { title: "plan it", mode: "thorough" });
    assert.match((await next("checkpoint", agent.ref)).text, /4 available for explicit approval/);
    assert.throws(() => worq.send(agent.ref, "/continue 5"));
    release();
    assert.match((await next("checkpoint", agent.ref, 2)).text, /No turns left.*within 1s/);
    if (approve) {
      worq.send(agent.ref, "/continue 4");
      await next("review-ready", agent.ref);
      assert.equal(agent.reviews.length, 4);
      assert.match((await next("warning", agent.ref)).text, /no additional turns can be granted/);
      await worq.cancel(agent.ref);
    } else assert.match((await next("failed", agent.ref)).text, /Cumulative turn allowance exhausted/);
  }
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
  assert.equal(await readFile(join(agent.work!, "unfinished"), "utf8"), "recover me");
  assert.match(worq.list(agent.ref), /Worktree retained/);
});


for (const runTurns of [1, 2]) test(`worker preserves planner text with ${runTurns - 1} shared turns remaining`, async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const { worq, events } = setup(root, state, {
    "agent.plan": (turn) => {
      requests++;
      turn.spec.emit({ type: "text", text: "Observed greeting in app.py", completed: true });
      turn.spec.emit({ type: "text", text: " ", completed: true });
    },
  }, { agentTurns: 1, runTurns });
  const agent = await worq.spawn("plan", "Inspect greeting", { title: "Inspect greeting" });
  await agent.done;
  assert.equal(agent.state, "handed-off");
  assert.equal(requests, 1);
  assert.equal(agent.view().budget.spent, 1);
  assert.equal(agent.plan, undefined);
  assert.equal(events.filter(e => e.type === "handed-off").length, 1);
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.equal(handoff.unreviewed.ordinary, "Observed greeting in app.py");
  assert.match(worq.list(agent.ref), /Unreviewed handoff:/);
});

test("eligible closeout debits one turn, fences tools, and retains ignored execute output", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const { worq } = setup(root, state, {
    "agent.execute": async (turn) => {
      if (++requests === 1) {
        await writeFile(join(turn.spec.cwd, "app.py"), "updated");
        await writeFile(join(turn.spec.cwd, "new.txt"), "new");
        await mkdir(join(turn.spec.cwd, ".agents"), { recursive: true });
        await writeFile(join(turn.spec.cwd, ".agents", "ignored.txt"), "ignored");
        turn.spec.emit({ type: "text", text: "Ordinary evidence", completed: true });
      } else {
        assert.match(turn.text, /Do not use tools/);
        assert.match(await turn.tool("read_file", { path: "app.py" }), /Tool dispatch is closed/);
        turn.spec.emit({ type: "text", text: "Closeout evidence", completed: true });
      }
    },
  }, { agentTurns: 1, runTurns: 3 });
  const agent = await worq.spawn("execute", "Edit greeting", { title: "Edit greeting" });
  await agent.done;
  assert.equal(agent.state, "handed-off");
  assert.equal(requests, 2);
  assert.equal(agent.view().budget.spent, 2);
  assert.equal(agent.candidate, undefined);
  assert.equal(await readFile(join(agent.work!, ".agents", "ignored.txt"), "utf8"), "ignored");
  assert.equal(git("show", `${agent.handoff!.partial}:app.py`).toString(), "updated");
  assert.equal(git("show", `${agent.handoff!.partial}:new.txt`).toString(), "new");
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.equal(handoff.unreviewed.ordinary, "Ordinary evidence");
  assert.equal(handoff.unreviewed.closeout, "Closeout evidence");
});


test("final ordinary ask uses its own deadline and records an unresolved question", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let asked!: () => void;
  const parked = new Promise<void>(resolve => { asked = resolve; });
  let requests = 0;
  let answer = "";
  const { worq } = setup(root, state, {
    "agent.plan": async (turn) => {
      requests++;
      const pending = turn.tool("ask_main", { question: "Which API is authorized?" });
      asked();
      answer = await pending;
    },
  }, { agentTurns: 1, runTurns: 2, askMinutes: 2 });
  const agent = await worq.spawn("plan", "Check authorization", { title: "Check authorization" });
  await parked;
  t.mock.timers.tick(119_999);
  assert.equal(agent.state, "waiting");
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await agent.done;
  assert.match(answer, /did not answer in time/);
  assert.equal(agent.state, "handed-off");
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.equal(handoff.unreviewed.unresolvedQuestion, "Which API is authorized?");
});

test("automatic over-cap turn fences tools and skips model closeout", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const { worq } = setup(root, state, {
    "agent.plan": async (turn) => {
      requests++;
      if (requests === 1) {
        turn.spec.emit({ type: "text", text: "Kept ordinary text", completed: true });
        turn.steered.push("automatic continuation");
      } else {
        turn.spec.emit({ type: "text", text: "Discarded late text", completed: true });
        assert.match(await turn.tool("submit", planSubmission), /Tool dispatch is closed/);
      }
    },
  }, { agentTurns: 1, runTurns: 5 });
  const agent = await worq.spawn("plan", "Test automatic turn accounting", { title: "Test automatic turn accounting" });
  await agent.done;
  assert.equal(agent.state, "handed-off");
  assert.equal(requests, 2);
  assert.equal(agent.view().budget.spent, 1);
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.equal(handoff.trigger, "automatic turn admission");
  assert.equal(handoff.unreviewed.ordinary, "Kept ordinary text");
});


test("closeout timeout falls back to ordinary evidence and fences late callbacks", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const { worq, events } = setup(root, state, {
    "agent.plan": async (turn) => {
      if (++requests === 1) turn.spec.emit({ type: "text", text: "Ordinary result", completed: true });
      else {
        start();
        await blocked;
        turn.spec.emit({ type: "text", text: "Late closeout", completed: true });
      }
    },
  }, { agentTurns: 1, runTurns: 3 });
  const agent = await worq.spawn("plan", "Inspect greeting", { title: "Inspect greeting" });
  await started;
  t.mock.timers.tick(15_000);
  await agent.done;
  release();
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.equal(handoff.unreviewed.ordinary, "Ordinary result");
  assert.equal(handoff.unreviewed.closeout, undefined);
  assert.equal(events.filter(e => e.type === "handed-off").length, 1);
});

test("handoff artifact write failure publishes inline evidence once", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, events } = setup(root, state, {
    "agent.plan": async (turn) => {
      const agent = worq.all()[0];
      await mkdir(join(state, agent.ref, "handoff-1.json.tmp"));
      turn.spec.emit({ type: "text", text: "Recoverable text", completed: true });
    },
  }, { agentTurns: 1, runTurns: 2 });
  const agent = await worq.spawn("plan", "Inspect greeting", { title: "Inspect greeting" });
  await agent.done;
  assert.equal(agent.state, "handed-off");
  assert.ok(agent.finished);
  assert.equal(agent.handoff?.path, undefined);
  const notices = events.filter(e => e.type === "handed-off");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Handoff write failed:[\s\S]*Recoverable text/);
});


test("an open PQ blocks optional closeout with exactly two shared turns left", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let entered!: () => void;
  let unblock!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let workerRequests = 0;
  const { worq } = setup(root, state, {
    "agent.plan": async (turn) => {
      workerRequests++;
      await turn.tool("delegate", { question: "What does app.py print?", why: "Check evidence" });
      await started;
      await turn.tool("delegate", { question: "Which test covers the greeting?", why: "Check coverage" });
    },
    subagent: async () => { entered(); await blocked; },
  }, { agentTurns: 1, runTurns: 4, parallel: 1 });
  const agent = await worq.spawn("plan", "Inspect greeting", { title: "Inspect greeting" });
  await agent.done;
  unblock();
  assert.equal(agent.state, "handed-off");
  assert.equal(workerRequests, 1);
  assert.equal(agent.view().budget.spent, 2);
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.deepEqual(handoff.unreviewed.openPqs.map(({ question }: { question: string }) => question), [
    "What does app.py print?", "Which test covers the greeting?",
  ]);
  assert.deepEqual(agent.view().delegations.map(({ state }) => state), ["cancelled", "cancelled"]);
});


test("cleanup preserves a changed recovery SHA without extending verification", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let worker: string;
  const shas = new Set<string>();
  const { worq, next } = setup(root, state, {
    "agent.execute": async (turn) => {
      worker = turn.spec.cwd;
      await writeFile(join(worker, "app.py"), "reviewed");
      await turn.tool("submit", { summary: "First candidate" });
    },
    reviewer: async (turn) => {
      shas.add(execFileSync("git", ["rev-parse", "HEAD"], { cwd: turn.spec.cwd, encoding: "utf8" }).trim());
      await writeFile(join(worker, "app.py"), "unreviewed recovery");
      await turn.tool("report", pass);
    },
  });
  const agent = await worq.spawn("execute", "Change greeting", { title: "Change greeting" });
  const ready = await next("review-ready", agent.ref);
  assert.deepEqual([...shas], [agent.candidate]);
  assert.notEqual(agent.recoverySha, agent.candidate);
  assert.equal(git("rev-parse", agent.branch!).toString().trim(), agent.recoverySha);
  assert.match(ready.text, new RegExp(`Recovery SHA ${agent.recoverySha}: UNVERIFIED / not merge-ready`));
  assert.throws(() => worq.send(agent.ref, "Try again"), /review-ready/);
});

test("caller cancellation during closeout remains cancellation", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const { worq, events } = setup(root, state, {
    "agent.plan": async (turn) => {
      if (!turn.text.startsWith("{")) { enter(); await blocked; }
    },
  }, { agentTurns: 1, runTurns: 3 });
  const agent = await worq.spawn("plan", "Test cancellation", { title: "Test cancellation" });
  await started;
  await worq.cancel(agent.ref);
  release();
  assert.equal(agent.state, "cancelled");
  assert.equal(agent.handoff, undefined);
  assert.ok(!events.some(e => e.type === "handed-off"));
});
