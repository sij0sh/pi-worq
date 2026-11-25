# SDKs

An **SDK adapter** runs one Worq session (agent, PQ subagent or review) on a backend. Worq is the harness; SDKs are interchangeable execution backends. Two ship: Pi (`pi`, the default) and Claude Code (`claude-code`, an optional lazy built-in). Pi is the only reserved id.

Adding an SDK = one folder: `<agentDir>/worq/adapters/<id>/adapter.mjs`. No Worq source changes. Folder name = id (lowercase, hyphenated; `pi` is reserved). Global only: never project-local, never a path from a launch request. Installing it is the trust opt-in: it runs in-process with Pi's privileges (not a sandbox). A valid installed adapter wins its own id over a non-reserved built-in, including an installed `claude-code` or `claude`; a failed built-in load never replaces an installed adapter and never affects Pi or management.

```js
// <agentDir>/worq/adapters/echo/adapter.mjs — bundle its own dependencies
export default {
  version: 1,
  create({ id, dir, agentDir }) { return adapter; }, // SDKAdapter, or a promise of one
};
```

Select it per launch: `worq_spawn { kind, sdk: "echo", model? , thinking? }`, `worq spawn <kind> --sdk echo`, or the `/worq` runtime step. Discovery only lists folders; the module is imported on first use (in-flight loads shared). A broken adapter fails its own launches (`sdk "<id>" could not load`), is skipped by the picker and never blocks Pi or management.

## Layout

```
src/sdk/contract.ts       contract types, assertRuntime
src/sdk/registry.ts       Pi/Claude records + installed adapter discovery (lazy loaders) + createDriver
src/sdk/pi.ts             Pi adapter (shipped)
src/sdk/claude.ts         Claude Code adapter (shipped, optional package)
src/runtime/launch.ts     resolveRuntime (every launch route) + picker choices
src/runtime/config.ts     limits, migration findings
src/runtime/resources.ts  shared AGENTS.md + skills snapshot
src/session.ts            Conversation (budgets, nudges, queueing)
```

## Ownership

| Worq owns | Adapter owns |
|---|---|
| Runtime resolution (request → defaults) | Defaults, local preflight, native model resolution |
| Shared resources, prompt composition, `skill` tool | Passing `spec.system` / `spec.tools` through unchanged |
| Tool schema validation and dispatch fencing | Native tool registration |
| Live runtime changes (when, to what, validation) | Safe request boundary and `configure` mechanics |
| Budgets, turn charging | Emitting `turn` events |
| Workflow and completion | Session execution |
| Event → log/telemetry formatting | Native event translation |

## Registry

```ts
export interface SDKRecord { load(host: HostServices): Promise<SDKAdapter> }  // lazy
export function discoverAdapters(agentDir): { records: Record<string, SDKRecord>; problems };  // pi + installed
export async function createDriver(host, resources, records): Promise<Driver>;
```

`HostServices` carries the shipped Pi adapter's host (`pi: { model, modelRegistry, thinkingLevel, agentDir }`) and a provider-neutral accessor for Main's live selection (`main(): { model?, thinking? }`); installed adapters get `{ id, dir, agentDir }`. `resolveRuntime` loads the requested adapter, fills defaults, judges capabilities and runs `validateRuntime` before Worq reserves a slot, ref or worktree; it never calls `models()`. Worq freezes the selection and passes it through the conversation; PQs and reviews inherit the owner's effective runtime. Per `open(spec)` the driver re-checks that runtime, composes the system prompt, appends the `skill` tool, then calls the adapter.

Built-in discovery seeds `pi`, adds every valid installed folder, then adds `claude-code` only when no installed adapter claimed that id. `pi` cannot be replaced; installed `claude` remains its own id (there is no `claude` alias).

## Contract

```ts
interface SDKAdapter {
  models(): Promise<readonly string[]>; // picker information only; may be empty or incomplete
  defaultModel?(): string | undefined;  // used when a launch names no model
  defaultThinking?(): string | undefined; // inherited only when the model supports it
  capabilities(runtime: Runtime): Capabilities;
  validateRuntime(runtime: Runtime, signal: AbortSignal): void | Promise<void>; // required local preflight
  open(spec: SessionSpec): Promise<Handle>;
}
interface SessionSpec {
  id: string; name: string; cwd: string;
  runtime: Runtime; thinking?: string;
  system: string;                 // final, already composed
  tools: Tool[];                  // already validated + fenced by the core
  emit(event: SessionEvent): void;
  beforeRequest?(signal: AbortSignal): Promise<void>; // legacy safe boundary
  admitRequest?(signal): Promise<{ allowed: true } | { allowed: false; reason }>; // awaited admission
  signal: AbortSignal;            // aborts opening
}
interface Handle {
  prompt(text, signal?): Promise<"completed" | "preflight-failed" | "failed" | "aborted">;
  steer?(text): Promise<void>;    // optional; absent or throwing → core queues
  readonly streaming: boolean;
  abort(): Promise<void>;
  readonly selection?: { model?: string; thinking?: string }; // effective SDK settings
  configure?(change: { model?; thinking? }): Promise<void>;  // keeps history; harness stays locked
  dispose(): void;
}
type SessionEvent =
  | { type: "turn" } | { type: "tool-start"; name; args } | { type: "tool-error"; name; message }
  | { type: "text"; text; completed } | { type: "telemetry"; value } | { type: "log"; text };
```

## Duties

| Duty | Detail |
|---|---|
| Isolation | Start in `spec.cwd` with exactly `spec.system` and `spec.tools`. No ambient settings, skills, AGENTS.md, packages or prompt templates. |
| Request admission | If `requestAdmission: "awaited"`, call `spec.admitRequest(signal)` once immediately before every actual outgoing model request, including each tool continuation, and release nothing until it allows. A refusal is not a retry. |
| Managed policy | If a settings tier cannot be excluded (Claude managed policy), inspect it before starting a worker and refuse a configuration that can add behavior; an unreadable policy is a refusal. |
| Long-blocking tools | Await a tool for as long as it takes (`ask_main` parks up to `limits.askMinutes`); propagate its abort signal. |
| Image output | `{ text, image }` reaches the model as image content. |
| Tool errors | Emit `tool-error` for SDK-side failures (argument validation included); never throw out of the session. |
| Outcomes | `preflight-failed` = no work started (credentials etc.); `failed` = a model request errored after starting. Both surface as model failures. |
| Abort | Settles the in-flight `prompt()` and clears `streaming` within 5s. |
| Open | Respect `spec.signal`; the core disposes a handle that finishes opening after cancel/dispose. |
| Dispose | Idempotent. |
| Identity | `spec.id` is one `randomUUID()` per Conversation; key per-session resources on it. |
| Preflight | `validateRuntime` rejects malformed/locally unknown models, a missing required model and unsupported adapter-specific selections. No `open`, `models()`, credential probe, dummy session or request. Honour `signal`. Validating syntax only is fine when the backend alone can resolve a model; don't claim more. |

## Capabilities

Pure data; `assertRuntime(runtime, caps)` judges the resolved runtime. Not a substitute for `validateRuntime`.

| Field | Meaning | Denial |
|---|---|---|
| `switchModel` | `Handle.configure` can change the model | Manual model switch when `false` → `capability` |
| `thinking` | Levels the runtime's model accepts; `[]` = no level control | Explicit level outside the list → `capability` |
| `context` | `replace` + no ambient instructions required | Anything else refuses the session |
| `turnUnit` | `request` (one `turn` per model request) or `prompt` | Informational; logged at open |
| `requestAdmission` | `"awaited"` opts into the pre-request gate; `turn` events are observational only | None; the adapter must call it |

## Turn accounting

`turn` events charge the same budgets, but units differ: Pi emits one per model request; a CLI adapter that only sees prompts emits one per `prompt()` and must report `turnUnit: "prompt"`. An adapter with `requestAdmission: "awaited"` is charged by the awaited admission decision instead (first attempt prepaid, each continuation one turn); its `turn` events are observational. `limits.*Turns` defaults (80/16/40) are Pi-calibrated — lower them for prompt-unit SDKs. Unobservable measures (requests, tokens) are omitted, never reported as zero.

## Shared resources

Every adapter receives the same harness-neutral environment, already folded into `spec.system` and `spec.tools`: `<agentDir>/worq/AGENTS.md` and the skill index plus `skill` tool. No native extensions: an adapter loads nothing executable into its sessions.

## Conformance

`test/conformance-suite.ts` exports `adapterConformance(name, make, options)`, Conversation-level, run for MINIMAL and FULL capability sets; ambient context must be rejected. `test/claude.test.ts` drives the **production** Claude adapter through it with a deterministic SDK seam (query stream, MCP server, settings resolver), plus context isolation, images, tool errors, callbacks, cancellation, disposal, option shape, managed-policy refusal and model/thinking switching. Router behaviour (routing, environment preparation, unknown SDK) is asserted against `createDriver` with a recording adapter. `test/adapter.test.ts` installs a deterministic adapter folder and launches it through production discovery, `worq_spawn` and the CLI.

The live Pi run opens a real session, dispatches a Worq tool and submits: `WORQ_CONFORMANCE_PI=1 WORQ_CONFORMANCE_MODEL=<provider>/<model> npm test`. Unset, it skips. A real Claude worker run needs a signed-in account and is intentionally not part of CI; it was **not** run for this change. Live Claude worker behaviour, the disposable-HOME isolation gate, managed policy (`/etc/claude-code/...` on Linux, MDM/registry on macOS/Windows) and native Windows worker resolution are **unverified**.

## Tool bridge

Claude uses the SDK's native in-process MCP server (`createSdkMcpServer`) scoped to one conversation; no socket or listener is exposed to the checkout. The older loopback design remains a fallback for a process-boundary SDK: `<state>/bridge/<spec.id>.sock` (dir 0700, socket 0600, per-session token), allowlisted to `spec.tools`, errors mapped to `tool-error`. Yield-and-resume remains rejected (it breaks `ask_main`'s blocking guarantee).

## Adapters

### Pi (`pi`)

- `src/sdk/pi.ts` → `piAdapter(host)`.
- Refs `<provider>/<model>`; malformed or not in Main's model registry → `model`, at preflight; no Main model and none requested → `model`.
- Sessions: in-memory session + settings managers (compaction/retry off), fixed resource loader, explicit `agentDir`, and Main's model runtime when the host exposes it, so auth and providers match Main. No extensions are loaded.
- Capabilities: `switchModel: true`, thinking from the model, `turnUnit: "request"`, isolated context.
- `configure` uses `session.setModel` / `setThinkingLevel`. Pi clamps an incompatible level on a model-only switch; the adapter reports the effective level.
- Live changes apply at once when idle, or before the next request, even inside the same prompt. The adapter awaits `beforeRequest` before resolving provider inputs, never interrupting a running tool. For adapters without that hook, the core applies queued changes when the prompt settles.

### Claude Code (`claude-code`)

- `src/sdk/claude.ts` → `claudeAdapter(host)`; loads `@anthropic-ai/claude-agent-sdk` and `zod/v4` lazily, only when selected. Both are optional dependencies; a missing package fails this SDK alone.
- Reuses the operator's existing Claude Code login and native credential discovery. `workerEnv` passes only the OS identity/profile and supported credential variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`); ambient model, effort, endpoint, config-dir and provider switches are dropped. It hardcodes `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_MAX_RETRIES=0` so a retry cannot bypass admission.
- Main's Pi model is mapped only for a Claude-family reference under the `anthropic` provider (or a bare `claude-*`/`sonnet`/`opus`/`haiku`). Otherwise `model` is required. No thinking is inherited: the pinned SDK does not report the applied effort on stdio (`init.effort` is a Remote-Control-only field here), so a Main level is dropped rather than substituted. Worq advertises no level control and refuses an explicit level before a slot (`capability`).
- Isolation: `settingSources: []`, `tools: []`, `plugins: []`, `agents: {}`, `skills: []`, `strictMcpConfig: true`, `permissionMode: "dontAsk"`, exact `allowedTools` for `mcp__worq__*`, inline settings that disable auto-compaction/model fallback, and `verbatimPrompts` plus `disable-slash-commands`. The init message is checked before the first prompt: only Worq MCP tools, only the `worq` server, no ambient skills/slash commands/agents/plugins (SDK builtin plugins are fixed framing), `dontAsk`. Any mismatch refuses the session. Claude's fixed billing header and one-line agent identity are SDK framing, not settings-derived instructions.
- Managed policy is the one tier `settingSources` cannot remove. `resolveSettings({ settingSources: [] })` is inspected before the worker starts; any policy source setting hooks, env, permissions, plugins, model, MCP/skills/agents, sandbox or compaction keys refuses with `policy`. An unreadable policy or unavailable `machinePolicy.didNotLoad` refuses too.
- Tools are a session-scoped `createSdkMcpServer`; each Worq `Tool.parameters` JSON Schema is converted with `zod/v4.fromJSONSchema`, so advertised constraints match. Callbacks are serialized; a stale prompt generation or abort is fenced after the queue wait. Images, MCP validation errors, `tool-error`, `submit` termination and a long-blocking `ask_main` preserve Pi behaviour. The server timeout is 24h, above any `askMinutes`.
- Thinking: no level control is advertised. The SDK accepts `effort` but its stdio init never reports the applied value, so explicit levels are refused before a slot and live changes are refused before mutation.
- Admission: one `admitRequest` immediately before the first request and before every tool continuation; the final tool result is held until allowed. A refusal stops the turn without releasing the result; a budget stop is resumable, a fatal invalidation is not.
- Runtime: model switches use one `applyFlagSettings({ model })` control call and verify the effective model through `getContextUsage`; a mismatch or unreadable result latches `runtime-invalidated`, fences the handle and closes it. A documented all-or-nothing rejection keeps the previous verified model. A live thinking change is refused **before** mutation because the pinned SDK exposes no verified effort read-back; start a new session with the new pair.
- Streaming input with one live query per conversation preserves history across prompts, park/resume and model switches. `persistSession: false`; no durable Claude transcript is produced. `abort` clears streaming within the 5s duty; `dispose` is idempotent.
