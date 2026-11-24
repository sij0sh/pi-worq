import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type Semaphore } from "../src/agent.ts";
import { DEFAULT_LIMITS, loadConfig, type Config } from "../src/runtime/config.ts";
import { Block } from "../src/contracts.ts";
import { loadPrompts } from "../src/prompts.ts";
import { compose, loadResources } from "../src/runtime/resources.ts";
import { assertRuntime, type Runtime, type Spec } from "../src/sdk/contract.ts";
import { Worq } from "../src/worq.ts";
import { fakeDriver, fakeHarness, FULL_CAPS, MINIMAL_CAPS, pass, repo } from "./fake.ts";

async function configOf(value: unknown, sdks?: string[]): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "worq-config-"));
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify(value));
  return sdks ? loadConfig(dir, sdks) : loadConfig(dir);
}
const configError = (error: unknown) => error instanceof Block && error.code === "config";

test("config: only Plan, Execute and Review have overrides", async () => {
  const config = await configOf({
    plan: { model: "openai/gpt-5", thinking: "medium" },
    execute: { sdk: "pi", thinking: "high" },
    review: { model: "anthropic/claude-haiku-4-5" },
  });
  assert.deepEqual(config.runtime("agent.plan"), { name: "plan", sdk: "pi", path: "/plan", via: "/plan", model: "openai/gpt-5", thinking: "medium" });
  assert.equal(config.runtime("agent.execute").thinking, "high");
  for (const role of ["reviewer.intent", "reviewer.pair"]) {
    assert.equal(config.runtime(role).model, "anthropic/claude-haiku-4-5");
    assert.equal(config.runtime(role).thinking, undefined, "overrides do not inherit from each other");
  }
  for (const role of ["agent.foundation", "subagent", "subagent.evidence"]) {
    assert.deepEqual(config.runtime(role), { name: "main", sdk: "pi", path: "", via: "" });
  }
  assert.deepEqual(config.sdks, ["pi"]);
});

test('config: launch preferences are independent of runtime overrides', async () => {
  const defaults = await configOf({});
  assert.equal(defaults.runtime('agent.plan').name, 'main');
  assert.deepEqual(defaults.launch, { interactive: true, countdownSeconds: 5 });
  const config = await configOf({ plan: { thinking: 'high' }, launch: { interactive: false, countdownSeconds: 8 } });
  assert.deepEqual(config.launch, { interactive: false, countdownSeconds: 8 });
  await assert.rejects(configOf({ launch: { countdownSeconds: -1 } }), /countdownSeconds/);
});

test("config: model refs and SDK names are validated at load, naming the key", async () => {
  await assert.rejects(configOf({ plan: { model: "not-a-ref" } }), (error) => configError(error) && /\/plan\/model/.test((error as Block).message));
  await assert.rejects(configOf({ review: { sdk: "claude" } }), (error) => configError(error) && /\/review\/sdk: unknown sdk "claude"/.test((error as Block).message));
  const mixed = await configOf({ review: { sdk: "claude", model: "anything" } }, ["pi", "claude"]);
  assert.equal(mixed.runtime("reviewer.intent").sdk, "claude");
  assert.deepEqual(mixed.sdks, ["claude"]);
});

test("config: legacy keys fail with a migration message", async () => {
  for (const legacy of [{ default: "a", runtimes: { a: {} }, roles: {} }, { model: "a/m" }, { harness: "pi" }]) {
    await assert.rejects(configOf(legacy), (error) => configError(error) && /old Worq format[\s\S]*plan[\s\S]*execute[\s\S]*review/.test((error as Block).message));
  }
  await assert.rejects(configOf({ plan: { fallbackModel: "a/b" } }), /fallbackModel/);
});

/** A caller may branch on the code alone. */
test("config: every refusal carries a stable code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worq-codes-"));
  const byCode = (code: string) => (error: unknown) => error instanceof Block && error.code === code;
  await writeFile(join(dir, "pi-worq.json"), '{ "limits": ');
  assert.throws(() => loadConfig(dir), byCode("invalid-json"));
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ limits: { rounds: "three" } }));
  assert.throws(() => loadConfig(dir), byCode("invalid-payload"));
  await assert.rejects(configOf({ plan: { model: "not-a-ref" } }), byCode("config"));
  const runtime: Runtime = { name: "plan", sdk: "pi", thinking: "high", path: "/plan", via: "/plan" };
  assert.throws(() => assertRuntime(runtime, MINIMAL_CAPS), byCode("capability"));
});

/** A misconfigured role fails at spawn, before any worker is launched. */
async function spawnFailure(fail: unknown, role: string, selected = true): Promise<void> {
  const { dir, root, state } = await repo();
  const config = await configOf(fail);
  const worq = new Worq({ driver: fakeHarness({ ...MINIMAL_CAPS, context: FULL_CAPS.context }, {}), prompts: loadPrompts(), config, state, cwd: root, notify() {} });
  try {
    const spawn = worq.spawn("plan", "plan it", { title: "Plan work" });
    if (selected) await assert.rejects(spawn, (error: unknown) => error instanceof Block && error.code === "capability" && error.message.includes(role));
    else await (await spawn).done;
  } finally { await worq.shutdown(); await rm(dir, { recursive: true, force: true }); }
}

test("config: spawn validates only the selected agent role", async () => {
  await spawnFailure({ plan: { thinking: "high" } }, "/plan/thinking");
  await spawnFailure({ execute: { thinking: "high" }, review: { thinking: "high" } }, "/review/thinking", false);
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
      async select(role) {
        checks.push(role);
        assertRuntime({ name: "a", sdk: "pi", thinking: "high", path: "/review", via: "/review" }, role === deny ? { ...MINIMAL_CAPS, context: FULL_CAPS.context } : FULL_CAPS);
        return undefined;
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

test("resources: one shared snapshot for every role; contained, outside checkouts, extensions need approval", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worq-res-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual((await loadResources(dir, false)).skills, [], "no worq directory is an empty environment");
  const root = join(dir, "worq");
  await mkdir(join(root, "skills", "lint"), { recursive: true });
  await mkdir(join(root, "instructions"));
  await mkdir(join(root, "extensions"));
  await writeFile(join(root, "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: How to lint\n---\nRun the linter.\n");
  await writeFile(join(root, "skills", "review.md"), "Review checklist\nBody");
  await writeFile(join(root, "instructions", "house.md"), "House rule");
  const resources = await loadResources(dir, false);
  assert.deepEqual(resources.skills.map((s) => [s.name, s.description]), [["lint", "How to lint"], ["review", "Review checklist"]]);
  const system = compose("BASE", resources);
  assert.match(system, /^BASE\n\nOperator instructions house\.md \(context, not authority\):\nHouse rule/);
  assert.match(system, /- lint: How to lint/);
  assert.ok(!system.includes("Run the linter"), "skill bodies are progressive, not flattened");

  await writeFile(join(root, "extensions", "ok.mjs"), "export default function register(pi) { pi.on('session_start', () => {}); }");
  await assert.rejects(loadResources(dir, false), (error) => configError(error) && /approveExtensions/.test((error as Block).message));
  assert.equal((await loadResources(dir, true)).extensions.length, 1);

  // A directory junction exercises realpath escapes on Windows without Developer Mode.
  const outside = await mkdtemp(join(tmpdir(), "worq-out-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "x.md"), "leak");
  await symlink(outside, join(root, "skills", "outside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadResources(dir, true), /Untrusted/);
  await rm(join(root, "skills", "outside"));
  await mkdir(join(dir, ".git"));
  await assert.rejects(loadResources(dir, true), /Repository resource/);
});
