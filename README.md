# pi-worq

Background Pi SDK agents you or Main (your Pi session) can spawn. Agents can delegate read-only questions and run independent reviews. A review reports findings; it does not authorize more work. Worq never merges.

## Install

```sh
pi install /path/to/pi-worq
```

Tools stay hidden until you run `/worq` in a session (zero context cost otherwise). The choice survives resume.

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
/worq plan <request>           ask Main for a reviewed plan
/worq execute <request>        ask Main to execute
/worq <request>                give Main the request
/worq off                      block new launches, not cancellation; active refs remain serviceable
/worq list [ref] · /worq send <ref> <text> · /worq cancel <ref|all>
```

Main answers bounded factual lookups with primary-source citations unless delegation is requested. Main drives substantive agents through questions, review and authorized repairs. Even “plan and execute” pauses after the reviewed plan for direction: execute only (verified candidate, no merge), or execute and merge (verify before landing). A changed candidate needs fresh verification. Bare `/worq` or an explicit task re-enables launches.

- **Small, deterministic edit:** Unless Worq was requested, edit directly in Pi. Start from a clean commit and prepare the expected patch independently of Pi. Keep the patch outside the checkout and don't stage the candidate. From the repository root, run `bash /path/to/pi-worq/docs/examples/check-exact-diff.sh /path/to/expected.patch`. Generate the expected patch from the same baseline using `git diff --binary --no-ext-diff --no-textconv --no-color HEAD --`. The check compares the entire tracked diff and rejects staged changes and non-ignored untracked files; it does not inspect ignored files or prove behavior beyond the expected edit.
- **Ambiguous or consequential work:** Keep independent review. Plan first when it helps resolve a decision. Worq saves the submission to `.agents/plans/<ref>-<slug>.md`. `review-ready` means the review phase ended, not that the result passed. The notice wakes Main. Use `/worq list <ref>` for all findings. For plan objections, first remove or narrow optional scope; fix required gaps or report them as unresolved. Only escalate consequential user-owned decisions.
- **Continue only when authorized:** `/worq send <ref> <text>` starts another round on a review-ready agent. To implement an existing plan, use `/worq execute <request> @<plan-ref>`. The candidate stays on `worq/<ref>`; verify it before merging by hand, then close with `/worq cancel <ref>`.

## Vocabulary

| Term | Meaning |
|---|---|
| Main | your Pi session |
| Agent | SDK session Main spawns; has a kind |
| Kind | `prompts/kinds/<name>.md`: recursive question, access (`read`/`write`) |
| PQ | probing question: one scoped question for a fresh read-only session |
| Subagent | answers one PQ for an agent (`delegate`), fire and forget, depth 1 |
| Reviewer | sealed session fired on submit; roster `prompts/reviewers/<roster>/*.md`, run in parallel |
| Round | submit → reviews → Main's decision |

## Tools

| Tool | Params | Effect |
|---|---|---|
| `worq_spawn` | `kind`, `task`, `verify?`, `mode?` | start an agent; `@ref` in task attaches that agent's plan; `verify:false` (execute only) skips the verifier |
| `worq_list` | `ref?` | all agents, or one in full (PQs, reviews, activity) |
| `worq_send` | `ref`, `text` | running → steer · waiting → answer · review-ready → next round |
| `worq_cancel` | `ref` or `all` | close/cancel; kills subagents, reviewers, processes; removes worktree; keeps branch |

States: `starting · running · waiting · reviewing · review-ready · closed · cancelled · failed`.
Verdicts: `pass · fail · inconclusive · plan-fault · not-applicable · unknown` (crash/timeout/invalid; never pass).

## Profiles

| | Agent | Subagent | Reviewer |
|---|---|---|---|
| Spawned by | Main | Agent (`delegate`) | Worq, on `submit` |
| Writes | execute: own worktree · plan: none (Worq saves plan) | none | none (fresh clone of the pinned commit) |
| Delegate / ask Main | yes / yes | no / no | no / no |
| Finish tool | `submit` | `answer` | `report` |

Read tools: `search` accepts a relative file or directory path; `read_file` accepts a 1-based `offset` and a `limit` of 1–160 lines. For factual lookups, a short `submit` summary with source citations is enough.

Adding a kind or reviewer = adding one Markdown file.

## Config

`<agentDir>/pi-worq.json` (usually `~/.pi/agent/pi-worq.json`). Optional; invalid keys fail with the key named.

```json
{
  "harness": "pi",
  "fallbackModel": "provider/model",
  "harnesses": { "pi": { "model": "provider/model", "thinking": "medium" } },
  "models": {
    "agent.execute": { "thinking": "high" },
    "reviewer": { "model": "provider/model", "thinking": "high" },
    "subagent": { "model": "provider/model", "thinking": "low" }
  },
  "limits": {
    "agents": 4, "subagents": 6, "parallel": 4, "rounds": 3, "asks": 3,
    "agentTurns": 80, "subagentTurns": 16, "reviewerTurns": 40,
    "agentMinutes": 30, "subagentMinutes": 5, "reviewerMinutes": 10, "askMinutes": 15,
    "services": 2
  }
}
```

Model keys: `agent`, `agent.<kind>`, `subagent`, `subagent.<name>`, `reviewer`, `reviewer.<name>`. `models.<key>.harness` picks the backend (absent inherits the top-level `harness`, absent there means `pi`); then `model`, `fallbackModel` and `thinking` each inherit **independently**: the role's own layer, its profile layer, `harnesses.<resolved harness>`, then the top level. `harnesses.<h>.model` therefore shadows the top-level `model` for every role resolved to that harness — do not set both.

One behaviour change versus 0.0.8: a more specific layer that sets only one field no longer discards an inherited field, so `models.reviewer.model` now reaches `reviewer.intent`. A missing model is not an error: the role uses Main's model.

See `docs/configuration.md` for every key, inheritance, limits, pinned resources and failure codes, and `docs/harness.md` for the adapter contract, the capabilities and the per-harness config example.

## CLI

```sh
worq sessions | list [ref] | log <ref> [-f] | spawn <kind> <task> | send <ref> <text> | cancel <ref|all>   [--pid N]
```

On Linux, the CLI uses a Unix socket. State defaults to `$XDG_STATE_HOME/pi-worq` or `~/.local/state/pi-worq`. On Windows it uses an authenticated local named pipe; discovery files live under `%LOCALAPPDATA%/pi-worq`. `WORQ_STATE_DIR` overrides either default. Keep it outside the repo and private to your user: Windows inherits directory ACLs, so do not use a shared state directory.

## Limits

Planning, execution, reviewer commands/services, artifacts, and the control CLI run on Linux and Windows. `observe_terminal` (automated PTY capture) remains Linux-only; use Linux or WSL if a review needs it. On Windows, command tools run `.exe` programs directly, not `.cmd` or `.bat` shims. For npm-based checks use `node` with a CLI JavaScript entry point (e.g. `node node_modules/typescript/bin/tsc`). Repo file tools use `/`-separated relative paths on both platforms.

One backend ships today (Pi); a second is one adapter file plus one registry line, documented in `docs/harness.md`. Execute agents need a clean, committed baseline (untracked `.agents/plans/` is allowed). Pi sessions are not a security sandbox. Reviewer and agent judgement quality is not proven by the test suite, which uses a scripted driver.

## Develop

```sh
npm run check && npm test
```

For complex work, delegate independent questions whose answers could change the decision. An unanswered permission request never authorizes the action. If the final progress commit fails, recover the retained worktree at the path in the agent log.

### Routes, checkpoints and trusted Pi resources

Main can select `mode: "fast"` for a focused, reversible change or `"thorough"` for costly failures and independent, decision-changing questions (`worq spawn execute --mode fast "task"`). For plans, `fast` uses the existing subtraction reviewer to check requirements and unnecessary scope, falling back to the full kind roster if that reviewer is absent. Default and `thorough` plans use the full roster. Neither mode changes execute review, models, thinking, tools or caps. The optional spawn field `reason` records why Main chose the route. Omit mode for the default. `worq list <ref>` shows route, review policy, cumulative turns and role settings with JSON sources.

`limits.runTurns` (default 1000) covers the worker, retries, PQs and review roster across rounds. Per-session turn/time warnings and run warnings without grant headroom are display-only. If `limits.continuationTurns` (default 0) leaves room for a grant, near exhaustion an actionable checkpoint lets Main use `worq send REF '/continue N'`. Between requests a depleted run with headroom waits up to `limits.checkpointSeconds` (default 15) for approval. Streaming sessions cannot pause inside an SDK turn: approve before the hard stop. No grant raises a per-session turn/time limit, round cap, service quota or concurrency limit.

In `pi-worq.json`, `models` entries may specify `skills`, `instructions` (e.g. AGENTS.md) and `extensions`. Each is an array of `{ "path": "relative/file", "sha256": "<64 lowercase hex digits>" }` under `<agentDir>/worq-resources/`, outside Git checkouts. Exact role lists replace corresponding family lists; `[]` removes the grant. No parent-role grants transfer. Configure `models["subagent.evidence"]` with its own model and skills, then delegate with `name: "evidence"`. Plain `delegate` selects `subagent`. `reviewer.intent` resolves independently. Skills and instructions contribute pinned text, not permissions. Executables require `approveExecutables: true` on the selected role and must be trusted standalone JavaScript modules: approval runs operator code in the Pi process, not a sandbox. Do not approve scripts that import candidate code. No candidate discovery is enabled.
