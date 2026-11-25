import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageProvider = "commandcode" | "codex" | "claude" | "antigravity";

export interface NormalizedWindow {
  /** 0-100 percentage used */
  usedPercent: number;
  /** 0-100 percentage remaining */
  remainingPercent: number;
  /** ISO-8601 reset timestamp, or null if unused/unknown */
  resetsAt: string | null;
  /** Optional provider-specific bucket or pool name */
  label?: string;
}

export interface ProviderSnapshot {
  provider: UsageProvider;
  available: boolean;
  fiveHour: NormalizedWindow | null;
  weekly: NormalizedWindow | null;
  extraNotes?: string[];
  error?: string;
  fetchedAt: string;
}

export interface UsageSnapshot {
  providers: readonly ProviderSnapshot[];
  fetchedAt: number;
}

export interface UsageView {
  current(): UsageSnapshot | undefined;
  subscribe(listener: () => void): () => void;
}

export interface UsageTracker extends UsageView {
  refresh(force?: boolean): Promise<UsageSnapshot | undefined>;
  dispose(): void;
}

export interface PollOptions {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  readKeychain?: (service: string, account?: string) => string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export const DEFAULT_USAGE_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(readFileSync(filePath, "utf8"))) ?? null;
  } catch {
    return null;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    const val = readFileSync(filePath, "utf8").trim();
    return val || null;
  } catch {
    return null;
  }
}

function defaultReadMacKeychain(service: string, account?: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const args = ["find-generic-password", "-s", service];
    if (account) args.push("-a", account);
    args.push("-w");
    const out = execFileSync("security", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === 0 || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function fromUsedPercent(used: number, resetsAt: unknown, label?: string): NormalizedWindow {
  const usedPercent = clampPct(used);
  return {
    usedPercent,
    remainingPercent: clampPct(100 - usedPercent),
    resetsAt: toIsoDate(resetsAt),
    ...(label ? { label } : {}),
  };
}

function fromRemainingFraction(fraction: number, resetsAt: unknown, label?: string): NormalizedWindow {
  const remainingPercent = clampPct(fraction * 100);
  return {
    usedPercent: clampPct(100 - remainingPercent),
    remainingPercent,
    resetsAt: toIsoDate(resetsAt),
    ...(label ? { label } : {}),
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  opts: Required<Pick<PollOptions, "fetch" | "timeoutMs">> & { signal?: AbortSignal },
): Promise<{ status: number; data: unknown }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await opts.fetch(url, { ...init, signal });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function unavailable(provider: UsageProvider, error: string, fetchedAt: string): ProviderSnapshot {
  return { provider, available: false, fiveHour: null, weekly: null, error, fetchedAt };
}

// ---------------------------------------------------------------------------
// 1. Command Code
// ---------------------------------------------------------------------------

function getCommandCodeKey(env: NodeJS.ProcessEnv, home: string): string | null {
  const envKey = str(env.COMMAND_CODE_API_KEY) ?? str(env.COMMANDCODE_API_KEY);
  if (envKey) return envKey;
  const auth = readJsonFile(join(home, ".commandcode", "auth.json"));
  return str(auth?.apiKey) ?? str(auth?.api_key) ?? str(auth?.token) ?? str(auth?.accessToken);
}

function parseCommandCodeWindow(value: unknown): NormalizedWindow | null {
  const win = record(value);
  if (!win) return null;
  const resetsAt = win.resetAt ?? win.resetsAt ?? win.resets_at ?? null;
  if (typeof win.usedPercent === "number") return fromUsedPercent(win.usedPercent, resetsAt);
  if (typeof win.utilization === "number") return fromUsedPercent(win.utilization, resetsAt);
  if (typeof win.remainingPercent === "number") return fromRemainingFraction(win.remainingPercent / 100, resetsAt);
  if (typeof win.used === "number" && typeof win.limit === "number" && win.limit > 0) {
    return fromUsedPercent((win.used / win.limit) * 100, resetsAt);
  }
  return null;
}

export async function pollCommandCode(options: PollOptions = {}): Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const fetchedAt = new Date(now()).toISOString();
  const apiKey = getCommandCodeKey(env, home);
  if (!apiKey) return unavailable("commandcode", "No COMMAND_CODE_API_KEY or ~/.commandcode/auth.json found", fetchedAt);

  try {
    const { status, data } = await fetchJson(
      "https://api.commandcode.ai/alpha/billing/credits",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "x-api-key": apiKey,
          Accept: "application/json",
        },
      },
      { fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: options.signal },
    );
    if (status !== 200) return unavailable("commandcode", `HTTP ${status}`, fetchedAt);

    const parsed = record(data);
    const root = record(parsed?.credits) ?? parsed ?? {};
    const windows = record(root.windows);
    const fiveHour = parseCommandCodeWindow(root.fiveHour ?? root.five_hour ?? windows?.fiveHour);
    const weekly = parseCommandCodeWindow(root.weekly ?? root.sevenDay ?? windows?.weekly);

    const extraNotes: string[] = [];
    const monthly = Number(root.monthlyCredits ?? 0);
    const purchased = Number(root.purchasedCredits ?? 0);
    const free = Number(root.freeCredits ?? 0);
    const totalRemaining = monthly + purchased + free;
    if (Number.isFinite(totalRemaining) && (totalRemaining > 0 || purchased > 0)) {
      extraNotes.push(`credits: ${totalRemaining.toFixed(2)} total (${purchased.toFixed(2)} purchased)`);
    }
    return { provider: "commandcode", available: true, fiveHour, weekly, extraNotes, fetchedAt };
  } catch (error) {
    return unavailable("commandcode", error instanceof Error ? error.message : String(error), fetchedAt);
  }
}

// ---------------------------------------------------------------------------
// 2. OpenAI Codex
// ---------------------------------------------------------------------------

function getCodexAuth(env: NodeJS.ProcessEnv, home: string): { token: string; accountId?: string } | null {
  const envToken = str(env.CODEX_ACCESS_TOKEN);
  if (envToken) return { token: envToken, accountId: str(env.CODEX_ACCOUNT_ID) ?? undefined };
  const auth = readJsonFile(join(home, ".codex", "auth.json"));
  const tokens = record(auth?.tokens);
  const token = str(tokens?.access_token) ?? str(auth?.access_token);
  if (!token) return null;
  return { token, accountId: str(tokens?.account_id) ?? str(auth?.account_id) ?? undefined };
}

export async function pollCodex(options: PollOptions = {}): Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const fetchedAt = new Date(now()).toISOString();
  const auth = getCodexAuth(env, home);
  if (!auth) return unavailable("codex", "No CODEX_ACCESS_TOKEN or ~/.codex/auth.json found", fetchedAt);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  try {
    const { status, data } = await fetchJson(
      "https://chatgpt.com/backend-api/wham/usage",
      { headers },
      { fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: options.signal },
    );
    if (status !== 200) return unavailable("codex", `HTTP ${status}`, fetchedAt);

    const parsed = record(data);
    const rl = record(parsed?.rate_limit) ?? {};
    const candidates = [record(rl.primary_window), record(rl.secondary_window)].filter((w): w is Record<string, unknown> => w !== undefined);

    let fiveHour: NormalizedWindow | null = null;
    let weekly: NormalizedWindow | null = null;
    for (const win of candidates) {
      const used = Number(win.used_percent ?? 0);
      const resetAt =
        win.reset_at ??
        (typeof win.reset_after_seconds === "number" ? now() + win.reset_after_seconds * 1000 : null);
      const secs = Number(win.limit_window_seconds ?? 0);

      // Classify by window duration rather than slot name, since Team plans
      // place the 7-day window (604800s) in primary_window with secondary_window = null.
      if (secs >= 3 * 86_400) {
        weekly = fromUsedPercent(used, resetAt, `${Math.round(secs / 86_400)}d`);
      } else if (secs > 0) {
        fiveHour = fromUsedPercent(used, resetAt, `${Math.round(secs / 3600)}h`);
      } else if (!fiveHour) {
        fiveHour = fromUsedPercent(used, resetAt);
      } else {
        weekly = fromUsedPercent(used, resetAt);
      }
    }

    const extraNotes: string[] = [];
    if (rl.limit_reached === true) extraNotes.push("limit_reached=true");
    const plan = str(parsed?.plan_type);
    if (plan) extraNotes.push(`plan=${plan}`);
    return { provider: "codex", available: true, fiveHour, weekly, extraNotes, fetchedAt };
  } catch (error) {
    return unavailable("codex", error instanceof Error ? error.message : String(error), fetchedAt);
  }
}

// ---------------------------------------------------------------------------
// 3. Claude Code (read-only polling)
// ---------------------------------------------------------------------------

function getClaudeToken(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  readKeychain: (service: string, account?: string) => string | null,
): string | null {
  const envToken = str(env.CLAUDE_OAUTH_TOKEN);
  if (envToken) return envToken;
  const configDir = str(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
  const creds = readJsonFile(join(configDir, ".credentials.json"));
  const fileToken = str(record(creds?.claudeAiOauth)?.accessToken) ?? str(creds?.accessToken);
  if (fileToken) return fileToken;

  if (platform === "darwin") {
    const raw = readKeychain("Claude Code-credentials");
    if (raw) {
      try {
        const parsed = record(JSON.parse(raw));
        return str(record(parsed?.claudeAiOauth)?.accessToken) ?? str(parsed?.accessToken);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function pollClaude(options: PollOptions = {}): Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const readKeychain = options.readKeychain ?? defaultReadMacKeychain;
  const now = options.now ?? Date.now;
  const fetchedAt = new Date(now()).toISOString();
  const token = getClaudeToken(env, home, platform, readKeychain);
  if (!token) return unavailable("claude", "No CLAUDE_OAUTH_TOKEN, ~/.claude/.credentials.json, or Keychain entry found", fetchedAt);

  try {
    const { status, data } = await fetchJson(
      "https://api.anthropic.com/api/oauth/usage",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
        },
      },
      { fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: options.signal },
    );
    if (status === 429) return unavailable("claude", "HTTP 429 (rate limited per access token)", fetchedAt);
    if (status !== 200) return unavailable("claude", `HTTP ${status}`, fetchedAt);

    const parsed = record(data);
    const five = record(parsed?.five_hour);
    const seven = record(parsed?.seven_day);
    const fiveHour = five ? fromUsedPercent(Number(five.utilization ?? 0), five.resets_at) : null;
    const weekly = seven ? fromUsedPercent(Number(seven.utilization ?? 0), seven.resets_at) : null;
    return { provider: "claude", available: true, fiveHour, weekly, fetchedAt };
  } catch (error) {
    return unavailable("claude", error instanceof Error ? error.message : String(error), fetchedAt);
  }
}

// ---------------------------------------------------------------------------
// 4. Google Gemini / Antigravity (read-only polling)
// ---------------------------------------------------------------------------

function extractAntigravityToken(raw: string): string | null {
  try {
    const parsed = record(JSON.parse(raw));
    const tok = record(parsed?.token) ?? parsed;
    return str(tok?.access_token) ?? str(tok?.accessToken);
  } catch {
    return str(raw);
  }
}

function getAntigravityToken(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  readKeychain: (service: string, account?: string) => string | null,
): string | null {
  const envToken = str(env.ANTIGRAVITY_ACCESS_TOKEN);
  if (envToken) return envToken;
  const fileText = readTextFile(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
  if (fileText) {
    const token = extractAntigravityToken(fileText);
    if (token) return token;
  }
  if (platform === "darwin") {
    const keychainText = readKeychain("gemini", "antigravity");
    if (keychainText) return extractAntigravityToken(keychainText);
  }
  return null;
}

function pickMostConstrained(current: NormalizedWindow | null, candidate: NormalizedWindow): NormalizedWindow {
  if (!current) return candidate;
  return candidate.remainingPercent < current.remainingPercent ? candidate : current;
}

export async function pollAntigravity(options: PollOptions = {}): Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const readKeychain = options.readKeychain ?? defaultReadMacKeychain;
  const now = options.now ?? Date.now;
  const fetchedAt = new Date(now()).toISOString();
  const token = getAntigravityToken(env, home, platform, readKeychain);
  if (!token) {
    return unavailable("antigravity", "No ANTIGRAVITY_ACCESS_TOKEN or ~/.gemini/antigravity-cli/antigravity-oauth-token found", fetchedAt);
  }

  const hosts = ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"];
  const allGroups: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const seenGroupNames = new Set<string>();

  for (const host of hosts) {
    try {
      const { status, data } = await fetchJson(
        `${host}/v1internal:retrieveUserQuotaSummary`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
        { fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: options.signal },
      );
      if (status !== 200) {
        errors.push(`${host}: HTTP ${status}`);
        continue;
      }
      const parsed = record(data);
      const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
      for (const item of groups) {
        const g = record(item);
        if (!g) continue;
        const key = str(g.displayName) ?? JSON.stringify(g);
        if (!seenGroupNames.has(key)) {
          seenGroupNames.add(key);
          allGroups.push(g);
        }
      }
    } catch (error) {
      errors.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (allGroups.length === 0) {
    return unavailable("antigravity", errors.join("; ") || "Empty quota summary", fetchedAt);
  }

  let fiveHour: NormalizedWindow | null = null;
  let weekly: NormalizedWindow | null = null;

  for (const group of allGroups) {
    const groupName = str(group.displayName) ?? "default";
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const item of buckets) {
      const b = record(item);
      if (!b || b.disabled === true) continue;
      const remaining = record(b.remaining);
      const resetTime = b.resetTime ?? remaining?.resetTime ?? null;
      const rawFraction = b.remainingFraction ?? remaining?.remainingFraction;
      // Proto3 JSON omits 0-valued fields: treat missing remainingFraction as 0
      // whenever resetTime is present and the bucket is not disabled.
      const fraction = typeof rawFraction === "number" ? rawFraction : resetTime ? 0 : null;
      if (fraction === null) continue;

      const label = `${groupName} (${str(b.bucketId) ?? str(b.displayName) ?? "bucket"})`;
      const normalized = fromRemainingFraction(fraction, resetTime, label);
      const hint = `${str(b.window) ?? ""} ${str(b.bucketId) ?? ""} ${str(b.displayName) ?? ""}`.toLowerCase();
      if (hint.includes("week") || hint.includes("7d")) {
        weekly = pickMostConstrained(weekly, normalized);
      } else {
        fiveHour = pickMostConstrained(fiveHour, normalized);
      }
    }
  }

  return { provider: "antigravity", available: true, fiveHour, weekly, fetchedAt };
}

export async function pollAllProviders(options: PollOptions = {}): Promise<ProviderSnapshot[]> {
  return Promise.all([pollCommandCode(options), pollCodex(options), pollClaude(options), pollAntigravity(options)]);
}

// ---------------------------------------------------------------------------
// Runtime-to-Provider Mapping & Formatting
// ---------------------------------------------------------------------------

export function providerForRuntime(sdk: string, model?: string): UsageProvider | undefined {
  const s = sdk.trim().toLowerCase();
  if (s === "claude-code" || s === "claude") return "claude";
  if (s === "codex") return "codex";
  if (s === "commandcode" || s === "command-code") return "commandcode";
  if (s === "antigravity" || s === "gemini") return "antigravity";

  const m = model?.trim().toLowerCase();
  if (!m) return undefined;
  const slash = m.indexOf("/");
  const prefix = slash >= 0 ? m.slice(0, slash) : "";
  if (prefix === "anthropic" || m.startsWith("claude-")) return "claude";
  if (prefix === "openai-codex" || prefix === "codex") return "codex";
  if (prefix === "google-antigravity" || prefix === "antigravity" || prefix === "google-gemini-cli") return "antigravity";
  if (prefix === "commandcode" || prefix === "command-code") return "commandcode";
  return undefined;
}

export function hasQuotaInfo(snap: ProviderSnapshot): boolean {
  return snap.available && (snap.fiveHour !== null || snap.weekly !== null || Boolean(snap.extraNotes?.includes("limit_reached=true")));
}

export function usageTone(snap: ProviderSnapshot): "muted" | "warning" | "error" {
  if (snap.extraNotes?.includes("limit_reached=true")) return "error";
  const remaining = [snap.fiveHour?.remainingPercent, snap.weekly?.remainingPercent].filter((v): v is number => typeof v === "number");
  if (!remaining.length) return "muted";
  const lowest = Math.min(...remaining);
  if (lowest < 10) return "error";
  if (lowest < 30) return "warning";
  return "muted";
}

function fmtClock(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatUsageTui(snap: ProviderSnapshot): string {
  const parts: string[] = [];
  if (snap.fiveHour) {
    const reset = fmtClock(snap.fiveHour.resetsAt);
    parts.push(`5h ${Math.round(snap.fiveHour.remainingPercent)}% left${reset ? ` (${reset})` : ""}`);
  }
  if (snap.weekly) {
    parts.push(`7d ${Math.round(snap.weekly.remainingPercent)}% left`);
  }
  if (snap.extraNotes?.includes("limit_reached=true")) parts.push("limit reached");
  return parts.join(" · ") || "available";
}

export function formatUsageForPrompt(snapshot: UsageSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  const available = snapshot.providers.filter(hasQuotaInfo);
  if (!available.length) return undefined;
  const lines = available.map((snap) => {
    const parts: string[] = [];
    if (snap.fiveHour) {
      const reset = fmtClock(snap.fiveHour.resetsAt);
      parts.push(`5h ${Math.round(snap.fiveHour.remainingPercent)}% left${reset ? ` (resets ${reset})` : ""}`);
    }
    if (snap.weekly) {
      parts.push(`7d ${Math.round(snap.weekly.remainingPercent)}% left`);
    }
    if (snap.extraNotes?.includes("limit_reached=true")) parts.push("limit reached");
    return `- ${snap.provider}: ${parts.join(", ")}`;
  });
  return [
    "Provider usage snapshot (advisory; cached up to 5m — prefer providers with headroom when choices are otherwise comparable):",
    ...lines,
  ].join("\n").replaceAll("<", "\\u003c");
}

// ---------------------------------------------------------------------------
// Cached Non-Blocking Tracker
// ---------------------------------------------------------------------------

export interface UsageTrackerOptions {
  ttlMs?: number;
  now?: () => number;
  poll?: (signal: AbortSignal) => Promise<readonly ProviderSnapshot[]>;
}

export function createUsageTracker(options: UsageTrackerOptions = {}): UsageTracker {
  const ttlMs = options.ttlMs ?? DEFAULT_USAGE_TTL_MS;
  const now = options.now ?? Date.now;
  const poll = options.poll ?? ((signal) => pollAllProviders({ signal, now }));
  const listeners = new Set<() => void>();
  let snapshot: UsageSnapshot | undefined;
  let inFlight: Promise<UsageSnapshot | undefined> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;

  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* display only */ }
    }
  };

  return {
    current: () => snapshot,
    async refresh(force = false) {
      if (disposed) return snapshot;
      if (!force && snapshot && now() - snapshot.fetchedAt < ttlMs) return snapshot;
      if (inFlight) return inFlight;
      controller = new AbortController();
      const active = controller;
      inFlight = (async () => {
        try {
          const providers = await poll(active.signal);
          if (disposed || active.signal.aborted) return snapshot;
          snapshot = { providers, fetchedAt: now() };
          notify();
          return snapshot;
        } catch {
          return snapshot;
        } finally {
          if (controller === active) controller = undefined;
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      disposed = true;
      listeners.clear();
      controller?.abort();
      controller = undefined;
    },
  };
}
