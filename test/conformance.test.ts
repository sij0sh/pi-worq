import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { DEFAULT_LIMITS, type Config } from "../src/config.ts";
import { Block, obj, text } from "../src/contracts.ts";
import { createDriver, HARNESSES } from "../src/harness.ts";
import { piDriver, thinkingLevels } from "../src/pi.ts";
import { assertChoice, Conversation, NUDGE, type Capabilities, type Driver, type Spec, type Tool } from "../src/session.ts";
import { fakeHarness, FULL_CAPS, MINIMAL_CAPS, type FakeOptions, type Script } from "./fake.ts";

const finish = { name: "submit", description: "Submit.", schema: obj({ value: text(4000) }) };
const tools = (): Tool[] => [
  { name: "echo", description: "Echo.", parameters: obj({ value: text(20) }), run: () => ({ text: "ok", image: { mimeType: "image/png", data: "aGk=" } }) },
  { name: "strict", description: "Strict.", parameters: obj({ n: Type.Integer() }), run: () => "ok" },
  { name: "boom", description: "Boom.", parameters: obj({}), run: () => { throw new Block("boom", "boom"); } },
];

/** Every case drives the adapter through one scripted conversation; the caller's make() supplies the script. */
function open(driver: Driver, extra: { minutes?: number; turns?: number; signal?: AbortSignal; logs?: string[]; system?: string } = {}) {
  return new Conversation({
    driver,
    signal: extra.signal ?? new AbortController().signal,
    turns: extra.turns ?? 10,
    minutes: extra.minutes ?? 1,
    finish,
    spec: { profile: "subagent", name: "x", cwd: process.cwd(), system: extra.system ?? "SYSTEM", tools: tools(), log: (line) => { extra.logs?.push(line); } },
  });
}
/** The budget timer is unref'd (right for production); keep the loop alive while a case waits on it. */
async function guarded<T>(work: Promise<T>): Promise<T> {
  const keep = setTimeout(() => {}, 10_000);
  try { return await work; } finally { clearTimeout(keep); }
}
async function until(check: () => boolean, deadline = 2000) {
  const end = Date.now() + deadline;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the adapter");
    await sleep(5);
  }
}


/**
 * The exported conformance suite. A new adapter is proven by passing it for MINIMAL and FULL:
 * FULL proves the required capability set is sufficient, MINIMAL proves the denials are honest.
 * Agent-free: a Driver plus a signal, no workspace. `options` is the adapter's mutable recording
 * surface (abort count, image payloads, reported tool errors); the caller's make() must share it.
 */
export async function adapterConformance(name: string, make: (caps: Capabilities) => Driver, options: FakeOptions = {}): Promise<void> {
  await assert.rejects(open(make(MINIMAL_CAPS)).run("context"), /isolated context required/);
  for (const caps of [{ ...MINIMAL_CAPS, context: FULL_CAPS.context }, FULL_CAPS]) await run(name, caps, make, options);
}

async function run(name: string, caps: Capabilities, make: (caps: Capabilities) => Driver, options: FakeOptions): Promise<void> {
  const aborts = () => options.aborts?.n ?? 0;


  // tools, images, argument validation, a thrown Block
  {
    const images = (options.images ??= []);
    const errors = (options.toolErrors ??= []);
    const before = images.length;
    const c = open(make(caps));
    assert.deepEqual(await c.run("tools"), { value: "tools" });
    assert.equal(images.length, before + 1, `${name}: an image tool output reaches the model`);
    assert.ok(errors.some((e) => e.name === "strict"), `${name}: invalid parameters are reported through spec.toolError`);
  }

  // finish: a rejected submission is explained, then the second failure is fatal
  {
    const prompts = (options.prompts ??= []);
    const c = open(make(caps));
    const before = prompts.length;
    await assert.rejects(c.run("reject"), /submission rejected/);
    assert.match(prompts[before + 1], /Your submit call was rejected/, `${name}: a rejected submit gets the correction prompt`);
  }
  // finish: never submitting gets exactly one nudge
  {
    const prompts = (options.prompts ??= []);
    const c = open(make(caps));
    const before = prompts.length;
    await assert.rejects(c.run("refuse"), /ended without calling submit/);
    assert.deepEqual(prompts.slice(before), ["refuse", NUDGE], `${name}: exactly one settlement nudge`);
  }

  // end of run — own settle: no abort at all
  {
    const before = aborts();
    const c = open(make(caps));
    assert.deepEqual(await c.run("submit"), { value: "one" });
    assert.equal(aborts(), before, `${name}: a turn that settles after a submission calls abort() zero times`);
  }

  // end of run — budget: submit-then-hang returns the value after one bounded stop()
  {
    const before = aborts();
    const c = open(make(caps), { minutes: 0.02 });
    const started = Date.now();
    assert.deepEqual(await guarded(c.run("hang-after-submit")), { value: "kept" });
    assert.equal(aborts(), before + 1, `${name}: a budget abort stops the turn once`);
    assert.ok(Date.now() - started < 5000, `${name}: the stop is bounded`);
  }
  // end of run — budget: a pre-spent turn allowance admits no prompt
  {
    const c = open(make(caps), { turns: 0 });
    await assert.rejects(c.run("submit"), /turn limit/);
  }
  // end of run — budget racing a settle
  {
    const before = aborts();
    const c = open(make(caps), { minutes: 0.001 });
    assert.deepEqual(await guarded(c.run("race")), { value: "raced" }, `${name}: a budget abort racing a settle returns the submission`);
    assert.equal(aborts(), before + 1, `${name}: the racing abort stops the turn once`);
  }
  // end of run — terminal: a spent budget never prompts again
  {
    const prompts = (options.prompts ??= []);
    const c = open(make(caps), { turns: 1 });
    assert.deepEqual(await c.run("submit"), { value: "one" });
    const after = prompts.length;
    await assert.rejects(c.run("submit"), (error: unknown) => error instanceof Block && error.code === "turn-limit");
    assert.equal(prompts.length, after, `${name}: a spent budget issues no prompt`);
  }
  // end of run — caller abort: its reason wins, one stop, no result
  {
    const before = aborts();
    const controller = new AbortController();
    const c = open(make(caps), { signal: controller.signal });
    const running = c.run("hang-after-submit");
    await sleep(50);
    controller.abort(new Block("cancelled", "stopped by the test"));
    await assert.rejects(running, /stopped by the test/);
    assert.equal(aborts(), before + 1, `${name}: a caller abort stops the in-flight turn once`);
  }
  // end of run — caller abort racing a prompt that settles with a submission
  {
    const controller = new AbortController();
    const c = open(make(caps), { signal: controller.signal });
    const running = c.run("slow");
    await sleep(5);
    controller.abort(new Block("cancelled", "raced by the test"));
    await assert.rejects(running, /raced by the test/);
  }

  // abort duty: abort() settles the in-flight prompt and clears streaming
  {
    const spec: Spec = { id: "duty", profile: "subagent", name: "x", cwd: process.cwd(), system: "S", tools: [], log() {}, turn() {}, toolError() {} };
    const handle = await make(caps)(spec);
    const running = handle.prompt("hang");
    await until(() => handle.streaming);
    await handle.abort();
    const settled = await Promise.race([running.then(() => true), sleep(5500).then(() => false)]);
    assert.ok(settled, `${name}: abort() settles the in-flight prompt within the stop bound`);
    assert.equal(handle.streaming, false, `${name}: abort() clears streaming`);
    handle.dispose();
  }

  // reuse: each round returns its own submission
  {
    const c = open(make(caps));
    assert.deepEqual(await c.run("submit"), { value: "one" });
    assert.deepEqual(await c.run("submit-two"), { value: "two" }, `${name}: a second run returns its own submission`);
  }

  // steer: a steered message arrives inside the run
  {
    const logs: string[] = [];
    const c = open(make(caps), { logs });
    const running = c.run("wait");
    await until(() => c.streaming);
    c.deliver("main");
    assert.deepEqual(await running, { value: "ok" });
    assert.equal(logs.filter((line) => line.includes("message queued")).length, 0, `${name}: a steered message is not queued`);
  }

  // budgets
  {
    const c = open(make(caps), { turns: 1 });
    await assert.rejects(c.run("refuse"), (error: unknown) => error instanceof Block && error.code === "turn-limit");
  }
  {
    const c = open(make(caps), { minutes: 0.02 });
    await assert.rejects(guarded(c.run("hang")), (error: unknown) => error instanceof Block && error.code === "time-limit");
  }

  // fallback
  {
    const prompts = (options.prompts ??= []);
    const c = open(make(caps));
    const before = prompts.length;
    const outcome = await c.run("fail").then((value) => value, (error: unknown) => error);
    if (caps.fallback) {
      assert.ok(!(outcome instanceof Block), `${name}: with a fallback the request continues`);
      assert.match(prompts[before + 1] ?? "", /previous model request failed/, `${name}: the fallback re-prompts with CONTINUE`);
    } else {
      assert.ok(outcome instanceof Block && outcome.code === "model", `${name}: no fallback left is Block(model)`);
    }
  }

  // thinking: the list is data on the adapter, empty only without level control
  {
    const levels = make(caps).capabilities("x").thinking;
    assert.equal(levels.length === 0, !caps.fallback && caps.thinking.length === 0, `${name}: thinking levels are exposed as data`);
  }

  // denial paths: a capability-minimal adapter must refuse what it cannot do, naming the config path
  {
    if (caps.fallback) {
      assert.doesNotThrow(() => assertChoice({ harness: name, fallbackModel: "p/m", from: { fallbackModel: "/fallbackModel" } }, caps), `${name}: a supported fallback is accepted`);
    } else {
      assert.throws(() => assertChoice({ harness: name, fallbackModel: "p/m", from: { fallbackModel: "/fallbackModel" } }, caps),
        (error: unknown) => error instanceof Block && error.code === "capability" && /\/fallbackModel/.test(error.message),
        `${name}: a configured fallback on a harness without one is denied naming from.fallbackModel`);
    }
    if (caps.thinking.length === 0) {
      assert.throws(() => assertChoice({ harness: name, thinking: "high", from: { thinking: "/models/agent.plan/thinking" } }, caps),
        (error: unknown) => error instanceof Block && error.code === "capability" && /\/models\/agent\.plan\/thinking/.test(error.message),
        `${name}: a configured level without level control is denied naming from.thinking`);
    } else {
      assert.doesNotThrow(() => assertChoice({ harness: name, thinking: "high", from: { thinking: "/models/agent.plan/thinking" } }, caps), `${name}: a supported level is accepted`);
    }
  }

  // context
  {
    const logs: string[] = [];
    const c = open(make(caps), { logs, system: "SYSTEM-X" });
    const result = await c.run("context");
    assert.equal(result.value, "SYSTEM-X", `${name}: an isolating harness sees exactly spec.system`);
  }

  // identity
  {
    const driver = make(caps);
    const first = await open(driver).run("id");
    const second = await open(driver).run("id");
    assert.notEqual(first.value, second.value, `${name}: each Conversation gets its own spec.id`);
    assert.ok(first.value.length > 10, `${name}: spec.id is a real identity`);
  }
}

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
  if (prompt.startsWith("The previous model request failed")) { await turn.tool("submit", { value: "continued" }); return; }
};

const record: FakeOptions = { images: [], toolErrors: [], prompts: [], aborts: { n: 0 }, calls: { n: 0 } };
const make = (caps: Capabilities) => {
  record.fallbacks = caps.fallback ? 1 : 0;
  return fakeHarness(caps, { x: script }, record);
};

test("conformance: MINIMAL and FULL adapters", async () => {
  await adapterConformance("adapter", make, record);
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

test("harness: createDriver routes by the role's harness and passes capabilities through", async () => {
  const model = { provider: "p", id: "m", reasoning: true };
  const ctx = { model, modelRegistry: { find: () => undefined } };
  const piOnly: Config = { path: "test", limits: DEFAULT_LIMITS, model: () => ({ harness: "pi", from: {} }) };
  assert.deepEqual(createDriver({ host: ctx }, piOnly).capabilities("agent.plan"), piDriver(ctx as never, piOnly).capabilities("agent.plan"));
  // Pi cannot resolve a ref here, so both report Main's model and its derived level list.
  assert.deepEqual(createDriver({ host: ctx }, piOnly).capabilities("reviewer.pair").thinking, ["off", "minimal", "low", "medium", "high"]);

  const created: string[] = [];
  HARNESSES["test"] = { modelRef: /.*/, create: () => { created.push("test"); return fakeHarness(FULL_CAPS, {}, {}); } };
  try {
    const mixed: Config = { path: "test", limits: DEFAULT_LIMITS, model: (name) => ({ harness: name === "subagent" ? "test" : "pi", from: {} }) };
    const driver = createDriver({ host: ctx }, mixed);
    assert.deepEqual(driver.capabilities("subagent"), FULL_CAPS, "the role's harness answers capabilities");
    assert.deepEqual(driver.capabilities("agent.plan").thinking, ["off", "minimal", "low", "medium", "high"], "another role routes to pi");
    const spec: Spec = { id: "s", profile: "subagent", name: "subagent", cwd: process.cwd(), system: "S", tools: [], log() {}, turn() {}, toolError() {} };
    const handle = await driver(spec);
    assert.deepEqual(created, ["test"], "opening a session routes to the record the role resolves to");
    assert.equal(typeof handle.abort, "function");
    handle.dispose();
  } finally { delete HARNESSES["test"]; }

  const unregistered: Config = { path: "test", limits: DEFAULT_LIMITS, model: () => ({ harness: "claude", from: {} }) };
  assert.throws(() => createDriver({ host: ctx }, unregistered).capabilities("agent.plan"),
    (error: unknown) => error instanceof Block && error.code === "config" && /unknown harness "claude"/.test(error.message));
  await assert.rejects(createDriver({ host: ctx }, unregistered)({ id: "s", profile: "agent", name: "agent.plan", cwd: process.cwd(), system: "S", tools: [], log() {}, turn() {}, toolError() {} }),
    (error: unknown) => error instanceof Block && error.code === "config");
});

test("pi: capability snapshot derives thinking from the model", () => {
  const model = { provider: "p", id: "m", reasoning: true, thinkingLevelMap: { xhigh: "x" } };
  const registry = { find: (provider: string, id: string) => provider === "p" && id === "m" ? model : undefined };
  const config: Config = { path: "test", limits: DEFAULT_LIMITS, model: () => ({ harness: "pi", model: "p/m", from: {} }) };
  const driver = piDriver({ model, modelRegistry: registry } as never, config);
  const caps = driver.capabilities("agent.plan");
  assert.equal(caps.fallback, true);
  assert.deepEqual(caps.thinking, ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(caps.context, { system: "replace", ambientInstructions: false });
  assert.deepEqual(thinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(thinkingLevels(undefined), []);
});

test("live: Pi adapter", { skip: process.env.WORQ_CONFORMANCE_PI === "1" ? false : "set WORQ_CONFORMANCE_PI=1 (and WORQ_CONFORMANCE_MODEL=<provider>/<model>) to exercise the real Pi adapter" }, async () => {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const ref = process.env.WORQ_CONFORMANCE_MODEL;
  assert.ok(ref, "WORQ_CONFORMANCE_MODEL=<provider>/<model> is required for the live run");
  const models = createModels();
  const at = ref.lastIndexOf("/");
  const model = models.getModel(ref.slice(0, at), ref.slice(at + 1));
  assert.ok(model, `unknown model ${ref}`);
  const registry = { find: (provider: string, id: string) => models.getModel(provider, id) };
  const config: Config = { path: "live", limits: DEFAULT_LIMITS, model: () => ({ harness: "pi", model: ref, from: {} }) };
  const driver = piDriver({ model, modelRegistry: registry } as never, config);
  const caps = driver.capabilities("agent.plan");
  assert.equal(typeof caps.fallback, "boolean");
  assert.ok(caps.thinking.length > 0, "the live model must expose a thinking level");
});
