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

Standard recipe (state it in AGENTS.md to make it a convention):

1. `worq_spawn("plan", task)` → plan saved to `.agents/plans/<ref>-<slug>.md`.
2. Review digest arrives as `[worq <ref>]`. Adjudicate each finding: accept, reject or defer. Accepted → `worq_send(ref, feedback)` starts another round.
3. `worq_spawn("execute", "<task> @<plan-ref>")` → works in its own worktree on `worq/<ref>`.
4. Verifier passes and you agree → `git merge worq/<ref>` by hand, then `worq_cancel(ref)` to close.

## Vocabulary

| Term | Meaning |
|---|---|
| Main | your Pi session |
| Agent | SDK session Main spawns; has a kind |
| Kind | `prompts/kinds/<name>.md`: recursive question, access (`read`/`write`), reviewer roster |
| PQ | probing question: one scoped question for a fresh read-only session |
| Subagent | answers one PQ for an agent (`delegate`), fire and forget, depth 1 |
| Reviewer | sealed session fired on submit; roster `prompts/reviewers/<roster>/*.md`, run in parallel |
| Round | submit → reviews → Main's decision |

## Tools

| Tool | Params | Effect |
|---|---|---|
| `worq_spawn` | `kind`, `task` | start an agent; `@ref` in task attaches that agent's plan |
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
  "model": "provider/model",
  "fallbackModel": "provider/model",
  "models": { "agent.execute": { "model": "provider/model" }, "reviewer": { "model": "provider/model" } },
  "limits": {
    "agents": 4, "subagents": 6, "parallel": 4, "rounds": 3, "asks": 3,
    "agentTurns": 80, "subagentTurns": 16, "reviewerTurns": 40,
    "agentMinutes": 30, "subagentMinutes": 5, "reviewerMinutes": 10, "askMinutes": 15,
    "services": 2
  }
}
```

Model keys: `agent`, `agent.<kind>`, `subagent`, `reviewer`, `reviewer.<name>`; most specific wins, else Main's model.

## CLI

```sh
worq sessions | list [ref] | log <ref> [-f] | spawn <kind> <task> | send <ref> <text> | cancel <ref|all>   [--pid N]
```

Talks to `<state>/ctl/<pid>.sock`. State: `$WORQ_STATE_DIR` or `~/.local/state/pi-worq` (private, outside the repo).

## Limits

Linux only. Execute agents need a clean, committed baseline (untracked `.agents/plans/` is allowed). Pi sessions are not a security sandbox. Reviewer and agent judgement quality is not proven by the test suite, which uses a scripted driver.

## Develop

```sh
npm run check && npm test
```
