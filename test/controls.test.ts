import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai/models";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Block, obj, text } from "../src/contracts.ts";
import { EMPTY } from "../src/runtime/resources.ts";
import { tool, type CoreHandle, type Driver, type Handle, type Runtime, type RuntimeChange, type SDKAdapter, type Spec } from "../src/sdk/contract.ts";
import { createDriver, type HostServices } from "../src/sdk/registry.ts";
import { thinkingLevels } from "../src/sdk/pi.ts";
import { Conversation } from "../src/session.ts";
import { Telemetry } from "../src/telemetry.ts";
import { FULL_CAPS, planSubmission, repo, setup } from "./fake.ts";

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
    assert.equal(log.length, 3);
    assert.equal(log[1], `configure {"model":"p/a","thinking":"high"}`, "one merged change, before the next prompt");
    assert.equal(c.pendingChange, undefined);
    assert.equal(await c.configure({ thinking: "low" }), "applied", "idle sessions change immediately");
    c.dispose();
    await assert.rejects(c.configure({ thinking: "low" }), /ended/);
  } finally { clearTimeout(keep); }
});

test("registry: configure validates against the new model and tracks the runtime", async () => {
  const applied: RuntimeChange[] = [];
  const levels: Record<string, string[]> = { "m/a": ["off", "low", "high"], "m/b": ["off"] };
  const adapter: SDKAdapter = {
    models: async () => ["m/a", "m/b"],
    capabilities: (runtime: Runtime) => ({ ...FULL_CAPS, thinking: levels[runtime.model ?? "m/a"] ?? [] }),
    validateRuntime: () => {},
    async open() {
      const handle: Handle = { prompt: async () => "completed", get streaming() { return false; }, abort: async () => {}, dispose() {},
        configure: async (change) => { applied.push(change); } };
      return handle;
    },
  };
  const runtime: Runtime = { name: "plan", sdk: "pi", model: "m/a", thinking: "low", path: "/plan", via: "/plan" };
  const driver = await createDriver({}, EMPTY, { pi: { load: async () => adapter } });
  const handle = await driver.open({ id: "s", runtime, name: "agent.plan", cwd: process.cwd(), system: "S", tools: [], emit() {}, signal: new AbortController().signal });
  assert.equal(handle.runtime?.thinking, "low");
  assert.throws(() => handle.check!({ model: "m/b", thinking: "high" }), (e: unknown) => e instanceof Block && e.code === "capability", "thinking is judged against the new model");
  await handle.configure!({ thinking: "high" });
  assert.equal(handle.runtime?.thinking, "high");
  await handle.configure!({ model: "m/b", thinking: "off" });
  assert.deepEqual(applied, [{ thinking: "high" }, { model: "m/b", thinking: "off" }]);
  assert.deepEqual(handle.runtime, { ...runtime, model: "m/b", thinking: "off" });
});

test("Pi applies a queued model and thinking switch after tools, within the same prompt", { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "worq-runtime-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
  const [first, second] = modelRuntime.getAllModels().filter(m => isModelType(m, "chat"))
    .filter(m => m.provider === "openai" && ["medium", "high"].every(level => thinkingLevels(m).includes(level)));
  assert.ok(first && second);
  await modelRuntime.setRuntimeApiKey("openai", "test-transport-only");
  const registry = { runtime: modelRuntime, find: (provider: string, id: string) => [first, second].find(m => m.provider === provider && m.id === id) };
  const driver = await createDriver({ pi: { model: first, modelRegistry: registry as unknown as NonNullable<HostServices["pi"]>["modelRegistry"], thinkingLevel: "medium", agentDir: cwd } });
  const requests: { model: string; thinking?: string; roles: string[] }[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  modelRuntime.streamSimple = (model, { messages }, options) => {
    requests.push({ model: model.id, thinking: options?.reasoning, roles: messages.map(m => m.role) });
    const initial = requests.length === 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "toolUse", message: {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id: `call_${requests.length}`, name: initial ? "hold" : "submit", arguments: initial ? {} : { value: "done" } }],
    } });
    return stream;
  };
  let release: (() => void) | undefined;
  let warmed = 0;
  const hold = tool("hold", "Wait for the test.", obj({}), () => new Promise<string>(resolve => { release = () => resolve("tool finished"); }));
  const c = new Conversation({ driver, finish, signal: new AbortController().signal, turns: 4, minutes: 1, onFirstResponse: () => { warmed++; },
    spec: { name: "agent.plan", cwd, system: "S", tools: [hold], log() {} } });
  const done = c.run("go");
  void done.catch(() => {});
  try {
    await until(() => release !== undefined);
    assert.equal(warmed, 1, "the tool-only response warms before its tool finishes");
    assert.equal(c.runtime?.model, `openai/${first.id}`);
    assert.equal(c.runtime?.thinking, "medium");
    assert.equal(await c.configure({ model: `openai/${second.id}` }), "queued");
    assert.equal(await c.configure({ thinking: "high" }), "queued");
    assert.equal(requests.length, 1, "the running tool is not interrupted");
    assert.equal(c.runtime?.model, `openai/${first.id}`);
    release!();
    assert.deepEqual(await done, { value: "done" });
    assert.deepEqual(requests.map(({ model, thinking }) => [model, thinking]), [[first.id, "medium"], [second.id, "high"]]);
    assert.deepEqual(requests[1].roles, ["system", "user", "assistant", "toolResult"], "the next request keeps the same history");
    assert.equal(c.runtime?.model, `openai/${second.id}`);
    assert.equal(c.runtime?.thinking, "high");
    assert.equal(c.pendingChange, undefined);
    assert.equal(warmed, 1, "one callback across responses");
  } finally { release?.(); c.dispose(); }
});

test("Pi overlaps read-only calls and serializes mixed batches", { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "worq-read-batch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
  const model = runtime.getAllModels().filter(m => isModelType(m, "chat")).find(m => m.provider === "openai")!;
  await runtime.setRuntimeApiKey("openai", "test-transport-only");
  const modelRegistry = { runtime, find: () => model } as unknown as NonNullable<HostServices["pi"]>["modelRegistry"];
  const driver = await createDriver({ pi: { model, modelRegistry, thinkingLevel: "off", agentDir: cwd } });
  const releases: (() => void)[] = [];
  const toolOrder: string[] = [];
  const read = tool("read_probe", "Read without mutation.", obj({ value: text(100) }), ({ value }) => {
    toolOrder.push(value);
    return new Promise<string>(resolve => releases.push(() => resolve(value)));
  }, { parallel: true });
  const write = tool("write_probe", "Mutate state.", obj({}), () => { toolOrder.push("write"); return "written"; });
  const batches = [["read_probe", "read_probe"], ["read_probe", "write_probe", "read_probe"], ["submit"]];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let request = 0;
  runtime.streamSimple = (model) => {
    const stream = createAssistantMessageEventStream();
    const names = batches[request++];
    stream.push({ type: "done", reason: "toolUse", message: {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: "toolUse",
      content: names.map((name, i) => ({ type: "toolCall", id: `${request}_${i}`, name,
        arguments: { ...(name === "write_probe" ? {} : { value: name === "submit" ? "done" : `${request}_${i}` }) } })),
    } });
    return stream;
  };
  const c = new Conversation({ driver, finish, signal: new AbortController().signal, turns: 6, minutes: 1,
    spec: { name: "agent.plan", cwd, system: "S", tools: [read, write], log() {} } });
  const done = c.run("go");
  void done.catch(() => {});
  try {
    await until(() => releases.length === 2);
    assert.deepEqual(toolOrder, ["1_0", "1_1"]);
    releases[1]();
    releases[0]();
    await until(() => releases.length === 3);
    assert.deepEqual(toolOrder, ["1_0", "1_1", "2_0"]);
    releases[2]();
    await until(() => releases.length === 4);
    assert.deepEqual(toolOrder, ["1_0", "1_1", "2_0", "write", "2_2"]);
    releases[3]();
    assert.deepEqual(await done, { value: "done" });
  } finally { for (const release of releases) release(); c.dispose(); }
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
  await until(() => agent.delegations[0].state === "cancelled");
  assert.equal(agent.delegations[1].state, "running", "the sibling keeps running");
  assert.ok(!agent.ended, "the parent keeps running");
  assert.equal(answers.length, 0, "child results wait for open siblings (one coalesced wake)");
  assert.ok(!worq.sessions.has(pqs[0].key), "unregistered on disposal");
  await pqs[1].cancel();
  await until(() => answers.length === 1);
  assert.match(answers[0], /^\[PQ cancelled\] First question\?[\s\S]*cancelled by Main[\s\S]*\[PQ cancelled\] Second question\?/, "the parent is told once, about both");
  await assert.rejects(worq.configure(agent.ref, { thinking: "high" }), /cannot change a live session/, "a harness without configure refuses instead of dropping the change");
  await owner.cancel();
  assert.equal(agent.state, "cancelled");
  assert.equal(agent.delegations[1].state, "cancelled");
  assert.equal(worq.sessions.size, 0);
  assert.throws(() => worq.session(agent.ref), /no longer live/);
});

test("controls: cancelling the review records it inconclusive; the agent still parks", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let hung = 0;
  const { worq, next } = setup(root, state, {
    "agent.plan": async (turn) => { await turn.tool("submit", planSubmission); },
    review: async () => { hung++; await new Promise(() => {}); },
  }, {}, new Telemetry());
  const agent = await worq.spawn("plan", "Plan it", { title: "Reviewer cancel" });
  await until(() => hung === 1);
  const review = [...worq.sessions.values()].find((s) => s.role === "review")!;
  assert.match(review.consequence, /inconclusive/);
  await review.cancel();
  await next("parked", agent.ref);
  assert.equal(agent.review?.verdict, "inconclusive");
  assert.equal(agent.review?.error, "Review cancelled by Main");
  await worq.cancel(agent.ref);
});
