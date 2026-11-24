# SDKs

An **SDK adapter** runs one Worq session (agent, PQ subagent or review) on a backend. Worq is the harness; SDKs are interchangeable execution backends. Pi is the only one that ships.

Adding an SDK = one folder: `<agentDir>/worq/adapters/<id>/adapter.mjs`. No Worq source changes. Folder name = id (lowercase, hyphenated; `pi` is reserved). Global only: never project-local, never a path from a launch request. Installing it is the trust opt-in: it runs in-process with Pi's privileges (not a sandbox). Native-extension approval stays separate.

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
src/sdk/registry.ts       Pi record + installed adapter discovery (lazy loaders) + createDriver
src/sdk/pi.ts             Pi adapter (shipped)
src/runtime/launch.ts     resolveRuntime (every launch route) + picker choices
src/runtime/config.ts     limits, extension approval, migration findings
src/runtime/resources.ts  shared instructions, skills, extensions snapshot
src/session.ts            Conversation (budgets, nudges, queueing)
```

## Ownership

| Worq owns | Adapter owns |
|---|---|
| Runtime resolution (request → defaults) | Defaults, local preflight, native model resolution |
| Shared resources, prompt composition, `skill` tool | Loading native extension bytes |
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

`HostServices` carries only the shipped Pi adapter's host (`pi: { model, modelRegistry, thinkingLevel, agentDir }`); installed adapters get `{ id, dir, agentDir }`. `resolveRuntime` loads the requested adapter, fills defaults, judges capabilities and runs `validateRuntime` before Worq reserves a slot, ref or worktree; it never calls `models()`. Worq freezes the selection and passes it through the conversation; PQs and reviews inherit the owner's effective runtime. Per `open(spec)` the driver re-checks that runtime, composes the system prompt, appends the `skill` tool, attaches extensions, then calls the adapter.

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
  extensions: ExtensionFile[];    // shared native extension bytes
  emit(event: SessionEvent): void;
  beforeRequest?(signal: AbortSignal): Promise<void>; // await once prior tools have settled
  signal: AbortSignal;            // aborts opening
}
interface Handle {
  prompt(text): Promise<"completed" | "preflight-failed" | "failed" | "aborted">;
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

Pure data; `assertRuntime(runtime, caps, extensionCount)` judges the resolved runtime. Not a substitute for `validateRuntime`.

| Field | Meaning | Denial |
|---|---|---|
| `switchModel` | `Handle.configure` can change the model | Manual model switch when `false` → `capability` |
| `thinking` | Levels the runtime's model accepts; `[]` = no level control | Explicit level outside the list → `capability` |
| `context` | `replace` + no ambient instructions required | Anything else refuses the session |
| `extensions` | Can load shared native extensions | Installed extensions + `false` → `capability` |
| `turnUnit` | `request` (one `turn` per model request) or `prompt` | Informational; logged at open |

## Turn accounting

`turn` events charge the same budgets, but units differ: Pi emits one per model request; a CLI adapter that only sees prompts emits one per `prompt()` and must report `turnUnit: "prompt"`. `limits.*Turns` defaults (80/16/40) are Pi-calibrated — lower them for prompt-unit SDKs. Unobservable measures (requests, tokens) are omitted, never reported as zero.

## Extensions across SDKs

Shared `extensions/` files are SDK-native (Pi API). A non-Pi adapter reports `extensions: false`, so a mixed-SDK config with extensions installed fails as `capability` rather than silently degrading. Portable functionality belongs in Worq-owned surfaces (tools, instructions, skills); a portable hook contract is future work.

## Conformance

`test/conformance.test.ts` exports `adapterConformance(name, make, options)`, Conversation-level, run for MINIMAL and FULL capability sets; ambient context must be rejected. Router behaviour (routing, environment preparation, extension denial, unknown SDK) is asserted against `createDriver` with a recording adapter. `test/adapter.test.ts` installs a deterministic adapter folder and launches it through production discovery, `worq_spawn` and the CLI.

The live Pi run opens a real session, dispatches a Worq tool and submits: `WORQ_CONFORMANCE_PI=1 WORQ_CONFORMANCE_MODEL=<provider>/<model> npm test`. Unset, it skips.

## Tool bridge (design for the first CLI adapter)

For a process-boundary SDK the minimum `ask_main`-preserving equivalent is a loopback JSON-RPC tool bridge keyed by `spec.id`: `<state>/bridge/<spec.id>.sock` (dir 0700, socket 0600, per-session token), allowlisted to `spec.tools`, errors mapped to `tool-error`. Same framing as `src/control.ts`. Rejected: yield-and-resume (breaks the blocking guarantee in `prompts/protocol.md`). Lands as `src/sdk/bridge.ts` when needed.

## Adapters

### Pi (`pi`)

- `src/sdk/pi.ts` → `piAdapter(host)`.
- Refs `<provider>/<model>`; malformed or not in Main's model registry → `model`, at preflight; no Main model and none requested → `model`.
- Sessions: in-memory session + settings managers (compaction/retry off), fixed resource loader, explicit `agentDir`, and Main's model runtime when the host exposes it, so auth and extension-registered providers match Main.
- Capabilities: `switchModel: true`, thinking from the model, `extensions: true`, `turnUnit: "request"`, isolated context.
- `configure` uses `session.setModel` / `setThinkingLevel`. Pi clamps an incompatible level on a model-only switch; the adapter reports the effective level.
- Live changes apply at once when idle, or before the next request, even inside the same prompt. The adapter awaits `beforeRequest` before resolving provider inputs, never interrupting a running tool. For adapters without that hook, the core applies queued changes when the prompt settles.
