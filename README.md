# pi-worq

**Worq gives Pi users three focused passes over one request, then verifies the outcome through the product itself.**

When one coding session interprets, plans, builds, and reviews a change, its first assumption can carry through to the verdict. Worq gives each phase one recursive question and keeps the user's intended outcome in a shared contract.

## How it works

Each phase repeats its question until no relevant, material and uncertain answer remains, then hands off. Simple requests close fast; hard ones expand into investigation.

| Phase | Recursive question |
| --- | --- |
| Plan | Could another reasonable interpretation change what success means? Then: what unresolved decision could materially change how implementation should proceed? |
| Execute | What consequential work remains before the result is ready for independent verification? |
| Verify | What evidence or counterexample could materially change the acceptance verdict? |

Plan frames contract C: your request verbatim plus outcome, criteria bound to profile checks, boundaries and assumptions. C scopes Execute and Verify.

When Plan finishes, Worq fires lens SCQs on its own: independent read-only agents that see only your request and Plan's final contract and approach (`pair`, `defeater`, `decision`, `subtraction`). Their findings join Pi's plan review. Pi approves to discard them as overfitted, or revises to reopen Plan with a copy of them. Lenses need a Pi plan review, so print mode and `review: "asks-only"`/`"off"` skip them. Turn them off with `/worq --no-lenses <request>` or `worq_start` `lenses: false`. A fresh verifier selects a journey from your profile using the contract. Worq runs it on the exact candidate commit and checks what the user sees. A syntax check can pass while opening a note still prints the wrong text.

## Install

Requires Linux, Pi 1.6.0, Node.js 22.19+, Git at `/usr/bin/git`, and `/usr/bin/python3` for terminal UI verification.

Install from GitHub:

```sh
pi install git:github.com/sij0sh/pi-worq
```

Pi installs the dependencies and loads the bundled prompts and profile templates. No manual copying or `npm install` needed.

Update or uninstall:

```sh
pi update git:github.com/sij0sh/pi-worq
pi remove git:github.com/sij0sh/pi-worq
```

Uninstalling leaves your profiles and run records intact.

## Quick start

1. Run `pi` from your project (with a clean, committed Git baseline).
2. Run `/worq-init cli` for a command-line app or `/worq-init tui` for a terminal UI. Edit the prefilled profile for your app and submit it only if you trust the commands and project code. Worq fills in the repository path and saves the profile outside the project for you.
3. Start a run. For example:

```text
/worq Make loading a note print its contents in uppercase
```

That's it. A live rail shows each phase:

```text
◆ worq ─────────────────────────────── round 1/3 · 0:42
  ✓ Plan ━━ ⠹ Execute ── ○ Verify
  ↳ Building in the candidate worktree
```

If Worq needs you, the rail turns to **needs you** — just type your answer in Pi's editor and press Enter. For a changed contract, `y` approves; anything else is the change you want. Other chat goes to Pi as usual.

The result lands in the conversation as one line (expand for evidence and paths).

## Pi as manager

In Pi's interactive mode, the main Pi session manages Worq's agents. Pi has context Worq's agents lack: your conversation and preferences. Pi uses it to catch drift before a costly Verify round. Pi is never the verifier: only host-observed checks can PASS.

- **Agents ask Pi.** A Plan or Execute agent that is blocked calls `ask_manager`. The question arrives in Pi's chat as a `[worq]` message. Pi answers it, or escalates it to you when it depends on your intent. Without Pi attached, Plan's questions come straight to you.
- **Pi reviews handoffs.** Pi reviews the plan (contract and approach), the candidate before Verify, and the route after a mismatch. Pi approves, revises once per round, or escalates to you. Pi sees only the sanitized mismatch reason, never private fixtures. A contract change after an intent mismatch always needs your approval.
- **Verify stays independent.** Pi cannot steer journey selection or the verdict.
- **Talk to agents through Pi.** Say "tell the executor to keep the old flag". Pi uses `worq_send` (steer or follow-up) or `worq_interrupt`.
- **Timeouts.** A question with no answer after 120s tells the agent to decide and record its assumption. A review with no answer after 180s auto-approves. The agent's time budget pauses while it waits. In print mode, nobody manages the run: questions return at once and reviews auto-approve.

Pi's tools: `worq_status`, `worq_agents`, `worq_log`, `worq_send`, `worq_interrupt`, `worq_reply`, `worq_review`, `worq_escalate`, `worq_stop`, `worq_start`.

Set `"manager": { "review": "gates" | "asks-only" | "off", "askSeconds": 120, "gateSeconds": 180 }` in your profile (default `gates`).

## Commands

| Command / key | Action |
| --- | --- |
| `/worq-init cli\|tui` | Create a verification profile for the current project. |
| `/worq` | Write the request in Pi's editor. |
| `/worq status [run-id]` | Inspect contract, plan, lens runs, evidence and agents for the current or a saved run. |
| `/worq agents` · `log <agent>` | List agents and open items · show an agent's recent activity. |
| `/worq send <agent> <text>` · `interrupt <agent> <text>` | Steer an agent · abort its turn and redirect it. |
| `/worq reply <q-id> <text>` · `review <g-id> approve\|revise\|escalate [text]` | Answer a question · decide a review yourself. |
| `alt+x`, `/worq stop`, or typing `stop` at a prompt | Cancel the run and wait for its agents to stop. |

### `worq` CLI

Each interactive Pi session opens a control socket at `<state>/ctl/<pid>.sock` (owner-only). From another terminal, use `pi list` to find the installed package directory and run `node /path/to/pi-worq/bin/worq.mjs agents`. Substitute `--help` for the full command list. Pass `--pid N` when several sessions are open. The CLI runs the same operations as Pi's tools.

`WORQ_PROFILE=/abs/path.json` overrides profile discovery (`$XDG_CONFIG_HOME/pi-worq/profiles/*.json`, matched by `repository`).

Print mode waits and reports to stderr:

```sh
pi -p '/worq Make loading a note print its contents in uppercase'
```

## Profiles and records

In your profile, `entry` names the staged executable or script, `checks` defines the acceptance journeys, and `devChecks` lists development commands. Use data suitable for your model providers.

Worq stores run records and verification receipts in `${XDG_STATE_HOME:-$HOME/.local/state}/pi-worq`. Override with `WORQ_STATE_DIR`. Inspect the candidate with `git show worq/<run-id>`.

## Agent and SCQ models

Edit `~/.pi/agent/pi-worq.json` (or `$PI_CODING_AGENT_DIR/pi-worq.json`). Use exact `provider/model-id` references from Pi's model catalog, with credentials configured in Pi. Replace the example references with your own:

```json
{
  "model": "my-provider/default-model",
  "fallbackModel": "my-provider/backup-model",
  "agents": {
    "plan": { "model": "my-provider/planning-model" },
    "execute": { "fallbackModel": "my-provider/coding-backup" }
  },
  "scq": {
    "defeater": { "model": "my-provider/review-model" }
  }
}
```

- Agent keys: `plan`, `execute`, `journey` (Verify journey), and `route` (Verify mismatch routing).
- SCQ keys match the lens filenames without `.md`: `pair`, `defeater`, `decision`, and `subtraction`.
- Each override inherits any omitted field from the top level. Without a configured primary model, Worq uses Pi's active model. Without a fallback, no model switch occurs.
- A configured fallback can take over once per agent session if the primary fails. It continues within the same session and budget, retaining completed tool results. It does not trigger on cancellation or a normal response that omits submission.
- The file is optional and read at the start of each run. Changes don't affect the main Pi model or runs already in progress.

## Phase prompts

Edit the Markdown files in [`prompts/`](prompts/) in the installed Worq checkout. Verify uses `verify-journey.md` to select a journey and `verify-route.md` to classify a mismatch. `shared.md` (the common recursive mechanism and manager rules) is appended to every role, and `settle.md` is sent once when an agent stops without submitting. Each `lenses/*.md` (except `reviewer.md`, the shared lens role) runs after every Plan; add or delete files to change lenses.

Worq loads all prompts when you start a run. Edits take effect on the next run without restarting Pi. Missing or blank files prevent the run from starting.

## Development

From a local checkout:

```sh
npm ci
npm run check
npm test
```

Tests use disposable repositories, real CLI and terminal UI interactions, and a local scripted model endpoint.
