import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Block, obj, text } from "../src/contracts.ts";
import { DEFAULT_LIMITS, type Config } from "../src/runtime/config.ts";
import { EMPTY } from "../src/runtime/resources.ts";
import type { CoreHandle, Driver, Handle, Runtime, RuntimeChange, SDKAdapter, Spec } from "../src/sdk/contract.ts";
import { createDriver } from "../src/sdk/registry.ts";
import { Conversation } from "../src/session.ts";
import { Telemetry } from "../src/telemetry.ts";
import { FULL_CAPS, pass, planSubmission, repo, setup } from "./fake.ts";

const finish = { name: "submit", description: "Submit.", schema: obj({ value: text(100) }) };
async function until(check: () => boolean, deadline = 5000) {
  const end = Date.now() + deadline;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await sleep(5); }
}

test("conversation: a change during a prompt is queued, merged and applied before the next prompt", async () => {
  const log: string[] = [];
  let release: (() => void) | undefined;
  let streaming = false;
  let spec: Spec | undefined;
  const driver: Driver = {
    capabilities: () => FULL_CAPS,
    async open(s) {
      spec = s;
      const handle: CoreHandle = {
        async prompt(text) {
          log.push(`prompt ${text}`);
          if (text !== "go") { await spec!.tools[0].run({ value: "done" }, new AbortController().signal); return "completed"; }
          streaming = true;
          await new Promise<void>((resolve) => { release = resolve; });
          streaming = false;
          return "completed";
        },
        get streaming() { return streaming; }, abort: async () => { release?.(); }, dispose() {},
        fallback: async () => false,
        check(change) { if (change.thinking === "bogus") throw new Block("capability", "bogus"); },
        async configure(change) { log.push(`configure ${JSON.stringify(change)}`); },
      };
      return handle;
    },
  };
  const c = new Conversation({ driver, signal: new AbortController().signal, turns: 10, minutes: 1, finish,
    spec: { name: "x", cwd: process.cwd(), system: "S", tools: [], log() {} } });
  const keep = setTimeout(() => {}, 10_000);
  try {
    const running = c.run("go");
    await until(() => streaming);
    assert.equal(await c.configure({ model: "p/a" }), "queued");
    assert.equal(await c.configure({ thinking: "high" }), "queued");
    assert.deepEqual(c.pendingChange, { model: "p/a", thinking: "high" });
    await assert.rejects(c.configure({ thinking: "bogus" }), /bogus/, "invalid changes are refused before queuing");
    assert.ok(!log.some((l) => l.startsWith("configure")), "never applied mid-prompt");
    release!();
    assert.deepEqual(await running, { value: "done" });
    assert.deepEqual(log, ["prompt go", `configure {"model":"p/a","thinking":"high"}`, log[2]], "one merged change, before the next prompt");
    assert.equal(c.pendingChange, undefined);
    assert.equal(await c.configure({ thinking: "low" }), "applied", "idle sessions change immediately");
    c.dispose();
    await assert.rejects(c.configure({ thinking: "low" }), /ended/);
  } finally { clearTimeout(keep); }
});

test("registry: configure validates against the new model, tracks the runtime and supersedes fallback", async () => {
  const applied: RuntimeChange[] = [];
  const levels: Record<string, string[]> = { "m/a": ["off", "low", "high"], "m/b": ["off"] };
  const adapter: SDKAdapter = {
    models: async () => ["m/a", "m/b"],
    capabilities: (runtime: Runtime) => ({ ...FULL_CAPS, thinking: levels[runtime.model ?? "m/a"] ?? [] }),
    async open() {
      const handle: Handle = { prompt: async () => "completed", get streaming() { return false; }, abort: async () => {}, dispose() {},
        configure: async (change) => { applied.push(change); } };
      return handle;
    },
  };
  const runtime: Runtime = { name: "r", sdk: "pi", model: "m/a", fallbackModel: "m/b", path: "/runtimes/r", via: "/default" };
  const config: Config = { path: "t", limits: DEFAULT_LIMITS, approveExtensions: false, sdks: ["pi"], runtime: () => runtime };
  const driver = await createDriver({}, config, EMPTY, { pi: { modelRef: /.*/, load: async () => adapter } });
  const handle = await driver.open({ id: "s", name: "agent.plan", cwd: process.cwd(), system: "S", tools: [], emit() {}, signal: new AbortController().signal });
  assert.equal(handle.runtime?.thinking, "low");
  assert.throws(() => handle.check!({ model: "m/b", thinking: "high" }), (e: unknown) => e instanceof Block && e.code === "capability", "thinking is judged against the new model");
  await handle.configure!({ thinking: "high" });
  assert.equal(handle.runtime?.thinking, "high");
  await handle.configure!({ model: "m/a" });
  assert.equal(await handle.fallback(), false, "a manual model change supersedes the preset fallback");
  assert.deepEqual(applied, [{ thinking: "high" }, { model: "m/a" }]);
});

test("controls: cancelling one PQ leaves its siblings and parent running; cancelling the owner stops the family", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const telemetry = new Telemetry();
  const answers: string[] = [];
  let stalled = 0;
  const { worq } = setup(root, state, {
    "agent.plan": async (turn) => {
      if (turn.text.startsWith("[PQ")) { answers.push(turn.text); return; }
      await turn.tool("delegate", { question: "First question?", why: "w" });
      await turn.tool("delegate", { question: "Second question?", why: "w" });
    },
    subagent: async () => { stalled++; await new Promise(() => {}); },
  }, {}, telemetry);
  const agent = await worq.spawn("plan", "Plan it", { title: "Control test" });
  await until(() => stalled === 2);
  const pqs = [...worq.sessions.values()].filter((s) => s.role === "subagent");
  assert.equal(pqs.length, 2);
  const owner = worq.session(agent.ref);
  assert.equal(owner.role, "agent.plan");
  await pqs[0].cancel();
  await until(() => answers.length === 1);
  assert.match(answers[0], /^\[PQ cancelled\] First question\?[\s\S]*cancelled by Main/, "the parent is told");
  assert.equal(agent.delegations[0].state, "cancelled");
  assert.equal(agent.delegations[1].state, "running", "the sibling keeps running");
  assert.ok(!agent.ended, "the parent keeps running");
  assert.ok(!worq.sessions.has(pqs[0].key), "unregistered on disposal");
  await assert.rejects(worq.configure(agent.ref, { thinking: "high" }), /cannot change a live session/, "a harness without configure refuses instead of dropping the change");
  await owner.cancel();
  assert.equal(agent.state, "cancelled");
  assert.equal(agent.delegations[1].state, "cancelled");
  assert.equal(worq.sessions.size, 0);
  assert.throws(() => worq.session(agent.ref), /no longer live/);
});

test("controls: cancelling one reviewer records an unknown verdict; the round still settles", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let hung = 0;
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => { await turn.tool("submit", planSubmission); },
    "reviewer.decision": async () => { hung++; await new Promise(() => {}); },
    reviewer: async (turn) => { await turn.tool("report", pass); },
  }, {}, new Telemetry());
  const agent = await worq.spawn("plan", "Plan it", { title: "Reviewer cancel" });
  await until(() => hung === 1);
  const reviewer = [...worq.sessions.values()].find((s) => s.role === "reviewer.decision")!;
  assert.match(reviewer.consequence, /unknown/);
  await reviewer.cancel();
  await next("review-ready", agent.ref);
  const decision = agent.reviews.find((r) => r.name === "decision")!;
  assert.equal(decision.verdict, "unknown");
  assert.equal(decision.error, "Review cancelled by Main");
  assert.ok(agent.reviews.filter((r) => r.name !== "decision").every((r) => r.verdict === "pass"), "siblings unaffected");
  await worq.cancel(agent.ref);
});
