import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { forkedAnswer, type AgentEvent } from "../src/agent.ts";
import { balanced } from "../src/sdk/pi.ts";
import type { Capabilities, Spec } from "../src/sdk/contract.ts";
import { Worq } from "../src/worq.ts";
import { config, fakeDriver, FULL_CAPS, KINDS, planSubmission, repo, type FakeOptions, type Script } from "./fake.ts";

const FORK_CAPS: Capabilities = { ...FULL_CAPS, contextFork: true };

async function harness(t: import("node:test").TestContext, scripts: Record<string, Script>, caps: Capabilities = FULL_CAPS, options: FakeOptions = {}) {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen: Spec[] = [];
  const events: AgentEvent[] = [];
  const worq = new Worq({ driver: fakeDriver(scripts, seen, caps, options), kinds: KINDS, config: config(), state, cwd: root, notify: (e) => events.push(e) });
  t.after(() => worq.shutdown());
  const until = async (fn: () => boolean) => { const end = Date.now() + 15_000; while (!fn()) { if (Date.now() > end) throw new Error(JSON.stringify(events.map((e) => e.type))); await new Promise((r) => setTimeout(r, 10)); } };
  return { worq, seen, until };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

test("pi balanced(): cuts before an in-flight assistant turn and drops non-forkable roles", () => {
  const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id }] });
  const history = [{ role: "system", content: "s" }, { role: "user", content: "task" }, call("a"), { role: "toolResult", toolCallId: "a" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "custom" }];
  assert.deepEqual(balanced(history).map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
  const inFlight = [...history.slice(0, 4), call("b"), call("c"), { role: "toolResult", toolCallId: "b" }];
  assert.deepEqual(balanced(inFlight).map((m) => m.role), ["user", "assistant", "toolResult"]);
});

test("forkedAnswer maps the parent's submit schema onto a PQ answer", () => {
  assert.deepEqual(forkedAnswer({ summary: "Basis: observed. app.py:1 prints it", report: "unclear: tests" }), { answer: "app.py:1 prints it", basis: "observed", unresolved: ["unclear: tests"] });
  assert.equal(forkedAnswer({ summary: "no basis line" }).basis, "assumed");
});

test("coalesced PQs: three concurrent answers wake the parent once, together", async (t) => {
  const texts: string[] = [];
  const { worq, until } = await harness(t, {
    "agent.plan": async (turn) => {
      texts.push(turn.text);
      if (turn.text.includes('"task"')) {
        for (const q of ["One?", "Two?", "Three?"]) await turn.tool("delegate", { question: q, why: "w" });
        return;
      }
      await turn.tool("submit", planSubmission);
    },
    subagent: async (turn) => {
      const q = JSON.parse(turn.text).question as string;
      await new Promise((r) => setTimeout(r, q === "One?" ? 5 : q === "Two?" ? 60 : 120));
      await turn.tool("submit", { answer: `answer ${q}`, basis: "observed" });
    },
  });
  const agent = await worq.spawn("plan", "Plan it");
  await until(() => agent.ended || agent.state === "parked");
  const woken = texts.filter((x) => x.includes("[PQ]"));
  assert.equal(woken.length, 1, "one combined wake");
  for (const q of ["One?", "Two?", "Three?"]) assert.match(woken[0], new RegExp(`\\[PQ\\] ${q.replace("?", "\\?")}`));
  assert.equal(agent.delegationPeak, 3);
});

test("coalesced PQs: a Main message still wakes the waiting parent immediately", async (t) => {
  const texts: string[] = [];
  const hold = deferred();
  const { worq, until } = await harness(t, {
    "agent.plan": async (turn) => {
      texts.push(turn.text);
      if (turn.text.includes('"task"')) { await turn.tool("delegate", { question: "Slow?", why: "w" }); return; }
      if (turn.text.startsWith("Main:")) { hold.resolve(); return; }
      await turn.tool("submit", planSubmission);
    },
    subagent: async (turn) => { await hold.promise; await turn.tool("submit", { answer: "late", basis: "observed" }); },
  }, FULL_CAPS, { steer: "none" });
  const agent = await worq.spawn("plan", "Plan it");
  await until(() => agent.delegations[0]?.state === "running" && texts.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  worq.send(agent.ref, "focus on tests");
  await until(() => agent.ended || agent.state === "parked");
  assert.deepEqual(texts.map((x) => x.split("\n")[0].slice(0, 12)), ["{", "Main: focus ", "[PQ] Slow?"]);
});

test("fork: child reuses the parent's system, tools and finish schema, seeded with its history; disabled tools fence", async (t) => {
  let parent: Spec | undefined;
  const { worq, seen, until } = await harness(t, {
    "agent.plan": async (turn) => {
      parent = turn.spec;
      if (turn.text.includes('"task"')) {
        await turn.tool("read_file", { path: "app.py" });
        await turn.tool("delegate", { name: "minimal", question: "Smallest change?", why: "lens", fork: true });
        await turn.tool("delegate", { name: "risks", question: "Failure modes?", why: "lens", fork: true });
        return;
      }
      assert.match(turn.text, /Answer \(observed\): edit app\.py:1/);
      await turn.tool("submit", planSubmission);
    },
    "subagent.minimal": async (turn) => {
      assert.match(await turn.tool("delegate", { question: "nested?", why: "w" }), /Disabled in a forked PQ/);
      assert.match(await turn.tool("ask_main", { question: "?" }), /Disabled in a forked PQ/);
      assert.match(await turn.tool("read_file", { path: "app.py" }), /hello/);
      await turn.tool("submit", { summary: "Basis: observed. edit app.py:1" });
    },
    "subagent.risks": async (turn) => { await turn.tool("submit", { summary: "Basis: assumed. none" }); },
  }, FORK_CAPS, { snapshot: (spec) => [{ role: "user", content: `history of ${spec.name}` }] });
  const agent = await worq.spawn("plan", "Plan it");
  await until(() => agent.ended || agent.state === "parked");
  const child = seen.find((s) => s.name === "subagent.minimal")!;
  assert.equal(child.system, parent!.system, "byte-identical system prompt");
  assert.deepEqual(child.tools.map((x) => [x.name, x.description, JSON.stringify(x.parameters)]), parent!.tools.map((x) => [x.name, x.description, JSON.stringify(x.parameters)]));
  assert.deepEqual(child.seed, [{ role: "user", content: "history of agent.plan" }]);
  const view = agent.view();
  assert.deepEqual(view.delegations.map((d) => d.forked), [true, true]);
  assert.equal(view.delegationPeak, 2);
  assert.equal(agent.delegations[0].answer?.basis, "observed");
});

test("fork: falls back to a fresh PQ when the harness cannot fork", async (t) => {
  const { worq, seen, until } = await harness(t, {
    "agent.plan": async (turn) => {
      if (turn.text.includes('"task"')) { await turn.tool("delegate", { question: "Q?", why: "w", fork: true }); return; }
      await turn.tool("submit", planSubmission);
    },
    subagent: async (turn) => {
      assert.deepEqual(turn.spec.tools.map((x) => x.name).sort(), ["list_files", "read_file", "search", "submit"]);
      await turn.tool("submit", { answer: "a", basis: "observed" });
    },
  });
  const agent = await worq.spawn("plan", "Plan it");
  await until(() => agent.ended || agent.state === "parked");
  const child = seen.find((s) => s.name === "subagent")!;
  assert.equal(child.seed, undefined);
  assert.match(child.system, /Probing question/);
  assert.equal(agent.delegations[0].forked, false);
  assert.equal(agent.delegations[0].state, "answered");
});
