import { createHash } from "node:crypto";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { applyResources } from "../src/resources.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type Semaphore } from "../src/agent.ts";
import { DEFAULT_LIMITS, loadConfig, type Config } from "../src/config.ts";
import { Block } from "../src/contracts.ts";
import { piDriver } from "../src/pi.ts";
import { loadPrompts } from "../src/prompts.ts";
import { assertChoice, type Spec } from "../src/session.ts";
import { Worq } from "../src/worq.ts";
import { fakeDriver, fakeHarness, FULL_CAPS, MINIMAL_CAPS, pass, repo } from "./fake.ts";

async function configOf(value: unknown, harnesses?: string[]): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "worq-config-"));
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify(value));
  return harnesses ? loadConfig(dir, harnesses) : loadConfig(dir);
}
const configError = (error: unknown) => error instanceof Block && error.code === "config";

/** The plan's §8 example: the resolution walk's precedence table, row by row. */
const example = {
  harness: "pi",
  fallbackModel: "anthropic/claude-haiku-4-5",
  harnesses: { pi: { model: "openai/gpt-5", thinking: "medium" } },
  models: {
    agent: { harness: "pi" },
    "agent.execute": { thinking: "high" },
    subagent: { model: "anthropic/claude-haiku-4-5", thinking: "low" },
    reviewer: { model: "openai/gpt-5", thinking: "high" },
    "reviewer.intent": { harness: "pi" },
  },
  limits: { rounds: 3 },
};

test("config: the resolution walk matches the plan's table", async () => {
  const config = await configOf(example);
  const rows: [role: string, harness: string, model: string, thinking: string][] = [
    ["agent.plan", "pi", "openai/gpt-5", "medium"],
    ["agent.execute", "pi", "openai/gpt-5", "high"],
    ["subagent", "pi", "anthropic/claude-haiku-4-5", "low"],
    ["reviewer.intent", "pi", "openai/gpt-5", "high"],
    ["reviewer.pair", "pi", "openai/gpt-5", "high"],
  ];
  for (const [role, harness, model, thinking] of rows) {
    const choice = config.model(role);
    assert.equal(choice.harness, harness, `${role} harness`);
    assert.equal(choice.model, model, `${role} model`);
    assert.equal(choice.thinking, thinking, `${role} thinking`);
    assert.equal(choice.fallbackModel, "anthropic/claude-haiku-4-5", `${role} inherits the top-level fallback`);
    assert.equal(choice.from.fallbackModel, "/fallbackModel", `${role} fallback origin`);
  }
  const plan = config.model("agent.plan");
  assert.equal(plan.from.harness, "/models/agent/harness", "the first explicit harness in the walk wins");
  assert.equal(plan.from.model, "/harnesses/pi/model", "harnesses.pi.model is the second walk step");
  assert.equal(plan.from.thinking, "/harnesses/pi/thinking");
  const execute = config.model("agent.execute");
  assert.equal(execute.from.harness, "/models/agent/harness", "the profile layer supplies the harness");
  assert.equal(execute.from.thinking, "/models/agent.execute/thinking", "its own layer supplies only the level");
  assert.equal(execute.from.model, "/harnesses/pi/model");
  const intent = config.model("reviewer.intent");
  assert.equal(intent.from.model, "/models/reviewer/model", "an unharnessed layer is attributed to the resolved harness");
  assert.equal(intent.from.thinking, "/models/reviewer/thinking");
});

test("config: harnesses.<h>.model shadows the top-level model", async () => {
  const config = await configOf({ model: "top/m", fallbackModel: "fb/m", harnesses: { pi: { model: "h/m" } } });
  const choice = config.model("agent.plan");
  assert.equal(choice.model, "h/m");
  assert.equal(choice.from.model, "/harnesses/pi/model");
  assert.equal(choice.fallbackModel, "fb/m", "only the model is shadowed");
  assert.equal(choice.from.fallbackModel, "/fallbackModel");
});

test("config: a layer declaring another harness lends nothing to this role", async () => {
  const config = await configOf(
    { models: { reviewer: { harness: "claude", thinking: "high" }, "reviewer.intent": { harness: "pi" } } },
    ["pi", "claude"],
  );
  const choice = config.model("reviewer.intent");
  assert.equal(choice.harness, "pi");
  assert.equal(choice.thinking, undefined, "the claude layer's level does not reach a pi role");
  assert.equal(choice.from.thinking, undefined);
});

test("config: {\"model\": \"a/m\"} with no top-level harness still resolves to pi", async () => {
  const config = await configOf({ model: "a/m" });
  const choice = config.model("agent.plan");
  assert.equal(choice.harness, "pi");
  assert.equal(choice.model, "a/m");
  assert.equal(choice.from.model, "/model");
  assert.equal(choice.from.harness, undefined, "the default harness has no config origin");
});

test("config: each harness validates its own model refs, naming the key", async () => {
  await assert.rejects(configOf({ model: "not-a-ref" }), (error) => configError(error) && /\/model/.test((error as Block).message));
  await assert.rejects(configOf({ harnesses: { pi: { model: "also-bad" } } }), (error) => configError(error) && /\/harnesses\/pi\/model/.test((error as Block).message));
  await assert.rejects(configOf({ models: { subagent: { model: "/bad" } } }), (error) => configError(error) && /\/models\/subagent\/model/.test((error as Block).message));
  await assert.rejects(configOf({ models: { subagent: { harness: "claude" } } }), (error) => configError(error) && /unknown harness "claude"/.test((error as Block).message));
});

test("config: a denied fallback is Block(capability) naming from.fallbackModel", async () => {
  const config = await configOf({ models: { subagent: { fallbackModel: "a/b" } } });
  const choice = config.model("subagent");
  assert.equal(choice.from.fallbackModel, "/models/subagent/fallbackModel");
  assert.throws(() => assertChoice(choice, MINIMAL_CAPS),
    (error: unknown) => error instanceof Block && error.code === "capability" && /\/models\/subagent\/fallbackModel/.test(error.message));
});

/** Criterion 11: a caller may branch on the code alone, so all five codes are pinned here. */
test("config: every refusal carries one of the five stable codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worq-codes-"));
  const byCode = (code: string) => (error: unknown) => error instanceof Block && error.code === code;
  // malformed JSON: the file is not JSON at all (src/contracts.ts:21)
  await writeFile(join(dir, "pi-worq.json"), '{ "limits": ');
  assert.throws(() => loadConfig(dir), byCode("invalid-json"));
  // schema-invalid: JSON the config schema rejects (src/contracts.ts:16)
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ limits: { rounds: "three" } }));
  assert.throws(() => loadConfig(dir), byCode("invalid-payload"));
  // config: a ref the adapter registry does not accept (src/config.ts:70-75)
  await assert.rejects(configOf({ model: "not-a-ref" }), byCode("config"));
  // capability: a choice the role's harness cannot honour (assertChoice, src/session.ts:60)
  assert.throws(() => assertChoice({ harness: "pi", thinking: "high", from: { thinking: "/models/subagent/thinking" } }, MINIMAL_CAPS), byCode("capability"));
  // model: a choice that resolved to nothing at all (src/pi.ts:73)
  const config: Config = { path: "test", limits: DEFAULT_LIMITS, model: () => ({ harness: "pi", from: {} }) };
  const driver = piDriver({ model: undefined, modelRegistry: { find: () => undefined } } as never, config);
  const spec: Spec = { id: "x", profile: "agent", name: "agent.plan", cwd: process.cwd(), system: "S", tools: [], log() {}, turn() {}, toolError() {} };
  await assert.rejects(driver(spec), byCode("model"));
});

/** A ref the harness accepts by shape but its registry does not know names the JSON key, not only the value. */
test("config: an unknown model ref names the key it came from", async () => {
  const config = await configOf({ harness: "pi", models: { "agent.plan": { model: "openai/gpt-5" } } });
  const driver = piDriver({ model: undefined, modelRegistry: { find: () => undefined } } as never, config);
  const spec: Spec = { id: "x", profile: "agent", name: "agent.plan", cwd: process.cwd(), system: "S", tools: [], log() {}, turn() {}, toolError() {} };
  await assert.rejects(driver(spec), (error: unknown) =>
    error instanceof Block && error.code === "config"
    && error.message.includes("openai/gpt-5")
    && error.message.includes("/models/agent.plan/model"));
});

test("config: nothing to resolve is Block(model)", async () => {
  const config: Config = { path: "test", limits: DEFAULT_LIMITS, model: () => ({ harness: "pi", from: {} }) };
  const driver = piDriver({ model: undefined, modelRegistry: { find: () => undefined } } as never, config);
  const spec: Spec = { id: "x", profile: "agent", name: "agent.plan", cwd: process.cwd(), system: "S", tools: [], log() {}, turn() {}, toolError() {} };
  await assert.rejects(driver(spec), (error: unknown) => error instanceof Block && error.code === "model");
});

/** A misconfigured role fails at spawn, before the repository, the ref or any worktree exists. */
async function spawnFailure(fail: unknown, role: string, selected = true): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "worq-spawn-"));
  const config = await configOf(fail);
  const worq = new Worq({ driver: fakeHarness({ ...MINIMAL_CAPS, context: FULL_CAPS.context }, {}), prompts: loadPrompts(), config, state: join(dir, "state"), cwd: dir, notify() {} });
  // `dir` is not a git repository: reaching repository() would raise something else.
  await assert.rejects(worq.spawn("plan", "plan it"),
    (error: unknown) => selected ? error instanceof Block && error.code === "capability" && error.message.includes(role) : error instanceof Error && !(error instanceof Block && error.code === "capability"),
    `spawn fails on ${role} before any work`);
}

test("config: spawn validates only the selected agent role", async () => {
  await spawnFailure({ model: "a/m", models: { "agent.plan": { thinking: "high" } } }, "/models/agent.plan/thinking");
  await spawnFailure({ model: "a/m", models: { subagent: { fallbackModel: "a/b" } } }, "/models/subagent/fallbackModel", false);
  await spawnFailure({ model: "a/m", models: { "reviewer.pair": { thinking: "high" } } }, "/models/reviewer.pair/thinking", false);
});

/** A selected reviewer is checked before acquiring a slot or creating its snapshot. */
test("agent: a reviewer whose role check fails takes no semaphore slot and no snapshot", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompts = loadPrompts();
  const kind = prompts.kinds.get("execute")!;
  const seen: Spec[] = [];
  const acquires: string[] = [];
  const checks: string[] = [];
  /** Every reviewer's cwd: a snapshot checkout ends in review-<round>-<name>/product (src/agent.ts:332). */
  const cwds: string[] = [];
  const semaphore = { acquire: async () => { acquires.push("acquire"); return () => {}; } } as unknown as Semaphore;
  /** One execute agent; `deny` names the single reviewer role whose harness cannot honour its choice. */
  const run = async (ref: string, deny?: string) => {
    const agent = new Agent({
      driver: fakeDriver({
        "agent.execute": (turn) => turn.tool("submit", { summary: "Uppercased the greeting", changes: ["app.py"] }).then(() => {}),
        reviewer: (turn) => { cwds.push(turn.spec.cwd); return turn.tool("report", pass).then(() => {}); },
      }, seen),
      prompts, limits: DEFAULT_LIMITS, state, root, semaphore, notify() {},
      check(role) {
        checks.push(role);
        assertChoice({ harness: "pi", thinking: "high", from: { thinking: "/models/reviewer.intent/thinking" } }, role === deny ? MINIMAL_CAPS : FULL_CAPS);
      },
    }, { ref, kind, task: "Uppercase the greeting", attachments: [] });
    agent.launch();
    const deadline = Date.now() + 20_000;
    while (agent.state !== "review-ready") {
      if (agent.ended || Date.now() > deadline) throw new Error(`agent ${ref} ended ${agent.state}: ${agent.error}`);
      await sleep(5);
    }
    return agent;
  };

  // Control: when the check passes, the semaphore is taken and the reviewer is handed a snapshot checkout,
  // so the zeros asserted below come from the check, not from an inert double.
  const control = await run("abce");
  assert.deepEqual(control.reviews.map((r) => [r.name, r.verdict]), [["intent", "pass"]]);
  assert.deepEqual(acquires, ["acquire"], "a passing check reaches semaphore.acquire once");
  assert.match(cwds[0], /review-1-intent[/\\]product$/, "a passing check reaches snapshot");
  acquires.length = 0;
  cwds.length = 0;
  seen.length = 0;

  const denied = await run("abcd", "reviewer.intent");
  assert.deepEqual(denied.reviews.map((r) => [r.name, r.verdict]), [["intent", "unknown"]], "a denied role is recorded as unknown, never pass");
  assert.match(denied.reviews[0].error ?? "", /thinking/, "the record carries the real capability refusal");
  assert.ok(checks.includes("reviewer.intent"), "the check ran");
  assert.deepEqual(acquires, [], "the denied reviewer never reaches semaphore.acquire");
  // mkdir(scratch) and snapshot() both sit behind that acquire (src/agent.ts:328-332), so no checkout can exist.
  assert.ok(!cwds.some((cwd) => /review-1-intent/.test(cwd)), "no reviewer cwd, so snapshot never ran");
  assert.ok(!existsSync(join(state, denied.id, "review-1-intent")), "no scratch directory either");
  assert.ok(!seen.some((spec) => spec.name === "reviewer.intent"), "the driver never opened the denied reviewer's session");
  await control.cancel();
  await denied.cancel();
});

test("resource lists replace family settings; approved bytes only, no checkout or escaping link", async t => {
  const data = "operator skill";
  const pin = { path: "skill.md", sha256: createHash("sha256").update(data).digest("hex") };
  const config = await configOf({ models: { "subagent.evidence": {}, subagent: { skills: [pin] }, "subagent.empty": { skills: [] }, reviewer: { extensions: [pin] } } });
  assert.throws(() => config.model("subagent.typo"), /Unknown named child/);
  assert.deepEqual(config.model("subagent.empty").resources?.skills, []);
  assert.throws(() => assertChoice(config.model("subagent.evidence"), FULL_CAPS), /unsupported resource skills/);
  assert.throws(() => config.model("reviewer.intent"), /approval/);
  const dir = join(config.path, ".."); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "worq-resources"); await mkdir(root);
  const js = "export default function register(pi) { pi.on('session_start', () => {}); }";
  await writeFile(join(root, "ok.mjs"), js);
  const ext = { path: "ok.mjs", sha256: createHash("sha256").update(js).digest("hex") };
  const approved = {} as ResourceLoader;
  await applyResources(approved, "", config.path, { extensions: [ext] });
  assert.equal(approved.getExtensions().extensions.length, 1);
  const loader = {} as ResourceLoader;
  const apply = () => applyResources(loader, "base", config.path, config.model("subagent.evidence").resources);
  await writeFile(join(root, pin.path), data); await apply();
  assert.match(loader.getSystemPrompt()!, /operator skill/);
  await writeFile(join(root, pin.path), "changed"); await assert.rejects(apply(), /Changed resource/);
  await rm(join(root, pin.path)); await symlink(config.path, join(root, pin.path)); await assert.rejects(apply(), /Untrusted/);
  await rm(join(root, pin.path)); await writeFile(join(root, pin.path), data); await mkdir(join(dir, ".git")); await assert.rejects(apply(), /Repository resource/);
});
