import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Type } from "typebox";
import { Block, obj, text } from "../src/contracts.ts";
import { assertRuntime, type Capabilities, type Driver, type Runtime, type Spec, type Tool } from "../src/sdk/contract.ts";
import { Conversation, NUDGE } from "../src/session.ts";
import { FULL_CAPS, MINIMAL_CAPS, type FakeOptions } from "./fake.ts";

export const finish = { description: "Submit.", schema: obj({ value: text(4000) }) };
export const tools = (): Tool[] => [
  { name: "echo", description: "Echo.", parameters: obj({ value: text(20) }), run: () => ({ text: "ok", image: { mimeType: "image/png", data: "aGk=" } }) },
  { name: "strict", description: "Strict.", parameters: obj({ n: Type.Integer() }), run: () => "ok" },
  { name: "boom", description: "Boom.", parameters: obj({}), run: () => { throw new Block("boom", "boom"); } },
];

/** Every case drives the adapter through one scripted conversation; the caller's make() supplies the script. */
export function open(driver: Driver, extra: { minutes?: number; turns?: number; signal?: AbortSignal; logs?: string[]; system?: string } = {}) {
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
export async function until(check: () => boolean, deadline = 2000) {
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
export async function adapterConformance(name: string, make: (caps: Capabilities) => Driver, options: FakeOptions = {}, full: Capabilities = FULL_CAPS, fullOnly = false): Promise<void> {
  await assert.rejects(open(make(MINIMAL_CAPS)).run("context"), /isolated context required/);
  const variants = fullOnly ? [full] : [{ ...MINIMAL_CAPS, context: full.context }, full];
  for (const caps of variants) await run(name, caps, make, options);
}
async function run(name: string, caps: Capabilities, make: (caps: Capabilities) => Driver, options: FakeOptions): Promise<void> {
  const aborts = () => options.aborts?.n ?? 0;



  {
    const images = (options.images ??= []);
    const errors = (options.toolErrors ??= []);
    const before = images.length;
    const c = open(make(caps));
    assert.deepEqual(await c.run("tools"), { value: "tools" });
    assert.equal(images.length, before + 1, `${name}: an image tool output reaches the model (${before} -> ${images.length})`);
    assert.ok(errors.some((e) => e.name === "strict"), `${name}: invalid parameters are reported as tool-error events`);
  }


  {
    const prompts = (options.prompts ??= []);
    const c = open(make(caps));
    const before = prompts.length;
    await assert.rejects(c.run("reject"), /submission rejected/);
    assert.match(prompts[before + 1], /Your submit call was rejected/, `${name}: a rejected submit gets the correction prompt`);
  }

  {
    const prompts = (options.prompts ??= []);
    const c = open(make(caps));
    const before = prompts.length;
    await assert.rejects(c.run("refuse"), /ended without calling submit/);
    assert.deepEqual(prompts.slice(before), ["refuse", NUDGE], `${name}: exactly one settlement nudge`);
  }


  {
    const before = aborts();
    const c = open(make(caps));
    assert.deepEqual(await c.run("submit"), { value: "one" });
    assert.equal(aborts(), before, `${name}: a turn that settles after a submission calls abort() zero times`);
  }


  {
    const before = aborts();
    const c = open(make(caps), { minutes: 0.02 });
    const started = Date.now();
    assert.deepEqual(await guarded(c.run("hang-after-submit")), { value: "kept" });
    // An adapter that settles its turn as part of a terminal submit has nothing left to abort.
    assert.equal(aborts(), before + (options.earlyTerminate ? 0 : 1), `${name}: a budget abort stops the turn once`);
    assert.ok(Date.now() - started < 5000, `${name}: the stop is bounded`);
  }

  {
    const c = open(make(caps), { turns: 0 });
    await assert.rejects(c.run("submit"), /turn limit/);
  }

  {
    const before = aborts();
    const c = open(make(caps), { minutes: 0.001 });
    assert.deepEqual(await guarded(c.run("race")), { value: "raced" }, `${name}: a budget abort racing a settle returns the submission`);
    assert.equal(aborts(), before + (options.earlyTerminate ? 0 : 1), `${name}: the racing abort stops the turn once`);
  }

  {
    const prompts = (options.prompts ??= []);
    const c = open(make(caps), { turns: 1 });
    const before = prompts.length;
    await assert.rejects(c.run("refuse"), (error: unknown) => error instanceof Block && error.code === "turn-limit");
    assert.deepEqual(prompts.slice(before), ["refuse"], `${name}: a spent budget issues no further prompt`);
    assert.deepEqual(await c.run("submit"), { value: "one" }, `${name}: a later invocation has a fresh budget`);
  }

  {
    const before = aborts();
    const controller = new AbortController();
    const c = open(make(caps), { signal: controller.signal });
    // An early-terminating adapter has already settled a submit; use a plain hanging turn for this duty.
    const running = c.run(options.earlyTerminate ? "hang" : "hang-after-submit");
    await sleep(50);
    controller.abort(new Block("cancelled", "stopped by the test"));
    await assert.rejects(running, /stopped by the test/);
    assert.equal(aborts(), before + 1, `${name}: a caller abort stops the in-flight turn once`);
  }

  {
    const controller = new AbortController();
    const c = open(make(caps), { signal: controller.signal });
    const running = c.run("slow");
    await sleep(5);
    controller.abort(new Block("cancelled", "raced by the test"));
    await assert.rejects(running, /raced by the test/);
  }


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


  {
    const c = open(make(caps));
    assert.deepEqual(await c.run("submit"), { value: "one" });
    assert.deepEqual(await c.run("submit-two"), { value: "two" }, `${name}: a second run returns its own submission`);
  }


  {
    const logs: string[] = [];
    const c = open(make(caps), { logs });
    const running = c.run("wait");
    await until(() => c.streaming);
    c.deliver("main");
    assert.deepEqual(await running, { value: "ok" });
    assert.equal(logs.filter((line) => line.includes("message queued")).length, 0, `${name}: a steered message is not queued`);
  }


  {
    const c = open(make(caps), { turns: 1 });
    await assert.rejects(c.run("refuse"), (error: unknown) => error instanceof Block && error.code === "turn-limit");
  }
  {
    const c = open(make(caps), { minutes: 0.02 });
    await assert.rejects(guarded(c.run("hang")), (error: unknown) => error instanceof Block && error.code === "time-limit");
  }


  await assert.rejects(open(make(caps)).run("fail"), (error: unknown) => error instanceof Block && error.code === "model");


  {
    const levels = make(caps).capabilities("x").thinking;
    assert.equal(levels.length === 0, !caps.switchModel && caps.thinking.length === 0, `${name}: thinking levels are exposed as data`);
  }


  {
    const preset = (extra: Partial<Runtime>): Runtime => ({ name: "plan", sdk: name, path: "/plan", via: "/plan", ...extra });
    const iso = { ...caps, context: FULL_CAPS.context };
    if (caps.thinking.length === 0) {
      assert.throws(() => assertRuntime(preset({ thinking: "high" }), iso),
        (error: unknown) => error instanceof Block && error.code === "capability" && /\/plan\/thinking/.test(error.message),
        `${name}: a configured level without level control is denied naming the preset path`);
    } else {
      assert.doesNotThrow(() => assertRuntime(preset({ thinking: "high" }), iso), `${name}: a supported level is accepted`);
    }
  }


  {
    const logs: string[] = [];
    const c = open(make(caps), { logs, system: "SYSTEM-X" });
    const result = await c.run("context");
    assert.equal(result.value, "SYSTEM-X", `${name}: an isolating harness sees exactly spec.system`);
  }


  {
    const driver = make(caps);
    const first = await open(driver).run("id");
    const second = await open(driver).run("id");
    assert.notEqual(first.value, second.value, `${name}: each Conversation gets its own spec.id`);
    assert.ok(first.value.length > 10, `${name}: spec.id is a real identity`);
  }
}