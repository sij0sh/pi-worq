import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent.ts";
import { chains, hintLoader, hintThinking, matchHint, parseHints } from "../src/runtime/hints.ts";
import { resolveRuntime } from "../src/runtime/launch.ts";
import type { Capabilities, Driver, Spec } from "../src/sdk/contract.ts";
import { Worq } from "../src/worq.ts";
import { config, fakeDriver, FULL_CAPS, KINDS, planSubmission, repo, type Script } from "./fake.ts";

const TABLE = `# Worq Runtime Hints

Prose is ignored. | not a table row either? it is not at line start

<!--
| role | thinking |
| --- | --- |
| scout | high |
-->

\`\`\`markdown
| role | thinking |
| scout | max |
\`\`\`

| role | sdk | model | thinking | max-turns | max-minutes |
| --- | --- | --- | --- | --- | --- |
| * | - | - | - | - | - |
| scout | - | - | <=low | 16 | 5 |
| pq | | | <=medium | 14 | |
| plan.pq | - | p/fast | - | 12 | 4 |
| review | - | - | bogus level! | 900 | 10 |
| Bad Role | - | - | low | - | - |
| execute.review | - | - | <=high | - | - |
`;

test("hints: parses one GFM table, ignores prose/comments/fences, skips only bad cells and rows", () => {
  const hints = parseHints(TABLE, "R.md");
  assert.deepEqual([...hints.rows.keys()], ["*", "scout", "pq", "plan.pq", "review", "execute.review"]);
  assert.deepEqual(hints.rows.get("scout"), { thinking: "<=low", maxTurns: 16, maxMinutes: 5 });
  assert.deepEqual(hints.rows.get("pq"), { thinking: "<=medium", maxTurns: 14 });
  assert.deepEqual(hints.rows.get("review"), { maxMinutes: 10 }, "bad thinking and out-of-range turns skipped, row kept");
  assert.equal(hints.problems.length, 3);
  assert.match(hints.problems.join("\n"), /thinking "bogus level!"/);
  assert.match(hints.problems.join("\n"), /max-turns must be an integer 1\.\.400/);
  assert.match(hints.problems.join("\n"), /role "Bad Role"/);
});

test("hints: cascade merges broad to specific per field", () => {
  const hints = parseHints(TABLE);
  assert.deepEqual(matchHint(hints, chains.pq("plan", "lens")), { thinking: "<=medium", maxTurns: 12, model: "p/fast", maxMinutes: 4 });
  assert.deepEqual(matchHint(hints, chains.review("execute")), { maxMinutes: 10, thinking: "<=high" });
  assert.equal(matchHint(hints, chains.agent("execute")), undefined);
  assert.equal(matchHint(undefined, chains.agent("scout")), undefined);
});

test("hints: <=cap never upgrades, exact snaps down, no level control drops", () => {
  const all = ["off", "minimal", "low", "medium", "high", "xhigh"];
  assert.equal(hintThinking("<=medium", "xhigh", all), "medium");
  assert.equal(hintThinking("<=medium", "low", all), "low");
  assert.equal(hintThinking("<=medium", undefined, all), "medium");
  assert.equal(hintThinking("xhigh", "low", ["off", "low", "high"]), "high");
  assert.equal(hintThinking("<=medium", "xhigh", ["off", "low", "high"]), "low");
  assert.equal(hintThinking("high", "high", []), undefined);
});

const XCAPS: Capabilities = { ...FULL_CAPS, thinking: ["off", "low", "medium", "high", "xhigh"] };
function hostDriver(scripts: Record<string, Script> = {}, seen: Spec[] = [], known = ["p/main", "p/fast"]): Driver {
  const driver = fakeDriver(scripts, seen, XCAPS);
  driver.defaultModel = (sdk) => sdk === "pi" ? "p/main" : `${sdk}/default`;
  driver.defaultThinking = (sdk) => sdk === "pi" ? "xhigh" : undefined;
  driver.validate = async (runtime) => { if (runtime.sdk === "pi" && runtime.model && !known.includes(runtime.model)) throw new Error(`unknown model ${runtime.model}`); };
  return driver;
}

test("resolveRuntime: explicit fields win; hints fill omitted ones; cross-sdk and unavailable models fall back", async () => {
  const signal = AbortSignal.timeout(5000);
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const driver = hostDriver();
  const hinted = (hint: object) => ({ hint, role: "scout", warn });
  const r1 = await resolveRuntime(driver, {}, signal, hinted({ model: "p/fast", thinking: "<=medium" }));
  assert.equal(r1.model, "p/fast");
  assert.equal(r1.thinking, "medium");
  assert.match(r1.via, /RUNTIMES\.md \(scout\)/);
  const r2 = await resolveRuntime(driver, { thinking: "high" }, signal, hinted({ model: "p/fast", thinking: "<=low" }));
  assert.deepEqual([r2.model, r2.thinking], ["p/fast", "high"], "explicit thinking kept, model still hinted");
  const r3 = await resolveRuntime(driver, { sdk: "claude-code" }, signal, hinted({ model: "p/fast", thinking: "<=low" }));
  assert.deepEqual([r3.sdk, r3.model], ["claude-code", "claude-code/default"], "pi model hint ignored for an explicit other sdk");
  const r4 = await resolveRuntime(driver, {}, signal, hinted({ model: "p/gone", thinking: "<=low" }));
  assert.deepEqual([r4.model, r4.thinking], ["p/main", "low"]);
  assert.match(warnings.join("\n"), /RUNTIMES\.md \(scout\): p\/gone unavailable.*falling back to p\/main/);
  await assert.rejects(resolveRuntime(driver, { thinking: "max" }, signal, hinted({ thinking: "<=low" })), /not a pi thinking level/, "explicit stays fail-closed");
  const plain = await resolveRuntime(driver, {}, signal);
  assert.deepEqual([plain.model, plain.thinking, plain.via], ["p/main", "xhigh", ""], "no hints: Main's runtime unchanged");
});

async function profile(t: import("node:test").TestContext, body?: string) {
  const agentDir = await mkdtemp(join(tmpdir(), "worq-hints-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await mkdir(join(agentDir, "worq"), { recursive: true });
  if (body !== undefined) await writeFile(join(agentDir, "worq", "RUNTIMES.md"), body);
  return agentDir;
}
const table = (rows: string) => `| role | sdk | model | thinking | max-turns | max-minutes |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n`;

test("hints: loader hot-reloads on change, refuses symlinks, and missing means none", async (t) => {
  const agentDir = await profile(t, table("| scout | - | - | <=low | - | - |"));
  const load = hintLoader(agentDir);
  assert.equal(load().rows.get("scout")?.thinking, "<=low");
  assert.equal(load(), load(), "unchanged file is cached");
  const file = join(agentDir, "worq", "RUNTIMES.md");
  await writeFile(file, table("| scout | - | - | <=medium | - | - |"));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(load().rows.get("scout")?.thinking, "<=medium");
  await rm(file);
  assert.equal(load().rows.size, 0);
  const outside = join(agentDir, "elsewhere.md");
  await writeFile(outside, table("| scout | - | - | low | - | - |"));
  await symlink(outside, file);
  const linked = load();
  assert.equal(linked.rows.size, 0);
  assert.match(linked.problems.join(), /ignored/);
});

test("hints: Worq applies top-level and child hints at each launch; running agents keep theirs", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentDir = await profile(t, table("| scout | - | - | <=low | 1 | - |\n| plan | - | - | <=high | - | - |\n| plan.pq | - | p/fast | <=medium | - | - |"));
  const seen: Spec[] = [];
  const events: AgentEvent[] = [];
  const warnings: string[] = [];
  const driver = hostDriver({
    "agent.scout": async () => { /* end turn without submit: a 1-turn budget parks it */ },
    "agent.plan": async (turn) => {
      if (turn.text.includes('"task"')) { await turn.tool("delegate", { name: "lens", question: "Q?", why: "w" }); return; }
      await turn.tool("submit", planSubmission);
    },
    subagent: async (turn) => { await turn.tool("submit", { answer: "a", basis: "observed" }); },
  }, seen);
  const worq = new Worq({ driver, kinds: KINDS, config: config(), state, cwd: root, notify: (e) => events.push(e), warn: (m) => warnings.push(m), hints: hintLoader(agentDir) });
  t.after(() => worq.shutdown());
  const until = async (fn: () => boolean) => { const end = Date.now() + 15_000; while (!fn()) { if (Date.now() > end) throw new Error(JSON.stringify(events.map((e) => e.type))); await new Promise((r) => setTimeout(r, 20)); } };

  const scout = await worq.spawn("scout", "Find the greeting");
  await until(() => scout.state === "parked");
  assert.match(scout.exhausted ?? "", /turn limit \(1\)/, "RUNTIMES.md max-turns lowers the owner budget");
  assert.equal(seen.find((s) => s.name === "agent.scout")?.runtime?.thinking, "low");

  const plan = await worq.spawn("plan", "Plan the change");
  await until(() => plan.state === "done" || plan.state === "parked");
  assert.equal(seen.find((s) => s.name === "agent.plan")?.runtime?.thinking, "high");
  const pq = seen.find((s) => s.name === "subagent.lens");
  assert.deepEqual([pq?.runtime?.model, pq?.runtime?.thinking], ["p/fast", "medium"]);
  assert.match(pq?.runtime?.via ?? "", /RUNTIMES\.md \(plan\.pq\.lens\)/);
  assert.ok(plan.launches.some((l) => l.role === "subagent.lens" && l.runtime.model === "p/fast"));

  await writeFile(join(agentDir, "worq", "RUNTIMES.md"), table("| scout | - | - | <=medium | - | - |\n| bad row |"));
  await utimes(join(agentDir, "worq", "RUNTIMES.md"), new Date(), new Date(Date.now() + 10_000));
  const second = await worq.spawn("scout", "Find it again", { title: "second scout" });
  await until(() => second.ended || second.state === "parked"); // no turn cap now: it ends without submitting
  assert.equal(seen.filter((s) => s.name === "agent.scout").at(-1)?.runtime?.thinking, "medium", "edits apply on the next spawn");
  assert.match(warnings.join("\n"), /role "bad row" must be/);
});
