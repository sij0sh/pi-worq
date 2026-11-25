import type { Static, TSchema } from "typebox";
import type { Observation, Outcome } from "../telemetry.ts";
import { Block } from "../contracts.ts";

/**
 * The SDK contract. Worq owns model policy, resources, tool validation, budgets and workflow;
 * an adapter only translates a fully resolved SessionSpec into one native SDK session.
 */

export type ToolOutput = string | { text: string; image?: { mimeType: string; data: string }; terminate?: boolean };
export interface Tool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  /** Opt in only for independent, read-only operations. */
  parallel?: boolean;
  /** Params arrive already validated against `parameters` (the core wraps every tool). */
  run(params: Static<T>, signal: AbortSignal, report?: (outcome: Outcome) => void): Promise<ToolOutput> | ToolOutput;
}
export const tool = <T extends TSchema>(name: string, description: string, parameters: T, run: Tool<T>["run"], options?: Pick<Tool, "parallel">): Tool => ({ name, description, parameters, run, ...options } as Tool);

/** One runtime selection for a session. */
export interface Runtime {
  /** "main": Pi session defaults; "launch": a launch request set sdk, model or thinking. */
  name: string;
  sdk: string;
  model?: string;
  thinking?: string;
  /** Field prefix for refusals ("" for none). */
  path: string;
  /** Where the selection came from, "" for Main's defaults. */
  via: string;
}

/** What an SDK can do for a runtime. Pure data: the core judges (assertRuntime). */
export interface Capabilities {
  /** Handle.configure can change the model of a live session. */
  switchModel: boolean;
  /** Levels the runtime's model accepts; [] means no level control at all. */
  thinking: readonly string[];
  context: { system: "replace" | "append"; ambientInstructions: boolean };
  /** What one `turn` event counts: a model request, or a whole prompt when requests are invisible. */
  turnUnit: "request" | "prompt";
  /**
   * "awaited": the adapter calls `SessionSpec.admitRequest` once immediately before every actual outgoing
   * model request and releases nothing until allowed. `turn` events are observational only for core charging.
   */
  requestAdmission?: "awaited";
}

/** One normalized event stream from adapter to core. */
export type SessionEvent =
  | { type: "turn" }
  | { type: "tool-start"; name: string; args: unknown }
  | { type: "tool-error"; name: string; message: string }
  /** Assistant text; `completed` is false for errored/aborted messages. */
  | { type: "text"; text: string; completed: boolean }
  /** Top-level assistant response ended; no text or usage is required. */
  | { type: "response"; completed: boolean }
  | { type: "telemetry"; value: Observation }
  | { type: "log"; text: string };

/** Role-level session request: what the core asks the router for. */
export interface Spec {
  runtime?: Runtime;
  /** One identity per Conversation. */
  id: string;
  /** Role key: agent.<kind>, subagent[.<name>], review. */
  name: string;
  cwd: string;
  system: string;
  tools: Tool[];
  /** Session-specific skill packages (a workflow's own), indexed and readable alongside the shared ones. */
  skills?: readonly import("../runtime/skills.ts").Skill[];
  emit(event: SessionEvent): void;
  /** Optional safe boundary before a model request, including tool continuations within a prompt. */
  beforeRequest?(signal: AbortSignal): Promise<void>;
  /**
   * Awaited request admission, for adapters declaring `requestAdmission: "awaited"`. Called once immediately
   * before every actual outgoing model request; a refusal means no request is released.
   */
  admitRequest?(signal: AbortSignal): Promise<RequestDecision>;
  /** Aborts session opening; an adapter must not leave a live session behind it. */
  signal: AbortSignal;
}
/** Fully resolved session request: what an adapter receives. */
export interface SessionSpec extends Spec {
  runtime: Runtime;
  /** Selected thinking level; absent leaves it to the SDK. */
  thinking?: string;
}

/** A live runtime change; harness (sdk) stays locked for the session's lifetime. */
export interface RuntimeChange { model?: string; thinking?: string }

export type PromptOutcome = "completed" | "preflight-failed" | "failed" | "aborted";
/** A backend-neutral answer to one pre-request admission question. */
export type RequestDecision = { allowed: true } | { allowed: false; reason: unknown };
/** One live SDK session. */
export interface Handle {
  /** Resolves when the session goes idle. May assume the handle is idle. The signal is prompt-scoped. */
  prompt(text: string, signal?: AbortSignal): Promise<PromptOutcome>;
  /** Optional: deliver into the running turn; throws when it cannot. Absent → the core queues. */
  steer?(text: string): Promise<void>;
  readonly streaming: boolean;
  /** Settle the in-flight prompt and clear `streaming` within 5s. */
  abort(): Promise<void>;
  /** Effective SDK selection, including SDK defaults and any clamping. */
  readonly selection?: RuntimeChange;
  /** Mechanics only: apply model and/or thinking to the live session, keeping its history. The core decides when and to what. */
  configure?(change: RuntimeChange): Promise<void>;
  dispose(): void;
}
export interface CoreHandle extends Omit<Handle, "configure" | "selection"> {
  /** The runtime currently in effect (after any change). Absent on test doubles. */
  readonly runtime?: Runtime;
  /** Throws Block when the change cannot apply to this session. */
  check?(change: RuntimeChange): void;
  /** Validate then apply. */
  configure?(change: RuntimeChange): Promise<void>;
}

/** Per-SDK adapter. */
export interface SDKAdapter {
  /** Optional information for the /worq picker. Never required for a launch. */
  models(): Promise<readonly string[]>;
  defaultModel?(): string | undefined;
  defaultThinking?(): string | undefined;
  capabilities(runtime: Runtime): Capabilities;
  /**
   * Required local preflight for a resolved runtime, before Worq reserves a slot, ref or worktree.
   * Must not open a session, list models, probe credentials or send a request. Rejects malformed or locally
   * unknown models, a missing required model and unsupported adapter-specific selections. It does not claim the
   * backend will accept the model: account, network and provider-side resolution may still fail at open.
   */
  validateRuntime(runtime: Runtime, signal: AbortSignal): void | Promise<void>;
  open(spec: SessionSpec): Promise<Handle>;
}
/** Role router the core drives (see sdk/registry.ts). */
export interface Driver {
  /** Installed SDK ids (Pi first). */
  sdks?(): readonly string[];
  /** Import one SDK's adapter by id; required before its sync methods. Rejects unknown ids. */
  load?(sdk: string): Promise<void>;
  /** Picker information: each loadable SDK's models. A failing SDK is skipped. */
  catalog?(sdk?: string): Promise<ReadonlyMap<string, readonly string[]>>;
  defaultModel?(sdk: string): string | undefined;
  defaultThinking?(sdk: string): string | undefined;
  capabilities(role: string, runtime?: Runtime): Capabilities;
  /** The adapter's local preflight (SDKAdapter.validateRuntime). */
  validate?(runtime: Runtime, signal: AbortSignal): Promise<void>;
  open(spec: Spec): Promise<CoreHandle>;
}

/** Inherit only levels the selected model supports. Explicit overrides are validated separately. */
export function supportedThinking(level: string | undefined, levels: readonly string[]): string | undefined {
  return level !== undefined && levels.includes(level) ? level : undefined;
}

const at = (runtime: Runtime, field: string) => runtime.path ? `${runtime.path}/${field}` : field;
/** Judge a resolved runtime against what its SDK can do. Raises Block("capability") naming the config path. */
export function assertRuntime(runtime: Runtime, caps: Capabilities): void {
  if (runtime.thinking !== undefined && !caps.thinking.includes(runtime.thinking)) {
    throw new Block("capability", caps.thinking.length
      ? `${at(runtime, "thinking")}: ${runtime.thinking} is not a ${runtime.sdk} thinking level (${caps.thinking.join(", ")})`
      : `${at(runtime, "thinking")}: ${runtime.sdk} has no thinking level control`);
  }
  if (caps.context.system !== "replace" || caps.context.ambientInstructions) throw new Block("capability", `${at(runtime, "sdk")}: ${runtime.sdk} cannot isolate context`);
}
