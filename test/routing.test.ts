import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentEvent } from "../src/agent.ts";
import { resolveRuntime } from "../src/runtime/launch.ts";
import {
  budgetChains,
  evaluateRouting,
  hintThinking,
  matchRoleBudgets,
  matchRoleRouting,
  needsUsageSnapshot,
  parseRouting,
  routingChains,
  routingLoader,
} from "../src/runtime/routing.ts";
import { createUsageTracker, type ProviderSnapshot, type QuotaPool, type UsageSnapshot } from "../src/runtime/usage.ts";
import type { Capabilities, Driver, Spec } from "../src/sdk/contract.ts";
import { Worq } from "../src/worq.ts";
import { config, fakeDriver, FULL_CAPS, KINDS, planSubmission, repo, type Script } from "./fake.ts";

const SPAWN_GUIDANCE_ROUTING = {
  version: 1,
  defaults: {
    strategy: "highest-remaining",
    window: "5h",
    unknownQuota: "skip",
    refreshTimeoutMs: 2000,
  },
  roles: {
    scout: {
      rules: [
        {
          name: "primary-50pct",
          when: { window: "5h", minRemainingPercent: 50 },
          candidates: [
            { sdk: "antigravity", model: "gemini-4-hydrogen", thinking: "low" },
            { sdk: "claude-code", model: "sonnet", thinking: "low" },
          ],
        },
        {
          name: "fallback",
          strategy: "first-match",
          candidates: [
            { sdk: "pi", model: "commandcode/deepseek/deepseek-v4.1-flash", thinking: "high" },
          ],
        },
      ],
    },
    plan: {
      rules: [
        {
          name: "primary-available",
          when: { window: "5h", notExhausted: true },
          candidates: [
            { sdk: "antigravity", model: "gemini-4-neon", thinking: "medium" },
            { sdk: "claude-code", model: "claude-opus-5-5", thinking: "medium" },
            { sdk: "antigravity", model: "claude-opus-5-5", thinking: "medium" },
          ],
        },
        {
          name: "fallback",
          strategy: "first-match",
          candidates: [
            { sdk: "pi", model: "commandcode/meta/muse-spark-1.3-contributor", thinking: "max" },
          ],
        },
      ],
    },
    execute: {
      rules: [
        {
          name: "primary-20pct",
          when: { window: "5h", minRemainingPercent: 20 },
          candidates: [
            { sdk: "antigravity", model: "gemini-4-hydrogen", thinking: "medium" },
            { sdk: "claude-code", model: "claude-sonnet-5-5", thinking: "medium" },
            { sdk: "antigravity", model: "claude-sonnet-5-5", thinking: "medium" },
          ],
        },
        {
          name: "fallback",
          strategy: "first-match",
          candidates: [
            { sdk: "pi", model: "commandcode/deepseek/deepseek-v4.1-flash", thinking: "max" },
          ],
        },
      ],
    },
  },
} as const;

function snap(entries: Partial<Record<"antigravity" | "claude" | "commandcode" | "codex", { fiveHour?: number | null; weekly?: number | null; available?: boolean; limitReached?: boolean; pools?: Record<string, { fiveHour?: number | null; weekly?: number | null }> }>>): UsageSnapshot {
  const providers: ProviderSnapshot[] = Object.entries(entries).map(([provider, cfg]) => {
    let pools: Record<string, QuotaPool> | undefined;
    if (cfg?.pools) {
      pools = {};
      for (const [k, v] of Object.entries(cfg.pools)) {
        pools[k] = {
          fiveHour: v.fiveHour === null || v.fiveHour === undefined ? null : { usedPercent: 100 - v.fiveHour, remainingPercent: v.fiveHour, resetsAt: null },
          weekly: v.weekly === null || v.weekly === undefined ? null : { usedPercent: 100 - v.weekly, remainingPercent: v.weekly, resetsAt: null },
        };
      }
    }
    return {
      provider: provider as ProviderSnapshot["provider"],
      available: cfg?.available ?? true,
      fiveHour: cfg?.fiveHour === null || cfg?.fiveHour === undefined
        ? null
        : { usedPercent: 100 - cfg.fiveHour, remainingPercent: cfg.fiveHour, resetsAt: null },
      weekly: cfg?.weekly === null || cfg?.weekly === undefined
        ? null
        : { usedPercent: 100 - cfg.weekly, remainingPercent: cfg.weekly, resetsAt: null },
      ...(pools ? { pools } : {}),
      ...(cfg?.limitReached ? { extraNotes: ["limit_reached=true"] } : {}),
      fetchedAt: "2026-11-25T15:00:00.000Z",
    };
  });
  return { providers, fetchedAt: Date.now() };
}

test("parseRouting validates schema and reports clear problems without throwing", () => {
  const ok = parseRouting(JSON.stringify(SPAWN_GUIDANCE_ROUTING));
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.config);
  assert.deepEqual(Object.keys(ok.config.roles), ["scout", "plan", "execute"]);

  const badJson = parseRouting("{ not json");
  assert.equal(badJson.config, undefined);
  assert.match(badJson.problems[0] ?? "", /invalid JSON/);

  const badVersion = parseRouting(JSON.stringify({ version: 2, roles: {} }));
  assert.equal(badVersion.config, undefined);
  assert.match(badVersion.problems[0] ?? "", /\/version must be 1/);

  const partial = parseRouting(JSON.stringify({
    version: 1,
    defaults: { strategy: "bogus", refreshTimeoutMs: 99_999 },
    roles: {
      "Bad Role": { rules: [] },
      scout: {
        rules: [
          {
            name: "r1",
            when: { minRemainingPercent: 120, unknownKey: true },
            candidates: [
              { sdk: "antigravity", model: "gemini-4-hydrogen", thinking: "low" },
              { sdk: "Invalid!", model: "bad model" },
            ],
          },
        ],
      },
    },
  }));
  assert.ok(partial.config);
  assert.equal(partial.config.roles.scout?.rules?.[0]?.candidates.length, 1);
  assert.ok(partial.problems.length >= 5);
  assert.match(partial.problems.join("\n"), /\/defaults\/strategy/);
  assert.match(partial.problems.join("\n"), /minRemainingPercent/);
  assert.match(partial.problems.join("\n"), /unknownKey/);
});

test("evaluateRouting implements SPAWN-GUIDANCE 5h pools, highest-remaining tie-breaking, and threshold fallbacks", () => {
  const loaded = parseRouting(JSON.stringify(SPAWN_GUIDANCE_ROUTING));

  // Scout: antigravity 60%, claude 75% -> claude wins, then antigravity, then fallback
  const scoutMatch = matchRoleRouting(loaded, routingChains.agent("scout"))!;
  const s1 = evaluateRouting(scoutMatch.routing, scoutMatch.defaults, snap({ antigravity: { fiveHour: 60 }, claude: { fiveHour: 75 } }));
  assert.deepEqual(s1.map((c) => `${c.sdk}:${c.model}:${c.ruleName}`), [
    "claude-code:sonnet:primary-50pct",
    "antigravity:gemini-4-hydrogen:primary-50pct",
    "pi:commandcode/deepseek/deepseek-v4.1-flash:fallback",
  ]);

  // Scout: both below 50% -> skips primary-50pct, falls back to Command Code
  const s2 = evaluateRouting(scoutMatch.routing, scoutMatch.defaults, snap({ antigravity: { fiveHour: 49 }, claude: { fiveHour: 20 } }));
  assert.deepEqual(s2.map((c) => `${c.sdk}:${c.model}:${c.ruleName}`), [
    "pi:commandcode/deepseek/deepseek-v4.1-flash:fallback",
  ]);

  // Plan: antigravity 70%, claude 70% -> tie breaks by listed order (antigravity neon first, then claude opus, then antigravity opus)
  const planMatch = matchRoleRouting(loaded, routingChains.agent("plan"))!;
  const p1 = evaluateRouting(planMatch.routing, planMatch.defaults, snap({ antigravity: { fiveHour: 70 }, claude: { fiveHour: 70 } }));
  assert.deepEqual(p1.slice(0, 3).map((c) => `${c.sdk}:${c.model}`), [
    "antigravity:gemini-4-neon",
    "claude-code:claude-opus-5-5",
    "antigravity:claude-opus-5-5",
  ]);

  // Plan: all exhausted or unavailable -> fallback (even when commandcode quota is unknown!)
  const p2 = evaluateRouting(planMatch.routing, planMatch.defaults, snap({ antigravity: { fiveHour: 0 }, claude: { available: false } }));
  assert.deepEqual(p2.map((c) => `${c.sdk}:${c.model}:${c.ruleName}`), [
    "pi:commandcode/meta/muse-spark-1.3-contributor:fallback",
  ]);

  // Execute: antigravity 15% (<20), claude 20% (>=20) -> claude wins
  const execMatch = matchRoleRouting(loaded, routingChains.agent("execute"))!;
  const e1 = evaluateRouting(execMatch.routing, execMatch.defaults, snap({ antigravity: { fiveHour: 15 }, claude: { fiveHour: 20 } }));
  assert.equal(e1[0]?.sdk, "claude-code");
  assert.equal(e1[0]?.model, "claude-sonnet-5-5");

  // Execute: limit_reached=true treated as exhausted -> fallback
  const e2 = evaluateRouting(execMatch.routing, execMatch.defaults, snap({ antigravity: { fiveHour: 0 }, claude: { fiveHour: 50, limitReached: true } }));
  assert.equal(e2[0]?.sdk, "pi");
  assert.equal(e2[0]?.ruleName, "fallback");
});

test("evaluateRouting supports extensible ordered conditions (cross-provider, used%, combinators, context, unknownQuota)", () => {
  const loaded = parseRouting(JSON.stringify({
    version: 1,
    defaults: { strategy: "first-match", window: "5h", unknownQuota: "skip" },
    roles: {
      "*": {
        rules: [
          {
            name: "security-write",
            when: {
              all: [
                { access: "write" },
                { taskIncludes: ["security", "auth"] },
                { provider: "claude", maxUsedPercent: 70 },
              ],
            },
            candidates: [{ sdk: "claude-code", model: "claude-opus-5-5" }],
          },
          {
            name: "group-batch",
            when: { any: [{ inGroup: true }, { hasAttachments: true }] },
            unknownQuota: "allow",
            candidates: [{ sdk: "antigravity", model: "gemini-4-hydrogen", when: { minRemainingPercent: 10 } }],
          },
          {
            name: "default-fallback",
            candidates: [{ sdk: "pi", model: "commandcode/deepseek/deepseek-v4.1-flash" }],
          },
        ],
      },
    },
  }));

  const match = matchRoleRouting(loaded, routingChains.agent("execute"))!;
  assert.equal(needsUsageSnapshot(match.routing, match.defaults), true);

  // Matches security-write when claude usedPercent = 40 (<= 70)
  const r1 = evaluateRouting(match.routing, match.defaults, snap({ claude: { fiveHour: 60 } }), {
    access: "write",
    task: "Audit AUTH middleware",
  });
  assert.equal(r1[0]?.ruleName, "security-write");

  // Skips security-write when claude usedPercent = 80 (> 70), matches group-batch even with missing antigravity quota because unknownQuota="allow"
  const r2 = evaluateRouting(match.routing, match.defaults, snap({ claude: { fiveHour: 20 } }), {
    access: "write",
    inGroup: true,
    task: "Audit AUTH middleware",
  });
  assert.equal(r2[0]?.ruleName, "group-batch");

  // Child chains never match "*"
  assert.equal(matchRoleRouting(loaded, routingChains.pq("plan")), undefined);
  assert.equal(matchRoleRouting(loaded, routingChains.review("execute")), undefined);
});

const XCAPS: Capabilities = { ...FULL_CAPS, thinking: ["off", "low", "medium", "high", "xhigh", "max"] };
function multiDriver(scripts: Record<string, Script> = {}, seen: Spec[] = [], failing = new Set<string>()): Driver {
  const driver = fakeDriver(scripts, seen, XCAPS);
  driver.capabilities = (_role, runtime) => runtime?.sdk === "claude-code" ? { ...FULL_CAPS, thinking: [] } : XCAPS;
  driver.defaultModel = (sdk) => sdk === "pi" ? "p/main" : `${sdk}/default`;
  driver.defaultThinking = (sdk) => sdk === "pi" ? "xhigh" : undefined;
  driver.validate = async (runtime) => {
    if (failing.has(`${runtime.sdk}:${runtime.model}`) || failing.has(runtime.sdk)) {
      throw new Error(`${runtime.sdk} ${runtime.model} unavailable`);
    }
  };
  return driver;
}

test("resolveRuntime: routing.json drops unsupported thinking softly, falls through on preflight error, and yields to explicit fields", async () => {
  const signal = AbortSignal.timeout(5000);
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const loaded = parseRouting(JSON.stringify(SPAWN_GUIDANCE_ROUTING));
  const scout = matchRoleRouting(loaded, routingChains.agent("scout"))!;
  const candidates = evaluateRouting(scout.routing, scout.defaults, snap({ antigravity: { fiveHour: 60 }, claude: { fiveHour: 80 } }));

  // Claude wins with 80% remaining; thinking "low" is dropped softly because claude-code has caps.thinking=[]
  const driver = multiDriver();
  const r1 = await resolveRuntime(driver, {}, signal, { candidates, thinking: "<=medium", role: "scout", warn });
  assert.deepEqual([r1.sdk, r1.model, r1.thinking], ["claude-code", "sonnet", undefined]);
  assert.equal(r1.via, "routing.json (scout: primary-50pct)");

  // If claude-code fails local preflight, falls through to antigravity (next highest remaining)
  const driver2 = multiDriver({}, [], new Set(["claude-code"]));
  const r2 = await resolveRuntime(driver2, {}, signal, { candidates, role: "scout", warn });
  assert.deepEqual([r2.sdk, r2.model, r2.thinking], ["antigravity", "gemini-4-hydrogen", "low"]);
  assert.match(warnings.join("\n"), /claude-code sonnet unavailable/);

  // Explicit launch args always win over routing.json
  const r3 = await resolveRuntime(driver, { sdk: "pi", model: "p/explicit", thinking: "high" }, signal, { candidates, role: "scout", warn });
  assert.deepEqual([r3.sdk, r3.model, r3.thinking], ["pi", "p/explicit", "high"]);
  assert.equal(r3.via, "launch request");

  // Role thinking cap without rules applies softly over Main's runtime
  const r4 = await resolveRuntime(driver, {}, signal, { thinking: "<=medium", role: "pq", warn });
  assert.deepEqual([r4.sdk, r4.model, r4.thinking], ["pi", "p/main", "medium"]);
  assert.equal(r4.via, "routing.json (pq)");
});

test("Antigravity separate gemini vs claude 5h pools route independently", () => {
  const loaded = parseRouting(JSON.stringify({
    version: 1,
    defaults: { strategy: "highest-remaining", window: "5h", unknownQuota: "skip" },
    roles: {
      plan: {
        rules: [
          {
            name: "primary-neon-20pct",
            strategy: "first-match",
            when: { window: "5h", minRemainingPercent: 20 },
            candidates: [{ sdk: "antigravity", model: "gemini-4-neon", thinking: "medium" }],
          },
          {
            name: "secondary-opus",
            strategy: "highest-remaining",
            when: { window: "5h", notExhausted: true },
            candidates: [
              { sdk: "antigravity", model: "claude-opus-5-5", thinking: "medium" },
              { sdk: "claude-code", model: "claude-opus-5-5", thinking: "medium" },
            ],
          },
        ],
      },
      scout: {
        rules: [
          {
            name: "both-claude-50pct",
            strategy: "highest-remaining",
            when: {
              all: [
                { provider: "antigravity", pool: "claude", window: "5h", minRemainingPercent: 50 },
                { provider: "claude", window: "5h", minRemainingPercent: 50 },
              ],
            },
            candidates: [
              { sdk: "antigravity", model: "claude-sonnet-5-5", thinking: "low" },
              { sdk: "claude-code", model: "sonnet", thinking: "low" },
            ],
          },
          {
            name: "fallback",
            strategy: "first-match",
            candidates: [{ sdk: "pi", model: "commandcode/deepseek/deepseek-v4.1-flash", thinking: "high" }],
          },
        ],
      },
    },
  }));
  assert.deepEqual(loaded.problems, []);

  // Antigravity gemini pool is 10% (<20%), while antigravity claude pool is 85% and claude-code is 60%:
  // plan skips neon and picks antigravity claude-opus-5-5 (85% > 60%)!
  const planMatch = matchRoleRouting(loaded, routingChains.agent("plan"))!;
  const p1 = evaluateRouting(planMatch.routing, planMatch.defaults, snap({
    antigravity: { fiveHour: 10, pools: { gemini: { fiveHour: 10 }, claude: { fiveHour: 85 } } },
    claude: { fiveHour: 60 },
  }));
  assert.equal(p1[0]?.sdk, "antigravity");
  assert.equal(p1[0]?.model, "claude-opus-5-5");
  assert.equal(p1[0]?.pool, "claude");
  assert.equal(p1[0]?.remainingPercent, 85);

  // Scout requires BOTH antigravity/claude >= 50% AND claude >= 50%.
  // Even if antigravity/gemini is 100%, antigravity/claude at 40% forces fallback!
  const scoutMatch = matchRoleRouting(loaded, routingChains.agent("scout"))!;
  const s1 = evaluateRouting(scoutMatch.routing, scoutMatch.defaults, snap({
    antigravity: { fiveHour: 40, pools: { gemini: { fiveHour: 100 }, claude: { fiveHour: 40 } } },
    claude: { fiveHour: 90 },
  }));
  assert.equal(s1[0]?.sdk, "pi");
  assert.equal(s1[0]?.ruleName, "fallback");

  // When both antigravity/claude (70%) and claude (80%) are >= 50%, claude-code sonnet wins
  const s2 = evaluateRouting(scoutMatch.routing, scoutMatch.defaults, snap({
    antigravity: { fiveHour: 10, pools: { gemini: { fiveHour: 10 }, claude: { fiveHour: 70 } } },
    claude: { fiveHour: 80 },
  }));
  assert.equal(s2[0]?.sdk, "claude-code");
  assert.equal(s2[0]?.model, "sonnet");
});

test("routing.json per-role budgets and thinking caps merge broad -> specific (replacing RUNTIMES.md)", () => {
  const all = ["off", "minimal", "low", "medium", "high", "xhigh"];
  assert.equal(hintThinking("<=medium", "xhigh", all), "medium");
  assert.equal(hintThinking("<=medium", "low", all), "low");
  assert.equal(hintThinking("xhigh", "low", ["off", "low", "high"]), "high");
  assert.equal(hintThinking("high", "high", []), undefined);

  const loaded = parseRouting(JSON.stringify({
    version: 1,
    roles: {
      "*": { maxMinutes: 30 },
      pq: { thinking: "<=medium", maxTurns: 14, maxMinutes: 5 },
      "plan.pq": { maxTurns: 12, maxMinutes: 4 },
      review: { thinking: "<=medium", maxMinutes: 10 },
      "execute.review": { thinking: "<=high" },
    },
  }));
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(matchRoleBudgets(loaded, budgetChains.pq("plan", "lens")), {
    thinking: "<=medium",
    maxTurns: 12,
    maxMinutes: 4,
  });
  assert.deepEqual(matchRoleBudgets(loaded, budgetChains.review("execute")), {
    thinking: "<=high",
    maxMinutes: 10,
  });
});

async function profile(t: TestContext, routingJson?: unknown) {
  const agentDir = await mkdtemp(join(tmpdir(), "worq-routing-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await mkdir(join(agentDir, "worq"), { recursive: true });
  if (routingJson !== undefined) {
    await writeFile(join(agentDir, "worq", "routing.json"), typeof routingJson === "string" ? routingJson : JSON.stringify(routingJson, null, 2));
  }
  return agentDir;
}

test("routingLoader hot-reloads on change, refuses symlinks and Git checkouts", async (t) => {
  const agentDir = await profile(t, { version: 1, roles: { scout: { rules: [{ candidates: [{ sdk: "pi", model: "p/a" }] }] } } });
  const load = routingLoader(agentDir);
  assert.equal(load().config?.roles.scout?.rules?.[0]?.candidates[0]?.model, "p/a");
  assert.equal(load(), load(), "unchanged file is cached");

  const file = join(agentDir, "worq", "routing.json");
  await writeFile(file, JSON.stringify({ version: 1, roles: { scout: { rules: [{ candidates: [{ sdk: "pi", model: "p/b" }] }] } } }));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(load().config?.roles.scout?.rules?.[0]?.candidates[0]?.model, "p/b");

  await rm(file);
  assert.equal(load().config, undefined);

  const outside = join(agentDir, "outside.json");
  await writeFile(outside, JSON.stringify({ version: 1, roles: {} }));
  try {
    await symlink(outside, file);
    const linked = load();
    assert.equal(linked.config, undefined);
    assert.match(linked.problems.join("\n"), /ignored/);
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
});

test("Worq end-to-end: cold-start usage poll, defaults(), spawn(), routing.json budgets, and child routing", async (t) => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const routingCfg = {
    ...SPAWN_GUIDANCE_ROUTING,
    roles: {
      ...SPAWN_GUIDANCE_ROUTING.roles,
      scout: {
        ...SPAWN_GUIDANCE_ROUTING.roles.scout,
        maxTurns: 1,
      },
      "plan.pq": {
        rules: [
          {
            name: "pq-fast",
            candidates: [{ sdk: "antigravity", model: "gemini-4-hydrogen", thinking: "low" }],
          },
        ],
      },
    },
  };
  const agentDir = await profile(t, routingCfg);

  let antigravityPct = 30;
  let claudePct = 40;
  const usage = createUsageTracker({
    ttlMs: 60_000,
    poll: async () => [
      { provider: "antigravity", available: true, fiveHour: { usedPercent: 100 - antigravityPct, remainingPercent: antigravityPct, resetsAt: null }, weekly: null, fetchedAt: "2026-11-25T15:00:00.000Z" },
      { provider: "claude", available: true, fiveHour: { usedPercent: 100 - claudePct, remainingPercent: claudePct, resetsAt: null }, weekly: null, fetchedAt: "2026-11-25T15:00:00.000Z" },
    ],
  });
  t.after(() => usage.dispose());

  const seen: Spec[] = [];
  const events: AgentEvent[] = [];
  const driver = multiDriver({
    "agent.scout": async () => { /* parks on 1-turn budget from routing.json */ },
    "agent.plan": async (turn) => {
      if (turn.text.includes('"task"')) { await turn.tool("delegate", { name: "lens", question: "Q?", why: "w" }); return; }
      await turn.tool("submit", planSubmission);
    },
    subagent: async (turn) => { await turn.tool("submit", { answer: "a", basis: "observed" }); },
  }, seen);

  const worq = new Worq({
    driver,
    kinds: KINDS,
    config: config(),
    state,
    cwd: root,
    notify: (e) => events.push(e),
    routing: routingLoader(agentDir),
    usage,
  });
  t.after(() => worq.shutdown());
  const until = async (fn: () => boolean) => {
    const end = Date.now() + 15_000;
    while (!fn()) {
      if (Date.now() > end) throw new Error(JSON.stringify(events.map((e) => e.type)));
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  // Cold start: defaults("scout") waits for usage poll -> both < 50% -> Command Code fallback
  const scoutDefault = await worq.defaults(undefined, "scout");
  assert.equal(scoutDefault.sdk, "pi");
  assert.equal(scoutDefault.model, "commandcode/deepseek/deepseek-v4.1-flash");
  assert.equal(scoutDefault.thinking, "high");
  assert.equal(scoutDefault.via, "routing.json (scout: fallback)");

  // Spawn scout: routing.json selects runtime while RUNTIMES.md still enforces max-turns=1
  const scout = await worq.spawn("scout", "Check repo");
  await until(() => scout.state === "parked");
  assert.match(scout.exhausted ?? "", /turn limit \(1\)/);
  assert.equal(seen.find((s) => s.name === "agent.scout")?.runtime?.model, "commandcode/deepseek/deepseek-v4.1-flash");

  // Spawn plan: claude (40%) > antigravity (30%) -> claude-code opus (thinking dropped); PQ routes via plan.pq -> antigravity hydrogen
  const plan = await worq.spawn("plan", "Design feature");
  await until(() => plan.state === "done" || plan.state === "parked");
  const planSpec = seen.find((s) => s.name === "agent.plan");
  assert.equal(planSpec?.runtime?.sdk, "claude-code");
  assert.equal(planSpec?.runtime?.model, "claude-opus-5-5");
  assert.equal(planSpec?.runtime?.thinking, undefined);
  const pqSpec = seen.find((s) => s.name === "subagent.lens");
  assert.equal(pqSpec?.runtime?.sdk, "antigravity");
  assert.equal(pqSpec?.runtime?.model, "gemini-4-hydrogen");
  assert.equal(pqSpec?.runtime?.thinking, "low");
  assert.match(pqSpec?.runtime?.via ?? "", /routing\.json \(plan\.pq\.lens: pq-fast\)/);

  // Refresh with higher quota -> scout now routes to antigravity (85% > 40%)
  antigravityPct = 85;
  await usage.refresh(true);
  const scoutDefault2 = await worq.defaults(undefined, "scout");
  assert.equal(scoutDefault2.sdk, "antigravity");
  assert.equal(scoutDefault2.model, "gemini-4-hydrogen");
  assert.equal(scoutDefault2.thinking, "low");
  assert.equal(scoutDefault2.via, "routing.json (scout: primary-50pct)");
});
