import { Block } from "../contracts.ts";
import type { Config } from "../runtime/config.ts";
import { compose, EMPTY, skillTool, type Resources } from "../runtime/resources.ts";
import { assertRuntime, type CoreHandle, type Driver, type SDKAdapter, type SessionEvent } from "./contract.ts";
import type { PiHost } from "./pi.ts";

/** Explicit host dependencies, one optional entry per SDK that needs something from the host. */
export interface HostServices { pi?: PiHost }

/**
 * One record per SDK: metadata `loadConfig` needs (no SDK import) plus a lazy loader.
 * Adding an SDK = one adapter file under src/sdk/ + one record here.
 */
export interface SDKRecord {
  /** Model refs this SDK can resolve. */
  modelRef: RegExp;
  load(host: HostServices): Promise<SDKAdapter>;
}
export const SDKS: Record<string, SDKRecord> = {
  pi: { modelRef: /^[^/\s]+\/[^\s]+$/, load: async (host) => (await import("./pi.ts")).piAdapter(host.pi) },
};

/**
 * The core's single Driver. Per role it resolves the runtime preset, judges it against the SDK's
 * capabilities, prepares the shared environment (instructions, skill index + `skill` tool, extensions)
 * and owns fallback policy; the adapter only executes.
 */
export async function createDriver(host: HostServices, config: Config, resources: Resources = EMPTY, sdks: Record<string, SDKRecord> = SDKS): Promise<Driver> {
  const adapters = new Map<string, SDKAdapter>();
  const load = async (sdk: string) => {
    const record = sdks[sdk];
    if (!record) throw new Block("config", `${config.path}: unknown sdk "${sdk}" (available: ${Object.keys(sdks).join(", ")})`);
    if (!adapters.has(sdk)) adapters.set(sdk, await record.load(host));
  };
  const adapter = (sdk: string) => {
    const found = adapters.get(sdk);
    if (!found) throw new Block("config", `${config.path}: unknown sdk "${sdk}" (available: ${[...adapters.keys()].join(", ")})`);
    return found;
  };
  // Lazily import only the SDKs a role can reach: the built-in "pi" plus every declared preset.
  await Promise.all([...new Set(["pi", ...config.sdks])].filter((sdk) => sdks[sdk]).map(load));
  const skill = skillTool(resources);
  const skills = resources.skills.map((s) => s.name);

  return {
    capabilities(role) {
      const runtime = config.runtime(role);
      return adapter(runtime.sdk).capabilities(runtime);
    },
    async open(spec): Promise<CoreHandle> {
      const runtime = config.runtime(spec.name);
      const sdk = adapter(runtime.sdk);
      const caps = sdk.capabilities(runtime);
      assertRuntime(runtime, caps, resources.extensions.length);
      const thinking = runtime.thinking ?? (caps.thinking.includes("low") ? "low" : undefined);
      const emit = (event: SessionEvent) => spec.emit(event.type === "telemetry" && "setup" in event.value
        ? { type: "telemetry", value: { setup: { ...event.value.setup, skills } } } : event);
      spec.emit({ type: "log", text: `Role ${spec.name}: runtime ${runtime.name} (${runtime.sdk}, ${runtime.model ?? "Main's model"}), thinking ${thinking ?? "uncontrolled"}, turn unit ${caps.turnUnit}; via ${runtime.via || "built-in"}` });
      const handle = await sdk.open({
        ...spec, emit, runtime, thinking, extensions: resources.extensions,
        system: compose(spec.system, resources),
        tools: skill && !spec.tools.some((t) => t.name === skill.name) ? [...spec.tools, skill] : spec.tools,
      });
      if (spec.signal.aborted) { handle.dispose(); throw spec.signal.reason; }
      let fallback = runtime.fallbackModel !== runtime.model ? runtime.fallbackModel : undefined;
      return {
        prompt: (text, options) => handle.prompt(text, options),
        steer: handle.steer && ((text) => handle.steer!(text)),
        get streaming() { return handle.streaming; },
        abort: () => handle.abort(),
        async fallback() {
          if (!fallback || !handle.switchModel) return false;
          const next = fallback;
          fallback = undefined;
          await handle.switchModel(next);
          spec.emit({ type: "log", text: `switched to fallback model ${next}` });
          return true;
        },
        dispose: () => handle.dispose(),
      };
    },
  };
}

