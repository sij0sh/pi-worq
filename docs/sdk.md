# SDKs

An **SDK adapter** runs one Worq session (agent, PQ subagent or review) on a backend. Worq is the harness; SDKs are interchangeable execution backends. Pi is the only one that ships.

Adding an SDK = one file under `src/sdk/` + one record in `src/sdk/registry.ts`. Nothing in `src/agent.ts`, `src/worq.ts`, `src/session.ts`, `src/runtime/`, the prompts or the four tools changes.

## Layout

```
src/sdk/contract.ts       contract types, assertRuntime
src/sdk/registry.ts       SDKS metadata (lazy loaders) + createDriver role router
src/sdk/pi.ts             Pi adapter
src/runtime/config.ts     Plan, Execute, Review overrides / limits
src/runtime/resources.ts  shared instructions, skills, extensions snapshot
src/session.ts            Conversation (budgets, nudges, queueing)
```

## Ownership

| Worq owns | Adapter owns |
|---|---|
| Runtime resolution (role → preset) | Native model resolution |
| Shared resources, prompt composition, `skill` tool | Loading native extension bytes |
| Tool schema validation and dispatch fencing | Native tool registration |
| Live runtime changes (when, to what, validation) | Safe request boundary and `configure` mechanics |
| Budgets, turn charging | Emitting `turn` events |
| Workflow and completion | Session execution |
| Event → log/telemetry formatting | Native event translation |

## Registry

```ts
export interface SDKRecord {
  modelRef: RegExp;                                  // used by loadConfig, no SDK import
  load(host: HostServices): Promise<SDKAdapter>;     // lazy import of the adapter file
}
export const SDKS: Record<string, SDKRecord> = { pi: { … } };
export async function createDriver(host, config, resources): Promise<Driver>;
```

`HostServices` carries explicit per-SDK host dependencies (`pi: { model, modelRegistry, thinkingLevel, agentDir }`) — no opaque context. `createDriver` preloads `pi` plus any SDK named by a role override. The TUI discovers other registered adapters on demand. Worq snapshots the selection at launch and passes it through the conversation. Per `open(spec)` the driver checks that runtime, composes the system prompt, appends the `skill` tool, attaches extensions, then calls the adapter.

## Contract

```ts
interface SDKAdapter {
  models(): Promise<readonly string[]>; // selectable native model refs
  defaultModel?(): string | undefined;  // read the host's current model
  defaultThinking?(): string | undefined; // read the host's current thinking level
  capabilities(runtime: Runtime): Capabilities;
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

## Capabilities

Pure data; `assertRuntime(runtime, caps, extensionCount)` judges and names the preset path (e.g. `/plan/thinking`).

| Field | Meaning | Denial |
|---|---|---|
| `switchModel` | `Handle.configure` can change the model | Manual model switch when `false` → `capability` |
| `thinking` | Levels the runtime's model accepts; `[]` = no level control | Configured level outside the list → `capability` |
| `context` | `replace` + no ambient instructions required | Anything else refuses the session |
| `extensions` | Can load shared native extensions | Installed extensions + `false` → `capability` |
| `turnUnit` | `request` (one `turn` per model request) or `prompt` | Informational; logged at open |

## Turn accounting

`turn` events charge the same budgets, but units differ: Pi emits one per model request; a CLI adapter that only sees prompts emits one per `prompt()` and must report `turnUnit: "prompt"`. `limits.*Turns` defaults (80/16/40) are Pi-calibrated — lower them for prompt-unit SDKs. Unobservable measures (requests, tokens) are omitted, never reported as zero.

## Extensions across SDKs

Shared `extensions/` files are SDK-native (Pi API). A non-Pi adapter reports `extensions: false`, so a mixed-SDK config with extensions installed fails as `capability` rather than silently degrading. Portable functionality belongs in Worq-owned surfaces (tools, instructions, skills); a portable hook contract is future work.

## Conformance

`test/conformance.test.ts` exports `adapterConformance(name, make, options)`, Conversation-level, run for MINIMAL and FULL capability sets; ambient context must be rejected. Router behaviour (routing, environment preparation, extension denial, unknown SDK) is asserted against `createDriver` with a recording adapter.

The live Pi run opens a real session, dispatches a Worq tool and submits: `WORQ_CONFORMANCE_PI=1 WORQ_CONFORMANCE_MODEL=<provider>/<model> npm test`. Unset, it skips.

## Tool bridge (design for the first CLI adapter)

For a process-boundary SDK the minimum `ask_main`-preserving equivalent is a loopback JSON-RPC tool bridge keyed by `spec.id`: `<state>/bridge/<spec.id>.sock` (dir 0700, socket 0600, per-session token), allowlisted to `spec.tools`, errors mapped to `tool-error`. Same framing as `src/control.ts`. Rejected: yield-and-resume (breaks the blocking guarantee in `prompts/protocol.md`). Lands as `src/sdk/bridge.ts` when needed.

## Adapters

### Pi (`pi`)

- `src/sdk/pi.ts` → `piAdapter(host)`.
- Refs `<provider>/<model>` (`^[^/\s]+\/[^\s]+$`); unknown ref → `config` naming the override (e.g. `/plan/model`); nothing resolves → `model`.
- Sessions: in-memory session + settings managers (compaction/retry off), fixed resource loader, explicit `agentDir`, and Main's model runtime when the host exposes it, so auth and extension-registered providers match Main.
- Capabilities: `switchModel: true`, thinking from the model, `extensions: true`, `turnUnit: "request"`, isolated context.
- `configure` uses `session.setModel` / `setThinkingLevel`. Pi clamps an incompatible level on a model-only switch; the adapter reports the effective level.
- Live changes apply at once when idle, or before the next request, even inside the same prompt. The adapter awaits `beforeRequest` before resolving provider inputs, never interrupting a running tool. For adapters without that hook, the core applies queued changes when the prompt settles.
