import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pass, planSubmission, repo, setup, type Turn } from "./fake.ts";

const finding = { witness: "Criterion D1 ignores trailing newline", basis: "observed app.py:1", consequence: "output mismatch", change: "state the newline" };

test("plan agent: PQ delegation, plan saved to .agents/plans, parallel plan reviewers, Main rounds, close", async (t) => {
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
        assert.match(await turn.tool("delegate", { name: "evidence", question: "Where is the greeting printed?", why: "decides the edit" }), /Delegated d1/);
        assert.match(await turn.tool("submit", planSubmission), /still open/);
        return; // end turn: wait for the PQ
      }
      if (turn.text.startsWith("[PQ d1]")) { await turn.tool("submit", planSubmission); return; }
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
  const agent = await worq.spawn("plan", "Uppercase the greeting");
  assert.match(agent.ref, /^[0-9a-f]{4}$/);
  const ready = await next("review-ready", agent.ref);
  assert.equal(agent.state, "review-ready");
  assert.deepEqual(reviewers.sort(), ["reviewer.decision", "reviewer.defeater", "reviewer.pair", "reviewer.subtraction"]);
  assert.match(ready.text, /defeater: fail/);
  assert.match(ready.text, /defeater-1: Criterion D1 ignores trailing newline/);
  assert.match(ready.text, /worq_send/);
  assert.match(ready.text, /Ready → fold what you accept into the execute task/);
  assert.match(ready.text, /only when a finding changes the plan's criteria or scope/);
  assert.ok(agent.plan);
  assert.match(agent.plan.path, new RegExp(`^\\.agents/plans/${agent.ref}-uppercase-the-greeting\\.md$`));
  const saved = await readFile(join(root, agent.plan.path), "utf8");
  assert.match(saved, /## Decisions[\s\S]*D1/);
  assert.match(saved, /## Thought tree/);
  assert.ok(!agentTexts[0].includes('"verify"'), "read kinds carry no verify key");
  assert.equal(agent.delegations[0].state, "answered");
  assert.ok(agentTexts.some((x) => x.includes("Answer (observed): app.py:1")));
  assert.equal(seen.find((s) => s.name === "agent.plan")?.profile, "agent");

  assert.match(worq.send(agent.ref, "Accept defeater-1: state the newline"), /Round 2 started/);
  await next("review-ready", agent.ref, 2);
  assert.equal(agent.round, 2);
  assert.match(await readFile(join(root, agent.plan.path), "utf8"), /Revised: include newline/);
  assert.match(worq.list(), new RegExp(`${agent.ref} · plan · review-ready · round 2`));
  assert.match(worq.list(agent.ref), /PQs:[\s\S]*Reviews:/);

  assert.match(await worq.cancel(agent.ref), /closed/);
  assert.equal(agent.state, "closed");
  assert.throws(() => worq.send(agent.ref, "more"), /closed/);
  const record = JSON.parse(await readFile(join(state, agent.id, "record.json"), "utf8"));
  assert.equal(record.state, "closed");
});

test("execute agent: @plan attached, own worktree and branch, verifier sees pinned commit, Main merges by hand", async (t) => {
  const { dir, root, state, git } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let verifierSaw = "";
  let attached = "";
  const { worq, next } = setup(root, state, {
    "agent.plan": (turn) => turn.tool("submit", planSubmission).then(() => {}),
    "agent.execute": async (turn) => {
      attached = turn.text;
      assert.match(await turn.tool("write_file", { path: "app.py", content: "print('HELLO')\n" }), /Wrote/);
      assert.match(await turn.tool("run_command", { executable: "/usr/bin/cat", args: ["app.py"] }), /HELLO/);
      await turn.tool("submit", { summary: "Uppercased", changes: ["app.py"] });
    },
    "reviewer.intent": async (turn) => {
      const { commit } = JSON.parse(turn.text) as { commit: string };
      assert.match(commit, /^[0-9a-f]{40}$/);
      verifierSaw = await turn.tool("run_command", { executable: "/usr/bin/cat", args: ["app.py"] });
      await turn.tool("report", pass);
    },
    reviewer: (turn) => turn.tool("report", pass).then(() => {}),
  });
  const plan = await worq.spawn("plan", "Uppercase the greeting");
  await next("review-ready", plan.ref);
  const exec = await worq.spawn("execute", `Implement @${plan.ref}`);
  assert.deepEqual(exec.attachments.map((a) => a.ref), [plan.ref]);
  const ready = await next("review-ready", exec.ref);
  assert.match(attached, /Change the greeting to uppercase/);
  assert.match(attached, /"verify": true/);
  assert.match(verifierSaw, /HELLO/);
  assert.match(ready.text, /intent: pass/);
  assert.match(ready.text, new RegExp(`merge worq/${exec.ref} by hand`));
  assert.equal(await readFile(join(root, "app.py"), "utf8"), "print('hello')\n", "baseline untouched: Worq never merges");
  const work = exec.work!;
  assert.ok(existsSync(work));
  await worq.cancel(exec.ref);
  assert.equal(exec.state, "closed");
  assert.ok(!existsSync(work), "worktree removed");
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
  const exec = await worq.spawn("execute", "Uppercase the greeting", false);
  const ready = await next("review-ready", exec.ref);
  assert.match(texts[0], /"verify": false/);
  assert.equal(seen.filter((s) => s.profile === "reviewer").length, 0, "no reviewer ran");
  assert.match(ready.text, /No reviewers ran: this result is unverified/);
  assert.match(ready.text, /No verifier ran: read git diff/);
  assert.doesNotMatch(ready.text, /Adjudicate each finding/);
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
  });
  const agent = await worq.spawn("plan", "Change the greeting case");
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
  const a = await worq.spawn("plan", "One");
  const ready = await next("review-ready", a.ref);
  assert.match(ready.text, /pair: unknown \(reviewer crashed\)/);
  assert.throws(() => worq.send(a.ref, "again"), /used its 1 rounds/);
  await assert.rejects(worq.spawn("plan", "Needs @ffff"), /names no agent/);
  await assert.rejects(worq.spawn("review", "x"), /Unknown kind/);

  // Dirty baseline blocks an execute agent; it fails and Main is told.
  await writeFile(join(root, "app.py"), "dirty\n");
  const b = await worq.spawn("execute", "Do it");
  const failed = await next("failed", b.ref);
  assert.match(failed.text, /Commit or stash/);
  execFileSync("git", ["checkout", "app.py"], { cwd: root });

  // Agent that never submits: nudged once, then fails without leaving a worktree.
  const c = await worq.spawn("execute", "Do nothing");
  await next("failed", c.ref);
  assert.match(c.error!, /ended without calling submit/);
  const failedText = (await next("failed", c.ref)).text;
  assert.match(failedText, /Last activity:\n/);
  assert.equal(c.work, undefined);
  await worq.cancel(a.ref);
  const d = await worq.spawn("plan", "Two");
  const e = await worq.spawn("plan", "Three");
  await assert.rejects(worq.spawn("plan", "Four"), /at-capacity|agents are live/);
  await worq.cancel("all");
  assert.ok([d, e].every((x) => x.ended));
});

test("run turn checkpoints share the roster budget; fast does not skip reviewers", async (t) => {
  for (const approve of [false, true]) {
    const { dir, root, state } = await repo();
    t.after(() => rm(dir, { recursive: true, force: true }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { worq, next } = setup(root, state, {
      "agent.plan": async turn => { assert.match(turn.text, /"route": "fast"/); await gate; await turn.tool("submit", planSubmission); },
      reviewer: turn => turn.tool("report", pass).then(() => {}),
    }, { checkpointSeconds: 1, runTurns: 1, continuationTurns: 4 });
    const agent = await worq.spawn("plan", "plan it", true, "fast");
    await next("checkpoint", agent.ref);
    assert.throws(() => worq.send(agent.ref, "/continue 5"));
    release();
    if (approve) { await next("checkpoint", agent.ref, 2); worq.send(agent.ref, "/continue 4"); }
    if (approve) { await next("review-ready", agent.ref); assert.equal(agent.reviews.length, 4); await worq.cancel(agent.ref); }
    else assert.match((await next("failed", agent.ref)).text, /Cumulative turn allowance exhausted/);
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
  const agent = await worq.spawn("execute", "recoverable work");
  await next("ask", agent.ref); await worq.cancel(agent.ref);
  assert.equal(await readFile(join(agent.work!, "unfinished"), "utf8"), "recover me");
  assert.match(worq.list(agent.ref), /Worktree retained/);
});
