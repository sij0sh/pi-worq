# Workflows

A workflow is an operator-installed **skill package** that runs as an agent kind: own SDK session, `delegate`/`ask_main`, rounds, worktree isolation, telemetry, `worq_list`/`worq_send`/`worq_cancel`. Same format and loader (`src/runtime/skills.ts`) as shared skills under `<agentDir>/worq/skills/`.

## Install

```
<agentDir>/workflows/<name>/
  SKILL.md          frontmatter + body (the kind prompt)
  references/…      optional supporting files
  scripts/…
  assets/…
```

- `<agentDir>` is usually `~/.pi/agent`. Folder name = kind name: lowercase letters/digits, hyphen-separated, starts with a letter, not `plan`/`execute`.
- Read **once per extension load**. Restart Pi after adding or editing one.
- Must sit outside a Git checkout. Symlinked folders, dotfiles, `README.md` and loose files are skipped; a flat `<name>.md` is reported (`move to <name>/SKILL.md`).
- A broken folder is a warning (first TUI session start and every `/worq workflow`); valid siblings load.

Example: `docs/examples/foundation/` (read-only audit; capability table in `references/capabilities.md`). Copy it to `<agentDir>/workflows/foundation/`.

## Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `name` | no | Must equal the folder name if present. |
| `description` | yes | Shown in the `/worq workflow` menu and the `worq_spawn` kind list. |
| `disable-model-invocation` | no | `true`: user-only (`/worq workflow`). `false`/absent: also a `worq_spawn` kind, control-socket and CLI kind. |
| `access` | no | `read`: no worktree, result saved as an artifact. Absent or `write`: own worktree, pins `worq/<ref>`. |

Unknown keys are ignored. `reviewers` and `invocation` are rejected. The body has no required sections; the agent also receives the Worq protocol, guard and `submit` tool.

## Supporting files

Files under the folder (depth ≤4, ≤200, dotfiles skipped) are listed in the workflow agent's prompt and read with the `skill` tool: `{ name: "<workflow>", path: "references/x.md" }`. Only listed files, contained (realpath), regular, ≤256KiB, text. Scripts are readable, never executed. Subagents and other roles see only shared skills.

## Launching

| Path | Who | Ref | Task |
|---|---|---|---|
| `/worq workflow` | you; every workflow | `<name>-workflow` | optional instructions, else "Run the `<name>` workflow…" |
| `worq_spawn` / socket / CLI | Main; model-invocable only | from `title` | `task` |

- Menu label: `name · access[ · user-only] · description`. Escape at either step cancels. TUI only; `/worq workflow` takes no arguments.
- A menu launch activates `worq_list`/`worq_send`/`worq_cancel`, never `worq_spawn`, and is honored under `/worq off`.
- `worq_spawn` refuses `mode` and `verify` for workflows, and refuses user-only workflows (`invocation`).

## Lifecycle

- **No reviewers.** Prompt says the result must be self-contained; digest says `No reviewers ran: this result is unverified.`; policy `none (workflow)`.
- Completion is the actionable `review-ready` notice. The workflow stays live until `/worq cancel <ref>` and holds one `limits.agents` slot. `/worq send` starts another round when authorized.
- Read: `PlanReport` saved to `.agents/plans/plan-<ref>.md`, headed `# Workflow result: <title>`.
- Write: `WorkReport`, commit pinned on `worq/<ref>`. Worq never merges; verify before merging by hand.

## Configuration

Workflows are kinds; `roles` keys apply: `agent.<name>` one workflow, `agent` all agents. `limits.rounds`, `asks`, `agentTurns`, `agentMinutes`, `runTurns` apply unchanged.

```json
{ "runtimes": { "deep": { "model": "provider/model", "thinking": "high" } }, "roles": { "agent.foundation": "deep" } }
```

## Problems

| Message | Fix |
|---|---|
| `folder name must be lowercase…` | Rename the folder. |
| `"<name>" is a built-in kind` | Pick another name. |
| `add SKILL.md` | Add the file. |
| `name "<x>" must match the folder name` | Fix `name` or rename. |
| `description is required` | Add `description`. |
| `disable-model-invocation must be true or false` | Fix the value. |
| `access must be read or write (absent = write)` | Fix the value. |
| `workflows run no reviewers; remove "reviewers"` | Delete the key. |
| `use "disable-model-invocation: true" instead of "invocation"` | Replace the key. |
| `SKILL.md body is blank` | Add instructions. |
| `move to <dir>/<name>/SKILL.md` | Convert the old flat file. |
| `symlinked workflows are not followed` | Copy the folder. |
| `Untrusted resource` / `Resource too large` | Keep files inside the folder, ≤256KiB. |
| `Repository resource` / `Cannot read <dir>` | Move `<agentDir>/workflows` out of a checkout / fix permissions. |

## Deferred

- Executing workflow scripts.
- Reviewer support for workflows.
- Hot reload without restart.
