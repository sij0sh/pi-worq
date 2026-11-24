import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi restores the active branch into the next model request", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "worq-pi-checkpoint-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, authPath: `${cwd}/no-auth.json`, modelsPath: `${cwd}/no-models.json` });
  const model = modelRuntime.getAllModels().find(m => m.provider === "openai" && m.type === "chat")!;
  const manager = SessionManager.inMemory(cwd);
  const base = { role: "user", content: [{ type: "text", text: "Original request" }], timestamp: 1 } as const;
  manager.appendMessage(structuredClone(base) as never);
  const parent = manager.getLeafId()!;
  manager.appendMessage({ role: "user", content: "off-branch", timestamp: 2 });
  manager.branch(parent);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const call = { role: "assistant", content: [{ type: "toolCall", id: "call_submit", name: "submit", arguments: { decisions: ["retain"] } }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 3 } as const;
  const result = { role: "toolResult", toolCallId: "call_submit", toolName: "submit", content: [{ type: "text", text: "Submitted" }], isError: false, timestamp: 4 } as const;
  manager.appendMessage(structuredClone(call) as never);
  manager.appendMessage(structuredClone(result) as never);
  const entries = structuredClone([manager.getHeader()!, ...manager.getBranch()]);
  const reviewed = "# Exact plan\r\n\nEnd with space \n";
  const findings = [{ name: "decision", verdict: "fail", findings: ["Pivot"] }];
  const decision = "Use the settled alternative; no independent review required.";
  const input = JSON.stringify({ reviewed, findings, decision });
  const observed: unknown[] = [];
  await modelRuntime.setRuntimeApiKey("openai", "fake-transport-only");
  modelRuntime.streamSimple = (_model, context) => {
    observed.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: { ...call, content: [{ type: "text", text: "Done" }], stopReason: "stop" } });
    return stream;
  };
  const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: model as never, noTools: "all", sessionManager: SessionManager.inMemory(cwd, undefined, entries), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  try {
    await session.prompt(input);
    assert.equal(observed.length, 1, "fake transport must see exactly one actual model request");
    const messages = observed[0] as Array<{ role: string; content: { text: string }[] }>;
    assert.deepEqual(messages.slice(0, 3), [base, call, result]);
    assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "toolResult", "system", "user"]);
    assert.deepEqual(messages[4].content, [{ type: "text", text: input }]);
  } finally { session.dispose(); }
});
