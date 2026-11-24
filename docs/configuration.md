# Configuration

One optional JSON file: `<agentDir>/pi-worq.json` (`~/.pi/agent/pi-worq.json`), plus one optional shared resource directory: `<agentDir>/worq/`. By default, every new Worq session uses Main's current Pi model and thinking level.

Both are read once per Pi session, when the first Worq tool call creates the Worq instance. Edit, then start a new Pi session; running agents keep what they launched with.

Invalid JSON fails as `invalid-json`; a schema violation fails as `invalid-payload` naming the JSON pointer (e.g. `/limits/agents`). Unknown SDKs and malformed model refs fail at load as `config`. A capability mismatch fails as `capability` at spawn / before each PQ or reviewer.

```json
{
  "plan": { "sdk": "pi", "model": "provider/model", "thinking": "high" },
  "execute": { "thinking": "medium" },
  "review": { "model": "provider/review-model" },
  "launch": { "countdownSeconds": 5, "interactive": true },
  "approveExtensions": false,
  "limits": { "agents": 4, "idleMinutes": 60 }
}
```

Top-level keys: `plan`, `execute`, `review`, `launch`, `approveExtensions`, `limits`.

## Runtime overrides

`plan` and `execute` apply to the corresponding workers. `review` applies to every independent review. PQ subagents and workflows always start with Main's live Pi selection. Overrides are independent, and all three keys and their fields are optional.

- `sdk`: execution backend (default `pi`; the only backend shipped today).
- `model`: defaults to Main's current model for Pi. Pi refs use `<provider>/<model>`. Other SDKs use their own model refs and defaults.
- `thinking`: defaults to Main's current thinking level when the selected Pi model supports it; otherwise the SDK decides. An explicitly configured unsupported level fails as `capability`.

To migrate, remove `default`, `runtimes` and `roles`. Copy any worker and review settings you still want directly into `plan`, `execute` and `review`, keeping only `sdk`, `model` and `thinking`. Remove the old runtime keys even if you don't want any overrides.

## Launch picker

In the TUI, each new SDK session starts a five-second countdown with Main's current selection or the configured role override preselected. Parallel sessions share one popup: Tab selects a pending agent, ↑/↓ selects harness, model or thinking, and ←/→ changes it. Editing pauses that agent’s countdown. Enter launches immediately, A launches all, and Esc cancels the selected launch. Picker changes apply only to that session. Existing conversations continue without another countdown.

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

## Subagents and review

Subagents are read-only sessions answering one probing question. The delegating agent can give a subagent an optional name:

```json
{ "question": "…", "why": "…", "name": "evidence" }
```

The name labels the child without changing its runtime default. Each child has its own `subagentTurns` / `subagentMinutes` budget. Depth is one: a subagent cannot delegate.

Each submission of a `review: true` kind gets one review subagent (`prompts/review.md`, `review` override when set). Built-in plan and execute are reviewed unless spawned with `verify: false`; workflows only when they set `review: true`. `worq list <ref>` prints each role actually used with its resolved JSON and source paths.

## Workflows

Skill packages at `<agentDir>/workflows/<name>/SKILL.md`, read once at extension load (not part of `pi-worq.json`). `disable-model-invocation: true` keeps one user-only (`/worq workflow`); otherwise it is also a `worq_spawn` kind. `limits.agents` counts active workflows; turns spend from the same budgets. Reviewed only with `review: true`. See `docs/workflows.md`.

## Limits

Every value is optional; absent keys use these defaults.

| Key | Default | Applies to |
|---|---|---|
| `agents` | 4 | Active (non-parked) agents; spawn or resume fails as `at-capacity` |
| `subagents` | 6 | PQs per agent (`pq-limit`) |
| `parallel` | 4 | Concurrent subagents (PQs and reviews) |
| `asks` | 3 | `ask_main` calls per session |
| `agentTurns` | 80 | Turns per agent invocation (spawn or resume) |
| `subagentTurns` | 16 | Turns in one subagent session |
| `reviewerTurns` | 40 | Turns in one review session |
| `agentMinutes` | 30 | Wall clock per agent invocation, paused while Main answers |
| `subagentMinutes` | 5 | Wall clock for one subagent session |
| `reviewerMinutes` | 10 | Wall clock for one review session |
| `askMinutes` | 15 | How long `ask_main` waits before returning "unanswered" |
| `idleMinutes` | 60 | How long a parked agent keeps its session and worktree before closing |
| `services` | 2 | Services a write-kind review may start (`service-limit`) |

Budgets are per invocation and hard. Exhausting one parks the agent unreviewed with its last response and a pinned partial commit; `worq send <ref> <text>` resumes it with a fresh budget. Per-session warnings are visible but do not wake Main.

## Verifying a configuration

- `worq list <ref>` shows review policy and each role's resolved runtime (`name`, `sdk`, `path`, `via`).
- The agent log has `Role <role>: runtime <name> (<sdk>, <model>), thinking <level>, turn unit <unit>; via <path>` at session open, then the SDK's native resolution (`Pi model <provider>/<id>`).
- Skipped review reads `Review: none`.

## Failures and fixes

| Failure | Cause | Fix |
|---|---|---|
| `… old Worq format` | Obsolete runtime keys | Move overrides to `plan`, `execute` or `review`; resources to `<agentDir>/worq/` |
| `/plan/model … not a valid pi model ref` | Ref shape | Use `<provider>/<model>` |
| `unknown sdk` | `sdk` names no registered adapter | Use `pi` |
| `Pi does not know model …` | Model not installed in Pi | Install it or pick another |
| `… is not a pi thinking level` | Level unsupported by that model | Use one the error lists |
| `Extension approval required` | Files in `worq/extensions/` | Set `approveExtensions: true` or remove them |
| `cannot load the … native extension(s)` | A role's SDK has no native extension support | Remove the extensions or keep that role on `pi` |
| `Untrusted resource` / `Repository resource` | Escaping link, or `worq/` inside a checkout | Move the file / directory |
| `at-capacity` | `limits.agents` reached | Close an agent or raise the cap |
| `workflow-file` | The workflows directory cannot be read | Fix permissions; a missing directory is empty. Per-folder defects are warnings, not errors |
| `invocation` | User-only workflow sent to `worq_spawn`, or a built-in kind to `/worq workflow` | `/worq workflow`; `worq_spawn` for built-ins |

## Recipes

Longer agent invocations, parked sessions kept for a working day:

```json
{ "limits": { "agentTurns": 200, "agentMinutes": 90, "idleMinutes": 480 } }
```
