import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorText } from "../contracts.ts";
import { contained, exists, outsideCheckout, readBounded } from "./skills.ts";
import {
  poolForRuntime,
  providerForRuntime,
  USAGE_PROVIDERS,
  type ProviderSnapshot,
  type UsageProvider,
  type UsageSnapshot,
} from "./usage.ts";

type QuotaWindow = "5h" | "7d";
type RoutingStrategy = "first-match" | "highest-remaining";
type UnknownQuotaPolicy = "skip" | "allow";

interface RoutingCondition {
  provider?: UsageProvider;
  /** Optional provider-specific quota pool (e.g. Antigravity "gemini", "claude", "gpt"). */
  pool?: string;
  window?: QuotaWindow;
  minRemainingPercent?: number;
  maxRemainingPercent?: number;
  minUsedPercent?: number;
  maxUsedPercent?: number;
  notExhausted?: boolean;
  access?: "read" | "write";
  inGroup?: boolean;
  hasAttachments?: boolean;
  taskIncludes?: readonly string[];
  all?: readonly RoutingCondition[];
  any?: readonly RoutingCondition[];
}

interface RoutingCandidate {
  sdk: string;
  model: string;
  thinking?: string;
  provider?: UsageProvider;
  /** Optional quota pool override; inferred automatically for Antigravity models. */
  pool?: string;
  when?: RoutingCondition;
}

interface RoutingRule {
  name?: string;
  strategy?: RoutingStrategy;
  unknownQuota?: UnknownQuotaPolicy;
  when?: RoutingCondition;
  candidates: readonly RoutingCandidate[];
}

/** Per-role soft defaults and budgets merged broad -> specific across roles (replaces RUNTIMES.md). */
export interface RoleBudgets {
  thinking?: string;
  maxTurns?: number;
  maxMinutes?: number;
}

interface RoleRouting extends RoleBudgets {
  rules?: readonly RoutingRule[];
}

interface RoutingDefaults {
  strategy: RoutingStrategy;
  window: QuotaWindow;
  unknownQuota: UnknownQuotaPolicy;
  refreshTimeoutMs: number;
}

interface RoutingConfig {
  version: 1;
  defaults: RoutingDefaults;
  roles: Readonly<Record<string, RoleRouting>>;
}

export interface LoadedRouting {
  path: string;
  config?: RoutingConfig;
  /** Parse or validation issues; warned once per file version. */
  problems: readonly string[];
  /** `${mtimeMs}:${size}`, absent when the file does not exist. */
  stamp?: string;
}

export interface RoutingContext {
  access?: "read" | "write";
  inGroup?: boolean;
  hasAttachments?: boolean;
  task?: string;
}

export interface RoutedCandidate {
  sdk: string;
  model: string;
  thinking?: string;
  ruleName?: string;
  ruleIndex: number;
  provider?: UsageProvider;
  pool?: string;
  remainingPercent?: number;
}

const DEFAULT_ROUTING_DEFAULTS: RoutingDefaults = {
  strategy: "first-match",
  window: "5h",
  unknownQuota: "skip",
  refreshTimeoutMs: 2_000,
};

/** Canonical thinking rank order (matches sdk/pi.ts). Levels outside it only match exactly. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ROLE = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*)$/;
const SDK = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const THINKING = /^(<=)?([a-z][a-z0-9-]*)$/;
const POOL = /^[a-z][a-z0-9-]{0,31}$/;
const PROVIDERS = new Set<string>(USAGE_PROVIDERS);
const WINDOWS = new Set<string>(["5h", "7d"]);
const STRATEGIES = new Set<string>(["first-match", "highest-remaining"]);
const UNKNOWN_POLICIES = new Set<string>(["skip", "allow"]);
const BUDGET_RANGES = { maxTurns: [1, 400], maxMinutes: [1, 600] } as const;
const MAX_CONDITION_DEPTH = 8;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const routingPath = (agentDir: string) => join(agentDir, "worq", "routing.json");

const empty = (path: string, problems: string[] = [], stamp?: string): LoadedRouting => ({
  path,
  problems,
  ...(stamp ? { stamp } : {}),
});

/** Most-specific to broadest chains for `rules` lookup. Child roles never fall back to `*` so parent inheritance stays intact. */
export const routingChains = {
  agent: (kind: string): readonly string[] => [kind, "*"],
  pq: (kind: string, name?: string): readonly string[] => [
    ...(name ? [`${kind}.pq.${name}`] : []),
    `${kind}.pq`,
    "pq",
  ],
  review: (kind: string): readonly string[] => [`${kind}.review`, "review"],
  edit: (kind: string, name?: string): readonly string[] => [
    ...(name ? [`${kind}.edit.${name}`] : []),
    `${kind}.edit`,
    "edit",
  ],
};

/** Broad -> specific chains for per-role budgets and default thinking caps (replaces RUNTIMES.md). */
export const budgetChains = {
  agent: (kind: string): readonly string[] => ["*", kind],
  pq: (kind: string, name?: string): readonly string[] => ["*", "pq", `${kind}.pq`, ...(name ? [`${kind}.pq.${name}`] : [])],
  review: (kind: string): readonly string[] => ["*", "review", `${kind}.review`],
  edit: (kind: string, name?: string): readonly string[] => ["*", "edit", `${kind}.edit`, ...(name ? [`${kind}.edit.${name}`] : [])],
};

const rank = (level: string | undefined) => (level === undefined ? -1 : (LEVELS as readonly string[]).indexOf(level));
/**
 * `level`: that level, snapped down to the highest supported one. `<=level`: the inherited level capped at `level`
 * (never upgraded), snapped down likewise. No level control (`[]`) drops the thinking setting.
 */
export function hintThinking(hint: string, inherited: string | undefined, supported: readonly string[]): string | undefined {
  if (!supported.length) return undefined;
  const [, cap, level] = THINKING.exec(hint) ?? [];
  if (!level) return supported.includes(inherited ?? "") ? inherited : undefined;
  const target = cap && inherited !== undefined && rank(inherited) >= 0 && rank(inherited) <= rank(level) ? inherited : level;
  if (supported.includes(target)) return target;
  const want = rank(target);
  if (want < 0) return supported.includes(inherited ?? "") ? inherited : undefined;
  return [...supported].filter((l) => rank(l) >= 0 && rank(l) <= want).sort((a, b) => rank(b) - rank(a))[0];
}

function parsePercent(value: unknown, pointer: string, problems: string[]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  problems.push(`${pointer}: expected a number between 0 and 100`);
  return undefined;
}

function parseCondition(raw: unknown, pointer: string, problems: string[], depth = 0): RoutingCondition | undefined {
  if (depth > MAX_CONDITION_DEPTH) {
    problems.push(`${pointer}: condition nesting exceeds ${MAX_CONDITION_DEPTH}`);
    return undefined;
  }
  if (!isRecord(raw)) {
    problems.push(`${pointer}: expected an object`);
    return undefined;
  }
  const allowed = new Set([
    "provider", "pool", "window", "minRemainingPercent", "maxRemainingPercent",
    "minUsedPercent", "maxUsedPercent", "notExhausted",
    "access", "inGroup", "hasAttachments", "taskIncludes", "all", "any",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) problems.push(`${pointer}/${key}: unknown condition key`);
  }
  const out: RoutingCondition = {};
  if (raw.provider !== undefined) {
    if (typeof raw.provider === "string" && PROVIDERS.has(raw.provider)) out.provider = raw.provider as UsageProvider;
    else problems.push(`${pointer}/provider: expected one of ${USAGE_PROVIDERS.join(", ")}`);
  }
  if (raw.pool !== undefined) {
    if (typeof raw.pool === "string" && POOL.test(raw.pool.trim().toLowerCase())) out.pool = raw.pool.trim().toLowerCase();
    else problems.push(`${pointer}/pool: expected a pool name (e.g. "gemini", "claude", "gpt")`);
  }
  if (raw.window !== undefined) {
    if (typeof raw.window === "string" && WINDOWS.has(raw.window)) out.window = raw.window as QuotaWindow;
    else problems.push(`${pointer}/window: expected "5h" or "7d"`);
  }
  if (raw.minRemainingPercent !== undefined) {
    const n = parsePercent(raw.minRemainingPercent, `${pointer}/minRemainingPercent`, problems);
    if (n !== undefined) out.minRemainingPercent = n;
  }
  if (raw.maxRemainingPercent !== undefined) {
    const n = parsePercent(raw.maxRemainingPercent, `${pointer}/maxRemainingPercent`, problems);
    if (n !== undefined) out.maxRemainingPercent = n;
  }
  if (raw.minUsedPercent !== undefined) {
    const n = parsePercent(raw.minUsedPercent, `${pointer}/minUsedPercent`, problems);
    if (n !== undefined) out.minUsedPercent = n;
  }
  if (raw.maxUsedPercent !== undefined) {
    const n = parsePercent(raw.maxUsedPercent, `${pointer}/maxUsedPercent`, problems);
    if (n !== undefined) out.maxUsedPercent = n;
  }
  if (raw.notExhausted !== undefined) {
    if (typeof raw.notExhausted === "boolean") out.notExhausted = raw.notExhausted;
    else problems.push(`${pointer}/notExhausted: expected boolean`);
  }
  if (raw.access !== undefined) {
    if (raw.access === "read" || raw.access === "write") out.access = raw.access;
    else problems.push(`${pointer}/access: expected "read" or "write"`);
  }
  if (raw.inGroup !== undefined) {
    if (typeof raw.inGroup === "boolean") out.inGroup = raw.inGroup;
    else problems.push(`${pointer}/inGroup: expected boolean`);
  }
  if (raw.hasAttachments !== undefined) {
    if (typeof raw.hasAttachments === "boolean") out.hasAttachments = raw.hasAttachments;
    else problems.push(`${pointer}/hasAttachments: expected boolean`);
  }
  if (raw.taskIncludes !== undefined) {
    if (Array.isArray(raw.taskIncludes) && raw.taskIncludes.length > 0 && raw.taskIncludes.length <= 32
        && raw.taskIncludes.every((s) => typeof s === "string" && s.trim().length > 0 && s.length <= 120)) {
      out.taskIncludes = raw.taskIncludes.map((s) => s.trim());
    } else {
      problems.push(`${pointer}/taskIncludes: expected a non-empty array of 1..32 non-empty strings (<= 120 chars)`);
    }
  }
  if (raw.all !== undefined) {
    if (Array.isArray(raw.all) && raw.all.length > 0 && raw.all.length <= 16) {
      const items: RoutingCondition[] = [];
      raw.all.forEach((item, i) => {
        const parsed = parseCondition(item, `${pointer}/all/${i}`, problems, depth + 1);
        if (parsed) items.push(parsed);
      });
      if (items.length) out.all = items;
    } else {
      problems.push(`${pointer}/all: expected a non-empty array of 1..16 conditions`);
    }
  }
  if (raw.any !== undefined) {
    if (Array.isArray(raw.any) && raw.any.length > 0 && raw.any.length <= 16) {
      const items: RoutingCondition[] = [];
      raw.any.forEach((item, i) => {
        const parsed = parseCondition(item, `${pointer}/any/${i}`, problems, depth + 1);
        if (parsed) items.push(parsed);
      });
      if (items.length) out.any = items;
    } else {
      problems.push(`${pointer}/any: expected a non-empty array of 1..16 conditions`);
    }
  }
  return out;
}

function parseCandidate(raw: unknown, pointer: string, problems: string[]): RoutingCandidate | undefined {
  if (!isRecord(raw)) {
    problems.push(`${pointer}: expected an object`);
    return undefined;
  }
  const sdk = typeof raw.sdk === "string" ? raw.sdk.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!SDK.test(sdk)) {
    problems.push(`${pointer}/sdk: expected a valid sdk id`);
    return undefined;
  }
  if (!model || /\s/.test(model) || model.length > 200) {
    problems.push(`${pointer}/model: expected a non-empty model ref without whitespace (<= 200 chars)`);
    return undefined;
  }
  const candidate: RoutingCandidate = { sdk, model };
  if (raw.thinking !== undefined) {
    if (typeof raw.thinking === "string" && THINKING.test(raw.thinking.trim())) {
      candidate.thinking = raw.thinking.trim();
    } else {
      problems.push(`${pointer}/thinking: expected a thinking level or <=level`);
    }
  }
  if (raw.provider !== undefined) {
    if (typeof raw.provider === "string" && PROVIDERS.has(raw.provider)) {
      candidate.provider = raw.provider as UsageProvider;
    } else {
      problems.push(`${pointer}/provider: expected one of ${USAGE_PROVIDERS.join(", ")}`);
    }
  }
  if (raw.pool !== undefined) {
    if (typeof raw.pool === "string" && POOL.test(raw.pool.trim().toLowerCase())) {
      candidate.pool = raw.pool.trim().toLowerCase();
    } else {
      problems.push(`${pointer}/pool: expected a pool name (e.g. "gemini", "claude", "gpt")`);
    }
  }
  if (raw.when !== undefined) {
    const cond = parseCondition(raw.when, `${pointer}/when`, problems);
    if (cond) candidate.when = cond;
  }
  return candidate;
}

function parseRule(raw: unknown, pointer: string, problems: string[]): RoutingRule | undefined {
  if (!isRecord(raw)) {
    problems.push(`${pointer}: expected an object`);
    return undefined;
  }
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0 || raw.candidates.length > 32) {
    problems.push(`${pointer}/candidates: expected a non-empty array of 1..32 candidates`);
    return undefined;
  }
  const candidates: RoutingCandidate[] = [];
  raw.candidates.forEach((item, i) => {
    const parsed = parseCandidate(item, `${pointer}/candidates/${i}`, problems);
    if (parsed) candidates.push(parsed);
  });
  if (!candidates.length) return undefined;

  const rule: RoutingRule = { candidates };
  if (raw.name !== undefined) {
    if (typeof raw.name === "string" && raw.name.trim().length > 0 && raw.name.length <= 64) {
      rule.name = raw.name.trim();
    } else {
      problems.push(`${pointer}/name: expected a non-empty string (<= 64 chars)`);
    }
  }
  if (raw.strategy !== undefined) {
    if (typeof raw.strategy === "string" && STRATEGIES.has(raw.strategy)) {
      rule.strategy = raw.strategy as RoutingStrategy;
    } else {
      problems.push(`${pointer}/strategy: expected "first-match" or "highest-remaining"`);
    }
  }
  if (raw.unknownQuota !== undefined) {
    if (typeof raw.unknownQuota === "string" && UNKNOWN_POLICIES.has(raw.unknownQuota)) {
      rule.unknownQuota = raw.unknownQuota as UnknownQuotaPolicy;
    } else {
      problems.push(`${pointer}/unknownQuota: expected "skip" or "allow"`);
    }
  }
  if (raw.when !== undefined) {
    const cond = parseCondition(raw.when, `${pointer}/when`, problems);
    if (cond) rule.when = cond;
  }
  return rule;
}

/** Parse and validate routing.json fail-softly: bad entries record problems without throwing. */
export function parseRouting(raw: string, path = "routing.json"): LoadedRouting {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return empty(path, [`${path}: invalid JSON (${errorText(error)})`]);
  }
  if (!isRecord(data)) {
    return empty(path, [`${path}: expected a JSON object`]);
  }
  const problems: string[] = [];
  if (data.version !== 1) {
    return empty(path, [`${path}: /version must be 1`]);
  }
  const defaults: RoutingDefaults = { ...DEFAULT_ROUTING_DEFAULTS };
  if (data.defaults !== undefined) {
    if (!isRecord(data.defaults)) {
      problems.push(`${path}: /defaults must be an object`);
    } else {
      if (data.defaults.strategy !== undefined) {
        if (typeof data.defaults.strategy === "string" && STRATEGIES.has(data.defaults.strategy)) {
          defaults.strategy = data.defaults.strategy as RoutingStrategy;
        } else {
          problems.push(`${path}: /defaults/strategy must be "first-match" or "highest-remaining"`);
        }
      }
      if (data.defaults.window !== undefined) {
        if (typeof data.defaults.window === "string" && WINDOWS.has(data.defaults.window)) {
          defaults.window = data.defaults.window as QuotaWindow;
        } else {
          problems.push(`${path}: /defaults/window must be "5h" or "7d"`);
        }
      }
      if (data.defaults.unknownQuota !== undefined) {
        if (typeof data.defaults.unknownQuota === "string" && UNKNOWN_POLICIES.has(data.defaults.unknownQuota)) {
          defaults.unknownQuota = data.defaults.unknownQuota as UnknownQuotaPolicy;
        } else {
          problems.push(`${path}: /defaults/unknownQuota must be "skip" or "allow"`);
        }
      }
      if (data.defaults.refreshTimeoutMs !== undefined) {
        const n = data.defaults.refreshTimeoutMs;
        if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 10_000) {
          defaults.refreshTimeoutMs = n;
        } else {
          problems.push(`${path}: /defaults/refreshTimeoutMs must be an integer 0..10000`);
        }
      }
    }
  }

  const roles: Record<string, RoleRouting> = {};
  if (data.roles !== undefined) {
    if (!isRecord(data.roles)) {
      problems.push(`${path}: /roles must be an object`);
    } else {
      for (const [role, entry] of Object.entries(data.roles)) {
        if (!ROLE.test(role)) {
          problems.push(`${path}: /roles/${role} must be *, a kind, or dotted kind.child names`);
          continue;
        }
        if (!isRecord(entry)) {
          problems.push(`${path}: /roles/${role} must be an object`);
          continue;
        }
        const parsedRole: RoleRouting = {};
        if (entry.thinking !== undefined) {
          if (typeof entry.thinking === "string" && THINKING.test(entry.thinking.trim())) {
            parsedRole.thinking = entry.thinking.trim();
          } else {
            problems.push(`${path}: /roles/${role}/thinking must be a thinking level or <=level`);
          }
        }
        for (const key of ["maxTurns", "maxMinutes"] as const) {
          if (entry[key] !== undefined) {
            const [min, max] = BUDGET_RANGES[key];
            const n = entry[key];
            if (typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max) {
              parsedRole[key] = n;
            } else {
              problems.push(`${path}: /roles/${role}/${key} must be an integer ${min}..${max}`);
            }
          }
        }
        if (entry.rules !== undefined) {
          if (!Array.isArray(entry.rules)) {
            problems.push(`${path}: /roles/${role}/rules must be an array`);
          } else {
            const rules: RoutingRule[] = [];
            entry.rules.forEach((rawRule, i) => {
              const parsed = parseRule(rawRule, `${path}: /roles/${role}/rules/${i}`, problems);
              if (parsed) rules.push(parsed);
            });
            if (rules.length) parsedRole.rules = rules;
          }
        }
        if (parsedRole.rules?.length || parsedRole.thinking !== undefined || parsedRole.maxTurns !== undefined || parsedRole.maxMinutes !== undefined) {
          roles[role] = parsedRole;
        }
      }
    }
  }

  return {
    path,
    config: { version: 1, defaults, roles },
    problems,
  };
}

/**
 * Hot-reloading loader for `<agentDir>/worq/routing.json`.
 * Same containment rules as other operator resources: outside any Git checkout, no symlink escape, bounded size.
 */
export function routingLoader(agentDir: string): () => LoadedRouting {
  const path = routingPath(agentDir);
  let cached: LoadedRouting = empty(path);
  const load = (): LoadedRouting => {
    if (!exists(path)) return empty(path);
    const stat = lstatSync(path);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cached.stamp === stamp) return cached;
    try {
      const base = realpathSync(dirname(path));
      outsideCheckout(base);
      return { ...parseRouting(readBounded(contained(base, path), true), path), stamp };
    } catch (error) {
      return empty(path, [`${path}: ignored (${errorText(error)})`], stamp);
    }
  };
  return () => {
    try { cached = load(); }
    catch (error) { cached = empty(path, [`${path}: ignored (${errorText(error)})`]); }
    return cached;
  };
}

/** Find the most-specific configured role in `routing.json` that defines `rules`. */
export function matchRoleRouting(
  loaded: LoadedRouting | undefined,
  chain: readonly string[],
): { role: string; routing: RoleRouting & { rules: readonly RoutingRule[] }; defaults: RoutingDefaults } | undefined {
  const config = loaded?.config;
  if (!config) return undefined;
  for (const role of chain) {
    const routing = config.roles[role];
    if (routing?.rules?.length) return { role, routing: routing as RoleRouting & { rules: readonly RoutingRule[] }, defaults: config.defaults };
  }
  return undefined;
}

/** Merge per-role soft thinking caps and turn/minute budgets broad -> specific. */
export function matchRoleBudgets(loaded: LoadedRouting | undefined, chain: readonly string[]): RoleBudgets | undefined {
  const config = loaded?.config;
  if (!config) return undefined;
  const merged: RoleBudgets = {};
  for (const role of chain) {
    const entry = config.roles[role];
    if (!entry) continue;
    if (entry.thinking !== undefined) merged.thinking = entry.thinking;
    if (entry.maxTurns !== undefined) merged.maxTurns = entry.maxTurns;
    if (entry.maxMinutes !== undefined) merged.maxMinutes = entry.maxMinutes;
  }
  return Object.keys(merged).length ? merged : undefined;
}

function conditionUsesQuota(cond: RoutingCondition | undefined): boolean {
  if (!cond) return false;
  if (
    cond.provider !== undefined ||
    cond.pool !== undefined ||
    cond.window !== undefined ||
    cond.minRemainingPercent !== undefined ||
    cond.maxRemainingPercent !== undefined ||
    cond.minUsedPercent !== undefined ||
    cond.maxUsedPercent !== undefined ||
    cond.notExhausted !== undefined
  ) return true;
  if (cond.all?.some(conditionUsesQuota)) return true;
  if (cond.any?.some(conditionUsesQuota)) return true;
  return false;
}

/** Returns true if evaluating this role benefits from a live UsageSnapshot. */
export function needsUsageSnapshot(role: RoleRouting, defaults: RoutingDefaults): boolean {
  for (const rule of role.rules ?? []) {
    const strategy = rule.strategy ?? defaults.strategy;
    if (strategy === "highest-remaining" && rule.candidates.length > 1) return true;
    if (conditionUsesQuota(rule.when)) return true;
    if (rule.candidates.some((c) => conditionUsesQuota(c.when))) return true;
  }
  return false;
}

function getProviderWindow(
  snapshot: UsageSnapshot | undefined,
  provider: UsageProvider | undefined,
  window: QuotaWindow,
  pool?: string,
): { snap: ProviderSnapshot; remainingPercent: number; usedPercent: number; limitReached: boolean } | undefined {
  if (!snapshot || !provider) return undefined;
  const snap = snapshot.providers.find((p) => p.provider === provider);
  if (!snap || !snap.available) return undefined;
  const limitReached = Boolean(snap.extraNotes?.includes("limit_reached=true"));
  const source = pool && snap.pools ? snap.pools[pool] : snap;
  if (!source) return undefined;
  const win = window === "7d" ? source.weekly : source.fiveHour;
  if (!win) {
    if (limitReached) return { snap, remainingPercent: 0, usedPercent: 100, limitReached: true };
    return undefined;
  }
  return {
    snap,
    remainingPercent: limitReached ? 0 : win.remainingPercent,
    usedPercent: limitReached ? 100 : win.usedPercent,
    limitReached,
  };
}

function evalCondition(
  cond: RoutingCondition,
  candidateProvider: UsageProvider | undefined,
  candidatePool: string | undefined,
  defaultWindow: QuotaWindow,
  unknownQuota: UnknownQuotaPolicy,
  snapshot: UsageSnapshot | undefined,
  context: RoutingContext,
): boolean {
  if (cond.access !== undefined && context.access !== cond.access) return false;
  if (cond.inGroup !== undefined && Boolean(context.inGroup) !== cond.inGroup) return false;
  if (cond.hasAttachments !== undefined && Boolean(context.hasAttachments) !== cond.hasAttachments) return false;
  if (cond.taskIncludes !== undefined) {
    const hay = (context.task ?? "").toLowerCase();
    if (!cond.taskIncludes.some((needle) => hay.includes(needle.toLowerCase()))) return false;
  }

  const hasQuotaCheck =
    cond.minRemainingPercent !== undefined ||
    cond.maxRemainingPercent !== undefined ||
    cond.minUsedPercent !== undefined ||
    cond.maxUsedPercent !== undefined ||
    cond.notExhausted !== undefined;

  if (hasQuotaCheck) {
    const targetProvider = cond.provider ?? candidateProvider;
    // Use candidate's inferred pool only when evaluating the candidate's own provider; explicit cross-provider conditions use cond.pool.
    const targetPool = cond.pool ?? (cond.provider === undefined ? candidatePool : undefined);
    const window = cond.window ?? defaultWindow;
    const data = getProviderWindow(snapshot, targetProvider, window, targetPool);
    if (!data) {
      if (unknownQuota === "skip") return false;
    } else {
      if (cond.notExhausted === true && (data.limitReached || data.remainingPercent <= 0)) return false;
      if (cond.minRemainingPercent !== undefined && data.remainingPercent < cond.minRemainingPercent) return false;
      if (cond.maxRemainingPercent !== undefined && data.remainingPercent > cond.maxRemainingPercent) return false;
      if (cond.minUsedPercent !== undefined && data.usedPercent < cond.minUsedPercent) return false;
      if (cond.maxUsedPercent !== undefined && data.usedPercent > cond.maxUsedPercent) return false;
    }
  }

  if (cond.all && !cond.all.every((sub) => evalCondition(sub, candidateProvider, candidatePool, defaultWindow, unknownQuota, snapshot, context))) {
    return false;
  }
  if (cond.any && !cond.any.some((sub) => evalCondition(sub, candidateProvider, candidatePool, defaultWindow, unknownQuota, snapshot, context))) {
    return false;
  }
  return true;
}

/**
 * Evaluate a role's ordered routing rules against the current UsageSnapshot and launch context.
 * Returns candidates in strict priority order across rules (rule 0's ranked candidates, then rule 1's, etc.)
 * so local preflight failures can seamlessly fall through to the next candidate or fallback rule.
 */
export function evaluateRouting(
  role: RoleRouting,
  defaults: RoutingDefaults,
  snapshot: UsageSnapshot | undefined,
  context: RoutingContext = {},
): RoutedCandidate[] {
  const ordered: RoutedCandidate[] = [];

  (role.rules ?? []).forEach((rule, ruleIndex) => {
    const strategy = rule.strategy ?? defaults.strategy;
    const unknownQuota = rule.unknownQuota ?? defaults.unknownQuota;
    const rankWindow = rule.when?.window ?? defaults.window;

    const eligible: { item: RoutedCandidate; order: number; score: number }[] = [];
    rule.candidates.forEach((candidate, order) => {
      const provider = candidate.provider ?? providerForRuntime(candidate.sdk, candidate.model);
      const pool = candidate.pool ?? poolForRuntime(candidate.sdk, candidate.model);
      if (rule.when && !evalCondition(rule.when, provider, pool, defaults.window, unknownQuota, snapshot, context)) return;
      if (candidate.when && !evalCondition(candidate.when, provider, pool, defaults.window, unknownQuota, snapshot, context)) return;

      const win = getProviderWindow(snapshot, provider, candidate.when?.window ?? rankWindow, pool);
      const remainingPercent = win?.remainingPercent;
      eligible.push({
        order,
        score: remainingPercent ?? -1,
        item: {
          sdk: candidate.sdk,
          model: candidate.model,
          ...(candidate.thinking ? { thinking: candidate.thinking } : {}),
          ...(rule.name ? { ruleName: rule.name } : {}),
          ruleIndex,
          ...(provider ? { provider } : {}),
          ...(pool ? { pool } : {}),
          ...(remainingPercent !== undefined ? { remainingPercent } : {}),
        },
      });
    });

    if (strategy === "highest-remaining") {
      eligible.sort((a, b) => b.score - a.score || a.order - b.order);
    }

    for (const entry of eligible) ordered.push(entry.item);
  });

  return ordered;
}
