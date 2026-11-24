# Workflows

A workflow is an operator-installed **skill package** that runs as an agent kind: own SDK session, `delegate`/`ask_main`, terminal handoff, worktree isolation, telemetry, `worq_list`/`worq_send`/`worq_cancel`. Same format and loader (`src/runtime/skills.ts`) as shared skills under `<agentDir>/worq/skills/`.

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
| `review` | no | `true`: one independent review per submission. Absent/`false`: none. |

Unknown keys are ignored. Built-in kinds (`prompts/kinds/*.md`) use the same profile keys. The body has no required sections; the agent also receives the Worq protocol, guard and `submit` tool.

## Supporting files

Files under the folder (depth ≤4, ≤200, dotfiles skipped) are listed in the workflow agent's prompt and read with the `skill` tool: `{ name: "<workflow>", path: "references/x.md" }`. Only listed files, contained (realpath), regular, ≤256KiB, text. Scripts are readable, never executed. Subagents and other roles see only shared skills.

## Launching

| Path | Who | Ref | Task |
|---|---|---|---|
| `/worq workflow` | you; every workflow | `<name>-workflow` | optional instructions, else "Run the `<name>` workflow…" |
| `worq_spawn` / socket / CLI | Main; model-invocable only | from `title` | `task` |

- Menu label: `name · access[ · user-only] · description`. Escape at either step cancels. TUI only; `/worq workflow` takes no arguments.
- A menu launch activates `worq_list`/`worq_send`/`worq_cancel`, never `worq_spawn`, and is honored under `/worq off`.
- `worq_spawn` refuses `verify` for unreviewed workflows, and refuses user-only workflows (`invocation`).

## Lifecycle

- **Review only with `review: true`.** Otherwise the prompt says the result must be self-contained and the digest says `unreviewed`.
- Submission parks the agent (session and worktree kept, slot released); Main resumes it with `worq_send` or closes it with `worq_cancel`.
- Read: `Submission` (`summary`, Markdown `report`) saved to `.agents/plans/plan-<ref>.md`, headed `# Workflow result: <title>`.
- Write: commit pinned on `worq/<ref>`. Worq never merges; verify before merging by hand.

## Configuration

Workflows start with the current Pi session's model and thinking level. Use the launch picker to override a single launch. `limits.asks`, `agentTurns`, `agentMinutes`, `idleMinutes` apply unchanged.

## Problems

| Message | Fix |
|---|---|
| `folder name must be lowercase…` | Rename the folder. |
| `"<name>" is a built-in kind` | Pick another name. |
| `add SKILL.md` | Add the file. |
| `name "<x>" must match the folder name` | Fix `name` or rename. |
| `description is required` | Add `description`. |
| `disable-model-invocation must be true or false` | Fix the value. |
| `access must be read or write` | Fix the value. |
| `review must be true or false` | Fix the value. |
| `SKILL.md body is blank` | Add instructions. |
| `move to <dir>/<name>/SKILL.md` | Convert the old flat file. |
| `symlinked workflows are not followed` | Copy the folder. |
| `Untrusted resource` / `Resource too large` | Keep files inside the folder, ≤256KiB. |
| `Repository resource` / `Cannot read <dir>` | Move `<agentDir>/workflows` out of a checkout / fix permissions. |

## Deferred

- Executing workflow scripts.
- Reviewer support for workflows.
- Hot reload without restart.
