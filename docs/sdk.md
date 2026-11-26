# SDKs

An **SDK adapter** runs one Worq session (agent, PQ subagent or review) on a backend. Worq is the harness; SDKs are interchangeable execution backends. Three ship: Pi (`pi`, the default), Claude Code (`claude-code`, optional lazy built-in) and Antigravity (`antigravity`, optional lazy built-in). Pi is the only reserved id.

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
src/sdk/registry.ts       Pi/Claude/Antigravity records + installed adapter discovery (lazy loaders) + createDriver
src/sdk/pi.ts             Pi adapter (shipped)
src/sdk/claude.ts         Claude Code adapter (shipped, optional package)
src/sdk/antigravity.ts    Antigravity adapter (shipped, optional `agy` CLI over ACP)
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

Built-in discovery seeds `pi`, adds every valid installed folder, then adds `claude-code` and `antigravity` only when no installed adapter claimed those ids. `pi` cannot be replaced; installed `claude` remains its own id (there is no `claude` alias).

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
  seed?: readonly unknown[];      // contextFork: another handle's snapshot() to continue from
}
interface Handle {
  prompt(text, signal?): Promise<"completed" | "preflight-failed" | "failed" | "aborted">;
  steer?(text): Promise<void>;    // optional; absent or throwing → core queues
  readonly streaming: boolean;
  abort(): Promise<void>;
  readonly selection?: { model?: string; thinking?: string }; // effective SDK settings
  configure?(change: { model?; thinking? }): Promise<void>;  // keeps history; harness stays locked
  snapshot?(): readonly unknown[]; // contextFork: completed history up to the last balanced turn
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
| `context` | `replace` or `append` with no ambient instructions required | Ambient instructions refuse the session |
| `requestAdmission` | `"awaited"` opts into the pre-request gate; `turn` events are observational only | None; the adapter must call it |
| `contextFork` | `Handle.snapshot()` / `SessionSpec.seed` work: a new session can continue another's history | Absent/`false`: `fork: true` children start fresh with a brief |

Forked children reuse the parent's exact `system`, tool definitions (disallowed handlers fenced) and model, so the provider prompt cache hits on the seeded prefix. Snapshots are opaque to the core and only seed sessions on the same adapter.

## Turn accounting

`turn` events charge the same budgets, but units differ: Pi emits one per model request; a CLI adapter that only sees prompts emits one per `prompt()`. An adapter with `requestAdmission: "awaited"` is charged by the awaited admission decision instead (first attempt prepaid, each continuation one turn); its `turn` events are observational. `limits.*Turns` defaults (80/16/40) are Pi-calibrated — lower them for prompt-unit SDKs. Unobservable measures (requests, tokens) are omitted, never reported as zero.

## Shared resources

Every adapter receives the same harness-neutral environment, already folded into `spec.system` and `spec.tools`: `<agentDir>/worq/AGENTS.md` and the skill index plus `skill` tool. No native extensions: an adapter loads nothing executable into its sessions.

## Conformance

`test/conformance-suite.ts` exports `adapterConformance(name, make, options)`, Conversation-level, run for MINIMAL and FULL capability sets; ambient context must be rejected. `test/claude.test.ts` drives the **production** Claude adapter through it with a deterministic SDK seam (query stream, MCP server, settings resolver), plus context isolation, images, tool errors, callbacks, cancellation, disposal, option shape, managed-policy refusal and model/thinking switching. Router behaviour (routing, environment preparation, unknown SDK) is asserted against `createDriver` with a recording adapter. `test/adapter.test.ts` installs a deterministic adapter folder and launches it through production discovery, `worq_spawn` and the CLI.

The live Pi run opens a real session, dispatches a Worq tool and submits: `WORQ_CONFORMANCE_PI=1 WORQ_CONFORMANCE_MODEL=<provider>/<model> npm test`. Unset, it skips. `test/claude-native.test.ts` requires the pinned SDK and real native worker; it uses a synthetic key, a disposable HOME and checkout, and a recording loopback SSE endpoint. It does not contact a real inference provider. The fixture checks readiness before a send, the wire prompt and tool schema, real MCP dispatch, denied continuations, budget reuse, finalized response measurements and worker exit. It does not verify real account entitlement, native Windows resolution or deployed MDM/registry policy.

## Tool bridge

Claude uses the SDK's native in-process MCP server (`createSdkMcpServer`) scoped to one conversation; no socket or listener is exposed to the checkout. The older loopback design remains a fallback for a process-boundary SDK: `<state>/bridge/<spec.id>.sock` (dir 0700, socket 0600, per-session token), allowlisted to `spec.tools`, errors mapped to `tool-error`. Yield-and-resume remains rejected (it breaks `ask_main`'s blocking guarantee).

## Adapters

### Pi (`pi`)

- `src/sdk/pi.ts` → `piAdapter(host)`.
- Refs `<provider>/<model>`; malformed or not in Main's model registry → `model`, at preflight; no Main model and none requested → `model`.
- Sessions: in-memory session + settings managers (compaction/retry off), fixed resource loader, explicit `agentDir`, and Main's model runtime when the host exposes it, so auth and providers match Main. No extensions are loaded.
- Capabilities: `switchModel: true`, thinking from the model, isolated context, `contextFork: true`.
- Fork: `snapshot()` copies `session.messages` (user/assistant/toolResult only) up to the last point where every tool call has its result, excluding the in-flight turn; `seed` is appended to a fresh in-memory `SessionManager` before `createAgentSession`.
- `configure` uses `session.setModel` / `setThinkingLevel`. Pi clamps an incompatible level on a model-only switch; the adapter reports the effective level.
- Live changes apply at once when idle, or before the next request, even inside the same prompt. The adapter awaits `beforeRequest` before resolving provider inputs, never interrupting a running tool. For adapters without that hook, the core applies queued changes when the prompt settles.

### Claude Code (`claude-code`)

- `src/sdk/claude.ts` → `claudeAdapter(host)`; loads `@anthropic-ai/claude-agent-sdk` and `zod/v4` lazily, only when selected. Both are optional dependencies; a missing package fails this SDK alone.
- Uses existing Claude Code login and native credential discovery (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`). Ambient model, effort, endpoint, config-dir and provider switches do not reach the worker. Auto memory, tool search, ordinary SDK retries and refusal retry/fallback are disabled.
- The launch and live pickers use a bounded, advisory snapshot of the worker's native catalog. Concrete IDs are preferred, verified `[1m]` options stay selectable, and the original `sonnet`/`opus`/`haiku` aliases are a fallback. A catalog failure does not prevent opening an explicit model. Worq only inherits a compatible Claude-family Main reference. Thinking-level changes are not supported because this SDK does not reliably expose effective effort.
- Readiness uses `initializationResult()` on an empty streaming inbox, then serial MCP status and summary context read-back. It verifies blocking hooks, `dontAsk`, empty command and ambient context inventories, the exact SDK-owned Worq tools and effective model before releasing input. A `system/init` event is turn metadata, not startup readiness. Startup refusals, cancellation and timeout close input and reap the worker. Readiness does not prove authentication or model entitlement.
- Worq overrides settings, tools, plugins, agents and skills, uses strict MCP and `verbatimPrompts`, and disables slash commands, compaction and automatic model switching. The pinned SDK adds its billing header, one-line SDK identity, environment/model/date/safety reminders and a token-budget reminder to tool results. These are native framing, not ambient instructions. Nonempty or unreadable managed settings and separate machine `CLAUDE.md`/`managed-mcp.json` files refuse launch before spawn; Worq does not modify policy.
- Tools use a session-scoped `createSdkMcpServer` and translate the prepared object schemas through `zod/v4.fromJSONSchema`. Dispatch is serialized and fenced on cancellation or terminal `submit`. The prompt hook binds the admitted input to its SDK prompt identity, matching the SDK's outer-whitespace trim only at the hook (the provider receives the original text); `PostToolBatch` separately awaits admission before each tool continuation, including batches with invalid/failed tools. A denied continuation stops the prompt without another generation and ordinary budget exhaustion leaves the session reusable. In-flight messages queue for the next admitted Worq prompt instead of using the native priority inbox.
- **Release blocker in SDK 0.3.332:** After an admitted response ends with `max_tokens`, the native worker can append a continuation nudge and issue a new generation without either admission hook. A malformed `tool_use` stop with no tool blocks also triggers native repair and another observed generation, not an ordinary tool continuation. `maxTurns: 1` does not prevent these sends; the `Stop` hook arrives after recovery. Neither path satisfies the awaited admission contract. These are distinct from the HTTP fallback below.
- **Pinned HTTP limit:** The local provider observed one HTTP send for a 429, but three same-model sends for a generic 400 within one admitted generation even with `CLAUDE_CODE_MAX_RETRIES=0` and no `api_retry` event. This pre-existing internal fallback is not an extra Worq generation and is an exception to the literal per-wire-attempt contract; this repair does not enforce a strict wire-attempt cap.
- Model changes use `applyFlagSettings({ model })` and bounded summary read-back. An uncertain change invalidates the handle; a verified refusal keeps the previous selection. The dock shows the verified wire ID, while the effective runtime selection carries the context option for reuse. TURNS counts observed top-level response starts and CACHE/TOK/S are sampled from finalized successful responses, not startup, tool wait or whole-prompt aggregates.
- One native streaming query preserves history across prompts and switches (`persistSession: false`). Interrupt waits for prompt settlement, not just the control ACK; a worker which cannot confirm settlement is closed instead of reused.

### Antigravity (`antigravity`)

- `src/sdk/antigravity.ts` → `antigravityAdapter(host)`; probes the optional `agy` CLI (`ANTIGRAVITY_CLI`, default `agy`) lazily and spawns `agy acp --stdio --process-per-session --disable-telemetry --include-default-customizations=false`. A missing `agy` binary fails `antigravity` alone and is skipped by the picker.
- Uses your existing Google Account OAuth login (`agy` Pro/Enterprise subscription), `GEMINI_API_KEY`/`GOOGLE_API_KEY`, or Vertex ADC (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG`) through a curated `workerEnv()`; unrelated provider keys do not reach the worker.
- Isolation: passes `--include-default-customizations=false` (`ambientInstructions: false`), appends `spec.system` via ACP `_meta.antigravity.systemPrompt.append` (`context.system: "append"`), and handles ACP `session/request_permission` by auto-allowing only Worq's session-scoped tools and denying built-in `agy` tools.
- Tools are served over a per-session `127.0.0.1` bearer-authenticated Streamable HTTP MCP server passed to `session/new`, supporting long-blocking tools, `{ text, image }` outputs, `tool-error` reporting, and terminal `submit` cancellation.
- Capabilities: `switchModel: true` (live `configure({ model, thinking })` via ACP `session/set_config_option`), `thinking: ["low", "medium", "high", "xhigh"]`, `context: { system: "append", ambientInstructions: false }`. Default model inherits a compatible Main reference, else `gemini-4-neon`.
