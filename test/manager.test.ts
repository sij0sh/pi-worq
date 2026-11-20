import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Bus, unanswered, type BusEvent } from "../src/bus.ts";
import { dispatch, serve } from "../src/control.ts";
import type { Run } from "../src/controller.ts";

const never = new AbortController().signal;
const fast = { askMs: 2000, gateMs: 2000 };

test("asks reach the manager with context; replies return to the agent", async () => {
  const bus = new Bus("gates", true, fast);
  const events: BusEvent[] = [];
  bus.on((event) => events.push(event));
  const agent = bus.register("execute", false);
  agent.log("→ read_file app.py");
  const answer = bus.ask(agent.id, "Uppercase or title case?", never);
  await sleep(0);
  const [event] = events;
  assert.equal(event.type, "ask");
  assert.ok(event.type === "ask" && event.context.includes("read_file app.py"));
  assert.equal(bus.agentsView()[0].state, "waiting");
  assert.equal(bus.pendingView().length, 1);
  bus.reply(bus.pendingView()[0].id, "Uppercase");
  assert.equal(await answer, "Manager: Uppercase");
  assert.equal(bus.pendingView().length, 0);
  assert.throws(() => bus.reply("q1", "again"), /No open question/);
});

test("no manager: asks answer at once, gates auto-approve; unanswered asks time out", async () => {
  const off = new Bus("gates", false);
  const agent = off.register("plan", false);
  assert.equal(await off.ask(agent.id, "?", never), unanswered);
  assert.deepEqual(await off.gate("plan", "x", never), { decision: "approve", by: "auto" });
  const slow = new Bus("gates", true, { askMs: 30, gateMs: 30 });
  const a = slow.register("execute", false);
  assert.equal(await slow.ask(a.id, "?", never), unanswered);
  assert.equal((await slow.gate("plan", "x", never)).by, "auto");
});

test("verification agents are sealed; live agents receive steer and interrupt", async () => {
  const bus = new Bus("gates", true, fast);
  const journey = bus.register("journey", true);
  journey.attach({ steer() {}, followUp() {}, async interrupt() {} });
  assert.throws(() => bus.send(journey.id, "pick another scenario"), /independent/);
  const got: string[] = [];
  const exec = bus.register("execute", false);
  exec.attach({ steer: (t) => got.push(`steer ${t}`), followUp: (t) => got.push(`follow ${t}`), interrupt: async (t) => { got.push(`int ${t}`); } });
  bus.send(exec.id, "use helper X");
  bus.send(exec.id, "then summarize", "followUp");
  await bus.interrupt(exec.id, "stop editing tests");
  assert.deepEqual(got, ["steer Manager: use helper X", "follow Manager: then summarize", "int Manager interrupted you: stop editing tests"]);
  assert.match(bus.log(exec.id).map((x) => x.line).join("\n"), /manager \(interrupt\)/);
  exec.close("done");
  assert.throws(() => bus.send(exec.id, "late"), /is done/);
});

test("reviews: revise needs text, escalation asks the user, aborts reject", async () => {
  const bus = new Bus("gates", true, fast);
  const asked: string[] = [];
  bus.escalator = async (prompt) => { asked.push(prompt); return "Keep stderr empty"; };
  let review = bus.gate("plan", "Outcome: uppercase", never);
  await sleep(0);
  const [first] = bus.pendingView();
  assert.throws(() => bus.review(first.id, "revise"), /needs text/);
  assert.throws(() => bus.review(first.id, "approve", undefined, "intent"), /Only route reviews/);
  bus.review(first.id, "escalate");
  assert.deepEqual(await review, { decision: "revise", text: "Keep stderr empty", by: "user" });
  assert.match(asked[0], /Review plan/);
  const stop = new AbortController();
  review = bus.gate("plan", "steps", stop.signal);
  stop.abort(new Error("stopped"));
  await assert.rejects(review, /stopped/);
  assert.equal(bus.pendingView().length, 0);
});

test("CLI drives the control socket; socket is private and removed on close", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-ctl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bus = new Bus("gates", true, fast);
  let stopped = false;
  const run = { bus, view: {}, stop: async () => { stopped = true; } } as unknown as Run;
  const host = { run: () => run, report: () => "Worq test · RUNNING" };
  const server = await serve(dir, host);
  assert.equal((await stat(server.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "ctl"))).mode & 0o777, 0o700);
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [new URL("../bin/worq.mjs", import.meta.url).pathname, "--pid", String(process.pid), ...args], { env: { ...process.env, WORQ_STATE_DIR: dir } });
  const agent = bus.register("plan", false);
  agent.log("considering approach");
  const question = bus.ask(agent.id, "Which module?", never);
  const gate = bus.gate("plan", "1. Edit app.py", never);
  await sleep(0);
  const listing = (await cli("agents")).stdout;
  assert.match(listing, /p1 · plan · waiting/);
  assert.match(listing, /q2 · p1 asks: Which module\?/);
  assert.match((await cli("log", "p1")).stdout, /considering approach/);
  assert.match((await cli("reply", "q2", "src/app.py")).stdout, /Answered q2/);
  assert.equal(await question, "Manager: src/app.py");
  await cli("review", "g3", "revise", "Add", "a", "test");
  assert.deepEqual(await gate, { decision: "revise", text: "Add a test", route: undefined, by: "manager" });
  await assert.rejects(cli("reply", "q9", "x"), /No open question q9/);
  await cli("stop");
  assert.equal(stopped, true);
  await assert.rejects(dispatch(host, "nope", {}), /Unknown operation/);
  await server.close();
  await assert.rejects(stat(server.path));
});
