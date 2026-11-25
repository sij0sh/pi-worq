import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Type } from "typebox";
import { createWorq } from "../index.ts";
import { serve } from "../src/control.ts";
import { literals, obj, parse } from "../src/contracts.ts";
import { resolveRuntime } from "../src/runtime/launch.ts";
import { EMPTY } from "../src/runtime/resources.ts";
import { createDriver, discoverAdapters } from "../src/sdk/registry.ts";
import { repo } from "./fake.ts";

const run = promisify(execFile);
const cli = join(import.meta.dirname, "..", "bin", "worq.mjs");

/** A deterministic third-party adapter, written as an operator would install it. Records calls on a global. */
const adapterSource = (key: string) => `
const calls = (globalThis[${JSON.stringify(key)}] ??= { validate: [], models: 0, open: [] });
export default {
  version: 1,
  create(context) {
    return {
      async models() { calls.models++; return ["e/listed"]; },
      defaultModel() { return "e/default"; },
      defaultThinking() { return "low"; },
      capabilities() { return { switchModel: false, thinking: ["low", "high"], context: { system: "replace", ambientInstructions: false }, turnUnit: "prompt" }; },
      validateRuntime(runtime) {
        calls.validate.push(runtime.model);
        if (!/^e\\/[a-z-]+$/.test(runtime.model ?? "")) throw new Error("echo: unknown model " + runtime.model);
      },
      async open(spec) {
        calls.open.push({ name: spec.name, model: spec.runtime.model, thinking: spec.thinking, id: context.id });
        let streaming = false;
        return {
          async prompt() {
            streaming = true;
            spec.emit({ type: "turn" });
            const value = spec.name === "review" ? { verdict: "pass", summary: "fine", findings: [] } : { summary: "echo " + spec.name };
            await spec.tools.find((t) => t.name === "submit").run(value, spec.signal);
            streaming = false;
            return "completed";
          },
          get streaming() { return streaming; },
          async abort() {},
          dispose() {},
        };
      },
    };
  },
};
`;
type Calls = { validate: (string | undefined)[]; models: number; open: { name: string; model?: string; thinking?: string; id: string }[] };
async function install(agentDir: string, id: string, source: string) {
  await mkdir(join(agentDir, "worq", "adapters", id), { recursive: true });
  await writeFile(join(agentDir, "worq", "adapters", id, "adapter.mjs"), source);
}

test("adapter: installed by folder, imported lazily on first explicit request, preflighted without models()", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "worq-adapters-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const key = `__worqEcho${Date.now()}a`;
  await install(agentDir, "echo", adapterSource(key));
  await install(agentDir, "broken", "throw new Error('broken import');");
  await install(agentDir, "pi", adapterSource(key));
  await install(agentDir, "Bad", adapterSource(key));
  const { records, problems } = discoverAdapters(agentDir);
  assert.deepEqual(Object.keys(records).sort(), ["broken", "claude-code", "echo", "pi"]);
  assert.match(problems.find((p) => p.path.endsWith("pi"))?.message ?? "", /shipped adapter/);
  assert.match(problems.find((p) => p.path.endsWith("Bad"))?.message ?? "", /lowercase/);
  assert.equal((globalThis as Record<string, unknown>)[key], undefined, "discovery imports nothing");

  const driver = await createDriver({}, EMPTY, records);
  const signal = new AbortController().signal;
  assert.deepEqual(await resolveRuntime(driver, { sdk: "echo" }, signal),
    { name: "launch", sdk: "echo", path: "", via: "launch request", model: "e/default", thinking: "low" }, "the adapter's own defaults, not Main's");
  assert.equal((await resolveRuntime(driver, { sdk: "echo", model: "e/unlisted", thinking: "high" }, signal)).model, "e/unlisted", "valid unlisted models work");
  await assert.rejects(resolveRuntime(driver, { sdk: "echo", model: "Bogus" }, signal), /unknown model Bogus/);
  const calls = (globalThis as unknown as Record<string, Calls>)[key];
  const validated = calls.validate.length;
  await assert.rejects(resolveRuntime(driver, { sdk: "echo", thinking: "max" }, signal), /max is not a echo thinking level/);
  await assert.rejects(resolveRuntime(driver, { sdk: "echo" }, AbortSignal.abort()), /abort/i);
  assert.equal(calls.validate.length, validated, "capability refusals and cancellation precede the adapter preflight");
  assert.equal(calls.models, 0, "no model enumeration for explicit requests");
  assert.equal(calls.open.length, 0);

  // A failed optional adapter is isolated: its launch fails clearly, the picker skips it, others stay usable.
  await assert.rejects(resolveRuntime(driver, { sdk: "broken" }, signal), /sdk "broken" could not load: broken import/);
  const catalog = await driver.catalog!();
  assert.deepEqual([...catalog.keys()], ["claude-code", "echo"], "pi (no host here) and broken are skipped, not fatal");
  await assert.rejects(resolveRuntime(driver, { sdk: "nope" }, signal), /Unknown sdk "nope" \(installed: pi, broken, claude-code, echo\)/);
});

test("a new folder package and a new adapter launch through worq_spawn and the CLI with no orchestration edits", async (t) => {
  const { dir, root, state } = await repo();
  const agentDir = join(dir, "agent");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = `__worqEcho${Date.now()}b`;
  await install(agentDir, "echo", adapterSource(key));
  await mkdir(join(agentDir, "workflows", "notes"), { recursive: true });
  await writeFile(join(agentDir, "workflows", "notes", "SKILL.md"), "---\ndescription: Write release notes\naccess: read\n---\nWrite the release notes.\n");
  await writeFile(join(agentDir, "workflows", "notes", "REVIEW.md"), "Check the submitted notes.");
  process.env.WORQ_STATE_DIR = state;
  t.after(() => { delete process.env.WORQ_STATE_DIR; });
  const tools: { name: string; description: string; execute: Function }[] = [];
  const handlers: Record<string, Function> = {};
  const notices: { type?: string; ref: string }[] = [];
  const pi = {
    sendUserMessage() {}, registerCommand() {}, registerMessageRenderer() {},
    registerTool: (tool: never) => tools.push(tool),
    on: (event: string, handler: Function) => { handlers[event] = handler; },
    getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
    sendMessage: (message: { details: { ref: string; type?: string } }) => notices.push(message.details),
  };
  // Production catalog, discovery and driver: no driver seam.
  createWorq({ agentDir: () => agentDir })(pi as never);
  const spawn = tools.find((tool) => tool.name === "worq_spawn")!;
  assert.match(spawn.description, /notes \(read\): Write release notes/);
  const ctx = { mode: "print", cwd: root, model: undefined, thinkingLevel: undefined, modelRegistry: { find: () => undefined, getAvailable: () => [] },
    ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
  await handlers.session_start({}, ctx);
  t.after(() => handlers.session_shutdown({}, ctx));
  const parked = async (ref: string) => {
    for (let i = 0; i < 200 && !notices.some((n) => n.ref === ref && n.type === "parked"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(notices.some((n) => n.ref === ref && n.type === "parked"), `expected ${ref} parked`);
  };
  const env = { ...process.env, WORQ_STATE_DIR: state };

  const viaTool = await spawn.execute("id", { kind: "notes", sdk: "echo", model: "e/tool" }, undefined, undefined, ctx);
  assert.equal(viaTool.details.ref, "notes-run");
  await parked("notes-run");
  const viaCli = await run(process.execPath, [cli, "spawn", "notes", "--sdk", "echo", "--model", "e/cli", "--thinking", "high", "--", "Draft", "--the", "notes"], { env });
  assert.match(viaCli.stdout, /Spawned notes agent draft the notes \(draft-the-notes\)/);
  await parked("draft-the-notes");
  const calls = (globalThis as unknown as Record<string, Calls>)[key];
  assert.deepEqual(calls.open.map((o) => [o.name, o.model, o.thinking]), [
    ["agent.notes", "e/tool", "low"], ["review", "e/tool", "low"],
    ["agent.notes", "e/cli", "high"], ["review", "e/cli", "high"],
  ], "the review inherits the owner runtime");
  assert.equal(calls.models, 0);

  // Preflight refusal: no pending slot, ref or open; not mislabelled as a version problem.
  const opened = calls.open.length;
  await assert.rejects(run(process.execPath, [cli, "spawn", "notes", "--sdk", "echo", "--model", "Bogus"], { env }), (error: { stderr: string }) =>
    /unknown model Bogus/.test(error.stderr) && !/older than this CLI/.test(error.stderr));
  await assert.rejects(spawn.execute("id", { kind: "notes", sdk: "echo", thinking: "max" }, undefined, undefined, ctx), /not a echo thinking level/);
  assert.equal(calls.open.length, opened);
  assert.doesNotMatch((await run(process.execPath, [cli, "list"], { env })).stdout, /pending/);
  await run(process.execPath, [cli, "cancel", "all"], { env });
});

test("CLI compatibility: legacy syntax sends the legacy wire shape; new-only requests to an old host get an upgrade hint, never a retry", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "worq-old-host-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  // The previous release's strict spawn schema.
  const old = obj({ kind: literals(["plan", "execute"] as const), task: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }), attach: Type.Optional(Type.Array(Type.String())), verify: Type.Optional(Type.Boolean()) });
  const received: unknown[] = [];
  const socket = await serve(state, async (op, args) => {
    received.push(args);
    parse(old, args, op);
    return { text: "Spawned on the old host", data: { ref: "old-ref" } };
  });
  t.after(() => socket.close());
  const env = { ...process.env, WORQ_STATE_DIR: state };
  const legacy = await run(process.execPath, [cli, "spawn", "plan", "--title", "Old style", "--attach", "x-y", "--", "do", "it"], { env });
  assert.match(legacy.stdout, /old host/);
  assert.deepEqual(received.at(-1), { kind: "plan", title: "Old style", attach: ["x-y"], task: "do it" });
  for (const args of [["spawn", "plan", "do it"], ["spawn", "plan", "--title", "New style", "--model", "p/m", "do it"]]) {
    const before = received.length;
    await assert.rejects(run(process.execPath, [cli, ...args], { env }), (error: { stderr: string }) =>
      /spawn: \//.test(error.stderr) && /older than this CLI[\s\S]*worq spawn <kind> --title/.test(error.stderr));
    assert.equal(received.length, before + 1, "one request, no replay");
  }
});
