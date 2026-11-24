import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { DEFAULT_LIMITS, MAIN, type Config } from "../src/runtime/config.ts";
import { Block, obj, text } from "../src/contracts.ts";
import { EMPTY, type Resources } from "../src/runtime/resources.ts";
import { assertRuntime, type Capabilities, type Driver, type Handle, type Runtime, type SDKAdapter, type SessionSpec, type Spec, type Tool } from "../src/sdk/contract.ts";
import { createDriver, type SDKRecord } from "../src/sdk/registry.ts";
import { piAdapter, thinkingLevels } from "../src/sdk/pi.ts";
import { Conversation, NUDGE } from "../src/session.ts";
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
    spec: { name: "x", cwd: process.cwd(), system: extra.system ?? "SYSTEM", tools: tools(), log: (line) => { extra.logs?.push(line); } },
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
    assert.ok(errors.some((e) => e.name === "strict"), `${name}: invalid parameters are reported as tool-error events`);
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
    const spec: Spec = { id: "duty", name: "x", cwd: process.cwd(), system: "S", tools: [], emit() {}, signal: new AbortController().signal };
    const handle = await make(caps).open(spec);
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
    if (caps.switchModel) {
      assert.ok(!(outcome instanceof Block), `${name}: with a fallback the request continues`);
      assert.match(prompts[before + 1] ?? "", /previous model request failed/, `${name}: the fallback re-prompts with CONTINUE`);
    } else {
      assert.ok(outcome instanceof Block && outcome.code === "model", `${name}: no fallback left is Block(model)`);
    }
  }

  // thinking: the list is data on the adapter, empty only without level control
  {
    const levels = make(caps).capabilities("x").thinking;
    assert.equal(levels.length === 0, !caps.switchModel && caps.thinking.length === 0, `${name}: thinking levels are exposed as data`);
  }

  // denial paths: a capability-minimal adapter must refuse what it cannot do, naming the config path
  {
    const preset = (extra: Partial<Runtime>): Runtime => ({ name: "p", sdk: name, path: "/runtimes/p", via: "/roles/agent", ...extra });
    const iso = { ...caps, context: FULL_CAPS.context };
    if (caps.switchModel) {
      assert.doesNotThrow(() => assertRuntime(preset({ fallbackModel: "p/m" }), iso), `${name}: a supported fallback is accepted`);
    } else {
      assert.throws(() => assertRuntime(preset({ fallbackModel: "p/m" }), iso),
        (error: unknown) => error instanceof Block && error.code === "capability" && /\/runtimes\/p\/fallbackModel/.test(error.message),
        `${name}: a configured fallback on an sdk without model switching is denied naming the preset path`);
    }
    if (caps.thinking.length === 0) {
      assert.throws(() => assertRuntime(preset({ thinking: "high" }), iso),
        (error: unknown) => error instanceof Block && error.code === "capability" && /\/runtimes\/p\/thinking/.test(error.message),
        `${name}: a configured level without level control is denied naming the preset path`);
    } else {
      assert.doesNotThrow(() => assertRuntime(preset({ thinking: "high" }), iso), `${name}: a supported level is accepted`);
    }
    if (!caps.extensions) assert.throws(() => assertRuntime(preset({}), iso, 1), /cannot load/, `${name}: installed extensions need an sdk that loads them`);
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
  record.fallbacks = caps.switchModel ? 1 : 0;
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
function recordingSdk(caps: Capabilities, seen: SessionSpec[], switched: string[]): SDKRecord {
  return {
    modelRef: /.*/,
    load: async (): Promise<SDKAdapter> => ({
      capabilities: () => caps,
      async open(spec) {
        seen.push(spec);
        const handle: Handle = {
          prompt: async () => "completed", get streaming() { return false; }, abort: async () => {}, dispose() {},
          switchModel: async (ref) => { switched.push(ref); },
        };
        return handle;
      },
    }),
  };
}
const configFor = (runtime: (role: string) => Runtime, sdks: string[] = ["pi"]): Config =>
  ({ path: "test", limits: DEFAULT_LIMITS, approveExtensions: false, sdks, runtime });
const roleSpec = (name: string): Spec => ({ id: "s", name, cwd: process.cwd(), system: "S", tools: [], emit() {}, signal: new AbortController().signal });

test("registry: createDriver routes by runtime, prepares the shared environment, owns fallback", async () => {
  const seen: SessionSpec[] = [];
  const switched: string[] = [];
  const sdks = { pi: recordingSdk(FULL_CAPS, seen, switched), test: recordingSdk(FULL_CAPS, seen, switched) };
  const fast: Runtime = { name: "fast", sdk: "test", model: "m/a", fallbackModel: "m/b", path: "/runtimes/fast", via: "/roles/subagent" };
  const config = configFor((role) => role === "subagent" ? fast : { ...MAIN }, ["test"]);
  const resources: Resources = { root: "/r", instructions: [{ name: "a.md", text: "Shared rule" }], skills: [{ name: "lint", description: "How to lint", body: "Run lint" }], extensions: [{ name: "e.mjs", bytes: Buffer.from("") }] };
  const driver = await createDriver({}, config, resources, sdks);
  for (const role of ["agent.plan", "subagent", "reviewer.intent"]) {
    const handle = await driver.open(roleSpec(role));
    const spec = seen.at(-1)!;
    assert.equal(spec.runtime.sdk, role === "subagent" ? "test" : "pi", `${role} routes to its runtime's sdk`);
    assert.match(spec.system, /^S\n\nOperator instructions a\.md[\s\S]*Shared rule[\s\S]*- lint: How to lint/, `${role}: same instructions and skill index`);
    assert.ok(!spec.system.includes("Run lint"), `${role}: skill bodies load on demand`);
    assert.equal(await spec.tools.find((t) => t.name === "skill")!.run({ name: "lint" }, new AbortController().signal), "Run lint");
    assert.equal(spec.extensions.length, 1, `${role}: same extensions`);
    assert.equal(spec.thinking, role === "subagent" ? "low" : "low", "core default thinking level");
    assert.equal(await handle.fallback(), role === "subagent", "fallback only when the runtime names one");
    assert.equal(await handle.fallback(), false, "fallback is used once");
  }
  assert.deepEqual(switched, ["m/b"]);

  const minimal = await createDriver({}, configFor(() => ({ ...MAIN })), resources, { pi: recordingSdk({ ...FULL_CAPS, extensions: false }, [], []) });
  await assert.rejects(minimal.open(roleSpec("agent.plan")), (error: unknown) => error instanceof Block && error.code === "capability" && /extension/.test(error.message));
  const unknown = await createDriver({}, configFor(() => ({ ...MAIN, sdk: "claude" })), EMPTY, sdks);
  assert.throws(() => unknown.capabilities("agent.plan"), (error: unknown) => error instanceof Block && error.code === "config" && /unknown sdk "claude"/.test(error.message));
});

test("pi: capability snapshot derives thinking from the runtime's model", () => {
  const model = { provider: "p", id: "m", reasoning: true, thinkingLevelMap: { xhigh: "x" } };
  const registry = { find: (provider: string, id: string) => provider === "p" && id === "m" ? model : undefined };
  const adapter = piAdapter({ model: undefined, modelRegistry: registry } as never);
  const caps = adapter.capabilities({ ...MAIN, model: "p/m", path: "/runtimes/x" });
  assert.equal(caps.switchModel, true);
  assert.equal(caps.turnUnit, "request");
  assert.deepEqual(caps.thinking, ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(caps.context, { system: "replace", ambientInstructions: false });
  assert.deepEqual(piAdapter({ model, modelRegistry: registry } as never).capabilities(MAIN).thinking, caps.thinking, "no runtime model: Main's model");
  assert.throws(() => adapter.capabilities({ ...MAIN, model: "q/z", path: "/runtimes/x" }), /\/runtimes\/x\/model: Pi does not know model q\/z/);
  assert.deepEqual(thinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(thinkingLevels(undefined), []);
});

test("pi: nothing to resolve is Block(model)", async () => {
  const driver = await createDriver({ pi: { model: undefined, modelRegistry: { find: () => undefined } } as never }, configFor(() => ({ ...MAIN })));
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
  const runtime: Runtime = { name: "live", sdk: "pi", model: ref, path: "/runtimes/live", via: "/default" };
  const driver = await createDriver({ pi: { model, modelRegistry: registry } as never }, configFor(() => runtime));
  const caps = driver.capabilities("subagent");
  assert.ok(caps.thinking.length > 0, "the live model must expose a thinking level");
  const logs: string[] = [];
  const c = new Conversation({
    driver, signal: new AbortController().signal, turns: 6, minutes: 3, finish,
    spec: { name: "subagent", cwd: process.cwd(), system: "You are a conformance probe. Call submit with value set to the word ready.", tools: tools(), log: (line) => { logs.push(line); } },
  });
  try {
    const result = await c.run("Call the echo tool with value hi, then call submit with value ready.");
    assert.equal(result.value.trim().toLowerCase(), "ready");
    assert.ok(logs.some((line) => line.startsWith("→ echo")), "the real SDK dispatched a Worq tool");
  } finally { c.dispose(); }
});
