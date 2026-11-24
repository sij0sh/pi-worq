# pi-worq

Background Pi SDK agents you or Main (your Pi session) can spawn. Agents can delegate read-only questions and run independent reviews. A review reports findings; it does not authorize more work. Worq never merges.

## Install

```sh
pi install /path/to/pi-worq
```

Tools stay hidden until you launch an agent with `/worq` or enable them with `/worq on` (zero context cost otherwise). The choice survives resume.

First use installs the shipped `plan` and `execute` packages into `<agentDir>/workflows/` once, never over existing folders. They are then yours to edit, remove or replace.

### Windows (native)

Requires Windows 10/11, Node.js 22.19+, Git for Windows, and CPython 3.12+ (`git.exe` and `python.exe` on `PATH`). From this checkout in PowerShell:

```powershell
npm.cmd ci
pi.cmd install .
```

Start Pi, then run `node ./bin/worq.mjs sessions` in another terminal. To install the standalone `worq` command, run `npm.cmd install -g .`. Use Git Bash for the exact-diff shell example below.

## Use

```
/worq                         launch an agent: package → optional instructions → runtime (Enter launches, Esc cancels)
/worq on                      enable the tools only (bare /worq does this outside the TUI)
/worq plan <request>           ask Main for a reviewed plan
/worq <request>                give Main the request
/worq off                      block new launches, not cancellation; active refs remain serviceable
/worq list [ref] · /worq send <ref> <text> · /worq cancel <ref|all>
```

`/worq workflow` is an alias for `/worq`. A successful `/worq` launch activates all four Main tools before the agent starts, so Main can drive it; cancelling at any step changes nothing. Under `/worq off`, `/worq` asks before re-enabling the tools.

Main answers bounded factual lookups with primary-source citations unless delegation is requested. Main drives substantive agents through questions, review and authorized repairs. Even “plan and execute” pauses after the reviewed plan for direction: execute only (verified candidate, no merge), or execute and merge (verify before landing). A changed candidate needs fresh verification. `/worq on`, a confirmed `/worq` launch or an explicit task re-enables launches.

- **Small, deterministic edit:** Unless Worq was requested, edit directly in Pi. Start from a clean commit and prepare the expected patch independently of Pi. Keep the patch outside the checkout and don't stage the candidate. From the repository root, run `bash /path/to/pi-worq/docs/examples/check-exact-diff.sh /path/to/expected.patch`. Generate the expected patch from the same baseline using `git diff --binary --no-ext-diff --no-textconv --no-color HEAD --`. The check compares the entire tracked diff and rejects staged changes and non-ignored untracked files; it does not inspect ignored files or prove behavior beyond the expected edit.
- **Ambiguous or consequential work:** Keep independent review. Plan first when it helps resolve a decision. Worq saves the submission to `.agents/plans/plan-<ref>.md`. `parked` means the submission and its one review are done, not that the result passed. The notice wakes Main. Use `/worq list <ref>` for all findings. For plan objections, first remove or narrow optional scope; fix required gaps or report them as unresolved. Only escalate consequential user-owned decisions.
- **One review, one feedback pass:** every agent's first submission gets exactly one independent review, then it parks (session and worktree kept). Main accepts and closes it (`worq_cancel`), or sends filtered feedback once (`worq_send`): the agent makes one final revision, submits without another review and ends as `done` (branch/plan kept, worktree removed). Main may instead spawn a fresh agent for a different approach, or ask the user. To execute an existing plan, attach it explicitly. Only Main may merge, with explicit authority and exact-SHA verification.

## Agent packages

Every agent kind, shipped or yours, is one folder: `<agentDir>/workflows/<name>/SKILL.md` (frontmatter `name`, `description`, optional `disable-model-invocation`, `access`) plus any supporting folders (`references/`, `scripts/`, …). Read once when Pi loads Worq; restart to pick up changes. No Worq code registers a name.

- `disable-model-invocation: true` → user-only: launched by `/worq` alone, refused from `worq_spawn` and the CLI.
- absent/`false` → also a `worq_spawn` kind (and control socket/CLI).
- `access: read` → no worktree, no write/process tools; result saved to `.agents/plans/plan-<ref>.md`. Absent → write: own clean-baseline worktree, pins `worq/<ref>`, never merges.
- Every agent gets exactly one independent review of its first submission; no opt-out (`review` keys and `verify:false` are ignored/refused).
- Supporting files are listed in the prompt and read with `skill` (`name`, `path`); never executed.

See `docs/workflows.md`.

## Vocabulary

| Term | Meaning |
|---|---|
| Main | your Pi session |
| Agent | SDK session launched by Main, the CLI or you (`/worq`); has a kind |
| Kind | installed package `<agentDir>/workflows/<name>/SKILL.md`; frontmatter `access`, `disable-model-invocation`; the body is the workflow. `plan` and `execute` ship as packages |
| PQ | probing question: one scoped question for a fresh read-only session |
| Subagent | answers one PQ for an agent (`delegate`), fire and forget, depth 1 |
| Review | one subagent per agent, on its first submission (`prompts/review.md`); read tools, plus process tools on a clone of the exact commit for write kinds |
| Lifecycle | run → submit → review → parked → Main accepts (close) or sends feedback once → final revision → `done` |

## Tools

| Tool | Params | Effect |
|---|---|---|
| `worq_spawn` | `kind`, `task?`, `title?`, `attach?`, `sdk?`, `model?`, `thinking?` | start an agent; `task` omitted runs the package as written; `title` (2–4 words) generated when omitted; `attach` lists exact plan names or repo-relative plan paths; runtime defaults to Main's (`sdk` pi) |
| `worq_list` | `ref?` | all agents, or one in full (PQs, reviews, activity) |
| `worq_send` | `ref`, `text` | running → steer · waiting → answer · parked after review → feedback for the one final revision (no further review; ends as `done`) · parked out of budget → resume with a fresh budget |
| `worq_cancel` | `ref` or `all` | parked → close · live → cancel; kills subagents, review, processes; removes worktree; keeps branch |

States: `starting · running · waiting · reviewing · parked · done · closed · cancelled · failed`. `done` = final revision submitted after review, not re-reviewed: verify the exact candidate before reporting success or merging.

Parked agents hold no slot; resuming needs one. Idle parked agents close after `limits.idleMinutes`. Budget exhaustion parks the agent unreviewed with its last response and a pinned partial commit; Main may resume it with a fresh budget (same phase, never an extra review).
Verdicts: `pass · findings · inconclusive` (crash/timeout/invalid → inconclusive, never pass).

## Profiles

| | Agent | PQ subagent | Review |
|---|---|---|---|
| Spawned by | Main (`worq_spawn`), CLI, or you (`/worq`) | Agent (`delegate`) | Worq, on `submit` |
| Runtime | launch request, else Main's | owner's effective runtime | owner's effective runtime |
| Writes | `access: write`: own worktree · `access: read`: none (Worq saves the result) | none | none (fresh clone of the pinned commit) |
| Delegate / ask Main | yes / yes | no / no | no / no |
| Finish tool | `submit` | `submit` | `submit` |

Read tools: `search` accepts a relative file or directory path; `read_file` accepts a 1-based `offset` and a `limit` of 1–160 lines. For factual lookups, a short `submit` summary with source citations is enough.

Adding an agent = one package folder. Adding a harness = one adapter folder (`docs/sdk.md`). Neither changes Worq.

## Config

`<agentDir>/pi-worq.json` (usually `~/.pi/agent/pi-worq.json`). Optional; invalid keys fail with the key named.

```json
{
  "limits": {
    "agents": 4, "subagents": 6, "parallel": 4, "asks": 3, "idleMinutes": 60,
    "agentTurns": 80, "subagentTurns": 16, "reviewerTurns": 40,
    "agentMinutes": 30, "subagentMinutes": 5, "reviewerMinutes": 10, "askMinutes": 15,
    "services": 2
  }
}
```

Each launch defaults to the current Pi session's model and thinking level; a launch request (`sdk`/`model`/`thinking`, CLI flags or the `/worq` runtime step) overrides it. PQs and reviews inherit their agent's runtime. The removed `plan`, `execute` and `review` presets block new launches (not management) until removed; `launch` is ignored with a warning. See `docs/configuration.md`.

`AGENTS.md` and skills are **not** per role or per harness: install once under `<agentDir>/worq/` and every role on every SDK gets the same set. See `docs/configuration.md` for keys, resources, limits and failure codes, and `docs/sdk.md` for the adapter contract.

## CLI

```sh
worq sessions | list [ref] | log <ref> [-f] | send <ref> <text> | cancel <ref|all>   [--pid N]
worq spawn <kind> [--title "Short title"] [--attach <plan>]... [--sdk id] [--model ref] [--thinking level] [--] [task]
```

Legacy `spawn <kind> --title … <task>` works against older and newer hosts. Omitting the title or task, or the runtime flags, needs a host of the same release; an older host's schema refusal is reported with an upgrade hint, never retried.

On Linux, the CLI uses a Unix socket. State defaults to `$XDG_STATE_HOME/pi-worq` or `~/.local/state/pi-worq`. On Windows it uses an authenticated local named pipe; discovery files live under `%LOCALAPPDATA%/pi-worq`. `WORQ_STATE_DIR` overrides either default. Keep it outside the repo and private to your user: Windows inherits directory ACLs, so do not use a shared state directory.

## Limits

Planning, execution, reviewer commands/services, artifacts, and the control CLI run on Linux and Windows. `observe_terminal` (automated PTY capture) remains Linux-only; use Linux or WSL if a review needs it. On Windows, command tools run `.exe` programs directly, not `.cmd` or `.bat` shims. For npm-based checks use `node` with a CLI JavaScript entry point (e.g. `node node_modules/typescript/bin/tsc`). Repo file tools use `/`-separated relative paths on both platforms.

One SDK ships (Pi); others install as `<agentDir>/worq/adapters/<id>/adapter.mjs` (`docs/sdk.md`). Execute agents need a clean, committed baseline (untracked `.agents/plans/` is allowed). Pi sessions are not a security sandbox. Reviewer and agent judgement quality is not proven by the test suite, which uses a scripted driver.

## Develop

```sh
npm run check && npm run lint && npm test
```

Runtime versions match `.mise.toml` (Node 22.19, CPython 3.12); `mise install` is optional if both are already on `PATH`. CI runs the same commands on `ubuntu-latest` plus `npm run check && npm test` on `windows-latest` (`.github/workflows/ci.yml`). `npm run lint` uses Biome's recommended rules with the formatter and import sorting off, so it reports problems without rewriting files.

For complex work, delegate independent questions whose answers could change the decision. An unanswered permission request never authorizes the action. If the final progress commit fails, recover the retained worktree at the path in the agent log.

### Budgets and shared resources

Each invocation (spawn or resume) gets `agentTurns`/`agentMinutes`; PQs and reviews have their own. `worq list <ref>` shows review policy and each session's runtime. No message raises a per-session turn/time limit, service quota or concurrency limit.

Shared resources live in `<agentDir>/worq/`: `AGENTS.md` (appended to every system prompt) and `skills/<name>/SKILL.md` or `skills/<name>.md` (indexed in the prompt, read on demand with the `skill` tool). Harness-neutral Markdown only; no native extensions. Read once per Worq instance, outside Git checkouts, no symlink escapes. They add context, never tools, budgets or permissions beyond the role's own. No candidate discovery is enabled.

Agent names are exact lowercase slugs of their titles, with a numeric suffix on collision. Use the returned name for list, send, cancel and inspect. Plans are saved as `.agents/plans/plan-<name>.md`; revisions retain the same path. Existing plan files may be attached by their repo-relative path. At-sign mentions in tasks are always literal.
