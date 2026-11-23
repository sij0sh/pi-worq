# Harnesses

A **harness** is a backend that runs one Worq session: the agent, a PQ subagent or a reviewer. Worq's process, prompts and four-tool surface are harness-agnostic; everything backend-specific lives behind the adapter contract in `src/session.ts` and one registry record in `src/harness.ts`. Pi is the only backend that ships today.

Adding a backend costs one adapter file plus one registry line — it does not touch `src/agent.ts`, `src/worq.ts`, `src/control.ts`, the prompts or the four tools.

## The registry

`src/harness.ts` holds `HARNESSES`, the only runtime harness table:

```ts
export interface HarnessRecord {
  modelRef: RegExp;                                   // refs this harness can resolve
  create(ctx: HostContext, config: Config): Driver;   // builds the adapter
}
export const HARNESSES: Record<string, HarnessRecord> = { pi: { … } };
export function createDriver(ctx: HostContext, config: Config): Driver;
```

`createDriver` routes by config, not by caller: for each role it reads `config.model(name).harness` and delegates both `capabilities(name)` and the session open to that record. A name with no record raises `Block("config")`. `loadConfig` rejects an unknown `harness` key at load with the same code, so a file can never name a backend that is not registered.

`HostContext` is `{ host: unknown }`: the host (the Pi extension context) is narrowed only inside the adapter's `create`. That is the one documented untyped boundary.

## Required duties

An adapter implements `Driver` — a function from `Spec` to `Handle` — and owes the core these behaviours. They are duties, not flags: the core cannot check them, the conformance suite catches a dishonest fake, not a dishonest CLI.

| Duty | Detail |
|---|---|
| Isolation | Start in `spec.cwd` with exactly `spec.system` and exactly `spec.tools`. No extension, skill, AGENTS.md or prompt-template discovery of your own. |
| Long-blocking tools | Await a tool call for as long as it takes (`ask_main` can park for `limits.askMinutes`). No adapter-imposed timeout; propagate the tool's abort signal. |
| Image output | A tool returning `{ text, image: { mimeType, data } }` must reach the model as image content, not as a string. |
| Tool errors | Report argument-validation failures through `spec.toolError(name, message)` — they run before `Tool.run` and never throw out of the session. |
| Idle assumption | `prompt(text)` may assume the handle is idle. It resolves when the run goes idle, and returns `true` when the request failed before any work (credentials, preflight) so the core can try the fallback. |
| Steer | `steer(text)` is a required `Promise<void>`; it throws when the message cannot reach the running turn. The core then queues it and logs one line. |
| Abort | `abort()` settles the in-flight `prompt()` and leaves `streaming === false` within 5s. A `stop()` after a budget or caller abort is bounded; an adapter that keeps streaming leaves a live turn while Worq proceeds. |
| Dispose | `dispose()` is idempotent. |
| Identity | The spec carries `spec.id`, one `randomUUID()` per Conversation. Use it for any per-session resource. |

The core synthesizes no `unknown` review for a still-streaming or aborted handle: an aborted reviewer throws and its own catch decides.

## Capabilities

`Capabilities` is pure data. `driver.capabilities(name)` never judges a choice; `assertChoice(choice, caps)` does, and it names the config path each field came from (`choice.from.thinking`, `choice.from.fallbackModel`).

| Field | Meaning | Degraded behaviour |
|---|---|---|
| `fallback: boolean` | `Handle.fallback()` can switch to the configured `fallbackModel` once. | `fallback: false` plus a configured `fallbackModel` raises `Block("capability")` at spawn and before each `pq`/`reviewer`. |
| `thinking: readonly string[]` | Levels the role's chosen model accepts. `["off"]` for a non-reasoning model — never `[]`, which means the harness has no level control at all. | A configured `thinking` on `thinking: []` raises `Block("capability")`; a level outside a non-empty list does too. |
| `context: { system: "replace" \| "append"; ambientInstructions: boolean }` | Whether the harness isolates Worq's system prompt. | Any value other than `replace`/`false` refuses the session before open. |

`thinking` is derived from the effective model — `resolve(choice.model) ?? ctx.model` — so a configured level is validated even when no model is configured. Pi derives the list the way `getSupportedThinkingLevels` does: the five core levels minus those `thinkingLevelMap` maps to `null`, plus `xhigh`/`max` only where the map defines them.

Role admission and `Conversation.open` require isolated context. Nonempty requested resource lists also require advertised adapter support.

## Turn accounting

`spec.turn()` is called once per model request where the adapter can observe one, otherwise once per `prompt()`. Turn budgets are therefore **not comparable across harnesses**:

- Pi: one turn per model request (`turn_start`).
- A CLI process: one turn per `prompt()` unless the adapter can see individual requests.

`limits.*Turns` defaults (80/16/40) are **Pi-calibrated and operator-owned** per harness: each adapter's entry below must state its turn unit and whether the default is meaningful for it. No new config key is introduced for per-harness defaults.

## Fallback and thinking degradation

Pi applies `setThinkingLevel(choice.thinking ?? "low")` at open (Pi clamps a level the model does not support) and re-applies the same level after `fallback()`'s `setModel`. A fallback model that cannot take the level is a documented degradation: one log line naming the level and the fallback model's supported levels, never an error. Validation only holds a level against the model it was chosen for.

`Handle.fallback` also owns the context tradeoff on restart-style backends: the core only re-sends a `CONTINUE` prompt.

## Error codes

Exactly five, all `Block`:

| Code | Raised when |
|---|---|
| `config` | Unknown harness, bad model ref (per-harness validator, key named), or a well-formed ref the backend cannot resolve. |
| `invalid-json` | `pi-worq.json` is not JSON. |
| `invalid-payload` | A tool argument or submission fails its schema. |
| `capability` | `assertChoice` denies a configured `thinking` or `fallbackModel`. |
| `model` | Nothing resolves (no configured model and no default) or a request failed with no fallback left. |

## Conformance

`test/conformance.test.ts` exports:

```ts
export async function adapterConformance(name: string, make: (caps: Capabilities) => Driver): Promise<void>;
```

The suite runs MINIMAL (no fallback, `thinking: []`, append/ambient) and FULL (fallback, full level list, replace/isolated); ambient context must be rejected; remaining checks require isolation. MINIMAL proves the required capability set is sufficient and that denials are honest — a configured fallback or level on MINIMAL is `Block("capability")` naming the config path.

The suite is **Conversation-level**: a `Driver` plus an `AbortSignal`, no workspace, no `Agent`. Agent-level behaviour (review-ready, the merge line, the round loop, the reviewer-throw `unknown` record, every worktree behaviour) belongs to `test/worq.test.ts` and is covered once, there. Role→adapter routing, unknown harness and `capabilities` passthrough are asserted against `createDriver` in the same conformance file.

New adapters call `adapterConformance` from their own test file. The live Pi run is opt-in: `WORQ_CONFORMANCE_PI=1 WORQ_CONFORMANCE_MODEL=<provider>/<model> npm test` — unset, that case skips cleanly.

## The tool bridge (design for the first CLI adapter)

No harness implements `ask_main` semantics today except Pi, in-process. For a process-boundary harness the minimum viable equivalent is a loopback JSON-RPC tool bridge, keyed by `spec.id`:

```
Worq                                   CLI harness (Claude/Codex/Gemini)
 Tool[] ──serve──▶ <state>/bridge/<spec.id>.sock  (dir 0700, socket 0600, per-session token)
                    {"id":"7","tool":"ask_main","args":{…}}
                  ← {"id":"7","ok":true,"text":"Main: upper"} | {"id":"7","ok":false,"error":"…"}
 adapter registers MCP/stdio shims ──▶ harness sees the Worq tools as ordinary tools
```

Same framing and permissions as the existing control socket (`src/control.ts`), one socket per live session keyed by `spec.id`, a tool allowlist so only `spec.tools` is reachable, and errors mapped to tool errors exactly as `src/pi.ts` does. Rejected alternative: yield-and-resume (return "question asked", end the turn, inject the answer later) — it drops the blocking guarantee `prompts/protocol.md` states and correlates no answer with its ask. When it lands it becomes `src/bridge.ts`; until then this section is the design.

## Adapters

### Pi (`pi`)

- **Adapter:** `src/pi.ts` → `piDriver(ctx, config)`; `create(ctx, config)` narrows `ctx.host` to the Pi extension context.
- **Model refs:** `<provider>/<model>`, validated at load by `^[^/\s]+\/[^\s]+$`. A well-formed ref Pi cannot resolve raises `Block("config")` when resolution runs; nothing resolving at all raises `Block("model")`.
- **Capabilities:** `fallback: true`; `thinking` derived from the role's model; `context: { system: "replace", ambientInstructions: false }` (sessions are in-memory with a fixed resource loader).
- **Turn unit:** one per model request. The `limits.*Turns` defaults (80/16/40) are calibrated for this unit and are meaningful here; a backend that hides several requests inside one `prompt()` should say so and the operator should lower them.

## Multi-harness configuration

Per-role harness selection is in place; only `pi` is registered. A multi-harness configuration such as this one is schema-valid but **fails load with an unknown harness until those adapters register**:

```json
{
  "harness": "pi",
  "fallbackModel": "anthropic/claude-haiku-4-5",
  "harnesses": {
    "pi": { "model": "openai/gpt-5", "thinking": "medium" },
    "claude": { "model": "anthropic/claude-sonnet-4-5" }
  },
  "models": {
    "agent": { "harness": "pi" },
    "reviewer": { "harness": "claude", "thinking": "high" },
    "subagent": { "model": "anthropic/claude-haiku-4-5" }
  }
}
```

Resolution is harness-first and per field: the first explicit `harness` in `models[name]` → `models[profile]` → top-level (absent = `pi`) decides the backend, then each of `model`, `fallbackModel` and `thinking` walks `models[name]` → `models[profile]` → `harnesses[resolvedHarness]` → top-level, skipping any models layer whose explicit harness differs, and applying the top-level step only when the role resolves to the top-level harness.
