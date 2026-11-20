# pi-worq

**Worq plans in Pi, writes reports, and independently verifies code changes. No project setup required.**

When one coding session interprets, plans, builds, and reviews a change, its first assumption can carry through to the verdict. Worq gives each phase one recursive question and keeps the user's intended outcome in a shared contract.

## How it works

Each phase repeats its question until no relevant, material and uncertain answer remains, then hands off. Simple requests close fast; hard ones expand into investigation.

| Phase | Recursive question |
| --- | --- |
| Plan | Could another reasonable interpretation change what success means? Then: what unresolved decision could materially change how implementation should proceed? |
| Execute | What consequential work remains before the result is ready for independent verification? |
| Verify | What evidence or counterexample could materially change the acceptance verdict? |

- **Reports and plans:** Plan reads the repository without changing product files. It can save Markdown in the run's private `.agents/artifacts/` folder, or answer a small request directly. These runs end at `REPORT READY` without building or testing anything.
- **Code changes:** Plan describes the outcome, scope, and what Verify might look at in plain language. Execute builds on a separate branch. Verify sees a fresh checkout of the exact candidate commit and decides how to test it. It can run focused tests or direct CLI commands, drive a TUI, or use available local browser tools and save screenshots. It does not generate test scripts or need preset checks.
- **Verdicts:** `PASS` means the Verify agent judged its observations sufficient. `FAIL` means it observed a mismatch; Worq can give Execute up to two repair rounds. `INCONCLUSIVE` means Verify could not establish the result. Worq records the agent's observations and candidate commit; it does not decide whether the observations prove the outcome. Nothing is merged automatically.

When Plan finishes a change plan, Worq runs independent read-only lenses (`pair`, `defeater`, `decision`, `subtraction`). Their findings join Pi's plan review. Pi approves to proceed or revises with the findings Plan should address. Print mode skips lenses because there's no Pi plan review. Turn them off with `/worq --no-lenses <request>` or `worq_start` with `lenses: false`.

## Install

Requires Linux, Pi 1.6.0, Node.js 22.19+, Git at `/usr/bin/git`, and `/usr/bin/python3` for terminal UI verification.

Install from GitHub:

```sh
pi install git:github.com/sij0sh/pi-worq
```

Pi installs the dependencies and loads the bundled prompts. No manual copying or `npm install` needed.

Update or uninstall:

```sh
pi update git:github.com/sij0sh/pi-worq
pi remove git:github.com/sij0sh/pi-worq
```

Uninstalling leaves run records intact.

## Quick start

Run `pi` in your Git repository, then type a request:

```text
/worq Audit how notes are loaded and save a Markdown report
/worq Make loading a note print its contents in uppercase
```

Code changes need a clean, committed baseline. Use coding runs only on projects you trust: Execute and Verify can run local code as your user. Worq manages their processes and uses fresh runtime directories, but it is not a security sandbox. Verify uses a fresh checkout and runtime directories, not the original checkout's ignored files or dependencies. It can use available local tools but won't install missing dependencies or browsers.

That's it. A live rail shows each phase:

```text
◆ worq ─────────────────────────────── round 1/3 · 0:42
  ✓ Plan ━━ ⠹ Execute ── ○ Verify
  ↳ Building in the candidate worktree
```

If Worq needs you, the rail turns to **needs you** — type your answer in Pi's editor and press Enter. Other chat goes to Pi as usual.

Agents send concise `[worq]` reports to main Pi without starting a new turn. Expand a report for observations, artifact paths, and the commit it covers. The same reports are available in status, the control CLI, and print mode.

## Pi as manager

In Pi's interactive mode, the main Pi session manages Worq's agents. Pi has context Worq's agents lack: your conversation and preferences. Pi uses it to catch drift before Verify. Manager approval does not set or override the Verify agent's verdict.

- **Agents ask Pi.** A Plan or Execute agent that is blocked calls `ask_manager`. The question arrives in Pi's chat as a `[worq]` message. Pi answers it, or escalates it to you when it depends on your intent. Without Pi attached, Plan's questions come straight to you.
- **Pi reviews handoffs.** Pi reviews a code change's plan and candidate. Pi approves, requests a revision, or escalates to you.
- **Verify stays independent.** Pi and Execute cannot steer Verify or set its verdict.
- **Talk to agents through Pi.** Say "tell the executor to keep the old flag". Pi uses `worq_send` (steer or follow-up) or `worq_interrupt`.
- **Timeouts.** A question with no answer after 120s tells the agent to decide and record its assumption. A review with no answer after 180s auto-approves. The agent's time budget pauses while it waits. In print mode, nobody manages the run: questions return at once and reviews auto-approve.

Pi's tools: `worq_status`, `worq_agents`, `worq_log`, `worq_send`, `worq_interrupt`, `worq_reply`, `worq_review`, `worq_escalate`, `worq_stop`, `worq_start`.

## Commands

| Command / key | Action |
| --- | --- |
| `/worq` | Write the request in Pi's editor. |
| `/worq status [run-id]` | Inspect contract, plan, lens runs, reports and agents for the current or a saved run. |
| `/worq agents` · `log <agent>` | List agents and open items · show an agent's recent activity. |
| `/worq send <agent> <text>` · `interrupt <agent> <text>` | Steer an agent · abort its turn and redirect it. |
| `/worq reply <q-id> <text>` · `review <g-id> approve\|revise\|escalate [text]` | Answer a question · decide a review yourself. |
| `alt+x`, `/worq stop`, or typing `stop` at a prompt | Cancel the run and wait for its agents to stop. |

### `worq` CLI

Each interactive Pi session opens a control socket at `<state>/ctl/<pid>.sock` (owner-only). From another terminal, use `pi list` to find the installed package directory and run `node /path/to/pi-worq/bin/worq.mjs agents`. Substitute `--help` for the full command list. Pass `--pid N` when several sessions are open. The CLI runs the same operations as Pi's tools.

Print mode waits and reports to stderr:

```sh
pi -p '/worq Make loading a note print its contents in uppercase'
```

## Run records

Worq stores reports and artifacts in `${XDG_STATE_HOME:-$HOME/.local/state}/pi-worq/<run-id>`. Override the state root with `WORQ_STATE_DIR`. Inspect a code candidate with `git show worq/<run-id>`.

Upgrading: `/worq-init`, saved profiles, and `WORQ_PROFILE` no longer drive runs. Existing profile files are left untouched.

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

- Agent keys: `plan`, `execute`, `verify`. An older `journey` entry is used only if `verify` is absent; `route` is ignored.
- SCQ keys match the lens filenames without `.md`: `pair`, `defeater`, `decision`, and `subtraction`.
- Each override inherits any omitted field from the top level. Without a configured primary model, Worq uses Pi's active model. Without a fallback, no model switch occurs.
- A configured fallback can take over once per agent session if the primary fails. It continues within the same session and budget, retaining completed tool results. It does not trigger on cancellation or a normal response that omits submission.
- The file is optional and read at the start of each run. Changes don't affect the main Pi model or runs already in progress.

## Phase prompts

Edit the Markdown files in [`prompts/`](prompts/) in the installed Worq checkout. `verify.md` guides the independent Verify agent. `shared.md` (the common recursive mechanism and manager rules) is appended to every role, and `settle.md` is sent once when an agent stops without submitting. Each `lenses/*.md` (except `reviewer.md`, the shared lens role) can run after a change plan; add or delete files to change lenses.

Worq loads all prompts when you start a run. Edits take effect on the next run without restarting Pi. Missing or blank files prevent the run from starting.

## Development

From a local checkout:

```sh
npm ci
npm run check
npm test
```

Tests use disposable repositories, real CLI and terminal UI interactions, and a local scripted model endpoint.
