# pi-worq

Background Pi SDK agents you or Main (your Pi session) can spawn. Agents can delegate read-only questions and run independent reviews. A review reports findings; it does not authorize more work. Worq never merges.

## Install

```sh
pi install /path/to/pi-worq
```

Tools stay hidden until you run `/worq` or `/worq workflow` in a session (zero context cost otherwise). The choice survives resume.

### Windows (native)

Requires Windows 10/11, Node.js 22.19+, Git for Windows, and CPython 3.12+ (`git.exe` and `python.exe` on `PATH`). From this checkout in PowerShell:

```powershell
npm.cmd ci
pi.cmd install .
```

Start Pi, then run `node ./bin/worq.mjs sessions` in another terminal. To install the standalone `worq` command, run `npm.cmd install -g .`. Use Git Bash for the exact-diff shell example below.

## Use

```
/worq                         enable the tools
/worq workflow                choose an installed workflow; type optional instructions
/worq plan <request>           ask Main for a reviewed plan
/worq execute <request>        ask Main to execute
/worq <request>                give Main the request
/worq off                      block new launches, not cancellation; active refs remain serviceable
/worq list [ref] · /worq send <ref> <text> · /worq cancel <ref|all>
```

Main answers bounded factual lookups with primary-source citations unless delegation is requested. Main drives substantive agents through questions, review and authorized repairs. Even “plan and execute” pauses after the reviewed plan for direction: execute only (verified candidate, no merge), or execute and merge (verify before landing). A changed candidate needs fresh verification. Bare `/worq` or an explicit task re-enables launches.

- **Small, deterministic edit:** Unless Worq was requested, edit directly in Pi. Start from a clean commit and prepare the expected patch independently of Pi. Keep the patch outside the checkout and don't stage the candidate. From the repository root, run `bash /path/to/pi-worq/docs/examples/check-exact-diff.sh /path/to/expected.patch`. Generate the expected patch from the same baseline using `git diff --binary --no-ext-diff --no-textconv --no-color HEAD --`. The check compares the entire tracked diff and rejects staged changes and non-ignored untracked files; it does not inspect ignored files or prove behavior beyond the expected edit.
- **Ambiguous or consequential work:** Keep independent review. Plan first when it helps resolve a decision. Worq saves the submission to `.agents/plans/plan-<ref>.md`. `parked` means the submission and its one review are done, not that the result passed. The notice wakes Main. Use `/worq list <ref>` for all findings. For plan objections, first remove or narrow optional scope; fix required gaps or report them as unresolved. Only escalate consequential user-owned decisions.
- **Main owns iteration:** a parked agent keeps its session (and worktree). Main accepts and closes it, resumes it with targeted corrections (`worq_send`; new round, fresh budget, fresh review), spawns a fresh agent for a different approach, or asks the user. To execute an existing plan, attach it explicitly. Only Main may merge, with explicit authority and exact-SHA verification.

## Workflows

A workflow is a skill package: `<agentDir>/workflows/<name>/SKILL.md` (frontmatter `name`, `description`, optional `disable-model-invocation`, `access`, `review`) plus any supporting folders (`references/`, `scripts/`, …). Read once when Pi loads Worq; restart to pick up changes.

- `disable-model-invocation: true` → user-only: launched by `/worq workflow` alone.
- absent/`false` → also a `worq_spawn` kind (and control socket/CLI), so Main can launch it.
- `access: read` → read-only, result saved to `.agents/plans/plan-<ref>.md` (`# Workflow result:`). Absent → write: own worktree, pins `worq/<ref>`, never merges.
- Supporting files are listed in the prompt and read with `skill` (`name`, `path`); never executed.
- `review: true` → one independent review per submission, like built-in kinds. Absent → none (`verify` is refused).

`/worq workflow` lists every workflow, then asks for optional instructions (empty = run as written; escape cancels). It activates `worq_list`/`worq_send`/`worq_cancel`, never `worq_spawn`, and is honored under `/worq off`. A parked workflow releases its slot; the result remains available through `worq_list`.

## Vocabulary

| Term | Meaning |
|---|---|
| Main | your Pi session |
| Agent | SDK session launched by Main, or by you through a workflow; has a kind |
| Workflow | skill package `<agentDir>/workflows/<name>/SKILL.md`; `/worq workflow`, plus `worq_spawn` unless `disable-model-invocation: true` |
| Kind | SDK agent profile: built-in `prompts/kinds/<name>.md` or workflow `<agentDir>/workflows/<name>/SKILL.md`; frontmatter `access`, `review`, `disable-model-invocation`; the body is the workflow |
| PQ | probing question: one scoped question for a fresh read-only session |
| Subagent | answers one PQ for an agent (`delegate`), fire and forget, depth 1 |
| Review | one subagent per submission (`prompts/review.md`); read tools, plus process tools on a clone of the exact commit for write kinds |
| Round | run → submit → review → parked → Main's decision |

## Tools

| Tool | Params | Effect |
|---|---|---|
| `worq_spawn` | `kind`, `title`, `task`, `attach?`, `verify?` | start an agent; give it a 2–4 word title; `attach` lists exact plan names or repo-relative plan paths; `verify:false` skips review for a reviewed kind |
| `worq_list` | `ref?` | all agents, or one in full (PQs, reviews, activity) |
| `worq_send` | `ref`, `text` | running → steer · waiting → answer · parked → resume (new round) |
| `worq_cancel` | `ref` or `all` | parked → close · live → cancel; kills subagents, review, processes; removes worktree; keeps branch |

States: `starting · running · waiting · reviewing · parked · closed · cancelled · failed`.

Parked agents hold no slot; resuming needs one. Idle parked agents close after `limits.idleMinutes`. Budget exhaustion parks the agent unreviewed with its last response and a pinned partial commit; Main may resume it with a fresh budget.
Verdicts: `pass · findings · inconclusive` (crash/timeout/invalid → inconclusive, never pass).

## Profiles

| | Agent | PQ subagent | Review |
|---|---|---|---|
| Spawned by | Main (`worq_spawn`), or you (`/worq workflow` for workflows) | Agent (`delegate`) | Worq, on `submit` |
| Writes | execute/workflow write: own worktree · plan/workflow read: none (Worq saves the result) | none | none (fresh clone of the pinned commit) |
| Delegate / ask Main | yes / yes | no / no | no / no |
| Finish tool | `submit` | `submit` | `submit` |

Read tools: `search` accepts a relative file or directory path; `read_file` accepts a 1-based `offset` and a `limit` of 1–160 lines. For factual lookups, a short `submit` summary with source citations is enough.

Adding a built-in kind = one Markdown file; a workflow = one skill folder.

## Config

`<agentDir>/pi-worq.json` (usually `~/.pi/agent/pi-worq.json`). Optional; invalid keys fail with the key named.

```json
{
  "plan": { "sdk": "pi", "model": "provider/model", "thinking": "high" },
  "execute": { "thinking": "medium" },
  "review": { "model": "provider/review-model" },
  "limits": {
    "agents": 4, "subagents": 6, "parallel": 4, "asks": 3, "idleMinutes": 60,
    "agentTurns": 80, "subagentTurns": 16, "reviewerTurns": 40,
    "agentMinutes": 30, "subagentMinutes": 5, "reviewerMinutes": 10, "askMinutes": 15,
    "services": 2
  }
}
```

Each launch defaults to the current Pi session's model and thinking level. Optional `plan`, `execute` and `review` overrides replace the fields you set; `review` covers every review. The TUI picker still lets you change each launch. If upgrading, replace `default`, `runtimes` and `roles` with these direct overrides.

Skills, instructions and extensions are **not** per role: install once under `<agentDir>/worq/` and every role on every SDK gets the same set. See `docs/configuration.md` for keys, resources, limits and failure codes, and `docs/sdk.md` for the adapter contract.

## CLI

```sh
worq sessions | list [ref] | log <ref> [-f] | spawn <kind> --title "Short title" [--attach <plan>]... <task> | send <ref> <text> | cancel <ref|all>   [--pid N]
```

On Linux, the CLI uses a Unix socket. State defaults to `$XDG_STATE_HOME/pi-worq` or `~/.local/state/pi-worq`. On Windows it uses an authenticated local named pipe; discovery files live under `%LOCALAPPDATA%/pi-worq`. `WORQ_STATE_DIR` overrides either default. Keep it outside the repo and private to your user: Windows inherits directory ACLs, so do not use a shared state directory.

## Limits

Planning, execution, reviewer commands/services, artifacts, and the control CLI run on Linux and Windows. `observe_terminal` (automated PTY capture) remains Linux-only; use Linux or WSL if a review needs it. On Windows, command tools run `.exe` programs directly, not `.cmd` or `.bat` shims. For npm-based checks use `node` with a CLI JavaScript entry point (e.g. `node node_modules/typescript/bin/tsc`). Repo file tools use `/`-separated relative paths on both platforms.

One SDK ships today (Pi); a second is one adapter file under `src/sdk/` plus one registry record, documented in `docs/sdk.md`. Execute agents need a clean, committed baseline (untracked `.agents/plans/` is allowed). Pi sessions are not a security sandbox. Reviewer and agent judgement quality is not proven by the test suite, which uses a scripted driver.

## Develop

```sh
npm run check && npm run lint && npm test
```

Runtime versions match `.mise.toml` (Node 22.19, CPython 3.12); `mise install` is optional if both are already on `PATH`. CI runs the same commands on `ubuntu-latest` plus `npm run check && npm test` on `windows-latest` (`.github/workflows/ci.yml`). `npm run lint` uses Biome's recommended rules with the formatter and import sorting off, so it reports problems without rewriting files.

For complex work, delegate independent questions whose answers could change the decision. An unanswered permission request never authorizes the action. If the final progress commit fails, recover the retained worktree at the path in the agent log.

### Budgets and shared resources

Each invocation (spawn or resume) gets `agentTurns`/`agentMinutes`; PQs and reviews have their own. `worq list <ref>` shows review policy and role settings with JSON sources. No message raises a per-session turn/time limit, service quota or concurrency limit.

Shared resources live in `<agentDir>/worq/`: `instructions/*.md` (appended to every system prompt), `skills/<name>/SKILL.md` or `skills/<name>.md` (indexed in the prompt, read on demand with the `skill` tool) and `extensions/*.{mjs,js,ts}` (native Pi extensions; require `"approveExtensions": true`). Read once per Worq instance, outside Git checkouts, no symlink escapes. They add context, never tools, budgets or permissions beyond the role's own; extensions run operator code in-process, not a sandbox. No candidate discovery is enabled.

Agent names are exact lowercase slugs of their titles, with a numeric suffix on collision. Use the returned name for list, send, cancel and inspect. Plans are saved as `.agents/plans/plan-<name>.md`; revisions retain the same path. Existing plan files may be attached by their repo-relative path. At-sign mentions in tasks are always literal.
