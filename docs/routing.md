# Automated Runtime Routing (`routing.json`)

Worq can automatically select a worker's `sdk`, `model`, and `thinking` level at launch using live 5-hour / 7-day subscription quota snapshots and extensible rule conditions in `<agentDir>/worq/routing.json` (normally `~/.pi/agent/worq/routing.json`).

Starter example: [docs/examples/routing.json](examples/routing.json). On first load, Worq also provisions an inert `routing.json` (`{ "version": 1, "roles": {} }`) and an agent-facing reference at `<agentDir>/worq/ROUTING.md` so any agent can inspect and adjust your rules without needing this repository checked out.

## How it works

- **Applies everywhere:** `worq_spawn`, `/worq` Step 3 preselection (`· routing.json`), `worq spawn` CLI, and optionally child roles (`pq`, `review`, `edit`).
- **Hot-reloaded:** re-read automatically when `mtime` or file size changes; edits apply on the next spawn without restarting Pi. Running agents keep their runtime.
- **Precedence:** explicit launch fields > `routing.json` > Main / adapter defaults.
  - Role entries can also specify `thinking` (`level` or `<=level`), `maxTurns` (`1..400`), and `maxMinutes` (`1..600`), merged broad → specific and clamped by `pi-worq.json` `limits` (superseding the removed `RUNTIMES.md`).
- **Fail-soft:**
  - Invalid JSON or bad fields warn once per file version and never block launches.
  - Unsupported thinking levels (for example, built-in `claude-code`, which has no verified thinking-level control) snap down or drop softly instead of failing the launch.
  - If a winning candidate's adapter or model fails local preflight, Worq warns once and tries the next ranked candidate or falls through to the next rule.
- **Usage freshness:** cached snapshots (5-minute TTL) are used immediately while stale refreshes run in the background. On a cold start (no snapshot yet), quota-dependent rules wait up to `defaults.refreshTimeoutMs` (default `2000` ms) before falling back.

## Role lookup

Only the **most specific** matching key in `roles` is evaluated:

- Top-level agents: `<kind>` → `*`
- Child roles (never fall back to `*`, preserving parent inheritance and `fork: true` prompt-cache hits):
  - PQ: `<kind>.pq.<name>` → `<kind>.pq` → `pq`
  - Review: `<kind>.review` → `review`
  - Edit worker: `<kind>.edit.<name>` → `<kind>.edit` → `edit`

## Rule evaluation & strategies

Each role has an ordered `rules` array. Rules are evaluated in order from index `0` onward:

1. For each candidate in `rule.candidates`, Worq checks `rule.when` and `candidate.when`.
2. When a condition includes a quota check (`minRemainingPercent`, `maxRemainingPercent`, `minUsedPercent`, `maxUsedPercent`, or `notExhausted`), Worq looks up the candidate's inferred provider and pool (via `providerForRuntime` / `poolForRuntime`, or explicit `provider` / `pool`) in the current usage snapshot:
   - `antigravity` tracks separate quota pools per model family (`"gemini"`, `"claude"`, `"gpt"`), inferred automatically from the candidate model name or targeted explicitly via `when.pool`.
   - If the provider's quota is unavailable/errored, `unknownQuota: "skip"` (default) excludes the candidate; `unknownQuota: "allow"` keeps it.
   - Unconditional rules (no `when`, such as a fallback rule) are never skipped by `unknownQuota: "skip"`.
3. Eligible candidates in the rule are ordered by `strategy`:
   - `"highest-remaining"`: descending by the selected window's `remainingPercent` (ties keep listed order; unknown quota sorts last).
   - `"first-match"`: listed order.
4. Candidates from earlier rules are tried before later rules. The first candidate that passes local adapter preflight wins, recording `via: routing.json (<role>: <ruleName>)`.

## Conditions reference

Every field in `when` is optional; multiple fields in the same object are ANDed.

- **Quota qualifiers:**
  - `provider`: `"commandcode" | "codex" | "claude" | "antigravity"` (checks a specific provider's quota rather than the candidate's own provider — useful for cross-provider fallback conditions).
  - `pool`: optional provider-specific pool name (e.g. Antigravity `"gemini"`, `"claude"`, `"gpt"`). Inferred automatically for Antigravity candidates; set explicitly on cross-provider `when` conditions when needed.
  - `window`: `"5h" | "7d"` (defaults to `defaults.window`, which defaults to `"5h"`).
  - `minRemainingPercent` / `maxRemainingPercent`: `0..100` inclusive (`remainingPercent >= N` / `<= N`).
  - `minUsedPercent` / `maxUsedPercent`: `0..100` inclusive (`usedPercent >= N` / `<= N`).
  - `notExhausted`: `boolean` — when `true`, requires `remainingPercent > 0` and not `limit_reached`.
- **Context qualifiers:**
  - `access`: `"read" | "write"` (e.g. route read vs write workflows differently inside a `*` rule).
  - `inGroup`: `boolean` (whether the launch is part of a `group` / swarm).
  - `hasAttachments`: `boolean` (whether `attach` was passed).
  - `taskIncludes`: `string[]` (1..32 non-empty strings; matches case-insensitively if any substring appears in `task`).
- **Logical combinators:**
  - `all`: `Condition[]` (all must match)
  - `any`: `Condition[]` (at least one must match)

## Adding custom ordered conditions

Because rules resolve in order and support both context and cross-provider quota checks, you can layer conditions freely. For example, routing heavy security audits to a high-reasoning model when Claude has ≥ 30% 5h quota remaining, falling back to a general pool, and finally to Command Code:

```json
{
  "name": "security-audit",
  "strategy": "first-match",
  "when": {
    "all": [
      { "taskIncludes": ["security", "auth", "audit"] },
      { "window": "5h", "minRemainingPercent": 30 }
    ]
  },
  "candidates": [
    { "sdk": "claude-code", "model": "claude-opus-5-5" }
  ]
}
```

## Verifying routing

- Open `/worq`: Step 3 displays the preselected runtime with `· routing.json` when a rule matched.
- Run `worq list <ref>`: shows the resolved runtime and `via: routing.json (<role>: <rule>)`.
- Check the agent log: records `via routing.json (<role>: <rule>)` at session open.
