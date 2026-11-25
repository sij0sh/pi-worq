import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createWorq } from "../index.ts";
import { dispatch, ops } from "../src/control.ts";
import { fakeDriver, pass, planSubmission, repo, setup } from "./fake.ts";

test("barrier: early-completion race with expect: 3 emits wake:false members and one barrier wake", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, events, next } = setup(root, state, {
    "agent.scout": async (turn) => {
      const task = JSON.parse(turn.text).task as string;
      await turn.tool("submit", { summary: `Answer for ${task}` });
    },
  });

  // Launch scout 1 and let it finish completely before launching scouts 2 and 3.
  const s1 = await worq.spawn("scout", "Area one", { title: "Area one", group: "recon", notify: "barrier", expect: 3 });
  await next("done", s1.ref);
  assert.equal(events.filter((e) => e.type === "barrier").length, 0, "must not settle before expect: 3");

  const s2 = await worq.spawn("scout", "Area two", { title: "Area two", group: "recon", notify: "barrier", expect: 3 });
  await next("done", s2.ref);
  assert.equal(events.filter((e) => e.type === "barrier").length, 0, "still waiting for 3rd member");

  const s3 = await worq.spawn("scout", "Area three", { title: "Area three", group: "recon", notify: "barrier", expect: 3 });
  const barrier = await next("barrier", "group:recon");
  await new Promise((r) => setTimeout(r, 30));

  const memberDones = events.filter((e) => e.type === "done");
  assert.equal(memberDones.length, 3);
  assert.ok(memberDones.every((e) => e.wake === false && e.group === "recon"));
  assert.equal(events.filter((e) => e.type === "barrier").length, 1);
  assert.equal(barrier.wake, true);
  assert.equal(barrier.group, "recon");
  assert.match(barrier.text, /Group recon settled · 3 members \(expect 3\) \(3 done\)/);
  assert.match(barrier.text, new RegExp(s1.ref));
  assert.match(barrier.text, new RegExp(s2.ref));
  assert.match(barrier.text, new RegExp(s3.ref));
  assert.match(worq.list(undefined, "recon"), /Group recon \(barrier\) · 3\/3 members · settled/);
  await worq.cancel("all");
});

test("barrier: partial failure and dock cancel ranks failure first; cancelling all suppresses barrier", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let holdStarted!: () => void;
  const holding = new Promise<void>((resolve) => { holdStarted = resolve; });

  const { worq, events, next } = setup(root, state, {
    "agent.scout": async (turn) => {
      const task = JSON.parse(turn.text).task as string;
      if (task === "fail") throw new Error("boom failure");
      if (task === "hold") { holdStarted(); await new Promise(() => {}); }
      await turn.tool("submit", { summary: "ok result" });
    },
  });

  const a = await worq.spawn("scout", "ok", { title: "Ok scout", group: "mixed", notify: "barrier", expect: 3 });
  const b = await worq.spawn("scout", "fail", { title: "Fail scout", group: "mixed", notify: "barrier", expect: 3 });
  const c = await worq.spawn("scout", "hold", { title: "Hold scout", group: "mixed", notify: "barrier", expect: 3 });
  await next("done", a.ref);
  await next("failed", b.ref);
  await holding;
  await c.cancel();

  const barrier = await next("barrier", "group:mixed");
  assert.equal(events.filter((e) => e.type === "barrier" && e.group === "mixed").length, 1);
  const failedIdx = barrier.text.indexOf(`[failed] ${b.ref}`);
  const doneIdx = barrier.text.indexOf(`[done] ${a.ref}`);
  const cancelledIdx = barrier.text.indexOf(`[cancelled] ${c.ref}`);
  assert.ok(failedIdx !== -1 && doneIdx !== -1 && cancelledIdx !== -1);
  assert.ok(failedIdx < doneIdx && doneIdx < cancelledIdx, "failed ranked before done and cancelled");

  // Now launch a 3-member group and cancel all of them via group:<id>.
  const h1 = await worq.spawn("scout", "hold", { title: "Cancel one", group: "abort-me", notify: "barrier", expect: 3 });
  const h2 = await worq.spawn("scout", "hold", { title: "Cancel two", group: "abort-me", notify: "barrier", expect: 3 });
  const h3 = await worq.spawn("scout", "hold", { title: "Cancel three", group: "abort-me", notify: "barrier", expect: 3 });
  const stopMsg = await worq.cancel("group:abort-me");
  assert.match(stopMsg, new RegExp(h1.ref));
  assert.match(stopMsg, new RegExp(h2.ref));
  assert.match(stopMsg, new RegExp(h3.ref));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.type === "barrier" && e.group === "abort-me").length, 0, "all-cancelled group never wakes Main");
});

test("barrier: context filtering in index.ts strips passive wake:false notices and keeps barrier + ask", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.WORQ_STATE_DIR = state;
  t.after(() => { delete process.env.WORQ_STATE_DIR; });

  const tools: { name: string; execute: Function }[] = [];
  const handlers: Record<string, Function> = {};
  let renderNotice: Function | undefined;
  const notices: { message: { content: string; customType: string; details: { ref: string; type?: string; wake?: boolean; group?: string } }; options: { triggerTurn: boolean; deliverAs?: string } }[] = [];
  const pi = {
    sendUserMessage() {},
    registerTool: (tool: never) => tools.push(tool),
    registerCommand() {},
    registerMessageRenderer(_name: string, renderer: Function) { renderNotice = renderer; },
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    sendMessage: (message: typeof notices[number]["message"], options: typeof notices[number]["options"]) => notices.push({ message, options }),
  };

  createWorq({
    agentDir: () => agentDir,
    driver: () => fakeDriver({
      "agent.scout": async (turn) => {
        await turn.tool("submit", { summary: "Found it at app.py:1" });
      },
      "agent.plan": async (turn) => {
        if (!turn.text.startsWith("{")) return;
        await turn.tool("ask_main", { question: "Which color?" });
        await turn.tool("submit", planSubmission);
      },
      review: async (turn) => { await turn.tool("submit", pass); },
    }),
  })(pi as never);

  const ctx = { mode: "headless", cwd: root, ui: { notify() {} } };
  await handlers.session_start({}, ctx);

  const spawn = tools.find((x) => x.name === "worq_spawn")!;
  const send = tools.find((x) => x.name === "worq_send")!;

  // Launch a 2-member barrier group containing a scout (done -> wake:false) and a plan (ask -> wake:true, then parked -> wake:false).
  await spawn.execute("1", { kind: "scout", title: "Fast scout", task: "Check app", group: "wave", notify: "barrier", expect: 2 }, undefined, undefined, ctx);
  const p = await spawn.execute("2", { kind: "plan", title: "Slow plan", task: "Plan app", group: "wave", notify: "barrier", expect: 2 }, undefined, undefined, ctx);

  for (let i = 0; i < 100 && !notices.some((n) => n.message.details.type === "ask"); i++) await new Promise((r) => setTimeout(r, 20));
  const askNotice = notices.find((n) => n.message.details.type === "ask")!;
  assert.equal(askNotice.options.triggerTurn, true);

  await send.execute("3", { ref: p.details.ref, text: "Blue" }, undefined, undefined, ctx);
  for (let i = 0; i < 100 && !notices.some((n) => n.message.details.type === "barrier"); i++) await new Promise((r) => setTimeout(r, 20));

  const passiveDone = notices.find((n) => n.message.details.type === "done")!;
  const passiveParked = notices.find((n) => n.message.details.type === "parked")!;
  const barrierNotice = notices.find((n) => n.message.details.type === "barrier")!;
  assert.equal(passiveDone.options.triggerTurn, false);
  assert.equal(passiveParked.options.triggerTurn, false);
  assert.equal(barrierNotice.options.triggerTurn, true);

  const assistant = { role: "assistant" };
  const filtered = handlers.context({
    messages: [
      assistant,
      { ...passiveDone.message, role: "custom" },
      { ...askNotice.message, role: "custom" },
      { ...passiveParked.message, role: "custom" },
      { ...barrierNotice.message, role: "custom" },
    ],
  });
  assert.deepEqual(
    filtered.messages.map((m: { role: string; details?: { type?: string } }) => m.details?.type ?? m.role),
    ["assistant", "ask", "barrier"],
  );

  // Check message renderer tone for barrier with [parked] vs clean barrier.
  const tones: string[] = [];
  const theme = { fg: (tone: string, text: string) => { tones.push(tone); return text; } };
  renderNotice!(barrierNotice.message, { expanded: false }, theme);
  assert.equal(tones[0], "warning", "barrier with [parked] uses warning tone");

  // Also test CLI --group / --notify / --expect and `worq list --group`.
  const run = promisify(execFile);
  const cli = join(import.meta.dirname, "..", "bin", "worq.mjs");
  const env = { ...process.env, WORQ_STATE_DIR: state };
  const cliSpawn = await run(process.execPath, [cli, "spawn", "scout", "--title", "Cli scout", "--group", "cli-wave", "--notify", "barrier", "--expect", "1", "Check cli"], { env });
  assert.match(cliSpawn.stdout, /in group cli-wave/);
  for (let i = 0; i < 100 && !notices.some((n) => n.message.details.type === "barrier" && n.message.details.group === "cli-wave"); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const cliList = await run(process.execPath, [cli, "list", "--group", "cli-wave"], { env });
  assert.match(cliList.stdout, /Group cli-wave \(barrier\) · 1\/1 member · settled/);

  await handlers.session_shutdown({}, ctx);
});

test("barrier: parked resume re-arms barrier and coalesces second wave", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, events, next } = setup(root, state, {
    "agent.plan": async (turn) => {
      if (turn.text.startsWith("Main:")) {
        await turn.tool("submit", { ...planSubmission, summary: `Revised: ${turn.text.slice(6, 20)}` });
        return;
      }
      await turn.tool("submit", planSubmission);
    },
    review: async (turn) => { await turn.tool("submit", pass); },
  });

  const p1 = await worq.spawn("plan", "Plan one", { title: "Plan one", group: "plans", notify: "barrier", expect: 2 });
  const p2 = await worq.spawn("plan", "Plan two", { title: "Plan two", group: "plans", notify: "barrier", expect: 2 });
  const wave1 = await next("barrier", "group:plans", 1);
  assert.match(wave1.text, /2 parked/);

  // Resume both parked members in the same turn; expect one second barrier notice once both finish.
  worq.send(p1.ref, "tighten scope 1");
  worq.send(p2.ref, "tighten scope 2");
  const wave2 = await next("barrier", "group:plans", 2);
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(events.filter((e) => e.type === "barrier" && e.group === "plans").length, 2);
  assert.match(wave2.text, /2 done/);
  assert.equal(p1.state, "done");
  assert.equal(p2.state, "done");
  await worq.cancel("all");
});

test("barrier: validation refuses bad group combinations and ambiguous list", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq, next } = setup(root, state, {
    "agent.scout": async (turn) => { await turn.tool("submit", { summary: "ok" }); },
  });
  const table = ops();

  await assert.rejects(worq.spawn("scout", "x", { title: "Bad one", notify: "barrier" }), /notify: barrier requires group/);
  await assert.rejects(worq.spawn("scout", "x", { title: "Bad two", expect: 2 }), /expect requires group/);
  const s = await worq.spawn("scout", "x", { title: "Good one", group: "g1", notify: "barrier", expect: 1 });
  await next("barrier", "group:g1");
  await assert.rejects(worq.spawn("scout", "y", { title: "Bad mix", group: "g1", notify: "each" }), /already uses notify=barrier/);
  await assert.rejects(dispatch(worq, table, "list", { ref: s.ref, group: "g1" }), /either ref or group/);
  await assert.rejects(dispatch(worq, table, "list", { group: "missing" }), /No group missing/);
  await worq.cancel("all");
});
