# Configuration

One optional JSON file: `<agentDir>/pi-worq.json` (`~/.pi/agent/pi-worq.json`), plus one optional shared resource directory: `<agentDir>/worq/`. With neither, every role runs on Main's model at thinking level `low`.

Both are read once per Pi session, when the first Worq tool call creates the Worq instance. Edit, then start a new Pi session; running agents keep what they launched with.

Invalid JSON fails as `invalid-json`; a schema violation fails as `invalid-payload` naming the JSON pointer (e.g. `/limits/agents`). Unknown sdks, unknown runtime names and malformed model refs fail at load as `config`. A capability mismatch fails as `capability` at spawn / before each PQ or reviewer.

```json
{
  "default": "standard",
  "launch": { "countdownSeconds": 5, "interactive": true },
  "runtimes": {
    "standard": { "sdk": "pi", "model": "provider/model", "fallbackModel": "provider/model", "thinking": "medium" },
    "deep": { "model": "provider/model", "thinking": "high" },
    "fast": { "model": "provider/model", "thinking": "low" }
  },
  "roles": { "agent.plan": "deep", "agent.execute": "standard", "agent.foundation": "deep", "subagent": "fast", "subagent.evidence": "standard", "reviewer": "deep" },
  "approveExtensions": false,
  "limits": { "agents": 4, "runTurns": 1000, "continuationTurns": 0 }
}
```

Top-level keys: `default`, `launch`, `runtimes`, `roles`, `approveExtensions`, `limits`. Nothing else is accepted. The pre-0.0.28 keys (`harness`, `harnesses`, `model`, `fallbackModel`, `models`) fail with a migration message.

## Runtimes

A runtime is a named preset: `sdk` (default `pi`), `model`, `fallbackModel`, `thinking`. Every field optional. Presets are independent — no field inherits from another preset or layer, so switching a role's SDK is changing one name.

- `model` absent → Main's model. Ref shape is per SDK: `<provider>/<model>` for Pi, checked at load.
- `thinking` absent → `low` when the SDK supports it. A level the model rejects fails as `capability`.
- `fallbackModel` → used once, when a model request fails (preflight or mid-run). Ignored when equal to `model`. Worq decides when and to what; the adapter only switches.

## Roles

`roles` maps a role key to a runtime name:

| Key | Selects |
|---|---|
| `agent` / `agent.<kind>` | Every agent / one kind or workflow |
| `subagent` / `subagent.<name>` | Unnamed PQs / a PQ delegated with `name: "<name>"` |
| `reviewer` / `reviewer.<name>` | Every reviewer / one, e.g. `reviewer.intent` |

Resolution: **exact role → role family → `default` → built-in `main`** (`sdk: pi`, Main's model). Named children must be declared: delegating to `subagent.evidence` without `roles["subagent.evidence"]` fails as `Unknown named child`.

## Launch picker

In the TUI, each new SDK session starts a five-second countdown with its role’s preset selected. Use `roles["agent.<workflow-name>"]` to give an installed workflow its own default. Parallel sessions share one popup: Tab selects a pending agent, ↑/↓ selects harness, model or thinking, and ←/→ changes it. Editing pauses that agent’s countdown. Enter launches immediately, A launches all, and Esc cancels the selected launch. Overrides apply only to this session; changing model or harness drops its configured fallback. Existing conversations continue without another countdown.

Set `"launch": { "interactive": true, "countdownSeconds": 5 }` in `pi-worq.json` to customize this. `interactive: false`, zero seconds, or a non-TUI host launches defaults immediately. Only Pi ships today.

## Shared resources

Installed once, identical for every role and every SDK. Never part of model selection.

```
<agentDir>/worq/
├── instructions/*.md          appended to every system prompt
├── skills/<name>/SKILL.md     indexed in the prompt; body read on demand via the `skill` tool
├── skills/<name>.md
└── extensions/*.{mjs,js,ts}   native SDK extensions (Pi only today)
```

- Skill frontmatter `name` / `description` are used when present; else the directory/file name and first line. Only the index enters the prompt, so large collections cost little context.
- Instructions and skills are `context, not authority`: they never widen tools, budgets or permissions.
- Extensions run operator code in-process — **not a sandbox**. Installed extensions require `"approveExtensions": true`; every role's SDK must be able to load them, else `capability`. Do not install scripts that import or read candidate code.
- Safety: the directory must not sit inside a Git checkout (`Repository resource`); entries are resolved with `realpath` and must stay inside it (`Untrusted resource`); regular files ≤ 256 KiB.
- Ambient discovery stays off: no global Pi settings, AGENTS.md, packages or skills from Main or the candidate checkout are loaded.

## Subagents and reviewers

Subagents are read-only sessions answering one probing question. The delegating agent chooses the role with an optional name:

```json
{ "question": "…", "why": "…", "name": "evidence" }
```

`name` maps to `subagent.<name>`; omitting it selects `subagent`. Each named child gets its own runtime, plus its own `subagentTurns` / `subagentMinutes` budget from the shared allowance below. Depth is one: a subagent cannot delegate.

Callers do not select reviewers by name. The kind's review policy runs on submit, and each reviewer resolves `reviewer.<name>` (`intent`, `decision`, …). Plan agents are always reviewed; execute agents are reviewed unless spawned with `verify: false`; workflows are never reviewed. `worq list <ref>` prints each role actually used with its resolved JSON and source paths.

## Workflows

Skill packages at `<agentDir>/workflows/<name>/SKILL.md`, read once at extension load (not part of `pi-worq.json`). `disable-model-invocation: true` keeps one user-only (`/worq workflow`); otherwise it is also a `worq_spawn` kind. Roles: `agent.<name>` for one workflow, `agent` for all agents. `limits.agents` counts live workflows; turns spend from the same budgets. No reviewers. See `docs/workflows.md`.

## Limits

Every value is optional; absent keys use these defaults.

| Key | Default | Applies to |
|---|---|---|
| `agents` | 4 | Live agents; spawn fails as `at-capacity` |
| `subagents` | 6 | PQs per run (`pq-limit`) |
| `parallel` | 4 | Concurrent subagents and reviewers |
| `rounds` | 3 | Main-authorized rounds per agent; `worq_send` fails as `round-limit` at the cap |
| `asks` | 3 | `ask_main` calls per session |
| `agentTurns` | 80 | Turns in one agent session |
| `subagentTurns` | 16 | Turns in one subagent session |
| `reviewerTurns` | 40 | Turns in one reviewer session |
| `agentMinutes` | 30 | Wall clock for one agent session, paused while Main answers |
| `subagentMinutes` | 5 | Wall clock for one subagent session |
| `reviewerMinutes` | 10 | Wall clock for one reviewer session |
| `askMinutes` | 15 | How long `ask_main` waits before returning "unanswered" |
| `runTurns` | 1000 | Cumulative turns for one agent: worker, retries, PQs and reviews, all rounds |
| `continuationTurns` | 0 | Extra cumulative turns Main may grant |
| `checkpointSeconds` | 15 | How long a depleted run waits between requests for a grant |
| `services` | 2 | Services an execute reviewer may start (`service-limit`) |

Two separate budgets are at work. Per-session limits (`agentTurns`, `agentMinutes`, `rounds`, `asks`) are hard — no grant raises them. `runTurns` is a pool shared by everything one agent does, so a reviewer or a repair round spends from the same account.

Near the pool's end Worq reports the remaining allowance. If a grant is still available, the `checkpoint` wakes Main, which may answer `worq send <ref> "/continue N"` to grow the pool by `N`. Between requests a depleted run with headroom waits up to `checkpointSeconds` for approval; a streaming turn cannot be paused, so approve before the stop. Without grant headroom, exhaustion fails the agent with `run-limit`. Low-budget notices without headroom and per-session turn/time warnings are visible but do not wake Main or enter its model context.

## Routes

`mode` is chosen per spawn, not in the config file: `fast` for a small, reversible, plainly verifiable change; `thorough` for a broad change or a user-owned decision. It is a hint passed to the worker. For `plan`, `fast` runs only `subtraction` if configured; otherwise it uses the full roster, like default and `thorough`. It does not change execute review, model, thinking level, tools or budgets. The optional `reason` records why. Workflows refuse `mode` and `verify`. `worq spawn execute --mode fast "task"` in the CLI, `{ mode, reason }` through the tool.

## Verifying a configuration

- `worq list <ref>` shows route, review policy, `spent/allowance` turns, and each role's resolved runtime (`name`, `sdk`, `path`, `via`).
- The agent log has `Role <role>: runtime <name> (<sdk>, <model>), thinking <level>, turn unit <unit>; via <path>` at session open, then the SDK's native resolution (`Pi model <provider>/<id>`).
- Skipped verification reads `review: explicitly skipped`.

## Failures and fixes

| Failure | Cause | Fix |
|---|---|---|
| `… old Worq format` | Pre-0.0.28 keys | Move to `runtimes` + `roles`; resources to `<agentDir>/worq/` |
| `/runtimes/x/model … not a valid pi model ref` | Ref shape | Use `<provider>/<model>` |
| `unknown sdk` | `sdk` names no registered adapter | Use `pi` |
| `unknown runtime` | `default`/`roles` names an undeclared preset | Declare it in `runtimes` |
| `Pi does not know model …` | Model not installed in Pi | Install it or pick another |
| `… is not a pi thinking level` | Level unsupported by that model | Use one the error lists |
| `Extension approval required` | Files in `worq/extensions/` | Set `approveExtensions: true` or remove them |
| `cannot load the … native extension(s)` | A role's SDK has no native extension support | Remove the extensions or keep that role on `pi` |
| `Untrusted resource` / `Repository resource` | Escaping link, or `worq/` inside a checkout | Move the file / directory |
| `Unknown named child` | `name` delegated without a `roles` entry | Declare `roles["subagent.<name>"]` |
| `at-capacity` | `limits.agents` reached | Close an agent or raise the cap |
| `workflow-file` | The workflows directory cannot be read | Fix permissions; a missing directory is empty. Per-folder defects are warnings, not errors |
| `invocation` | User-only workflow sent to `worq_spawn`, or a built-in kind to `/worq workflow` | `/worq workflow`; `worq_spawn` for built-ins |
| `round-limit` | `limits.rounds` reached | Adjudicate and close, or spawn fresh with the plan in `attach` |
| `run-limit` | Cumulative turns spent | Raise `runTurns`, or configure `continuationTurns` |

## Recipes

Cheap workers, strong reviewers:

```json
{
  "default": "cheap",
  "runtimes": { "cheap": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" }, "strong": { "model": "anthropic/claude-opus-4-1", "thinking": "high" } },
  "roles": { "reviewer": "strong" }
}
```

A named evidence child: `roles["subagent.evidence"]` → a preset, and put its rules in `<agentDir>/worq/skills/evidence/SKILL.md` (every role sees the index; any role can read it).

Long autonomous runs with an approval step:

```json
{ "limits": { "runTurns": 2000, "continuationTurns": 500, "checkpointSeconds": 30 } }
```
