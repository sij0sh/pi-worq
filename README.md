# pi-worq

Background Pi SDK agents that Main (your Pi session) spawns, steers and adjudicates. Each agent works through a thought tree of probing questions, may delegate questions to read-only subagents, and ends with independent reviewers. Main decides what happens next. Worq never merges.

## Install

```sh
pi install /path/to/pi-worq
```

Tools stay hidden until you run `/worq` in a session (zero context cost otherwise). The choice survives resume.

## Use

```
/worq                         enable the tools
/worq <request>               enable and hand the request to Main
/worq off                     hide the tools (agents keep running)
/worq list [ref] · /worq send <ref> <text> · /worq cancel <ref|all>
```

Choose the route by the ask:

| Route | Spawn | Reviewers |
|---|---|---|
| small, plainly verifiable, no behaviour change | `execute`, `mode: "fast"` | normal verifier unless explicitly skipped |
| open work with one visible route | `plan` → `execute` | four lenses, then the verifier |
| user-facing behaviour, broad scope, a user-owned choice | `plan`, read it → `execute` | four lenses, then the verifier |

Standard recipe (state it in AGENTS.md to make it a convention):

1. `worq_spawn("plan", task)` → plan saved to `.agents/plans/<ref>-<slug>.md`.
2. Review digest arrives as `[worq <ref>]`. Adjudicate each finding: accept, reject or defer. Accepted → put the correction in the execute task; `worq_send` starts another round, so use it only for a finding that changes the plan's criteria or scope.
3. `worq_spawn("execute", "<the user's ask verbatim> @<plan-ref>", verify?)` → works in its own worktree on `worq/<ref>`. Attach a plan only when one exists; `verify:false` skips the verifier.
4. Verifier passes (or you have read the diff) and you agree → `git merge worq/<ref>` by hand, then `worq_cancel(ref)` to close.

A digest carries the four most consequential findings per reviewer; `worq_list <ref>` carries all of them with full text.

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

Talks to `<state>/ctl/<pid>.sock`. State: `$WORQ_STATE_DIR` or `~/.local/state/pi-worq` (private, outside the repo).

## Limits

Linux only. One backend ships today (Pi); a second is one adapter file plus one registry line, documented in `docs/harness.md`. Execute agents need a clean, committed baseline (untracked `.agents/plans/` is allowed). Pi sessions are not a security sandbox. Reviewer and agent judgement quality is not proven by the test suite, which uses a scripted driver.

## Develop

```sh
npm run check && npm test
```

Use execute directly for simple reversible work. For complex work, delegate independent questions whose answers could change the decision. An unanswered permission request never authorizes the action. If the final progress commit fails, recover the retained worktree at the path in the agent log.

### Routes, checkpoints and trusted Pi resources

Main can select `mode: "fast"` for a focused, reversible change or `"thorough"` for costly failures and independent, decision-changing questions (`worq spawn execute --mode fast "task"`). Neither changes models, thinking, tools, caps or the required roster. The optional spawn field `reason` records why Main chose the route. Omit mode for the default. `worq list <ref>` shows route, review policy, cumulative turns and role settings with JSON sources.

`limits.runTurns` (default 1000) covers the worker, retries, PQs and review roster across rounds. Near exhaustion Main sees a checkpoint with recent evidence. Only if the operator configured `limits.continuationTurns` (default 0) may Main use `worq send REF '/continue N'` at a checkpoint to allocate additional turns before exhaustion. Between requests a depleted run with available headroom waits up to `limits.checkpointSeconds` (default 15) for approval. Streaming sessions cannot pause inside an SDK turn: approve before the hard stop. The pool is cumulative. No grant raises a per-session turn/time limit, round cap, service quota or concurrency limit.

In `pi-worq.json`, `models` entries may specify `skills`, `instructions` (e.g. AGENTS.md) and `extensions`. Each is an array of `{ "path": "relative/file", "sha256": "<64 lowercase hex digits>" }` under `<agentDir>/worq-resources/`, outside Git checkouts. Exact role lists replace corresponding family lists; `[]` removes the grant. No parent-role grants transfer. Configure `models["subagent.evidence"]` with its own model and skills, then delegate with `name: "evidence"`. Plain `delegate` selects `subagent`. `reviewer.intent` resolves independently. Skills and instructions contribute pinned text, not permissions. Executables require `approveExecutables: true` on the selected role and must be trusted standalone JavaScript modules: approval runs operator code in the Pi process, not a sandbox. Do not approve scripts that import candidate code. No candidate discovery is enabled.
