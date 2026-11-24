# Agent packages

Every agent kind is an operator-installed **skill package**: own SDK session, `delegate`/`ask_main`, worktree isolation (write), telemetry, `worq_list`/`worq_send`/`worq_cancel`. Same format and loader (`src/runtime/skills.ts`) as shared skills under `<agentDir>/worq/skills/`. Adding one needs no Worq code.

## Install

```
<agentDir>/workflows/<name>/
  SKILL.md          frontmatter + body (the kind prompt)
  references/…      optional supporting files
  scripts/…
  assets/…
```

- `<agentDir>` is usually `~/.pi/agent`. Folder name = kind name: lowercase letters/digits, hyphen-separated, starts with a letter. No reserved names.
- Read **once per extension load**. Restart Pi after adding or editing one.
- Must sit outside a Git checkout. Symlinked folders, dotfiles, `README.md` and loose files are skipped; a flat `<name>.md` is reported (`move to <name>/SKILL.md`).
- A broken folder is a warning (first TUI session start and every `/worq`); valid siblings load.

Example: `docs/examples/foundation/` (read-only audit; capability table in `references/capabilities.md`). Copy it to `<agentDir>/workflows/foundation/`.

## Shipped packages

`plan` (read, reviewed) and `execute` (write, reviewed) ship in this package's `workflows/` and are copied into `<agentDir>/workflows/` on first use, then marked done (`.worq-seeded`). Worq never seeds that profile again or overwrites anything: edit, delete or replace them freely; deleting the whole `workflows/` folder reseeds.

- A pre-existing **different** `plan`/`execute` folder at first use is withheld (warning) and the profile is not marked done. Move it aside and restart Pi to install the shipped one, then replace that folder deliberately if you want yours.
- Unwritable profile: warning; copy `workflows/<name>/` by hand. Controls keep working.
- No built-in fallback: with no packages, `/worq` says so and `worq_spawn` lists none.

## Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `name` | no | Must equal the folder name if present. |
| `description` | yes | Shown in the `/worq` menu and the `worq_spawn` kind list. |
| `disable-model-invocation` | no | `true`: user-only (`/worq`); refused from `worq_spawn`, socket and CLI. `false`/absent: also launchable by Main and the CLI. |
| `access` | no | `read`: no worktree or write/process tools, result saved as a plan file. Absent or `write`: own clean-baseline worktree, pins `worq/<ref>`. |

Unknown keys are ignored, including a legacy `review`: every agent gets exactly one review. The body has no required sections; the agent also receives the Worq protocol and `submit` tool.

## Supporting files

Files under the folder (depth ≤4, ≤200, dotfiles skipped) are listed in the agent's prompt and read with the `skill` tool: `{ name: "<package>", path: "references/x.md" }`. Only listed files, contained (realpath), regular, ≤256KiB, text. Scripts are readable, never executed. Subagents and other roles see only shared skills.

## Launching

| Path | Who | Packages | Runtime |
|---|---|---|---|
| `/worq` (TUI) | you | all | runtime step, explicit Enter |
| `worq_spawn` / socket / `worq spawn` | Main, CLI | model-invocable | request fields, else Main's |

- Same payload everywhere: `kind`, optional `task` (omitted: "Run the `<name>` workflow…"), `title` (omitted: first task words, else `<name> run`), `attach`, `sdk`, `model`, `thinking`.
- `/worq`: menu `name · access[ · user-only] · description` → optional instructions → runtime. Esc at any step changes nothing. Success activates all four Main tools before the agent starts.
- `verify:false` is refused.

## Lifecycle

- **One review.** The first submission gets one independent review, then the agent parks (session and worktree kept, slot released).
- Main accepts with `worq_cancel`, or sends filtered feedback once with `worq_send`. The agent revises, submits its final result without another review, and ends as `done` (worktree removed, branch/plan kept).
- Out of budget: parks unreviewed; `worq_send` resumes the same phase with a fresh budget.
- Read: `Submission` (`summary`, Markdown `report`) saved to `.agents/plans/plan-<ref>.md`, headed `# Plan: <title>`.
- Write: commit pinned on `worq/<ref>`; the review checks a fresh clone of that exact SHA. The final revision's commit is not re-reviewed. Worq never merges; verify before merging by hand.

## Problems

| Message | Fix |
|---|---|
| `folder name must be lowercase…` | Rename the folder. |
| `add SKILL.md` | Add the file. |
| `name "<x>" must match the folder name` | Fix `name` or rename. |
| `description is required` | Add `description`. |
| `disable-model-invocation must be true or false` | Fix the value. |
| `access must be read or write` | Fix the value. |
| `review must be true or false` | Fix the value. |
| `SKILL.md body is blank` | Add instructions. |
| `move to <dir>/<name>/SKILL.md` | Convert the old flat file. |
| `symlinked workflows are not followed` | Copy the folder. |
| `differs from the shipped "<name>" package` | Move it aside, restart, then replace deliberately. |
| `Default packages not installed` | Fix permissions or copy by hand. |
| `Untrusted resource` / `Resource too large` | Keep files inside the folder, ≤256KiB. |
| `Repository resource` / `Cannot read <dir>` | Move `<agentDir>/workflows` out of a checkout / fix permissions. |

## Deferred

- Executing package scripts.
- Hot reload without restart.
