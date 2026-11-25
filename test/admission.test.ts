import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Block } from "../src/contracts.ts";
import type { Capabilities, Driver, RequestDecision, Runtime } from "../src/sdk/contract.ts";
import { Conversation } from "../src/session.ts";
import { obj, text } from "../src/contracts.ts";
import { DEFAULT_LIMITS } from "../src/runtime/config.ts";
import type { Observation } from "../src/telemetry.ts";
import { Worq } from "../src/worq.ts";
import { KINDS } from "./fake.ts";

const ADMITTED: Capabilities = {
  switchModel: true, thinking: ["low", "high"], turnUnit: "request", requestAdmission: "awaited",
  context: { system: "replace", ambientInstructions: false },
};
const finish = { description: "Submit.", schema: obj({ value: text(200) }) };
const runtime: Runtime = { name: "launch", sdk: "claude-code", model: "claude-sonnet-4-5", path: "", via: "launch request" };

test("admission: a stale callback is refused and cannot spend a later prompt's token", async () => {
  let captured: ((signal: AbortSignal) => Promise<RequestDecision>) | undefined;
  const driver: Driver = {
    capabilities: () => ADMITTED,
    async open(spec) {
      captured = spec.admitRequest;
      return {
        async prompt(_text, signal) {
          const decision = await spec.admitRequest!(signal!);
          if (!decision.allowed) return "aborted";
          await spec.tools.find((tool) => tool.name === "submit")!.run({ value: "ok" }, signal!);
          return "completed";
        },
        get streaming() { return false; },
        async abort() {},
        dispose() {},
      };
    },
  };
  const c = new Conversation({ driver, signal: new AbortController().signal, turns: 4, minutes: 1, finish,
    spec: { name: "x", cwd: process.cwd(), system: "S", runtime, tools: [], log() {} } });
  assert.deepEqual(await c.run("go"), { value: "ok" });
  const stale = new AbortController();
  const decision = await captured!(stale.signal);
  assert.equal(decision.allowed, false, "an old prompt's admission callback is refused");
  c.dispose();
});

test("admission: cancelling while the adapter waits for admission settles the run and stops the handle", async () => {
  let aborts = 0;
  let release: (() => void) | undefined;
  let streaming = false;
  const driver: Driver = {
    capabilities: () => ADMITTED,
    async open(spec) {
      return {
        async prompt(_text, signal) {
          streaming = true;
          const decision = await spec.admitRequest!(signal!);
          if (!decision.allowed) { streaming = false; return "aborted"; }
          await new Promise<void>((resolve) => { release = resolve; });
          streaming = false;
          return "aborted";
        },
        get streaming() { return streaming; },
        async abort() { aborts++; release?.(); streaming = false; },
        dispose() {},
      };
    },
  };
  const caller = new AbortController();
  const c = new Conversation({ driver, signal: caller.signal, turns: 4, minutes: 1, finish,
    spec: { name: "x", cwd: process.cwd(), system: "S", runtime, tools: [], log() {} } });
  const running = c.run("wait");
  await sleep(20);
  caller.abort(new Block("cancelled", "cancelled by the test"));
  await assert.rejects(running, /cancelled by the test/);
  assert.equal(aborts, 1, "the core stops the in-flight adapter turn once");
  c.dispose();
});

test("fatal runtime invalidation is latched, clears pending settings, and forbids later runs", async () => {
  const observations: Observation[] = [];
  let c!: Conversation<typeof finish.schema>;
  let applied = "claude-sonnet-4-5";
  // A purpose-built handle: the switch queues configure while the prompt is active; the continuation
  // admission then applies it and hits the fatal failure after the first native update.
  const driver: Driver = {
    capabilities: () => ADMITTED,
    async open(spec) {
    let streaming = false;
    return {
      async prompt(_text, signal) {
        streaming = true;
        const first = await spec.admitRequest!(signal!);
        if (!first.allowed) { streaming = false; return "aborted"; }
        await c.configure({ model: "claude-opus-4-1" });
        const continuation = await spec.admitRequest!(signal!);
        if (continuation.allowed) await spec.tools.find((tool) => tool.name === "submit")!.run({ value: "leak" }, signal!);
        streaming = false;
        return continuation.allowed ? "completed" : "aborted";
      },
      get streaming() { return streaming; },
      async abort() { streaming = false; },
      get runtime() { return { ...runtime, model: applied }; },
      async configure(change) {
        applied = change.model ?? applied;
        throw new Block("runtime-invalidated", "Claude reported a mixed state after the switch");
      },
      dispose() {},
    };
    },
  };
  const switchTool = { name: "switch", description: "switch", parameters: obj({}), run: async () => "ok" };
  c = new Conversation({ driver, signal: new AbortController().signal, turns: 4, minutes: 1, finish,
    spec: { name: "x", cwd: process.cwd(), system: "S", runtime, tools: [switchTool], log() {}, observe: (value) => observations.push(value) } });
  await assert.rejects(c.run("go"), (error: unknown) => error instanceof Block && error.code === "runtime-invalidated");
  assert.equal(c.invalidated, true);
  assert.equal(c.pendingChange, undefined, "pending settings are cleared");
  assert.ok(observations.some((value) => "setup" in value && value.setup.model === undefined), "telemetry shows unavailable, not stale settings");
  await assert.rejects(c.run("again"), (error: unknown) => error instanceof Block && error.code === "runtime-invalidated");
  await assert.rejects(c.configure({ model: "claude-opus-4-1" }), (error: unknown) => error instanceof Block && error.code === "runtime-invalidated");
  c.dispose();
});

test("worq.choices does not fall back to Main for an invalidated session", async () => {
  const worq = new Worq({
    driver: { capabilities: () => ADMITTED, async open() { throw new Error("not opened"); } },
    kinds: KINDS, config: { path: "test", limits: { ...DEFAULT_LIMITS } }, state: "/tmp/worq-admission-state", cwd: process.cwd(),
    notify() {},
  });
  worq.sessions.set("bad", {
    key: "bad", ref: "bad", role: "agent.plan", label: "bad", consequence: "none",
    runtime: () => undefined, invalidated: () => true, pending: () => undefined,
    cancel: async () => "cancelled", configure: async () => "applied",
  });
  await assert.rejects(worq.choices("bad"), (error: unknown) => error instanceof Block && error.code === "runtime-invalidated");
});
