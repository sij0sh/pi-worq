# Workflows

A workflow is a **user-invoked** agent kind. It uses the same engine as `plan` and `execute`: its own SDK session, `delegate`/`ask_main`, rounds, independent review, worktree isolation, telemetry, `worq_list`, `worq_send` and `worq_cancel`.

The one difference is authority. Only you can launch a workflow. It is absent from `worq_spawn`, the control socket and the `worq` CLI. Main cannot see it as a tool.

## Install

Put one Markdown file at:

```
<agentDir>/workflows/<name>.md
```

`<agentDir>` is usually `~/.pi/agent`. The file name is the kind name:

- lowercase letters and digits, hyphen-separated
- starts with a letter
- must not collide with a built-in kind (`plan`, `execute`)

A new file is read on the next `/worq workflow`; no restart is needed. Valid files load even when a sibling is invalid. Dotfiles, `README.md` (any case), non-`.md` entries and directories are ignored.

## File contract

```markdown
---
access: read
description: Identify consequential architectural problems
---

# Objective

Identify structural problems that increase the cost or risk of changing the software.

## Workflow

1. Establish the project's architectural boundaries.
2. Inspect ownership, contracts and dependencies.
3. Identify violations with concrete evidence.
4. Recommend the smallest adequate corrections.

## Recursive question

What unresolved architectural concern could materially affect future changes?

## Completion

Submit prioritized findings, supporting evidence and recommended corrections.
```

A full working example is `docs/examples/foundation-workflow.md`: an unattended, read-only audit of runtime pinning, setup, tests, CI, dependencies, docs, secrets and infrastructure that never asks Main and opts into the `plan` reviewer roster. Copy it to `<agentDir>/workflows/foundation.md` to install it.

### Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `access` | yes | `read` produces a Workflow result artifact and no worktree. `write` runs in a worktree and pins `worq/<ref>`. |
| `description` | yes | Shown in the launcher menu. |
| `reviewers` | no | `plan` or `execute` opts into that packaged reviewer roster. Omit it, or use `none`, for no reviewers. |

Do not add `invocation`; the `workflows` directory decides that a kind is user-invoked. The loader rejects that key.

### Body

| Section | Required | Meaning |
|---|---|---|
| `Workflow` | yes | H1–H3 heading with non-blank steps. This is the semantic workflow the agent must follow. |
| `Recursive question` | yes | H1–H3 heading, or a `Recursive question: …` line, stating what unresolved decision the run must close. |
| `Objective`, `Completion` | no | Useful context; not parsed. |

The whole body is the kind prompt. The agent also receives the shared Worq protocol, guard and finish tool.

### Result identity

- Title: the file name with hyphens replaced by spaces (`architecture-audit` → `architecture audit`).
- Ref: `<name>-workflow` (`architecture-audit-workflow`). `reserveName` appends `-2`, `-3` on collision.
- Read result: `.agents/plans/plan-<ref>.md`, headed `# Workflow result: <title>`.
- Write result: commit on `worq/<ref>`, worktree removed on cancel. Worq never merges.

## Launching

```
/worq workflow
```

The native TUI menu lists each valid workflow as `name · access · description`. Select one, then answer:

```
Additional instructions for <name> (optional)
```

- **Empty** → the workflow runs as written.
- **Text** → the text becomes the task, with the workflow body still in the system prompt.
- **Escape** at either step → nothing launches.

The launcher rereads the directory every time. Invalid files are reported as warnings and skipped; valid siblings remain selectable. If nothing valid loads, the notice names the directory and the required file shape. In a non-TUI session the command says the launcher requires a TUI; there is no fallback command.

`/worq workflow` takes no arguments. `/worq workflow <extra>` prints `Usage: /worq workflow`. `workflow` is a reserved first word after `/worq`; it is not forwarded to Main.

### Tool activation

A launch activates `worq_list`, `worq_send` and `worq_cancel`. It never activates `worq_spawn` and does not write a `worq-enabled` entry.

`/worq off` still blocks Main's launches. An explicit `/worq workflow` launch is honored while off, because the user initiated it.

## Lifecycle

The completion notice is the usual actionable `review-ready` event. It wakes Main, who can read findings with `/worq list <ref>`.

A workflow stays live in `review-ready` until `/worq cancel <ref>` and keeps one `limits.agents` slot. The notice says so. `/worq send <ref> <text>` starts another round only when authorized; `/worq cancel` stops it and removes its worktree.

Read workflows save a `PlanReport` as the Workflow result artifact. Write workflows submit a `WorkReport`, pin a commit and leave the candidate for manual verification. Never merge without verifying the candidate.

## Reviewers

Workflows run **no reviewers by default**. With no roster the system prompt says the result is self-contained, the finish description does not promise review, and the digest reports `No reviewers ran: this result is unverified.`

Opt in with frontmatter:

```yaml
reviewers: plan
```

or:

```yaml
reviewers: execute
```

Only packaged rosters (`plan`, `execute`) exist in v1. `reviewers: none` is the same as omitting the key. User-installed roster directories are not supported yet.

Reviewer turns spend from the same `runTurns` pool as the workflow. A read workflow can use either roster; a read workflow with `reviewers: execute` gets the execute intent reviewer, which is usually less useful than `plan`.

## Configuration

Workflows are kinds, so the normal role keys apply:

```json
{
  "models": {
    "agent.architecture-audit": { "model": "provider/model", "thinking": "high" }
  }
}
```

- `agent.<name>` selects one workflow.
- `agent` selects every agent, including workflows.
- `reviewer`, `reviewer.<name>` select review roles.
- `limits.agents` caps live workflows along with other agents.
- `limits.rounds`, `asks`, `agentTurns`, `agentMinutes` and `runTurns` apply unchanged.

Workflow files are not part of `pi-worq.json`; they are read per launch. Config is read once when the Worq instance is created.

## Errors

Each per-file problem is printed as `! <path>: <message>` before the menu. The file is skipped; valid siblings still load.

| Message | Fix |
|---|---|
| `… file name must be lowercase letters and digits, hyphen-separated, starting with a letter` | Rename the file, e.g. `architecture-audit.md`. |
| `… is a built-in kind; rename the file` | Pick a name other than `plan` or `execute`. |
| `Cannot read <path>: …` | Fix permissions or the file path. |
| `<path>: is blank` | Add frontmatter and a body. |
| `<path>: invocation is decided by the workflows directory; remove "invocation"` | Delete the `invocation` key. |
| `<path>: access must be read or write` | Add `access: read` or `access: write`. |
| `<path>: description is required (shown by /worq workflow)` | Add `description: …`. |
| `<path>: add a "Workflow" section with the steps the agent must follow` | Add a non-empty `# Workflow` (or `##`/`###`) section. |
| `<path>: add a "Recursive question" section stating what unresolved decision the run must close` | Add that heading or a `Recursive question: …` line. |
| `<path>: reviewers "<value>" is not a packaged roster (plan, execute)` | Use `plan`, `execute`, or remove the key. |
| `Cannot read <workflows dir>: …` | The directory itself is unreadable; fix permissions or `agentDir`. A missing directory is an empty installation. |

`/worq workflow` with no valid files prints the directory and the required shape. A launch rejected by `limits.agents` reports `at-capacity`; cancel an agent or raise the limit.

## Deferred

- A single overlay that combines the workflow list and instructions field.
- Package-shipped example workflows.
- User-installed reviewer rosters under `<agentDir>/reviewers/<name>`.
- A passive `result-ready` notification instead of the actionable `review-ready`.
- Scheduled runs, workflow chaining, a separate registry, a generic `WorkflowReport` artifact, and automatic merging.
