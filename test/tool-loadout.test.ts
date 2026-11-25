import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorq, TOOLS } from "../index.ts";
import { fakeDriver, repo } from "./fake.ts";

const cli = join(import.meta.dirname, "..", "bin", "worq.mjs");
const lateTool = {
  name: "late_tool", description: "Unrelated late-registering tool", label: "Late tool",
  parameters: Type.Object({}), defaultActive: false,
  async execute() { return { content: [], details: undefined }; },
};

test("Pi keeps management tools hidden on resume, preserves late tools, and toggles on launch and last cancellation", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(process, "cwd", () => root);
  process.env.WORQ_STATE_DIR = state;
  t.after(() => { delete process.env.WORQ_STATE_DIR; });
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(root);
  const declarations = (...names: string[]) => names.map(name => ({ name, description: name, parameters: Type.Object({}) }));
  // Two recorded loadouts: one from before the agent existed, another with management tools active.
  const before = sessionManager.appendMessage({ role: "system", content: "Recorded prompt", timestamp: 1,
    toolsAdded: declarations("worq_spawn", lateTool.name) });
  sessionManager.appendMessage({ role: "system", content: "", timestamp: 2, toolsAdded: declarations(...TOOLS.slice(1)) });
  sessionManager.appendMessage({ role: "user", content: "Previous request", timestamp: 3 });
  let registerLate!: () => void;
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, extensionFactories: [
    createWorq({ agentDir: () => agentDir, driver: () => fakeDriver({ "agent.plan": () => new Promise(() => {}) }) }),
    pi => { registerLate = () => pi.registerTool(lateTool); },
  ] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, sessionManager, resourceLoader });
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  await session.bindExtensions({ mode: "print" });
  const worqTools = () => session.getActiveToolNames().filter(name => name.startsWith("worq_")).sort();
  const all = [...TOOLS].sort();
  assert.deepEqual(worqTools(), ["worq_spawn"]);
  assert.doesNotMatch(session.systemPrompt, /worq_(list|send|cancel)\b/);
  assert.ok(!session.getActiveToolNames().includes(lateTool.name));
  registerLate();
  assert.ok(session.getActiveToolNames().includes(lateTool.name), "resumed unrelated tool was still pending");

  const run = promisify(execFile);
  const control = (...args: string[]) => run(process.execPath, [cli, ...args]);
  await assert.rejects(control("spawn", "unknown"), /Unknown kind/);
  assert.deepEqual(worqTools(), ["worq_spawn"]);
  await control("spawn", "plan", "--title", "First agent");
  assert.deepEqual(worqTools(), all);
  assert.match(session.systemPrompt, /worq_cancel\b/);
  assert.equal((await session.navigateTree(before)).cancelled, false);
  assert.deepEqual(worqTools(), all, "the current agent keeps management available on an older branch");
  await control("spawn", "plan", "--title", "Second agent");
  await control("cancel", "first-agent");
  assert.deepEqual(worqTools(), all);
  await control("cancel", "second-agent");
  assert.deepEqual(worqTools(), ["worq_spawn"]);
  assert.doesNotMatch(session.systemPrompt, /worq_(list|send|cancel)\b/);
  assert.ok(session.getActiveToolNames().includes(lateTool.name));
});
