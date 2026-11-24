import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, type Config } from "../src/runtime/config.ts";
import { Block } from "../src/contracts.ts";
import { loadPrompts } from "../src/prompts.ts";
import { compose, loadResources } from "../src/runtime/resources.ts";
import { assertRuntime, type Runtime } from "../src/sdk/contract.ts";
import { Worq } from "../src/worq.ts";
import { fakeDriver, fakeHarness, FULL_CAPS, KINDS, MINIMAL_CAPS, pass, repo } from "./fake.ts";
const configError = (error: unknown) => error instanceof Block && error.code === "config";

async function configOf(value: unknown): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "worq-config-"));
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify(value));
  return loadConfig(dir);
}

test("config: removed role presets refuse new launches with file, keys and migration text; empty blocks count", async () => {
  for (const value of [{ plan: { model: "openai/gpt-5" } }, { review: {} }, { execute: { sdk: "pi" }, review: { model: "a/b" } }, { plan: {}, launch: { countdownSeconds: 3 } }]) {
    const config = await configOf(value);
    const keys = Object.keys(value).filter((key) => key !== "launch").map((key) => `/${key}`).join(", ");
    assert.ok(config.migration?.includes(`pi-worq.json: ${keys} `), config.migration);
    assert.match(config.migration!, /launch request sets sdk, model or thinking/);
    assert.match(config.migration!, /distinct reviewer runtime, keep the older Worq release/);
  }
  const legacy = await configOf({ default: "a", runtimes: { a: {} }, roles: {} });
  assert.match(legacy.migration ?? "", /\/default, \/runtimes, \/roles are no longer supported/);
});

test("config: obsolete launch preferences are ignored with a warning, never a gate", async () => {
  for (const launch of [{ countdownSeconds: 8 }, { interactive: false }, { countdownSeconds: -1 }, "junk"]) {
    const config = await configOf({ launch, limits: { agents: 2 } });
    assert.equal(config.migration, undefined);
    assert.match(config.ignored ?? "", /\/launch is ignored/);
    assert.equal(config.limits.agents, 2);
  }
  assert.equal((await configOf({})).ignored, undefined);
});

/** A caller may branch on the code alone. */
test("config: every refusal carries a stable code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worq-codes-"));
  const byCode = (code: string) => (error: unknown) => error instanceof Block && error.code === code;
  await writeFile(join(dir, "pi-worq.json"), '{ "limits": ');
  assert.throws(() => loadConfig(dir), byCode("invalid-json"));
  await writeFile(join(dir, "pi-worq.json"), JSON.stringify({ limits: { rounds: "three" } }));
  assert.throws(() => loadConfig(dir), byCode("invalid-payload"));
  const runtime: Runtime = { name: "launch", sdk: "pi", thinking: "high", path: "", via: "launch request" };
  assert.throws(() => assertRuntime(runtime, MINIMAL_CAPS), byCode("capability"));
});

test("config: the migration gate blocks every new launch before preflight; management keeps working; ignored launch warns once", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings: string[] = [];
  const validated: string[] = [];
  const driver = fakeDriver({});
  driver.validate = async (runtime) => { validated.push(runtime.sdk); };
  const config = await configOf({ review: {}, launch: { countdownSeconds: 2 } });
  const worq = new Worq({ driver, prompts: loadPrompts(), kinds: KINDS, config, state, cwd: root, notify() {}, warn: (text) => warnings.push(text) });
  t.after(() => worq.shutdown());
  for (const kind of ["plan", "execute"]) {
    await assert.rejects(worq.spawn(kind, "plan it", { title: "Plan work" }), (error) => configError(error) && /\/review is no longer supported/.test((error as Block).message));
  }
  assert.deepEqual(validated, [], "refused before adapter preflight");
  assert.equal(warnings.length, 1, "ignored launch warns once, alongside the gate");
  assert.match(warnings[0], /\/launch is ignored/);
  assert.equal(worq.list(), "No Worq agents in this session.");
  assert.equal(await worq.cancel("all"), "No live agents");
});

test("config: an ignored launch block alone does not block launches", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings: string[] = [];
  const worq = new Worq({ driver: fakeDriver({ agent: (turn) => turn.tool("submit", { summary: "ok" }).then(() => {}), review: (turn) => turn.tool("submit", pass).then(() => {}) }),
    prompts: loadPrompts(), kinds: KINDS, config: await configOf({ launch: { interactive: false } }), state, cwd: root, notify() {}, warn: (text) => warnings.push(text) });
  t.after(() => worq.shutdown());
  const agent = await worq.spawn("plan", "plan it", { title: "Plan work" });
  await worq.spawn("plan", "plan more", { title: "Plan more" });
  assert.equal(warnings.length, 1);
  await agent.cancel();
});

test("verify:false is refused before admission; review follows the package", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worq = new Worq({ driver: fakeHarness(FULL_CAPS, {}), prompts: loadPrompts(), kinds: KINDS, config: await configOf({}), state, cwd: root, notify() {} });
  await assert.rejects(worq.spawn("execute", "x", { title: "No review", verify: false }), (error) => error instanceof Block && error.code === "verify" && /review follows the package/.test(error.message));
  assert.equal(worq.size, 0);
});

test("explicit runtime fields the harness cannot honour are refused before admission", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worq = new Worq({ driver: fakeHarness({ ...MINIMAL_CAPS, context: FULL_CAPS.context }, {}), prompts: loadPrompts(), kinds: KINDS, config: await configOf({}), state, cwd: root, notify() {} });
  await assert.rejects(worq.spawn("plan", "plan it", { title: "Plan work", thinking: "high" }), (error: unknown) => error instanceof Block && error.code === "capability" && /thinking/.test(error.message));
  const isolated = new Worq({ driver: fakeHarness(MINIMAL_CAPS, {}), prompts: loadPrompts(), kinds: KINDS, config: await configOf({}), state, cwd: root, notify() {} });
  await assert.rejects(isolated.spawn("plan", "plan it", { title: "Plan work" }), /cannot isolate context/);
  assert.equal(worq.size + isolated.size, 0);
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
