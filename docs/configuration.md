# Configuration

One optional JSON file: `<agentDir>/pi-worq.json` (`~/.pi/agent/pi-worq.json`), plus one optional shared resource directory: `<agentDir>/worq/`. By default, every new Worq session uses Main's current Pi model and thinking level.

Both are read once per Pi session, when the first Worq tool call creates the Worq instance. Edit, then start a new Pi session; running agents keep what they launched with.

Invalid JSON fails as `invalid-json`; a schema violation fails as `invalid-payload` naming the JSON pointer (e.g. `/limits/agents`). Runtime problems (unknown SDK, unknown model, unsupported thinking, context isolation) fail at launch, before any slot, ref or worktree.

```json
{
  "limits": { "agents": 4, "idleMinutes": 60 }
}
```

Top-level key: `limits`.

## Runtime

No config. Every launch resolves the same way, from `/worq`, `worq_spawn` or `worq spawn`:

- `sdk`: explicit, else `pi`. The adapter is imported on first use. `claude-code` is a lazy built-in when its optional `@anthropic-ai/claude-agent-sdk` and `zod` packages are installed; a valid installed adapter with the same id wins. `pi` is the only reserved id.
- `model`: explicit, else the adapter default (Pi: Main's current model).
- `thinking`: explicit, else the adapter default (Pi: Main's level) when the model supports it; an unsupported inherited level is dropped, an unsupported explicit one refused (`capability`).
- Then the adapter's local preflight (`validateRuntime`) rejects malformed/unknown models before admission. Account, network and provider-side failures can still surface at open; the agent then fails with the existing cleanup.

PQ subagents and reviews inherit their agent's effective runtime at child launch (applied `configure` changes included). The CLI `worq configure` and the dock change a live session; the harness stays locked.

`/worq` shows a runtime step (harness, model, thinking) with Main's selection preselected. Enter launches, Esc cancels; no countdown. Changing harness resets model and thinking to that harness's defaults. Tool and CLI launches never open it.

## Migration

| Old key | Now | Effect until removed |
|---|---|---|
| `plan`, `execute`, `review` (even `{}`) | launch request fields; reviews inherit | **every new launch refused** with the file, keys and these instructions. list/send/cancel/log/configure and cleanup keep working |
| `default`, `runtimes`, `roles`, `model`, … (pre-preset formats) | same | same |
| `launch` | removed (no countdown) | ignored; one warning per Pi session on first launch use |
| `approveExtensions`, `worq/extensions/` | removed (harness-specific) | ignored; same warning |
| `worq/instructions/*.md` | `worq/AGENTS.md` | not read; same warning |

Relying on a distinct reviewer model? Keep the older release until you accept inherited reviewer runtime; Worq never translates or silently drops it. Fix the file, then reload Pi.

## Shared resources

Installed once, identical for every role and every SDK (harness-neutral: plain Markdown only). Never part of model selection.

```
<agentDir>/worq/
├── AGENTS.md                  appended to every system prompt
├── skills/<name>/SKILL.md     indexed in the prompt; body read on demand via the `skill` tool
└── skills/<name>.md
```

- Skill frontmatter `name` / `description` are used when present; else the directory/file name and first line. Only the index enters the prompt, so large collections cost little context.
- AGENTS.md and skills are `context, not authority`: they never widen tools, budgets or permissions.
- No native harness extensions: nothing executable is loaded into sessions.
- Safety: the directory must not sit inside a Git checkout (`Repository resource`); entries are resolved with `realpath` and must stay inside it (`Untrusted resource`); regular files ≤ 256 KiB.
- Ambient discovery stays off: no global Pi settings, project AGENTS.md, packages or skills from Main or the candidate checkout are loaded.

## Subagents and review

Subagents are read-only sessions answering one probing question. The delegating agent can give a subagent an optional name:

```json
{ "question": "…", "why": "…", "name": "evidence" }
```

The name labels the child; it runs on its agent's runtime. Each child has its own `subagentTurns` / `subagentMinutes` budget. Depth is one: a subagent cannot delegate.

A workflow with `REVIEW.md` gets exactly one review subagent, on its first submission and on the agent's runtime. Main's feedback then opens one final, unreviewed revision; the agent ends as `done`. `verify:false` is refused. `worq list <ref>` prints each session's resolved runtime.

## Workflows

The agent catalog: `<agentDir>/workflows/<name>/SKILL.md`, read once at extension load (not part of `pi-worq.json`). `plan` and `execute` are seeded on first use. `disable-model-invocation: true` keeps one user-only (`/worq`). See `docs/workflows.md`.

## Adapters

Built in: `pi` (default) and `claude-code` (optional package). Claude uses the existing Claude Code login and native credentials; no API key is required. It replaces the system prompt, exposes only Worq's tools, ignores user/project/local settings and refuses nonempty or unreadable managed settings before a worker starts. The picker shows versioned models from the SDK catalog when available. Main's Claude-family model is the default when it has a defensible mapping; otherwise pass `model` explicitly. A live model switch is verified. If startup reports a policy or isolation refusal, check managed Claude Code policy rather than retrying with a prompt. If startup succeeds but the first turn fails, check Claude Code login and access to the selected model: worker readiness does not verify either. Thinking is fail-closed: the pinned SDK does not report the applied effort, so Main's level is not inherited and Worq advertises no level control; an explicit level is refused before a slot (and a live change is refused before mutation).

Extra harnesses: `<agentDir>/worq/adapters/<id>/adapter.mjs`. Installing one is the trust opt-in (operator code, in-process). A valid installed adapter wins its own id (including `claude-code` and `claude`); `pi` cannot be replaced. A missing or broken built-in never displaces an installed adapter and never affects Pi or management. See `docs/sdk.md`.

## Limits

Every value is optional; absent keys use these defaults.

| Key | Default | Applies to |
|---|---|---|
| `agents` | 4 | Active (non-parked) non-inline agents; spawn or resume fails as `at-capacity` |
| `scouts` | 12 | Active inline read-only agents (e.g. `scout`); concurrent execution remains bounded by `parallel` |
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

Budgets are per invocation and hard. Exhausting one parks the agent unreviewed with its last response and a pinned partial commit; `worq send <ref> <text>` resumes it with a fresh budget (same phase, no extra review). Per-session warnings are visible but do not wake Main.

## Verifying a configuration

- `worq list <ref>` shows review policy and each session's resolved runtime (`name` `main` or `launch`, `sdk`, `model`, `thinking`).
- The agent log has `Role <role>: runtime <name> (<sdk>, <model>), thinking <level>, turn unit <unit>; via <source>` at session open, then the SDK's native resolution (`Pi model <provider>/<id>`).
- `Phase:` shows initial work, reviewed (awaiting acceptance or feedback), final revision, or done.

## Failures and fixes

| Failure | Cause | Fix |
|---|---|---|
| `… are no longer supported, so new launches are refused` | Removed presets / old format | See Migration; remove the keys, reload |
| `/launch is ignored` | Removed countdown settings | Remove `launch` |
| `… is not a Pi model ref` | Ref shape | Use `<provider>/<model>` |
| `Unknown sdk` | No installed adapter with that id | `pi`, `claude-code` (package installed), or install `<agentDir>/worq/adapters/<id>/` |
| `sdk "<id>" could not load` | Adapter import/factory failed | Fix the adapter; other SDKs keep working |
| `The Claude Agent SDK is not available` | Optional package missing | `npm install @anthropic-ai/claude-agent-sdk zod` in the Worq install, or use `pi` |
| `Claude isolation refused` | Managed policy sets behavior, or could not be read | Change managed policy or use `pi`; never weaken the refusal |
| `Claude has no verified thinking-level control` | The pinned SDK does not report effort on stdio | Omit `thinking` for Claude |
| `Claude cannot verify a live thinking-level change` | The pinned SDK has no effort read-back | Start a new session without thinking |
| `runtime-invalidated` | A live model update was partial or unverifiable | The handle is fenced; restart the agent |
| `Pi does not know model …` | Model not installed in Pi | Install it or pick another |
| `… is not a pi thinking level` | Level unsupported by that model | Use one the error lists |
| `… is ignored` / `… is no longer read` | Removed key or resource layout | Remove it (move instructions into `worq/AGENTS.md`) |
| `Untrusted resource` / `Repository resource` | Escaping link, or `worq/` inside a checkout | Move the file / directory |
| `at-capacity` | `limits.agents` reached | Close an agent or raise the cap |
| `workflow-file` | The workflows directory cannot be read | Fix permissions; a missing directory is empty. Per-folder defects are warnings, not errors |
| `invocation` | User-only package sent to `worq_spawn` or the CLI | Launch it with `/worq` |
| `kind` | No installed package with that name | Install it, or check `/worq` warnings |

## Recipes

Longer agent invocations, parked sessions kept for a working day:

```json
{ "limits": { "agentTurns": 200, "agentMinutes": 90, "idleMinutes": 480 } }
```
