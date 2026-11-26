import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createUsageTracker,
  ensureUsageSnapshot,
  formatUsageForPrompt,
  formatUsageTui,
  pollAntigravity,
  pollClaude,
  pollCodex,
  pollCommandCode,
  poolForRuntime,
  providerForRuntime,
  usageTone,
  type ProviderSnapshot,
} from "../src/runtime/usage.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("pollCommandCode parses mixed timestamps, credits, and auth.json", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "worq-usage-cc-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".commandcode"), { recursive: true });
  await writeFile(join(home, ".commandcode", "auth.json"), JSON.stringify({ apiKey: "cc-secret" }));

  let seenHeaders: Record<string, string> = {};
  const fakeFetch: typeof fetch = async (_url, init) => {
    seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return jsonResponse(200, {
      credits: {
        fiveHour: { usedPercent: 35, resetAt: "2026-11-25T20:00:00.000Z" },
        weekly: { used: 20, limit: 100, resetAt: 1795651200000 },
        monthlyCredits: 10,
        purchasedCredits: 5.5,
        freeCredits: 0,
      },
    });
  };

  const snap = await pollCommandCode({ home, env: {}, fetch: fakeFetch });
  assert.equal(snap.available, true);
  assert.equal(seenHeaders.authorization, "Bearer cc-secret");
  assert.equal(seenHeaders["x-api-key"], "cc-secret");
  assert.equal(snap.fiveHour?.remainingPercent, 65);
  assert.equal(snap.fiveHour?.resetsAt, "2026-11-25T20:00:00.000Z");
  assert.equal(snap.weekly?.remainingPercent, 80);
  assert.equal(snap.weekly?.resetsAt, new Date(1795651200000).toISOString());
  assert.deepEqual(snap.extraNotes, ["credits: 15.50 total (5.50 purchased)"]);
});

test("pollCodex classifies Team 7-day primary_window by duration and passes account header", async () => {
  let seenHeaders: Record<string, string> = {};
  const fakeFetch: typeof fetch = async (_url, init) => {
    seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return jsonResponse(200, {
      plan_type: "team",
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 92, limit_window_seconds: 604800, reset_after_seconds: 3600 },
        secondary_window: null,
      },
    });
  };

  const now = () => Date.UTC(2026, 10, 25, 12, 0, 0);
  const snap = await pollCodex({
    env: { CODEX_ACCESS_TOKEN: "cx-tok", CODEX_ACCOUNT_ID: "acct-1" },
    home: "/nonexistent",
    fetch: fakeFetch,
    now,
  });
  assert.equal(snap.available, true);
  assert.equal(seenHeaders["chatgpt-account-id"], "acct-1");
  assert.equal(snap.fiveHour, null);
  assert.equal(snap.weekly?.usedPercent, 92);
  assert.equal(snap.weekly?.remainingPercent, 8);
  assert.equal(snap.weekly?.label, "7d");
  assert.ok(snap.extraNotes?.includes("limit_reached=true"));
  assert.ok(snap.extraNotes?.includes("plan=team"));
  assert.equal(usageTone(snap), "error");
});

test("pollClaude parses windows and flags HTTP 429 explicitly", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "worq-usage-cl-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "cl-tok" } }));

  let betaHeader = "";
  const okSnap = await pollClaude({
    home,
    env: {},
    platform: "linux",
    fetch: async (_url, init) => {
      betaHeader = new Headers(init?.headers).get("anthropic-beta") ?? "";
      return jsonResponse(200, {
        five_hour: { utilization: 75, resets_at: "2026-11-25T18:00:00Z" },
        seven_day: { utilization: 40, resets_at: "2026-12-01T00:00:00Z" },
      });
    },
  });
  assert.equal(betaHeader, "oauth-2025-04-20");
  assert.equal(okSnap.available, true);
  assert.equal(okSnap.fiveHour?.remainingPercent, 25);
  assert.equal(okSnap.weekly?.remainingPercent, 60);
  assert.equal(usageTone(okSnap), "warning");

  const rateLimited = await pollClaude({
    home,
    env: {},
    platform: "linux",
    fetch: async () => jsonResponse(429, {}),
  });
  assert.equal(rateLimited.available, false);
  assert.match(rateLimited.error ?? "", /429/);
});

test("pollAntigravity merges prod and daily hosts, handles proto3 zero omission, and picks most constrained bucket", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("https://cloudcode-pa.googleapis.com")) {
      return jsonResponse(200, {
        groups: [
          {
            displayName: "Gemini",
            buckets: [
              { bucketId: "5h-pro", remainingFraction: 0.6, resetTime: "2026-11-25T19:00:00Z" },
              { bucketId: "5h-disabled", disabled: true, resetTime: "2026-11-25T19:00:00Z" },
            ],
          },
        ],
      });
    }
    return jsonResponse(200, {
      groups: [
        { displayName: "Gemini", buckets: [{ bucketId: "dup", remainingFraction: 0.1, resetTime: "2026-11-25T19:00:00Z" }] },
        {
          displayName: "Claude",
          buckets: [
            // Omitted remainingFraction with resetTime present -> 0% remaining (exhausted)
            { bucketId: "5h-claude", resetTime: "2026-11-25T18:30:00Z" },
            { bucketId: "weekly-claude", window: "7d", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" },
          ],
        },
      ],
    });
  };

  const snap = await pollAntigravity({
    env: { ANTIGRAVITY_ACCESS_TOKEN: "ag-tok" },
    home: "/nonexistent",
    platform: "linux",
    fetch: fakeFetch,
  });
  assert.equal(calls.length, 2);
  assert.equal(snap.available, true);
  assert.equal(snap.fiveHour?.remainingPercent, 0);
  assert.equal(snap.fiveHour?.label, "Claude (5h-claude)");
  assert.equal(snap.weekly?.remainingPercent, 50);
  assert.equal(snap.pools?.gemini?.fiveHour?.remainingPercent, 60);
  assert.equal(snap.pools?.claude?.fiveHour?.remainingPercent, 0);
  assert.equal(snap.pools?.claude?.weekly?.remainingPercent, 50);
  assert.equal(usageTone(snap), "error");
});

test("pollAntigravity uses Linux keyring, sends User-Agent, and falls back to fetchAvailableModels for Gemini pool", async () => {
  let seenUa = "";
  const fakeFetch: typeof fetch = async (url, init) => {
    seenUa = new Headers(init?.headers).get("user-agent") ?? "";
    const href = String(url);
    if (href.includes("retrieveUserQuotaSummary")) {
      return jsonResponse(200, {
        groups: [
          {
            displayName: "Claude and GPT models",
            buckets: [
              { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-26T06:00:00Z" },
              { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.8, resetTime: "2026-12-03T01:00:00Z" },
            ],
          },
        ],
      });
    }
    return jsonResponse(200, {
      models: {
        "gemini-4-hydrogen-sonar": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.94, resetTime: "2026-11-26T06:00:00Z" } },
        "tab_flash_lite_preview": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1 } },
      },
    });
  };

  const snap = await pollAntigravity({
    env: {},
    home: "/nonexistent",
    platform: "linux",
    readKeychain: (service, account) => (service === "gemini" && account === "antigravity" ? JSON.stringify({ access_token: "ag-linux-tok" }) : null),
    fetch: fakeFetch,
  });
  assert.equal(seenUa, "antigravity");
  assert.equal(snap.available, true);
  assert.equal(snap.pools?.claude?.fiveHour?.remainingPercent, 100);
  assert.equal(snap.pools?.claude?.weekly?.remainingPercent, 80);
  assert.equal(snap.pools?.gemini?.fiveHour?.remainingPercent, 94);
  assert.equal(snap.fiveHour?.remainingPercent, 94);
});

test("providerForRuntime and poolForRuntime map SDKs, Pi model prefixes, and Antigravity model pools", () => {
  assert.equal(providerForRuntime("claude-code", "sonnet"), "claude");
  assert.equal(providerForRuntime("pi", "anthropic/claude-sonnet-4-5"), "claude");
  assert.equal(providerForRuntime("pi", "openai-codex/gpt-5.3-codex"), "codex");
  assert.equal(providerForRuntime("pi", "google-antigravity/gemini-3-pro"), "antigravity");
  assert.equal(providerForRuntime("pi", "command-code/default"), "commandcode");
  assert.equal(providerForRuntime("pi", "openai/gpt-4o"), undefined);
  assert.equal(providerForRuntime("echo", "e/analysis"), undefined);
  assert.equal(poolForRuntime("antigravity", "gemini-4-neon"), "gemini");
  assert.equal(poolForRuntime("antigravity", "claude-opus-5-5"), "claude");
  assert.equal(poolForRuntime("antigravity", "gpt-oss-120b-medium"), "gpt");
  assert.equal(poolForRuntime("pi", "google-antigravity/claude-sonnet-5-5"), "claude");
  assert.equal(poolForRuntime("claude-code", "claude-opus-5-5"), undefined);
});

test("formatUsageForPrompt omits unavailable providers and escapes <", () => {
  const providers: ProviderSnapshot[] = [
    {
      provider: "claude",
      available: true,
      fiveHour: { usedPercent: 38, remainingPercent: 62, resetsAt: null },
      weekly: { usedPercent: 16, remainingPercent: 84, resetsAt: null },
      fetchedAt: "2026-11-25T13:00:00Z",
    },
    {
      provider: "codex",
      available: false,
      fiveHour: null,
      weekly: null,
      error: "HTTP 401",
      fetchedAt: "2026-11-25T13:00:00Z",
    },
  ];
  const prompt = formatUsageForPrompt({ providers, fetchedAt: 1 });
  assert.ok(prompt);
  assert.match(prompt, /- claude: 5h 62% left, 7d 84% left/);
  assert.doesNotMatch(prompt, /codex|401|</);
  assert.equal(formatUsageTui(providers[0]), "5h 62% left · 7d 84% left");
  assert.equal(formatUsageForPrompt({ providers: [providers[1]], fetchedAt: 1 }), undefined);
});

test("createUsageTracker caches within TTL, deduplicates in-flight polls, notifies subscribers, and aborts on dispose", async () => {
  let clock = 1_000;
  let polls = 0;
  let aborted = false;
  let release!: () => void;

  const tracker = createUsageTracker({
    ttlMs: 60_000,
    now: () => clock,
    poll: async (signal) => {
      polls++;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      if (polls === 1) await new Promise<void>((resolve) => { release = resolve; });
      return [
        {
          provider: "claude",
          available: true,
          fiveHour: { usedPercent: 20, remainingPercent: 80, resetsAt: null },
          weekly: null,
          fetchedAt: new Date(clock).toISOString(),
        },
      ];
    },
  });

  let notifications = 0;
  const unsub = tracker.subscribe(() => { notifications++; });
  assert.equal(tracker.current(), undefined);

  const p1 = tracker.refresh();
  const p2 = tracker.refresh();
  assert.equal(polls, 1, "in-flight refreshes deduplicate");
  release();
  await Promise.all([p1, p2]);
  assert.equal(notifications, 1);
  assert.equal(tracker.current()?.providers[0]?.fiveHour?.remainingPercent, 80);

  // Within TTL: no extra poll
  clock += 30_000;
  await tracker.refresh();
  assert.equal(polls, 1);

  // Past TTL: polls again
  clock += 31_000;
  await tracker.refresh();
  assert.equal(polls, 2);
  assert.equal(notifications, 2);

  unsub();
  // Verify dispose aborts an in-flight poll
  let neverRelease!: () => void;
  const slow = createUsageTracker({
    poll: (signal) => new Promise((_resolve, reject) => {
      neverRelease = () => reject(new Error("aborted"));
      signal.addEventListener("abort", () => { aborted = true; neverRelease(); }, { once: true });
    }),
  });
  const pending = slow.refresh();
  slow.dispose();
  await pending;
  assert.equal(aborted, true);
});

test("ensureUsageSnapshot waits bounded on cold start without aborting background poll, and returns cached snapshot immediately", async () => {
  let release!: () => void;
  let polls = 0;
  const tracker = createUsageTracker({
    ttlMs: 60_000,
    poll: async () => {
      polls++;
      if (polls === 1) await new Promise<void>((resolve) => { release = resolve; });
      return [{ provider: "claude", available: true, fiveHour: { usedPercent: 25, remainingPercent: 75, resetsAt: null }, weekly: null, fetchedAt: "2026-11-25T15:00:00.000Z" }];
    },
  });

  // Cold start times out quickly without aborting the in-flight poll
  const timedOut = await ensureUsageSnapshot(tracker, 15);
  assert.equal(timedOut, undefined);
  assert.equal(polls, 1);

  // Once the background poll completes, subsequent calls return cached immediately
  release();
  await tracker.refresh();
  const cached = await ensureUsageSnapshot(tracker, 500);
  assert.equal(cached?.providers[0]?.fiveHour?.remainingPercent, 75);
  assert.equal(polls, 1);
  tracker.dispose();
});
