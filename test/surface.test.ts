import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Type } from "typebox";
import { createWorq, TOOLS } from "../index.ts";
import { DEFAULT_LIMITS, loadConfig } from "../src/config.ts";
import { dispatch, ops, serve } from "../src/control.ts";
import { obj, text } from "../src/contracts.ts";
import { loadPrompts } from "../src/prompts.ts";
import { Conversation, NUDGE } from "../src/session.ts";
import { fakeDriver, pass, planSubmission, repo, setup } from "./fake.ts";

const never = new AbortController().signal;
const finish = { name: "done", description: "Finish.", schema: obj({ value: text(20) }) };
const conversation = (script: Parameters<typeof fakeDriver>[0][string], pending?: () => number) => new Conversation({
  driver: fakeDriver({ x: script }), signal: never, turns: 10, minutes: 1, finish, pending,
  spec: { profile: "subagent", name: "x", cwd: "/", system: "", tools: [], log() {} },
});

test("conversation: one settlement nudge, rejected finish is explained, then fails", async () => {
  const texts: string[] = [];
  const ok = conversation(async (turn) => { texts.push(turn.text); if (turn.text === NUDGE) await turn.tool("done", { value: "v" }); });
  assert.deepEqual(await ok.run("go"), { value: "v" });
  assert.deepEqual(texts, ["go", NUDGE]);

  const seen: string[] = [];
  const bad = conversation(async (turn) => { seen.push(turn.text); await turn.tool("done", { value: "" }); });
  await assert.rejects(bad.run("go"), /submission rejected: Invalid done arguments/);
  assert.match(seen[1], /Your done call was rejected/);
});

test("conversation: waits for pending work and takes delivered messages in order", async () => {
  let open = 1;
  const texts: string[] = [];
  const c = conversation(async (turn) => { texts.push(turn.text); if (turn.text === "answer") await turn.tool("done", { value: "ok" }); }, () => open);
  const result = c.run("start");
  await new Promise((r) => setTimeout(r, 20));
  open = 0;
  c.deliver("answer");
  assert.deepEqual(await result, { value: "ok" });
  assert.deepEqual(texts, ["start", "answer"]);
});

test("conversation: turn limit aborts", async () => {
  const c = new Conversation({ driver: fakeDriver({ x: () => {} }), signal: never, turns: 1, minutes: 1, finish,
    spec: { profile: "subagent", name: "x", cwd: "/", system: "", tools: [], log() {} } });
  await assert.rejects(c.run("go"), /turn limit/);
});

test("config: defaults, model lookup by specificity, invalid keys name the file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(loadConfig(dir).limits, DEFAULT_LIMITS);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ model: "a/m", models: { reviewer: { model: "b/r" }, "reviewer.intent": { model: "c/i" } }, limits: { rounds: 5 } }));
  const config = loadConfig(dir);
  assert.equal(config.limits.rounds, 5);
  assert.equal(config.limits.agents, DEFAULT_LIMITS.agents);
  assert.equal(config.model("agent.plan").model, "a/m");
  assert.equal(config.model("reviewer.pair").model, "b/r");
  assert.equal(config.model("reviewer.intent").model, "c/i");
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ limits: { rounds: 0 } }));
  assert.throws(() => loadConfig(dir), /pi-worq\.json: \/limits\/rounds/);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ agents: { plan: {} }, scq: {} }));
  assert.throws(() => loadConfig(dir), /agents and scq are from the old Worq format/);
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ land: "auto" }));
  assert.throws(() => loadConfig(dir), /pi-worq\.json/);
});

test("prompts: kinds and reviewer rosters are data", () => {
  const prompts = loadPrompts();
  assert.deepEqual([...prompts.kinds.keys()].sort(), ["execute", "plan"]);
  assert.equal(prompts.kinds.get("plan")!.access, "read");
  assert.equal(prompts.kinds.get("execute")!.access, "write");
  assert.deepEqual(prompts.reviewers("plan").map((r) => r.name), ["decision", "defeater", "pair", "subtraction"]);
  assert.deepEqual(prompts.reviewers("execute").map((r) => r.name), ["intent"]);
});

test("tools are hidden until /worq, restored on resume, and share one schema with the CLI", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.WORQ_STATE_DIR = state;
  const tools: { name: string; defaultActive?: boolean; parameters: unknown; execute: Function }[] = [];
  const handlers: Record<string, Function> = {};
  let command: Function | undefined;
  let active = ["read", "bash"];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const userMessages: string[] = [];
  const pi = {
    registerTool: (tool: never) => tools.push(tool),
    registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; },
    registerMessageRenderer() {},
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string) => userMessages.push(text),
    sendMessage() {},
  };
  const scripts = { "agent.plan": (turn: { tool: Function }) => turn.tool("submit", planSubmission), reviewer: (turn: { tool: Function }) => turn.tool("report", pass) };
  createWorq({ driver: () => fakeDriver(scripts as never), agentDir: () => agentDir })(pi as never);
  assert.deepEqual(tools.map((x) => x.name), [...TOOLS]);
  assert.ok(tools.every((x) => x.defaultActive === false));
  assert.ok(!active.some((name) => name.startsWith("worq_")));
  const ctx = { mode: "print", cwd: root, ui: { notify() {}, setStatus() {} }, sessionManager: { getBranch: () => entries } };
  await command!("", ctx);
  assert.ok(TOOLS.every((name) => active.includes(name)));
  await command!("off", ctx);
  assert.ok(!active.some((name) => name.startsWith("worq_")));
  await command!("make the greeting louder", ctx);
  assert.match(userMessages[0], /Use Worq for this: make the greeting louder/);
  active = ["read"];
  await handlers.session_start({}, ctx);
  assert.ok(TOOLS.every((name) => active.includes(name)), "resume restores /worq");

  const spawn = tools.find((x) => x.name === "worq_spawn")!;
  const result = await spawn.execute("id", { kind: "plan", task: "Plan it" }, undefined, undefined, ctx);
  const ref = /agent ([0-9a-f]{4})/.exec(result.content[0].text)![1];
  // The CLI reaches the same operations through the control socket.
  const run = promisify(execFile);
  const cli = join(import.meta.dirname, "..", "bin", "worq.mjs");
  const env = { ...process.env, WORQ_STATE_DIR: state };
  for (let i = 0; i < 100 && !(await run(process.execPath, [cli, "list"], { env })).stdout.includes("review-ready"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match((await run(process.execPath, [cli, "list", ref], { env })).stdout, /Plan: \.agents\/plans\//);
  assert.match((await run(process.execPath, [cli, "cancel", ref], { env })).stdout, /closed/);
  await handlers.session_shutdown({}, ctx);
  delete process.env.WORQ_STATE_DIR;
});

test("dispatch validates arguments against the shared schema", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { worq } = setup(root, state, {});
  const table = ops(["plan", "execute"]);
  await assert.rejects(dispatch(worq, table, "spawn", { kind: "review", task: "x" }), /kind/);
  await assert.rejects(dispatch(worq, table, "send", { ref: "zz", text: "x" }), /ref/);
  await assert.rejects(dispatch(worq, table, "nope", {}), /Unknown operation/);
  assert.match((await dispatch(worq, table, "list", {})).text, /No Worq agents/);
  const socket = await serve(state, (op, args) => dispatch(worq, table, op, args));
  await socket.close();
  assert.ok(Type.Object({}));
});
