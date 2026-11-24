import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadPrompts } from "../src/prompts.ts";
import { DEFAULT_LIMITS, MAIN, type Config } from "../src/runtime/config.ts";
import { createDriver, type HostServices } from "../src/sdk/registry.ts";
import { Worq } from "../src/worq.ts";
import type { AgentEvent } from "../src/agent.ts";
import { planSubmission, repo } from "./fake.ts";

test("Worq finalizes a sealed batch with the real Pi active branch in model input", { timeout: 10_000 }, async t => {
  const { dir, root, state } = await repo();
  let worq: Worq | undefined;
  t.after(async () => { await worq?.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, authPath: join(dir, "no-auth.json"), modelsPath: join(dir, "no-models.json") });
  const model = runtime.getAllModels().find(m => m.provider === "openai" && m.type === "chat")!;
  await runtime.setRuntimeApiKey("openai", "fake-transport-only");
  const config: Config = { path: "test", limits: DEFAULT_LIMITS, approveExtensions: false, sdks: ["pi"], runtime: () => ({ ...MAIN }) };
  const registry = { runtime, getAvailable: () => [model], find: () => model } as unknown as NonNullable<HostServices["pi"]>["modelRegistry"];
  const driver = await createDriver({ pi: { model: model as NonNullable<HostServices["pi"]>["model"], modelRegistry: registry, agentDir: dir } }, config);
  const decision = "Adopt the narrower direction without independent review.";
  const unresolved = ["Confirm ownership"];
  const offBranch = "ABANDONED BRANCH MUST NOT REACH MODEL";
  const inMemory = SessionManager.inMemory;
  let activeBranch: ReturnType<SessionManager["getBranch"]> | undefined;
  // Add a real sibling before production checkpoint serialization, without changing the active leaf.
  t.mock.method(SessionManager, "inMemory", (...args: Parameters<typeof inMemory>) => {
    const manager = inMemory.apply(SessionManager, args);
    const append = manager.appendMessage.bind(manager);
    manager.appendMessage = message => {
      const leaf = append(message);
      if (!activeBranch && message.role === "toolResult" && message.toolCallId === "original_submit") {
        activeBranch = structuredClone(manager.getBranch());
        append({ role: "user", content: offBranch, timestamp: 1 });
        manager.branch(leaf);
      }
      return leaf;
    };
    return manager;
  });
  type Messages = Parameters<typeof runtime.streamSimple>[1]["messages"];
  const original: Messages[] = [], finalized: Messages[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const report = { verdict: "fail", summary: "Narrow the plan", findings: [{ witness: "The alternative is smaller." }] };
  runtime.streamSimple = (_model, { messages }) => {
    const last = messages.at(-1);
    const isFinal = last?.role === "user" && JSON.stringify(last.content).includes(decision);
    const reviewer = last?.role === "user" && JSON.stringify(last.content).includes('\\"request\\"');
    const afterTool = last?.role === "toolResult";
    if (isFinal) finalized.push(structuredClone(messages));
    else if (!reviewer && !afterTool) original.push(structuredClone(messages));
    const call = { type: "toolCall" as const, id: reviewer ? "review_report" : isFinal ? "final_submit" : "original_submit", name: reviewer ? "report" : "submit", arguments: reviewer ? report : planSubmission };
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
    if (afterTool) stream.push({ type: "done", reason: "stop", message: { ...message, content: [{ type: "text", text: "Done" }], stopReason: "stop" } });
    else stream.push({ type: "done", reason: "toolUse", message: { ...message, content: [call], stopReason: "toolUse" } });
    return stream;
  };
  let ready!: (event: AgentEvent) => void;
  const next = () => new Promise<AgentEvent>(resolve => { ready = resolve; });
  worq = new Worq({ driver, config, prompts: loadPrompts(), state, cwd: root, notify: event => { if (event.type === "review-ready" || event.type === "failed") ready(event); } });
  const reviewed = next();
  const agent = await worq.spawn("plan", "Keep the greeting change small.", { title: "Greeting plan", mode: "fast" });
  const notice = await reviewed;
  assert.equal(agent.batch, "complete", notice.text);
  assert.equal(agent.reviews[0].verdict, "fail");
  const path = join(root, agent.plan!.path);
  const bytes = await readFile(path, "utf8");
  const finished = next();
  worq.send(agent.ref, `/finalize ${JSON.stringify({ materialPivot: true, directionSettled: true, independentReviewRequired: false, reviewedDigest: agent.reviewedDigest, decision, unresolved })}`);
  const final = await finished;
  assert.equal(agent.finalization?.status, "unreviewed", final.text);
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.ok(activeBranch, "the original branch had a real structured submit result before checkpointing");
  assert.equal(finalized.length, 1);
  assert.deepEqual(finalized[0].map(m => m.role), ["system", "user", "assistant", "toolResult", "system", "user"]);
  const [system, user, call, result, , pivot] = finalized[0];
  assert.deepEqual([system, user], original[0]);
  const originalExchange = activeBranch.flatMap(entry => entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") ? [entry.message] : []);
  // JSON persistence drops optional properties whose value is undefined.
  assert.deepEqual([call, result], JSON.parse(JSON.stringify(originalExchange)));
  assert.ok(call.role === "assistant");
  assert.deepEqual(call.content, [{ type: "toolCall", id: "original_submit", name: "submit", arguments: planSubmission }]);
  assert.ok(result.role === "toolResult" && result.toolCallId === "original_submit" && !result.isError);
  assert.deepEqual(result.content, [{ type: "text", text: "Submitted." }]);
  assert.doesNotMatch(JSON.stringify(finalized[0]), /ABANDONED BRANCH MUST NOT REACH MODEL/);
  assert.ok(pivot.role === "user" && Array.isArray(pivot.content) && pivot.content[0].type === "text");
  assert.deepEqual(JSON.parse(pivot.content[0].text), { reviewed: bytes, findings: agent.reviews, reviewedDigest: agent.reviewedDigest, decision, unresolved });
});
