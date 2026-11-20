# pi-worq

**Worq gives Pi users four focused passes over one request, then verifies the outcome through the product itself.**

When one coding session interprets, plans, builds, and reviews a change, its first assumption can carry through to the verdict. Worq gives each phase one question and keeps the user's intended outcome in a shared contract.

## How it works

| Phase | Question |
| --- | --- |
| Orient | What should the user be able to do, and which ambiguity would change that outcome? |
| Plan | What's the smallest change that could deliver it, and what assumption could make that plan wrong? |
| Execute | How do we make the change within the agreed scope? |
| Verify | Can we observe the requested outcome by using the product? |

Plan and Execute can delegate focused jobs. A fresh verifier selects a journey from your profile using the original request and contract. Worq runs it on the exact candidate commit and checks what the user sees. A syntax check can pass while opening a note still prints the wrong text.

## Install

Requires Linux, Pi 1.6.0, Node.js 22.19+, Git at `/usr/bin/git`, and `/usr/bin/python3` for terminal UI verification.

From your local `pi-worq` checkout, install dependencies and register the package with Pi:

```sh
npm ci
pi install "$PWD"
```

To update, refresh the checkout and rerun `npm ci`. To remove the package, run `pi remove "$PWD"` from the same directory.

## Quick start

Adapt the [CLI profile](examples/cli-profile.json) or [terminal UI profile](examples/tui-profile.json) for a trusted Git project with a clean committed baseline. Set `repository` to its absolute path. Save the profile outside the repository in a file you own (mode `0600`). Use code and build commands you trust to run under your account.

From the target project:

```sh
WORQ_PROFILE="$HOME/.config/pi-worq/my-project.json" pi
```

In Pi, request an outcome covered by your profile. For the example CLI profile:

```text
/worq Make loading a note print its contents in uppercase
```

The widget starts in Orient. Open `/worq status` and select **Verify evidence** to compare expected and observed results. The example checks for `HELLO, WORLD!` and exit status `0`.

## Use

| Command | Action |
| --- | --- |
| `/worq [request]` | Start in the background. Run `/worq` on its own to enter a request in Pi's editor. |
| `/worq status [run-id]` | Inspect the current or saved run. Use arrows and Enter to navigate, Esc to go back. |
| `/worq answer [answer]` | Answer a clarification or approval prompt. |
| `/worq stop` | Cancel the run and wait for its jobs to stop. |

Print mode waits and reports to stderr:

```sh
WORQ_PROFILE="$HOME/.config/pi-worq/my-project.json" pi -p '/worq Make loading a note print its contents in uppercase'
```

## Profiles and records

In your profile, `entry` names the staged executable or script, `checks` defines the acceptance journeys, and `devChecks` lists development commands. `orientModel` optionally selects a model from Pi's registry. Use data suitable for your model providers.

Worq stores run records and verification receipts in `${XDG_STATE_HOME:-$HOME/.local/state}/pi-worq`. Override with `WORQ_STATE_DIR`. Inspect the candidate with `git show worq/<run-id>`.

## Phase prompts

Edit the Markdown files in [`prompts/`](prompts/) in the installed Worq checkout. Verify uses `verify-journey.md` to select a journey and `verify-route.md` to classify a mismatch. `worker.md` guides delegated jobs, and `shared.md` is appended to the SDK role prompts.

Worq loads all prompts when you start a run. Edits take effect on the next run without restarting Pi. Keep `{{ORIENT_SCHEMA}}` in `orient.md`; Worq replaces it with the current JSON schema. Missing or blank files prevent the run from starting.

## Development

```sh
npm run check
npm test
```

Tests use disposable repositories, real CLI and terminal UI interactions, and a local scripted model endpoint.
