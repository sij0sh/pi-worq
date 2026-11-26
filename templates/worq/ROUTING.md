# Worq Routing Guide (Agent & Operator Reference)

Edit `<agentDir>/worq/routing.json` (normally `~/.pi/agent/worq/routing.json`) to configure automatic runtime routing for Worq launches.

- **Hot-reloaded:** changes take effect on the next spawn or `/worq` open; no Pi restart required. Running agents keep the runtime they launched with.
- **Precedence:** explicit launch fields (`worq_spawn`, `/worq` manual pick, `worq spawn --sdk/--model/--thinking`) > `routing.json` > Main/adapter defaults.
- **Fail-soft:** invalid fields warn once per file version without blocking launches; unavailable adapters/models fall through to the next candidate or rule; unsupported thinking levels (such as on built-in `claude-code`) snap down or drop softly.
- **Per-role budgets & thinking caps:** each role entry may also set `thinking` (`level` or `<=level`), `maxTurns` (`1..400`), and `maxMinutes` (`1..600`), merged broad → specific (`*` → `<kind>` / `pq` / `review` / `edit` → `<kind>.<child>` → `<kind>.<child>.<name>`), clamped by `pi-worq.json` `limits`.

## Schema

```json
{
  "version": 1,
  "defaults": {
    "strategy": "highest-remaining",
    "window": "5h",
    "unknownQuota": "skip",
    "refreshTimeoutMs": 2000
  },
  "roles": {
    "<role>": {
      "thinking": "<=medium",
      "maxTurns": 50,
      "maxMinutes": 20,
      "rules": [
        {
          "name": "optional-label",
          "strategy": "highest-remaining",
          "unknownQuota": "skip",
          "when": { "...condition..." },
          "candidates": [
            { "sdk": "antigravity", "model": "gemini-4-neon", "thinking": "medium" }
          ]
        }
      ]
    }
  }
}
```

### Top-level & `defaults`

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `version` | `1` | required | Schema version |
| `defaults.strategy` | `"first-match"` \| `"highest-remaining"` | `"first-match"` | How eligible candidates within a rule are ranked |
| `defaults.window` | `"5h"` \| `"7d"` | `"5h"` | Rolling subscription quota window to check |
| `defaults.unknownQuota` | `"skip"` \| `"allow"` | `"skip"` | When a rule/candidate has a quota qualifier and the provider's snapshot is unavailable |
| `defaults.refreshTimeoutMs` | integer `0..10000` | `2000` | Cold-start wait when no usage snapshot exists yet |

### Roles & Matching Order

Only the **most specific** matching key in `roles` is evaluated:

- **Top-level workflows:** `<kind>` → `*` (e.g. `scout`, `plan`, `execute`, `*`).
- **Child sessions** (never fall back to `*`, preserving parent inheritance and `fork: true` cache hits):
  - PQ: `<kind>.pq.<name>` → `<kind>.pq` → `pq`
  - Review: `<kind>.review` → `review`
  - Edit worker: `<kind>.edit.<name>` → `<kind>.edit` → `edit`

### Rules & Candidates

Rules inside `roles.<role>.rules` are evaluated **in order**. Within each rule:

1. `when` (optional) filters candidates (or skips the whole rule for context/cross-provider conditions).
2. `candidates` (1..32 items) each specify:
   - `sdk`: adapter id (`"pi"`, `"claude-code"`, `"antigravity"`, or installed custom adapter)
   - `model`: model ref (`provider/model` for `pi`, e.g. `commandcode/deepseek/deepseek-v4.1-flash`; native id for `antigravity`/`claude-code`)
   - `thinking` (optional): exact level (`low`, `medium`, `high`, `xhigh`, `max`) or cap (`<=medium`). Softly snapped down or dropped if unsupported (e.g. `claude-code`).
   - `provider` (optional): override usage provider (`"commandcode"`, `"codex"`, `"claude"`, `"antigravity"`). Normally inferred automatically from `sdk`/`model`.
   - `pool` (optional): override provider-specific quota pool (e.g. Antigravity `"gemini"`, `"claude"`, `"gpt"`). Inferred automatically for Antigravity models (`gemini-*` → `"gemini"`, `claude-*` → `"claude"`, `gpt-*` → `"gpt"`).
   - `when` (optional): per-candidate condition.
3. Eligible candidates are ranked by `strategy`:
   - `"highest-remaining"`: highest `remainingPercent` first (ties keep listed order; unknown quota sorts last).
   - `"first-match"`: listed order.
4. Candidates are tried in order across rules; if an adapter/model fails local preflight, Worq warns once and tries the next candidate/rule.
5. An unconditional fallback rule (no `when`) is never skipped by `unknownQuota: "skip"`.

### Conditions (`when`)

All keys in a `when` object are ANDed together.

| Key | Type | Meaning |
| --- | --- | --- |
| `provider` | `"commandcode"` \| `"codex"` \| `"claude"` \| `"antigravity"` | Check a specific provider's quota instead of the candidate's own provider |
| `pool` | `"gemini"` \| `"claude"` \| `"gpt"` \| string | Check a specific provider quota pool (e.g. Antigravity `gemini` vs `claude` 5h limits) |
| `window` | `"5h"` \| `"7d"` | Quota window for this condition (default: `defaults.window`) |
| `minRemainingPercent` | `0..100` | Pass when `remainingPercent >= N` |
| `maxRemainingPercent` | `0..100` | Pass when `remainingPercent <= N` |
| `minUsedPercent` | `0..100` | Pass when `usedPercent >= N` |
| `maxUsedPercent` | `0..100` | Pass when `usedPercent <= N` |
| `notExhausted` | `boolean` | When `true`, requires `remainingPercent > 0` and not `limit_reached` |
| `access` | `"read"` \| `"write"` | Match workflow access mode (useful in `*` rules) |
| `inGroup` | `boolean` | Match whether the launch belongs to a swarm/batch `group` |
| `hasAttachments` | `boolean` | Match whether the launch has `attach` entries |
| `taskIncludes` | `string[]` | Case-insensitive substring match against `task` (matches if any string is found) |
| `all` | `Condition[]` | All sub-conditions must match |
| `any` | `Condition[]` | At least one sub-condition must match |

## Example (5h Quota Pools + Threshold Fallbacks)

```json
{
  "version": 1,
  "defaults": {
    "strategy": "highest-remaining",
    "window": "5h",
    "unknownQuota": "skip",
    "refreshTimeoutMs": 2000
  },
  "roles": {
    "scout": {
      "rules": [
        {
          "name": "primary-50pct",
          "when": { "window": "5h", "minRemainingPercent": 50 },
          "candidates": [
            { "sdk": "antigravity", "model": "gemini-4-hydrogen", "thinking": "low" },
            { "sdk": "claude-code", "model": "sonnet", "thinking": "low" }
          ]
        },
        {
          "name": "fallback",
          "strategy": "first-match",
          "candidates": [
            { "sdk": "pi", "model": "commandcode/deepseek/deepseek-v4.1-flash", "thinking": "high" }
          ]
        }
      ]
    },
    "plan": {
      "rules": [
        {
          "name": "primary-available",
          "when": { "window": "5h", "notExhausted": true },
          "candidates": [
            { "sdk": "antigravity", "model": "gemini-4-neon", "thinking": "medium" },
            { "sdk": "claude-code", "model": "claude-opus-5-5", "thinking": "medium" },
            { "sdk": "antigravity", "model": "claude-opus-5-5", "thinking": "medium" }
          ]
        },
        {
          "name": "fallback",
          "strategy": "first-match",
          "candidates": [
            { "sdk": "pi", "model": "commandcode/meta/muse-spark-1.3-contributor", "thinking": "max" }
          ]
        }
      ]
    },
    "execute": {
      "rules": [
        {
          "name": "primary-20pct",
          "when": { "window": "5h", "minRemainingPercent": 20 },
          "candidates": [
            { "sdk": "antigravity", "model": "gemini-4-hydrogen", "thinking": "medium" },
            { "sdk": "claude-code", "model": "claude-sonnet-5-5", "thinking": "medium" },
            { "sdk": "antigravity", "model": "claude-sonnet-5-5", "thinking": "medium" }
          ]
        },
        {
          "name": "fallback",
          "strategy": "first-match",
          "candidates": [
            { "sdk": "pi", "model": "commandcode/deepseek/deepseek-v4.1-flash", "thinking": "max" }
          ]
        }
      ]
    }
  }
}
```

## Editing Checklist for Agents

1. Read `<agentDir>/worq/routing.json` first and preserve unrelated roles/rules.
2. Keep valid JSON (`version: 1`, no comments, no trailing commas).
3. Use `provider/model` for `sdk: "pi"`, and native model IDs for `antigravity` / `claude-code`.
4. Put more specific or higher-threshold rules **earlier** in `rules`, and keep an unconditional fallback rule **last**.
5. Verify with `/worq` (Step 3 shows `· routing.json`) or `worq list <ref>` (shows `via: routing.json (<role>: <rule>)`).
