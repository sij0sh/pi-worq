import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { KINDS, pass, planSubmission, repo, setup } from "./fake.ts";

for (const reviewed of [true, false]) test(`headless plan and execute (review ${reviewed ? "configured" : "absent"})`, async (t) => {
  const { dir, root, state } = await repo();
  const kinds = new Map(KINDS);
  if (!reviewed) for (const name of ["plan", "execute"]) kinds.set(name, { ...kinds.get(name)!, review: undefined });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const reviewHeads: string[] = [];
  const { worq, next, seen } = setup(root, state, {
    "agent.plan": async turn => { await turn.tool("submit", planSubmission); },
    "agent.execute": async turn => {
      turn.spec.emit({ type: "response-start" });
      await sleep(15);
      turn.spec.emit({ type: "response", completed: true });
      if (reviewed) turn.spec.emit({ type: "telemetry", value: { cache: { read: 9, write: 1, input: 2 } } });
      const final = turn.text.startsWith("Main:");
      if (!final) {
        assert.equal(JSON.parse(turn.text).attachments.length, 1);
        await turn.tool("ask_main", { question: "Which greeting?" });
      }
      await turn.tool("write_file", { path: "app.py", content: `print('${final ? "FINAL" : "FIRST"}')\n` });
      await turn.tool("submit", { summary: "Updated the greeting" });
    },
    review: async turn => {
      const { commit } = JSON.parse(turn.text);
      if (commit) { assert.equal(git(turn.spec.cwd, "rev-parse", "HEAD"), commit); reviewHeads.push(commit); }
      await turn.tool("submit", pass);
    },
  }, {}, undefined, kinds);
  t.after(async () => { await worq.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const plan = await worq.spawn("plan", "Plan a greeting", { title: "Plan the greeting" });
  const planResult = await next(reviewed ? "parked" : "done", plan.ref);
  if (reviewed) {
    assert.match(planResult.text, /review passed/);
    await worq.cancel(plan.ref);
    assert.equal(plan.state, "closed");
  } else assert.doesNotMatch(planResult.text, /unverified|review/i);
  const writer = await worq.spawn("execute", "Implement the plan", {
    title: "Implement greeting", attach: [plan.ref], writePaths: ["app.py"],
    gates: [{ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 30)"] }],
  });
  await next("ask", writer.ref);
  await sleep(15);
  worq.send(writer.ref, "Use the uppercase greeting");
  if (reviewed) {
    await next("parked", writer.ref);
    await sleep(15);
    worq.send(writer.ref, "Use the final greeting");
  }
  const result = await next("done", writer.ref);
  const record = JSON.parse(await readFile(join(state, writer.ref, "record.json"), "utf8"));
  const timing = record.timings;
  assert.ok(timing.startedAt <= timing.firstTurnAt && timing.firstTurnAt <= timing.submittedAt);
  assert.equal(timing.finishedAt, record.finished);
  assert.equal(timing.turns, reviewed ? 2 : 1);
  assert.equal(timing.toolCalls, reviewed ? 5 : 3);
  assert.ok(timing.activeModelMs >= 10 && timing.gateMs >= 25 && timing.waitMainMs >= 10);
  assert.ok(Math.abs(timing.workMs - timing.workModelMs - timing.workToolMs - timing.activeGateMs) <= 2);
  const detail = worq.list(writer.ref);
  assert.match(detail, /Timing: .*model.*tools.*gates.*waiting for Main/);
  if (reviewed) {
    assert.equal(seen.filter(s => s.name === "review").length, 2);
    assert.deepEqual(reviewHeads, [record.reviewedSha]);
    assert.notEqual(record.reviewedSha, record.candidate);
    const range = `${record.reviewedSha}..${record.candidate}`;
    assert.match(git(root, "diff", range), /-print\('FIRST'\)[\s\S]*\+print\('FINAL'\)/);
    assert.ok(result.text.includes(`git diff ${range}`));
    assert.ok(detail.includes(`git diff ${range}`));
    assert.ok(timing.submittedAt <= timing.reviewStartedAt && timing.reviewFinishedAt <= timing.parkedAt);
    assert.ok(timing.parkedAt < timing.resumedAt && timing.resumedAt <= timing.finishedAt);
    assert.ok(timing.parkedMs >= 10);
    assert.deepEqual(timing.cache, { responses: 2, read: 18, write: 2, input: 4, completeResponses: 2 });
    assert.match(detail, /75% cache/);
  } else {
    assert.equal(seen.filter(s => s.name === "review").length, 0);
    assert.equal(timing.reviewStartedAt, undefined);
    assert.equal(record.reviewedSha, undefined);
    assert.match(detail, /cache unavailable/);
    assert.doesNotMatch(result.text, /unverified|review/i);
  }
});
