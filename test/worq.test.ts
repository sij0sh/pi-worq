import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadPrompts } from "../src/prompts.ts";
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
  assert.match(ready.text, /review-ready · unresolved review issues/);
  assert.match(ready.text, /does not authorize further action/);
  assert.doesNotMatch(ready.text, /worq_spawn|worq_send|git merge/);
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
  assert.match((await next("review-ready", agent.ref, 2)).text, /unresolved review issues/, "a repair attempt does not clear a repeated finding");
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
  const agent = await worq.spawn("plan", "What does the app print? Cite source.");
  const ready = await next("review-ready", agent.ref);
  assert.match(ready.text, /unresolved review issues/);
  assert.match(worq.list(agent.ref), /defeater-1: app.py:1 prints hello, not goodbye/);
  const saved = await readFile(join(root, agent.plan!.path), "utf8");
  assert.match(saved, /## Summary\n\nThe app prints goodbye \(app.py:1\)\./);
  assert.doesNotMatch(saved, /## (Criteria|Decisions|Thought tree)/);
  await worq.cancel(agent.ref);
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
  const plan = await worq.spawn("plan", "Uppercase the greeting");
  await next("review-ready", plan.ref);
  const exec = await worq.spawn("execute", `Implement @${plan.ref}`, true, "fast");
  assert.deepEqual(exec.attachments.map((a) => a.ref), [plan.ref]);
  const ready = await next("review-ready", exec.ref);
  assert.match(attached, /Change the greeting to uppercase/);
  assert.match(attached, /"verify": true/);
  assert.match(verifierSaw, /HELLO/);
  assert.match(ready.text, /intent: pass/);
  assert.match(ready.text, /review-ready · no review issues reported/);
  assert.match(ready.text, new RegExp(`Branch worq/${exec.ref}`));
  assert.doesNotMatch(ready.text, /git merge|worq_spawn|worq_send/);
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
  const exec = await worq.spawn("execute", "Uppercase the greeting", false, "fast");
  const ready = await next("review-ready", exec.ref);
  assert.match(texts[0], /"verify": false/);
  assert.equal(seen.filter((s) => s.profile === "reviewer").length, 0, "no reviewer ran");
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
  assert.match(ready.text, /review-ready · unresolved review issues/);
  assert.match(ready.text, /pair: unknown \(reviewer crashed\)/);
  assert.match(worq.list(a.ref), /Reviews: unresolved review issues/);
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
  const fallback = await worq.spawn("plan", "Fallback plan", true, "fast");
  await next("review-ready", fallback.ref);
  assert.deepEqual(fallback.reviews.map(r => r.name), ["decision", "defeater", "pair"]);
  assert.match(worq.list(fallback.ref), /review: kind roster/);
  assert.ok(seen.filter(s => s.profile === "reviewer").every(s => !s.system.includes("only reviewer on this fast plan")));
  await worq.cancel(fallback.ref);

  const failed = setup(root, state, {
    "agent.plan": turn => turn.tool("submit", planSubmission).then(() => {}),
    "reviewer.subtraction": () => { throw new Error("reviewer failed"); },
  });
  const agent = await failed.worq.spawn("plan", "Focused reviewer fails", true, "fast");
  const notice = await failed.next("review-ready", agent.ref);
  assert.match(notice.text, /subtraction: unknown \(reviewer failed\)/);
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
    const agent = await worq.spawn("plan", "plan it", true, "thorough");
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
  const agent = await worq.spawn("execute", "recoverable work");
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
      turn.spec.completedText?.("Observed greeting in app.py");
      turn.spec.completedText?.(" ");
    },
  }, { agentTurns: 1, runTurns });
  const agent = await worq.spawn("plan", "Inspect greeting");
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
        turn.spec.completedText?.("Ordinary evidence");
      } else {
        assert.match(turn.text, /Do not use tools/);
        assert.match(await turn.tool("read_file", { path: "app.py" }), /Tool dispatch is closed/);
        turn.spec.completedText?.("Closeout evidence");
      }
    },
  }, { agentTurns: 1, runTurns: 3 });
  const agent = await worq.spawn("execute", "Edit greeting");
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
  const agent = await worq.spawn("plan", "Check authorization");
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
        turn.spec.completedText?.("Kept ordinary text");
        turn.steered.push("automatic continuation");
      } else {
        turn.spec.completedText?.("Discarded late text");
        assert.match(await turn.tool("submit", planSubmission), /Tool dispatch is closed/);
      }
    },
  }, { agentTurns: 1, runTurns: 5 });
  const agent = await worq.spawn("plan", "Test automatic turn accounting");
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
      if (++requests === 1) turn.spec.completedText?.("Ordinary result");
      else {
        start();
        await blocked;
        turn.spec.completedText?.("Late closeout");
      }
    },
  }, { agentTurns: 1, runTurns: 3 });
  const agent = await worq.spawn("plan", "Inspect greeting");
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
      await mkdir(join(state, agent.id, "handoff-1.json.tmp"));
      turn.spec.completedText?.("Recoverable text");
    },
  }, { agentTurns: 1, runTurns: 2 });
  const agent = await worq.spawn("plan", "Inspect greeting");
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
    },
    subagent: async () => { entered(); await blocked; },
  }, { agentTurns: 1, runTurns: 4 });
  const agent = await worq.spawn("plan", "Inspect greeting");
  await agent.done;
  unblock();
  assert.equal(agent.state, "handed-off");
  assert.equal(workerRequests, 1);
  assert.equal(agent.view().budget.spent, 2);
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.equal(handoff.unreviewed.openPqs[0].id, "d1");
});


test("a later handoff keeps the prior reviewed SHA separate from partial work", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next } = setup(root, state, {
    "agent.execute": async (turn) => {
      if (turn.text.startsWith("{")) {
        await writeFile(join(turn.spec.cwd, "app.py"), "reviewed");
        await turn.tool("submit", { summary: "First candidate" });
      } else if (turn.text.startsWith("Main reviewed")) {
        await writeFile(join(turn.spec.cwd, "app.py"), "partial");
      }
    },
    reviewer: async (turn) => { await turn.tool("report", pass); },
  }, { agentTurns: 2 });
  const agent = await worq.spawn("execute", "Change greeting");
  await next("review-ready", agent.ref);
  const prior = agent.candidate;
  assert.ok(prior);
  worq.send(agent.ref, "Refine the greeting");
  await agent.done;
  assert.equal(agent.state, "handed-off");
  assert.equal(agent.candidate, prior);
  assert.notEqual(agent.handoff?.partial, prior);
  const handoff = JSON.parse(await readFile(agent.handoff!.path!, "utf8"));
  assert.equal(handoff.priorReview.candidate, prior);
  assert.equal(handoff.unreviewed.partialCommit, agent.handoff?.partial);
  assert.ok(handoff.priorReview.reviews.length);
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
  const agent = await worq.spawn("plan", "Test cancellation");
  await started;
  await worq.cancel(agent.ref);
  release();
  assert.equal(agent.state, "cancelled");
  assert.equal(agent.handoff, undefined);
  assert.ok(!events.some(e => e.type === "handed-off"));
});
