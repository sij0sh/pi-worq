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
- **Ambiguous or consequential work:** Keep independent review. Plan first when it helps resolve a decision. Worq saves the submission to `.agents/plans/<ref>-<slug>.md`. `review-ready` means the review phase ended, not that the result passed. The notice wakes Main. Use `/worq list <ref>` for all findings. For plan objections, first remove or narrow optional scope; fix required gaps or report them as unresolved. Only escalate consequential user-owned decisions.
- **Continue only when authorized:** `/worq send <ref> <text>` starts another round on a review-ready agent. To implement an existing plan, ask Main to execute with that plan in the explicit `attach` list. The candidate stays on `worq/<ref>`; verify it before merging by hand, then close with `/worq cancel <ref>`.

## Workflows

A workflow is a user-invoked agent kind. Add one Markdown file at `<agentDir>/workflows/<name>.md`; `/worq workflow` opens a native menu of installed workflows, then asks for optional instructions. Empty instructions run the workflow as written; escape at either step cancels. A newly added file appears in the next launcher without restarting Pi.

Workflows are deliberately absent from `worq_spawn`, the control socket and the `worq` CLI: only you can launch one. A launch activates `worq_list`, `worq_send` and `worq_cancel`, never `worq_spawn`, and does not change the stored `/worq` on/off choice. `/worq off` still blocks Main's spawns while an explicit `/worq workflow` launch is honored.

A workflow result is the usual actionable `review-ready` notice. It stays live until `/worq cancel <ref>` and keeps one `limits.agents` slot. Read workflows save `.agents/plans/plan-<ref>.md` with a `# Workflow result:` heading; write workflows pin `worq/<ref>` and never merge. Workflows run no reviewers by default; `reviewers: plan` or `reviewers: execute` opts into a packaged roster. The ref base is `<name>-workflow`; a collision adds a numeric suffix. See `docs/workflows.md` for the file contract and every launcher warning.

## Vocabulary

| Term | Meaning |
|---|---|
| Main | your Pi session |
| Agent | SDK session launched by Main, or by you through a workflow; has a kind |
| Workflow | user-invoked kind in `<agentDir>/workflows/<name>.md`; launched only by `/worq workflow` |
| Kind | shared: `prompts/kinds/<name>.md` · user: `<agentDir>/workflows/<name>.md`; recursive question, access (`read`/`write`), `invocation` |
| PQ | probing question: one scoped question for a fresh read-only session |
| Subagent | answers one PQ for an agent (`delegate`), fire and forget, depth 1 |
| Reviewer | sealed session fired on submit; roster `prompts/reviewers/<roster>/*.md`, run in parallel |
| Round | submit → reviews → Main's decision |

## Tools

| Tool | Params | Effect |
|---|---|---|
| `worq_spawn` | `kind`, `title`, `task`, `attach?`, `verify?`, `mode?` | start an agent; give it a 2–4 word title; `attach` lists exact plan names or repo-relative plan paths; `verify:false` (execute only) skips the verifier |
| `worq_list` | `ref?` | all agents, or one in full (PQs, reviews, activity) |
| `worq_send` | `ref`, `text` | running → steer · waiting → answer · review-ready → next round |
| `worq_cancel` | `ref` or `all` | close/cancel; kills subagents, reviewers, processes; removes worktree; keeps branch |

States: `starting · running · waiting · reviewing · review-ready · closed · cancelled · failed`.
Verdicts: `pass · fail · inconclusive · plan-fault · not-applicable · unknown` (crash/timeout/invalid; never pass).

## Profiles

| | Agent | Subagent | Reviewer |
|---|---|---|---|
| Spawned by | Main (`worq_spawn`), or you (`/worq workflow` for workflows) | Agent (`delegate`) | Worq, on `submit` |
| Writes | execute/workflow write: own worktree · plan/workflow read: none (Worq saves the result) | none | none (fresh clone of the pinned commit) |
| Delegate / ask Main | yes / yes | no / no | no / no |
| Finish tool | `submit` | `answer` | `report` |

Read tools: `search` accepts a relative file or directory path; `read_file` accepts a 1-based `offset` and a `limit` of 1–160 lines. For factual lookups, a short `submit` summary with source citations is enough.

Adding a shared kind, workflow, or reviewer = adding one Markdown file.

## Config

`<agentDir>/pi-worq.json` (usually `~/.pi/agent/pi-worq.json`). Optional; invalid keys fail with the key named.

```json
{
  "default": "standard",
  "runtimes": {
    "standard": { "sdk": "pi", "model": "provider/model", "fallbackModel": "provider/model", "thinking": "medium" },
    "deep": { "model": "provider/model", "thinking": "high" },
    "fast": { "model": "provider/model", "thinking": "low" }
  },
  "roles": { "agent.execute": "deep", "reviewer": "deep", "subagent": "fast" },
  "limits": {
    "agents": 4, "subagents": 6, "parallel": 4, "rounds": 3, "asks": 3,
    "agentTurns": 80, "subagentTurns": 16, "reviewerTurns": 40,
    "agentMinutes": 30, "subagentMinutes": 5, "reviewerMinutes": 10, "askMinutes": 15,
    "services": 2
  }
}
```

`runtimes` are named presets (`sdk` defaults to `pi`). `roles` maps `agent`, `agent.<kind>`, `subagent`, `subagent.<name>`, `reviewer`, `reviewer.<name>` to a preset. Resolution: exact role → role family → `default` → built-in `main` (Pi, Main's model). Presets never inherit from each other.

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
npm run check && npm test
```

For complex work, delegate independent questions whose answers could change the decision. An unanswered permission request never authorizes the action. If the final progress commit fails, recover the retained worktree at the path in the agent log.

### Routes, checkpoints and shared resources

Main can select `mode: "fast"` for a focused, reversible change or `"thorough"` for costly failures and independent, decision-changing questions (`worq spawn execute --title "Update report" --mode fast "task"`). For plans, `fast` uses the existing subtraction reviewer to check requirements and unnecessary scope, falling back to the full kind roster if that reviewer is absent. Default and `thorough` plans use the full roster. Neither mode changes execute review, models, thinking, tools or caps. The optional spawn field `reason` records why Main chose the route. Omit mode for the default. `worq list <ref>` shows route, review policy, cumulative turns and role settings with JSON sources.

`limits.runTurns` (default 1000) covers the worker, retries, PQs and review roster across rounds. Per-session turn/time warnings and run warnings without grant headroom are display-only. If `limits.continuationTurns` (default 0) leaves room for a grant, near exhaustion an actionable checkpoint lets Main use `worq send REF '/continue N'`. Between requests a depleted run with headroom waits up to `limits.checkpointSeconds` (default 15) for approval. Streaming sessions cannot pause inside an SDK turn: approve before the hard stop. No grant raises a per-session turn/time limit, round cap, service quota or concurrency limit.

Shared resources live in `<agentDir>/worq/`: `instructions/*.md` (appended to every system prompt), `skills/<name>/SKILL.md` or `skills/<name>.md` (indexed in the prompt, read on demand with the `skill` tool) and `extensions/*.{mjs,js,ts}` (native Pi extensions; require `"approveExtensions": true`). Read once per Worq instance, outside Git checkouts, no symlink escapes. They add context, never tools, budgets or permissions beyond the role's own; extensions run operator code in-process, not a sandbox. Named PQs: map `roles["subagent.evidence"]` to a preset, then delegate with `name: "evidence"`. No candidate discovery is enabled.

Agent names are exact lowercase slugs of their titles, with a numeric suffix on collision. Use the returned name for list, send, cancel and inspect. Plans are saved as `.agents/plans/plan-<name>.md`; revisions retain the same path. Existing plan files may be attached by their repo-relative path. At-sign mentions in tasks are always literal.
