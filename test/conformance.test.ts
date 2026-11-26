import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { MAIN, } from "../src/runtime/config.ts";
import { Block, text } from "../src/contracts.ts";
import { EMPTY, type Resources } from "../src/runtime/resources.ts";
import { type Capabilities, type Driver, type Handle, type Runtime, type SDKAdapter, type SessionSpec, type Spec } from "../src/sdk/contract.ts";
import { createDriver, type SDKRecord } from "../src/sdk/registry.ts";
import { piAdapter, thinkingLevels } from "../src/sdk/pi.ts";
import { Conversation } from "../src/session.ts";
import { fakeHarness, FULL_CAPS, type FakeOptions, type Script } from "./fake.ts";

import { adapterConformance, finish, open, tools, until } from "./conformance-suite.ts";
/** A scripted adapter response table shared by the MINIMAL and FULL runs. */
export const script: Script = async (turn) => {
  const { text: prompt } = turn;
  if (prompt === "tools") {
    await turn.tool("echo", { value: "hi" });
    await turn.tool("echo", { bad: 1 });
    await turn.tool("strict", { n: "no" });
    await turn.tool("boom", {});
    await turn.tool("submit", { value: "tools" });
    return;
  }
  if (prompt.startsWith("Your submit call was rejected")) { await turn.tool("submit", { value: "" }); return; }
  if (prompt === "reject") { await turn.tool("submit", { value: "" }); return; }
  if (prompt === "refuse") return;
  if (prompt === "one-turn") {
    await turn.tool("echo", { value: "hi" });
    if (await turn.admit()) await turn.tool("submit", { value: "leak" });
    return;
  }
  if (prompt === "submit") { await turn.tool("submit", { value: "one" }); return; }
  if (prompt === "submit-two") { await turn.tool("submit", { value: "two" }); return; }
  if (prompt === "hang") return new Promise(() => {});
  if (prompt === "hang-after-submit") { await turn.tool("submit", { value: "kept" }); return new Promise(() => {}); }
  if (prompt === "race") { await turn.tool("submit", { value: "raced" }); await sleep(300); return; }
  if (prompt === "slow") { await sleep(30); await turn.tool("submit", { value: "slow" }); return; }
  if (prompt === "wait") { await sleep(80); return; }
  if (prompt === "main") { await turn.tool("submit", { value: "ok" }); return; }
  if (prompt === "context") { await turn.tool("submit", { value: turn.system }); return; }
  if (prompt === "id") { await turn.tool("submit", { value: turn.spec.id }); return; }
};

const record: FakeOptions = { images: [], toolErrors: [], prompts: [], aborts: { n: 0 }, calls: { n: 0 } };
const make = (caps: Capabilities) => fakeHarness(caps, { x: script }, record);

test("conformance: MINIMAL and FULL adapters", async () => {
  await adapterConformance("adapter", make, record);
});

test("conformance: awaited admission makes exactly one request, stops cleanly at turn-limit, then reuses a fresh budget", async () => {
  const options: FakeOptions = { admission: true, requests: { n: 0 }, prompts: [] };
  const caps: Capabilities = { ...FULL_CAPS, requestAdmission: "awaited" };
  const driver = fakeHarness(caps, { x: script }, options);
  const c = open(driver, { turns: 1 });
  await assert.rejects(c.run("one-turn"), (error: unknown) => error instanceof Block && error.code === "turn-limit");
  assert.equal(options.requests!.n, 1, "the first response's tool call is not followed by a continuation");
  assert.equal(c.streaming, false, "the refused continuation leaves the session idle");
  assert.deepEqual(await c.run("submit"), { value: "one" }, "the same handle runs again with a fresh budget");
  assert.equal(options.requests!.n, 2, "each invocation released exactly its own first request");
});

test("conformance: a throwing steer downgrades to the inbox with one log line", async () => {
  const driver = fakeHarness(FULL_CAPS, { x: script }, { steer: "throw" });
  const logs: string[] = [];
  const c = open(driver, { logs });
  const running = c.run("wait");
  await until(() => c.streaming);
  c.deliver("main");
  assert.deepEqual(await running, { value: "ok" });
  assert.equal(logs.filter((line) => line.includes("message queued")).length, 1);
});

test("conformance: the abort-duty case fails a dangling abort", async () => {
  const options: FakeOptions = { abort: "dangle", images: [], toolErrors: [], prompts: [], aborts: { n: 0 }, calls: { n: 0 } };
  await assert.rejects(adapterConformance("DANGLING", (caps) => fakeHarness(caps, { x: script }, options), options), /abort\(\) settles/);
});

test("conformance: a harness without steer queues delivered messages", async () => {
  const driver = fakeHarness(FULL_CAPS, { x: script }, { steer: "none" });
  const logs: string[] = [];
  const c = open(driver, { logs });
  const running = c.run("wait");
  await until(() => c.streaming);
  c.deliver("main");
  assert.deepEqual(await running, { value: "ok" });
  assert.equal(logs.filter((line) => line.includes("message queued")).length, 1);
});

test("conformance: a session that finishes opening after dispose is disposed, not leaked", async () => {
  let release!: () => void;
  let disposed = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inner = fakeHarness(FULL_CAPS, { x: script });
  const driver: Driver = {
    capabilities: inner.capabilities,
    async open(spec) { await gate; const handle = await inner.open(spec); return { ...handle, prompt: handle.prompt, abort: handle.abort, get streaming() { return handle.streaming; }, dispose() { disposed++; } }; },
  };
  const controller = new AbortController();
  const c = open(driver, { signal: controller.signal });
  const running = c.run("submit");
  await sleep(5);
  controller.abort(new Block("cancelled", "early"));
  await assert.rejects(running, /early/);
  c.dispose();
  release();
  await until(() => disposed === 1);
});

/** A recording SDK adapter: proves the router hands adapters a resolved, prepared spec. */
function recordingSdk(caps: Capabilities, seen: SessionSpec[], defaultThinking?: () => string): SDKRecord {
  return {
    load: async (): Promise<SDKAdapter> => ({
      models: async () => ['m/a', 'm/b'],
      capabilities: () => caps,
      validateRuntime: () => {},
      defaultThinking,
      async open(spec) {
        seen.push(spec);
        const handle: Handle = {
          prompt: async () => "completed", get streaming() { return false; }, abort: async () => {}, dispose() {},
        };
        return handle;
      },
    }),
  };
}
const roleSpec = (name: string): Spec => ({ id: "s", name, cwd: process.cwd(), system: "S", tools: [], emit() {}, signal: new AbortController().signal });

test("registry: createDriver routes by runtime and prepares the shared environment", async () => {
  const seen: SessionSpec[] = [];
  const sdks = { pi: recordingSdk(FULL_CAPS, seen, () => "medium"), test: recordingSdk(FULL_CAPS, seen) };
  const review: Runtime = { name: "launch", sdk: "test", model: "m/a", path: "", via: "launch request" };
  const resources: Resources = { root: "/r", agents: "Shared rule", skills: [{ name: "lint", description: "How to lint", body: "Run lint", files: [] }], ignored: [] };
  const driver = await createDriver({}, resources, sdks);
  for (const role of ["agent.plan", "subagent", "review"]) {
    const handle = await driver.open(role === "review" ? { ...roleSpec(role), runtime: review } : roleSpec(role));
    const spec = seen.at(-1)!;
    assert.equal(spec.runtime.sdk, role === "review" ? "test" : "pi", `${role} routes to its runtime's sdk`);
    assert.match(spec.system, /^S\n\nOperator instructions AGENTS\.md[\s\S]*Shared rule[\s\S]*- lint: How to lint/, `${role}: same instructions and skill index`);
    assert.ok(!spec.system.includes("Run lint"), `${role}: skill bodies load on demand`);
    assert.equal(await spec.tools.find((t) => t.name === "skill")!.run({ name: "lint" }, new AbortController().signal), "Run lint");
    assert.equal(spec.thinking, role === "review" ? undefined : "medium", "use the selected SDK's host thinking level when available");
    handle.dispose();
  }
  const override = { ...review, model: 'm/b', thinking: 'high' };
  const selected = await driver.open({ ...roleSpec('agent.plan'), runtime: override });
  assert.equal(seen.at(-1)?.runtime, override);
  selected.dispose();
  (await driver.open({ ...roleSpec('agent.plan'), runtime: { ...MAIN, model: 'm/a' } })).dispose();
  assert.equal(seen.at(-1)?.thinking, undefined, "an admitted SDK default stays resolved");

  const unknown = await createDriver({}, EMPTY, sdks);
  await assert.rejects(unknown.load!("claude"), (error: unknown) => error instanceof Block && error.code === "sdk" && /Unknown sdk "claude" \(installed: pi, test\)/.test(error.message));
  await assert.rejects(unknown.open({ ...roleSpec("agent.plan"), runtime: { ...MAIN, sdk: "claude" } }), /Unknown sdk "claude"/);
});

test("pi: capability snapshot derives thinking from the runtime's model", () => {
  const model = { provider: "p", id: "m", reasoning: true, thinkingLevelMap: { xhigh: "x" } };
  const registry = { find: (provider: string, id: string) => provider === "p" && id === "m" ? model : undefined };
  const adapter = piAdapter({ model: undefined, modelRegistry: registry } as never);
  const caps = adapter.capabilities({ ...MAIN, model: "p/m", path: "/plan" });
  assert.equal(caps.switchModel, true);
  assert.deepEqual(caps.thinking, ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(caps.context, { system: "replace", ambientInstructions: false });
  assert.deepEqual(piAdapter({ model, modelRegistry: registry } as never).capabilities(MAIN).thinking, caps.thinking, "no runtime model: Main's model");
  assert.throws(() => adapter.capabilities({ ...MAIN, model: "q/z", path: "/plan" }), /\/plan\/model: Pi does not know model q\/z/);
  assert.throws(() => adapter.validateRuntime({ ...MAIN, model: "q/z" }, new AbortController().signal), /model: Pi does not know model q\/z/);
  assert.throws(() => adapter.validateRuntime({ ...MAIN, model: "no-slash" }, new AbortController().signal), /not a Pi model ref/);
  assert.throws(() => adapter.validateRuntime(MAIN, new AbortController().signal), (e: unknown) => e instanceof Block && e.code === "model", "no Main model and none requested");
  assert.doesNotThrow(() => adapter.validateRuntime({ ...MAIN, model: "p/m" }, new AbortController().signal));
  assert.deepEqual(thinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(thinkingLevels(undefined), []);
});

test("pi: nothing to resolve is Block(model)", async () => {
  const driver = await createDriver({ pi: { model: undefined, modelRegistry: { find: () => undefined } } as never });
  await assert.rejects(driver.open(roleSpec("agent.plan")), (error: unknown) => error instanceof Block && error.code === "model");
});

test("live: Pi adapter opens a real session and submits", { skip: process.env.WORQ_CONFORMANCE_PI === "1" ? false : "set WORQ_CONFORMANCE_PI=1 (and WORQ_CONFORMANCE_MODEL=<provider>/<model>) to exercise the real Pi adapter" }, async () => {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const ref = process.env.WORQ_CONFORMANCE_MODEL;
  assert.ok(ref, "WORQ_CONFORMANCE_MODEL=<provider>/<model> is required for the live run");
  const models = createModels();
  const at = ref.lastIndexOf("/");
  const model = models.getModel(ref.slice(0, at), ref.slice(at + 1));
  assert.ok(model, `unknown model ${ref}`);
  const registry = { find: (provider: string, id: string) => models.getModel(provider, id) };
  const runtime: Runtime = { name: "live", sdk: "pi", model: ref, path: "/plan", via: "/plan" };
  const driver = await createDriver({ pi: { model, modelRegistry: registry } as never });
  await driver.load!("pi");
  const caps = driver.capabilities("subagent", runtime);
  assert.ok(caps.thinking.length > 0, "the live model must expose a thinking level");
  const logs: string[] = [];
  const c = new Conversation({
    driver, signal: new AbortController().signal, turns: 6, minutes: 3, finish,
    spec: { runtime, name: "subagent", cwd: process.cwd(), system: "You are a conformance probe. Call submit with value set to the word ready.", tools: tools(), log: (line) => { logs.push(line); } },
  });
  try {
    const result = await c.run("Call the echo tool with value hi, then call submit with value ready.");
    assert.equal(result.value.trim().toLowerCase(), "ready");
    assert.ok(logs.some((line) => line.startsWith("→ echo")), "the real SDK dispatched a Worq tool");
  } finally { c.dispose(); }
});
