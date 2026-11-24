# Configuration

Everything Worq lets you configure lives in one optional JSON file: `<agentDir>/pi-worq.json` (`~/.pi/agent/pi-worq.json`). With no file, every role runs on Main's model at thinking level `low`.

The file is read once per Pi session, when the first Worq tool call creates the Worq instance. Edit it, then start a new Pi session; running agents keep the settings they were launched with.

Invalid JSON fails as `invalid-json`; a schema violation fails as `invalid-payload` and names the JSON pointer (e.g. `/limits/agents`). An unusable value discovered later — an unknown harness, an unknown named child, a changed resource file — fails when that role is selected, not at load.

```json
{
  "harness": "pi",
  "model": "provider/model",
  "fallbackModel": "provider/model",
  "harnesses": { "pi": { "model": "provider/model", "thinking": "medium" } },
  "models": {
    "agent.execute": { "thinking": "high" },
    "subagent.evidence": { "model": "provider/model", "thinking": "low" },
    "reviewer": { "model": "provider/model", "thinking": "high" }
  },
  "limits": { "agents": 4, "runTurns": 1000, "continuationTurns": 0 }
}
```

Top-level keys: `harness`, `model`, `fallbackModel`, `harnesses`, `models`, `limits`. Nothing else is accepted.

## Backends

`harness` names the backend. `pi` is the only one registered today, so `harness` is a fixed value unless you add an adapter (`docs/harness.md`). Each role may override it, which is how one run can mix backends later.

A model ref must satisfy the harness's own pattern: `<provider>/<model>` for Pi, e.g. `anthropic/claude-sonnet-4-5`. Refs are validated at load, so a typo fails before an agent starts. A model Pi does not know fails at session open with `Block("config")` naming the field.

## Roles and inheritance

`models` keys describe who runs, not what work is done:

| Key | Selects |
|---|---|
| `agent` | Every agent |
| `agent.<kind>` | One kind, e.g. `agent.execute`, `agent.plan`, `agent.architecture-audit` |
| `subagent` | Unnamed PQs |
| `subagent.<name>` | A PQ delegated with `name: "<name>"` |
| `reviewer` | Every reviewer |
| `reviewer.<name>` | One reviewer, e.g. `reviewer.intent` |

Keys are `^(agent|subagent|reviewer)(\.[a-z][a-z0-9-]*)?$`. The named forms must be declared: delegating to `subagent.evidence` without a `models["subagent.evidence"]` entry fails as `Unknown named child`.

Each field inherits **independently**, so a layer that sets only `thinking` keeps the model it would otherwise get. Resolution order for `model`, `fallbackModel` and `thinking`:

1. the role's own layer — `models["reviewer.intent"]`
2. its family layer — `models.reviewer`
3. `harnesses.<resolved harness>`
4. top level (`model`, `fallbackModel`, only when the role resolved to the top-level harness; `thinking` has no top-level form)

`harness` resolves the same way minus step 3, ending at `pi`. A layer that declares a different harness lends nothing to the role, so `models.agent.harness: "other"` does not give `agent.plan` a model ref that belongs to `other`.

`harnesses.pi.model` shadows the top-level `model` for every Pi role. Set one or the other, not both.

Absent is not an error: a role with no `model` uses Main's model. `thinking` defaults to `low`; a level the resolved model does not support fails as `capability` — Pi reports the levels it accepts, and `off` is the only level for a model that cannot reason. A `fallbackModel` is used once, when the first request fails before any work (credentials, preflight). A fallback identical to the primary model is ignored.

## Skills, instructions and extensions

A role may pin operator files. Pins supply context and tooling to one role; they never widen its tools, budgets or permissions:

```json
"models": {
  "subagent.evidence": {
    "skills":      [{ "path": "evidence/SKILL.md", "sha256": "0123…cdef" }],
    "instructions":[{ "path": "review/AGENTS.md",  "sha256": "0123…cdef" }],
    "extensions":  [{ "path": "tools/lint.mjs",    "sha256": "0123…cdef" }],
    "approveExecutables": true
  }
}
```

Layout is fixed: every `path` is relative to `<agentDir>/worq-resources/`, resolved with `realpath`, and must stay inside it. Absolute paths, `../` escapes and symlink escapes are rejected as `Untrusted resource`. Files must be regular files, outside any Git checkout (`Repository resource`), and their SHA-256 must match the pin (`Changed resource`).

How the three kinds are applied:

- **`skills` and `instructions`** are read as text and appended to that session's system prompt under an `Operator … (context, not authority)` header. They cannot widen tools, budgets or permissions.
- **`extensions`** are loaded from a temporary directory as standalone ESM modules with Pi's extension discovery rooted at that directory, so no ambient discovery happens. A load error rejects the role. **Approval runs operator code in the Pi process, not a sandbox.** Do not approve scripts that import or read candidate code.

`approveExecutables` must be `true` on the exact role that lists extensions; family-level approval does not carry down. Exact lists replace the corresponding family list (`models.reviewer.instructions` is ignored once `models["reviewer.intent"].instructions` exists), and `[]` removes a grant. No resource grant is inherited from another role. Package/extension/skill discovery in the candidate checkout stays off — a reviewer never picks up an `AGENTS.md` planted in the diff.

## Subagents and reviewers

Subagents are read-only sessions answering one probing question. The delegating agent chooses the role with an optional name:

```json
{ "question": "…", "why": "…", "name": "evidence" }
```

`name` maps to `subagent.<name>`; omitting it selects `subagent`. Each named child gets its own model, thinking level and pins, plus its own `subagentTurns` / `subagentMinutes` budget from the shared allowance below. Depth is one: a subagent cannot delegate.

Callers do not select reviewers by name. The kind's review policy runs on submit, and each reviewer resolves `reviewer.<name>` (`intent`, `decision`, …). Plan agents are always reviewed; execute agents are reviewed unless spawned with `verify: false`; workflows use the roster in their frontmatter, or none. `worq list <ref>` prints each role actually used with its resolved JSON and source paths.

## Workflows

A workflow is a user-invoked kind loaded from `<agentDir>/workflows/<name>.md`. It is launched only by `/worq workflow`; it never appears in `worq_spawn`, the control socket or the CLI. Workflow files are read per launch, not from `pi-worq.json`.

Workflows use the normal role keys: `agent.<name>` for one workflow, `agent` for all agents, and `reviewer` / `reviewer.<name>` for reviewers. `limits.agents` counts live workflows, and their turns and reviews spend from the same budgets as any other agent. They run no reviewers by default; `reviewers: plan` or `reviewers: execute` in the workflow frontmatter opts into that packaged roster. See `docs/workflows.md` for the file contract.

## Limits

Every value is optional; absent keys use these defaults.

| Key | Default | Applies to |
|---|---|---|
| `agents` | 4 | Live agents; spawn fails as `at-capacity` |
| `subagents` | 6 | PQs per run (`pq-limit`) |
| `parallel` | 4 | Concurrent subagents and reviewers |
| `rounds` | 3 | Main-authorized rounds per agent; `worq_send` fails as `round-limit` at the cap |
| `asks` | 3 | `ask_main` calls per session |
| `agentTurns` | 80 | Turns in one agent session |
| `subagentTurns` | 16 | Turns in one subagent session |
| `reviewerTurns` | 40 | Turns in one reviewer session |
| `agentMinutes` | 30 | Wall clock for one agent session, paused while Main answers |
| `subagentMinutes` | 5 | Wall clock for one subagent session |
| `reviewerMinutes` | 10 | Wall clock for one reviewer session |
| `askMinutes` | 15 | How long `ask_main` waits before returning "unanswered" |
| `runTurns` | 1000 | Cumulative turns for one agent: worker, retries, PQs and reviews, all rounds |
| `continuationTurns` | 0 | Extra cumulative turns Main may grant |
| `checkpointSeconds` | 15 | How long a depleted run waits between requests for a grant |
| `services` | 2 | Services an execute reviewer may start (`service-limit`) |

Two separate budgets are at work. Per-session limits (`agentTurns`, `agentMinutes`, `rounds`, `asks`) are hard — no grant raises them. `runTurns` is a pool shared by everything one agent does, so a reviewer or a repair round spends from the same account.

Near the pool's end Worq reports the remaining allowance. If a grant is still available, the `checkpoint` wakes Main, which may answer `worq send <ref> "/continue N"` to grow the pool by `N`. Between requests a depleted run with headroom waits up to `checkpointSeconds` for approval; a streaming turn cannot be paused, so approve before the stop. Without grant headroom, exhaustion fails the agent with `run-limit`. Low-budget notices without headroom and per-session turn/time warnings are visible but do not wake Main or enter its model context.

## Routes

`mode` is chosen per spawn, not in the config file: `fast` for a small, reversible, plainly verifiable change; `thorough` for a broad change or a user-owned decision. It is a hint passed to the worker. For `plan`, `fast` runs only `subtraction` if configured; otherwise it uses the full roster, like default and `thorough`. It does not change execute review, model, thinking level, tools or budgets. The optional `reason` records why. Workflows have no spawn options and use the default route. `worq spawn execute --mode fast "task"` in the CLI, `{ mode, reason }` through the tool.

## Verifying a configuration

- `worq list <ref>` shows route, review policy, `spent/allowance` turns, and each role's resolved settings with source paths.
- The agent log contains `Role <role>: <provider>/<model>, thinking <level>; sources {…}`, written when the session opens.
- Skipped verification is reported explicitly: the detail line reads `review: explicitly skipped` instead of the selected review policy.

## Failures and fixes

| Failure | Cause | Fix |
|---|---|---|
| `invalid-payload` `/models/x/model` | Ref does not match the harness pattern | Use `<provider>/<model>` |
| `unknown harness` | `harness` names no registered backend | Use `pi` |
| `Pi does not know model …` | Model not installed in Pi | Install it or pick another |
| `… is not a pi thinking level` | Level unsupported by that model | Use one the error lists |
| `Executable approval required on …` | Extensions without approval | Add `approveExecutables: true` on that exact role |
| `Untrusted resource` / `Repository resource` | Path escapes `worq-resources/` or sits in a checkout | Move the file |
| `Changed resource` | File edited after pinning | Recompute the SHA-256 |
| `Unknown named child` | `name` delegated without a `models` entry | Declare `subagent.<name>` |
| `at-capacity` | `limits.agents` reached | Close an agent or raise the cap |
| `workflow-file` | The workflows directory cannot be read | Fix permissions, or make `<agentDir>/workflows` readable; a missing directory is empty, not an error |
| `invocation` | A user workflow was launched through the shared path, or a shared kind through the workflow path | Use `/worq workflow` for workflows; `worq_spawn` for `plan`/`execute` |
| `round-limit` | `limits.rounds` reached | Adjudicate the evidence and close, or spawn a fresh agent with the plan in `attach` |
| `run-limit` | Cumulative turns spent | Raise `runTurns`, or configure `continuationTurns` and grant headroom |

## Recipes

Cheap workers, strong reviewers:

```json
{
  "harnesses": { "pi": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" } },
  "models": { "reviewer": { "model": "anthropic/claude-opus-4-1", "thinking": "high" } }
}
```

A named child with pinned evidence rules:

```json
{
  "models": {
    "subagent.evidence": {
      "model": "anthropic/claude-sonnet-4-5",
      "instructions": [{ "path": "evidence/AGENTS.md", "sha256": "…" }]
    }
  }
}
```

Long autonomous runs with an approval step:

```json
{ "limits": { "runTurns": 2000, "continuationTurns": 500, "checkpointSeconds": 30 } }
```

Reviewers start empty-handed: leaving `reviewer.*` without resources means no skills, no instructions and no extensions, which is the intended default for an unbiased verdict.
