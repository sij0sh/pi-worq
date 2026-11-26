# Agent packages

Every agent kind is an operator-installed **skill package**: own SDK session, `ask_main`, worktree isolation (write), telemetry, `worq_list`/`worq_send`/`worq_cancel`. Same format and loader (`src/runtime/skills.ts`) as shared skills under `<agentDir>/worq/skills/`. Adding one needs no Worq code.

## Install

```
<agentDir>/workflows/<name>/
  SKILL.md          frontmatter + body (the kind prompt)
  PQ.md             optional: enables delegate; child instructions
  REVIEW.md         optional: first-submission review instructions (opt-in)
  EDIT.md           optional (write kinds only): enables delegate_edit; edit worker instructions
  gates.json        optional (write kinds only): deterministic pre-submit commands
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

`plan` (read, reviewed), `execute` (write, reviewed) and `scout` (read, inline, unreviewed, `asks: 0`) ship in this package's `workflows/` and are copied into `<agentDir>/workflows/` on first use, then marked done (`.worq-seeded`). Worq never seeds that profile again or overwrites anything: edit, delete or replace them freely; deleting the whole `workflows/` folder reseeds. Existing seeded installs can copy `workflows/scout/` into `<agentDir>/workflows/scout/` once manually.

- A pre-existing **different** `plan`/`execute` folder at first use is withheld (warning) and the profile is not marked done. Move it aside and restart Pi to install the shipped one, then replace that folder deliberately if you want yours.
- Unwritable profile: warning; copy `workflows/<name>/` by hand. Controls keep working.
- No built-in fallback: with no packages, `/worq` says so and `worq_spawn` lists none.

**Before upgrading:** Installed packages are not updated. Without `REVIEW.md` their submissions finish `done` by design; without `PQ.md` they lose delegation. Back up `<agentDir>/workflows`, diff each installed package against the extension’s shipped `workflows/`, then copy the desired stock files or merge the instructions into your customized packages. Install review instructions for every custom workflow requiring independent review. Reload Pi.

## Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `name` | no | Must equal the folder name if present. |
| `description` | yes | Shown in the `/worq` menu and the `worq_spawn` kind list. |
| `disable-model-invocation` | no | `true`: user-only (`/worq`); refused from `worq_spawn`, socket and CLI. `false`/absent: also launchable by Main and the CLI. |
| `access` | no | `read`: no worktree or write/process tools, result saved as a plan file (or returned inline). Absent or `write`: own clean-baseline worktree, pins `worq/<ref>`. |
| `output` | no | Read kinds only. `plan` (default): writes `.agents/plans/plan-<ref>.md`. `inline`: returns cited summary directly without touching the repo; attachable by `ref` in the same session. |
| `explore` | no | Deterministic baseline snapshot placed right after the authority preamble (before the skill body and writePaths) so every kind shares one cached prefix per repo state. `map` (default): Tier 2 symbol map or Tier 3 skeleton (never full inline). `auto` (read kinds only): Tier 1 inline source (`<= 40 KB` & `<= 40` source files), Tier 2 symbol map (`<= 1.5 MB` & `<= 600` source files), or Tier 3 structural skeleton. `none`: off. Shipped: `scout` uses `auto`; `plan`, `execute` use the default. |
| `max-turns` | no | Optional integer (`1..400`) clamping `limits.agentTurns` downward only. |
| `max-minutes` | no | Optional integer (`1..600`) clamping `limits.agentMinutes` downward only. |
| `asks` | no | Optional integer (`0..20`) clamping `limits.asks` downward only. `0` removes `ask_main` from the agent's tool list. |

Unknown keys are ignored, including a legacy `review`. The body has no required sections; the agent also receives the `submit` tool.

## Supporting files

Files under the folder (depth ≤4, ≤200, dotfiles skipped) are listed in the agent's prompt and read with the `skill` tool: `{ name: "<package>", path: "references/x.md" }`. Only listed files, contained (realpath), regular, ≤256KiB, text. Scripts are readable, never executed. Subagents and other roles see only shared skills.

## Launching

| Path | Who | Packages | Runtime |
|---|---|---|---|
| `/worq` (TUI) | you | all | runtime step, explicit Enter |
| `worq_spawn` / socket / `worq spawn` | Main, CLI | model-invocable | request fields, else Main's |

- Same payload everywhere: `kind`, optional `task` (omitted: "Run the `<name>` workflow…"), `title` (omitted: first task words, else `<name> run`), `attach`, `sdk`, `model`, `thinking`.
- `/worq`: package and access → optional instructions (Ctrl+V or right-click pastes the clipboard) → runtime. Esc at any step changes nothing.
- `verify:false` is refused.

## Pre-submit gates

`gates.json` (and the `worq_spawn` `gates` field) is a JSON array of 1–4 gates:

```json
[{ "name": "tests", "executable": "node", "args": ["--test"], "timeoutSeconds": 120 }]
```

`executable` and `args` are required; `name` (≤48 chars), `independent` and `timeoutSeconds` (5–300, default 120) are optional.

Commands and gates inherit Worq's trusted PATH prefix plus existing absolute host bin directories outside the checkouts and `.git`. `VIRTUAL_ENV` is forwarded if set; HOME and temp remain isolated. Internal Git uses its separate strict environment. Use an explicit executable path for checkout-local commands (on Windows the launcher supports `.exe`, not batch shims).

All configured executables are checked before any gate launches. Package gates precede launch gates. By default gates run in declaration order. Set `"independent": true` on adjacent gates only when they are read-only and safe to overlap (no shared state, cache or port contention and no dependency on each other's output). This is an operator assertion, not a sandbox: unmarked gates remain ordering barriers, and a failure stops and drains the batch before returning.

## Lifecycle

- **One review.** With `REVIEW.md`, the first submission gets one independent review, then the agent parks (session and worktree kept, slot released).
- Main accepts with `worq_cancel`, or sends filtered feedback once with `worq_send`. The agent revises, submits its final result without another review, and ends as `done` (worktree removed, branch/plan kept).
- Remove `REVIEW.md` from a provisioned package to opt out of review. The submission ends as `done`, with no substitute reviewer needed.

## Edit waves (`EDIT.md`)

Contract-first parallel edits inside one write agent. Main still sees one branch, one candidate, one review.

1. Parent applies shared types/interfaces/exports, then calls `delegate_edit` per slice (`task`, `writePaths`, optional `name`, `context`, `fork`) in one turn.
2. First call pins the parent worktree (`edit wave N base`). Each worker gets a detached worktree from that commit (`<state>/<ref>/edits/<id>/work`), dependencies linked.
3. Workers edit only within both their `writePaths` and the parent's (edit + submit audit), run slice-local checks, submit; Worq commits each slice. Parent writes and `run_command` are fenced; `submit` refuses while workers are open.
4. When all settle: `git merge-tree` accumulates clean slices onto the base, `commit-tree` + `merge --ff-only` lands one commit on `worq/<ref>`, worktrees are removed, and the parent wakes once with `[EDIT WAVE N]` (per-slice status, diffstat, conflict/partial SHAs to cherry-pick).
5. Parent fixes glue, runs the full gates once, submits (one review if `REVIEW.md`).

- Guards: slices in one wave must be disjoint (`scope-conflict`); slices must overlap the parent's own `writePaths`; `limits.edits` workers per agent (`edit-limit`); a failed slice never blocks clean siblings.
- `fork: true` (contextFork harnesses): worker continues the parent's context with its tool definitions rebound to the worker's worktree; other handlers refuse. Else fresh session with `EDIT.md` + slice + attached plans.
- Runtime: owner's, plus `routing.json` roles `edit`, `<kind>.edit[.<name>]` (forks keep the parent's model). Budgets: `limits.editTurns` / `editMinutes`.
- Delete `EDIT.md` to disable. `record.json`: `editWaves[]` (base, integrated, workers with state, sha, forked).
- Out of budget: parks unreviewed; `worq_send` resumes the same phase with a fresh budget.
- Read: `Submission` (`summary`, Markdown `report`) saved to `.agents/plans/plan-<ref>.md`, headed `# Plan: <title>`.
- Write: commit pinned on `worq/<ref>`; the review checks a fresh clone of that exact SHA. The final revision's commit is not re-reviewed. Worq never merges; verify before merging by hand.

## Run timings

`worq_list(ref)` and `record.json` report owner timing in both interactive and headless runs. `submittedAt` is the first durable submission; park/resume timestamps are the latest of each, and `parkedMs` is cumulative. Review time includes the review session's setup and teardown. Owner model and tool counts exclude child review and PQ sessions.

Measured work excludes requester waits, review, parked time, and unmeasured overhead. Known requester waits never count as work, even during a model response. Remaining overlap is attributed once (model, gates, then tools): `workModelMs`, `activeGateMs`, and `workToolMs`. Observed `activeModelMs` and `waitMainMs` retain their full intervals; `toolMs` sums individual tool durations and `gateMs` sums individual gate attempts, including failures. Do not add the observed totals to estimate wall time. Model time measures observed assistant-message intervals, not provider-side latency; an interrupted stream ends at observed prompt settlement if it has no end event. Cache tokens are only summed when reported, and the ratio is unavailable when the SDK omits usage needed to compute it.

## Problems

| Message | Fix |
|---|---|
| `folder name must be lowercase…` | Rename the folder. |
| `add SKILL.md` | Add the file. |
| `name "<x>" must match the folder name` | Fix `name` or rename. |
| `description is required` | Add `description`. |
| `disable-model-invocation must be true or false` | Fix the value. |
| `access must be read or write` | Fix the value. |
| `explore must be auto, map or none` | Fix the value. |
| `explore: auto is only valid when access is read (use map or none)` | Use `map` or `none` on write kinds. |
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
