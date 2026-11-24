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
  /** Params arrive already validated against `parameters` (the core wraps every tool). */
  run(params: Static<T>, signal: AbortSignal, report?: (outcome: Outcome) => void): Promise<ToolOutput> | ToolOutput;
}
export const tool = <T extends TSchema>(name: string, description: string, parameters: T, run: Tool<T>["run"]): Tool => ({ name, description, parameters, run } as Tool);

/** One named preset from config `runtimes`, resolved for a role. */
export interface Runtime {
  /** Preset name; "main" is the built-in preset (Pi, Main's model). */
  name: string;
  sdk: string;
  model?: string;
  fallbackModel?: string;
  thinking?: string;
  /** JSON path the preset came from (`/runtimes/<name>`), "" for the built-in one. */
  path: string;
  /** JSON path that selected the preset for this role (`/roles/<key>`, `/default`), "" when built-in. */
  via: string;
}

/** What an SDK can do for a runtime. Pure data: the core judges (assertRuntime). */
export interface Capabilities {
  /** Handle.switchModel works. */
  switchModel: boolean;
  /** Levels the runtime's model accepts; [] means no level control at all. */
  thinking: readonly string[];
  context: { system: "replace" | "append"; ambientInstructions: boolean };
  /** The SDK can load the shared native extension files (Pi only today). */
  extensions: boolean;
  /** What one `turn` event counts: a model request, or a whole prompt when requests are invisible. */
  turnUnit: "request" | "prompt";
}

/** One normalized event stream from adapter to core. */
export type SessionEvent =
  | { type: "turn" }
  | { type: "tool-start"; name: string; args: unknown }
  | { type: "tool-error"; name: string; message: string }
  /** Assistant text; `completed` is false for errored/aborted messages. */
  | { type: "text"; text: string; completed: boolean }
  | { type: "telemetry"; value: Observation }
  | { type: "log"; text: string };

/** Role-level session request: what the core asks the router for. */
export interface Spec {
  runtime?: Runtime;
  /** One identity per Conversation. */
  id: string;
  /** Role key: agent.<kind>, subagent[.<name>], reviewer.<name>. */
  name: string;
  cwd: string;
  system: string;
  tools: Tool[];
  /** Session-specific skill packages (a workflow's own), indexed and readable alongside the shared ones. */
  skills?: readonly import("../runtime/skills.ts").Skill[];
  emit(event: SessionEvent): void;
  /** Aborts session opening; an adapter must not leave a live session behind it. */
  signal: AbortSignal;
}
/** Native extension file from the shared resource snapshot. */
export interface ExtensionFile { name: string; bytes: Buffer }
/** Fully resolved session request: what an adapter receives. */
export interface SessionSpec extends Spec {
  runtime: Runtime;
  /** Resolved thinking level (runtime's, else the core default when supported). */
  thinking?: string;
  extensions: readonly ExtensionFile[];
}

export type PromptOutcome = "completed" | "preflight-failed" | "failed" | "aborted";
/** One live SDK session. */
export interface Handle {
  /** Resolves when the session goes idle. May assume the handle is idle. */
  prompt(text: string, options?: { toolFree: boolean }): Promise<PromptOutcome>;
  /** Optional: deliver into the running turn; throws when it cannot. Absent → the core queues. */
  steer?(text: string): Promise<void>;
  readonly streaming: boolean;
  /** Settle the in-flight prompt and clear `streaming` within 5s. */
  abort(): Promise<void>;
  /** Mechanics only: switch to this model ref. The core decides when and to what. */
  switchModel?(ref: string): Promise<void>;
  dispose(): void;
}
/** Model fallback lives in the core: one switch to the runtime's fallbackModel. */
export interface CoreHandle extends Omit<Handle, "switchModel"> { fallback(): Promise<boolean> }

/** Per-SDK adapter. */
export interface SDKAdapter {
  models(): Promise<readonly string[]>;
  defaultModel?(): string | undefined;
  capabilities(runtime: Runtime): Capabilities;
  open(spec: SessionSpec): Promise<Handle>;
}
/** Role router the core drives (see sdk/registry.ts). */
export interface Driver {
  catalog?(): Promise<ReadonlyMap<string, readonly string[]>>;
  defaultModel?(sdk: string): string | undefined;
  capabilities(role: string, runtime?: Runtime): Capabilities;
  open(spec: Spec): Promise<CoreHandle>;
}

const at = (runtime: Runtime, field: string) => runtime.path ? `${runtime.path}/${field}` : field;
/** Judge a resolved runtime against what its SDK can do. Raises Block("capability") naming the config path. */
export function assertRuntime(runtime: Runtime, caps: Capabilities, extensions = 0): void {
  if (runtime.fallbackModel !== undefined && !caps.switchModel) throw new Block("capability", `${at(runtime, "fallbackModel")}: ${runtime.sdk} cannot switch models`);
  if (runtime.thinking !== undefined && !caps.thinking.includes(runtime.thinking)) {
    throw new Block("capability", caps.thinking.length
      ? `${at(runtime, "thinking")}: ${runtime.thinking} is not a ${runtime.sdk} thinking level (${caps.thinking.join(", ")})`
      : `${at(runtime, "thinking")}: ${runtime.sdk} has no thinking level control`);
  }
  if (extensions && !caps.extensions) throw new Block("capability", `${at(runtime, "sdk")}: ${runtime.sdk} cannot load the ${extensions} installed native extension(s)`);
  if (caps.context.system !== "replace" || caps.context.ambientInstructions) throw new Block("capability", `${at(runtime, "sdk")}: ${runtime.sdk} cannot isolate context`);
}
