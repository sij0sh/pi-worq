# Configuration

One optional JSON file: `<agentDir>/pi-worq.json` (`~/.pi/agent/pi-worq.json`), plus one optional shared resource directory: `<agentDir>/worq/`. By default, every new Worq session uses Main's current Pi model and thinking level.

Both are read once per Pi session, when the first Worq tool call creates the Worq instance. Edit, then start a new Pi session; running agents keep what they launched with.

Invalid JSON fails as `invalid-json`; a schema violation fails as `invalid-payload` naming the JSON pointer (e.g. `/limits/agents`). Runtime problems (unknown SDK, unknown model, unsupported thinking, context isolation, extensions) fail at launch, before any slot, ref or worktree.

```json
{
  "approveExtensions": false,
  "limits": { "agents": 4, "idleMinutes": 60 }
}
```

Top-level keys: `approveExtensions`, `limits`.

## Runtime

No config. Every launch resolves the same way, from `/worq`, `worq_spawn` or `worq spawn`:

- `sdk`: explicit, else `pi`. The adapter is imported on first use.
- `model`: explicit, else the adapter default (Pi: Main's current model).
- `thinking`: explicit, else the adapter default (Pi: Main's level) when the model supports it; an unsupported inherited level is dropped, an unsupported explicit one refused (`capability`).
- Then the adapter's local preflight (`validateRuntime`) rejects malformed/unknown models before admission. Account, network and provider-side failures can still surface at open; the agent then fails with the existing cleanup.

PQ subagents and reviews inherit their agent's effective runtime at child launch (applied `configure` changes included). `/worq configure` / the dock change a live session; the harness stays locked.

`/worq` shows a runtime step (harness, model, thinking) with Main's selection preselected. Enter launches, Esc cancels; no countdown. Changing harness resets model and thinking to that harness's defaults. Tool and CLI launches never open it.

## Migration

| Old key | Now | Effect until removed |
|---|---|---|
| `plan`, `execute`, `review` (even `{}`) | launch request fields; reviews inherit | **every new launch refused** with the file, keys and these instructions. list/send/cancel/log/configure and cleanup keep working |
| `default`, `runtimes`, `roles`, `model`, … (pre-preset formats) | same | same |
| `launch` | removed (no countdown) | ignored; one warning per Pi session on first launch use |

Relying on a distinct reviewer model? Keep the older release until you accept inherited reviewer runtime; Worq never translates or silently drops it. Fix the file, then reload Pi.

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

The name labels the child; it runs on its agent's runtime. Each child has its own `subagentTurns` / `subagentMinutes` budget. Depth is one: a subagent cannot delegate.

Each submission of a `review: true` package gets one review subagent (`prompts/review.md`), on the agent's runtime. Shipped `plan` and `execute` set `review: true`. `verify:false` is refused; install an unreviewed package instead. `worq list <ref>` prints each session's resolved runtime.

## Workflows

The agent catalog: `<agentDir>/workflows/<name>/SKILL.md`, read once at extension load (not part of `pi-worq.json`). `plan` and `execute` are seeded on first use. `disable-model-invocation: true` keeps one user-only (`/worq`). Reviewed only with `review: true`. See `docs/workflows.md`.

## Adapters

Extra harnesses: `<agentDir>/worq/adapters/<id>/adapter.mjs`. Installing one is the trust opt-in (operator code, in-process). See `docs/sdk.md`.

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

- `worq list <ref>` shows review policy and each session's resolved runtime (`name` `main` or `launch`, `sdk`, `model`, `thinking`).
- The agent log has `Role <role>: runtime <name> (<sdk>, <model>), thinking <level>, turn unit <unit>; via <source>` at session open, then the SDK's native resolution (`Pi model <provider>/<id>`).
- An unreviewed package reads `Review: none`.

## Failures and fixes

| Failure | Cause | Fix |
|---|---|---|
| `… are no longer supported, so new launches are refused` | Removed presets / old format | See Migration; remove the keys, reload |
| `/launch is ignored` | Removed countdown settings | Remove `launch` |
| `… is not a Pi model ref` | Ref shape | Use `<provider>/<model>` |
| `Unknown sdk` | No installed adapter with that id | `pi`, or install `<agentDir>/worq/adapters/<id>/` |
| `sdk "<id>" could not load` | Adapter import/factory failed | Fix the adapter; other SDKs keep working |
| `verify:false is no longer supported` | Legacy review opt-out | Omit `verify`; use an unreviewed package |
| `Pi does not know model …` | Model not installed in Pi | Install it or pick another |
| `… is not a pi thinking level` | Level unsupported by that model | Use one the error lists |
| `Extension approval required` | Files in `worq/extensions/` | Set `approveExtensions: true` or remove them |
| `cannot load the … native extension(s)` | A role's SDK has no native extension support | Remove the extensions or keep that role on `pi` |
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
