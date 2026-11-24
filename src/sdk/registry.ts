import { Block } from "../contracts.ts";
import type { Config } from "../runtime/config.ts";
import { compose, EMPTY, skillTool, type Resources } from "../runtime/resources.ts";
import { assertRuntime, type CoreHandle, type Driver, type Runtime, type RuntimeChange, type SDKAdapter, type SessionEvent } from "./contract.ts";
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

  return {
    async catalog() {
      const catalog = new Map<string, readonly string[]>();
      for (const sdk of Object.keys(sdks)) {
        // An optional backend without host services must not block installed ones.
        if (!adapters.has(sdk)) { try { await load(sdk); } catch { continue; } }
        catalog.set(sdk, await adapter(sdk).models());
      }
      return catalog;
    },
    defaultModel(sdk) { return adapter(sdk).defaultModel?.(); },
    capabilities(role, runtime = config.runtime(role)) {
      return adapter(runtime.sdk).capabilities(runtime);
    },
    async open(spec): Promise<CoreHandle> {
      spec.signal.throwIfAborted();
      const runtime = spec.runtime ?? config.runtime(spec.name);
      const sdk = adapter(runtime.sdk);
      const caps = sdk.capabilities(runtime);
      assertRuntime(runtime, caps, resources.extensions.length);
      const thinking = runtime.thinking ?? (caps.thinking.includes("low") ? "low" : undefined);
      const { skills: own = [], ...rest } = spec;
      const packages = [...resources.skills, ...own.filter((s) => !resources.skills.some((r) => r.name === s.name))];
      const skill = skillTool(packages);
      const skills = packages.map((s) => s.name);
      const emit = (event: SessionEvent) => spec.emit(event.type === "telemetry" && "setup" in event.value
        ? { type: "telemetry", value: { setup: { ...event.value.setup, sdk: runtime.sdk, skills } } } : event);
      spec.emit({ type: "log", text: `Role ${spec.name}: runtime ${runtime.name} (${runtime.sdk}, ${runtime.model ?? "Main's model"}), thinking ${thinking ?? "uncontrolled"}, turn unit ${caps.turnUnit}; via ${runtime.via || "built-in"}` });
      const handle = await sdk.open({
        ...rest, emit, runtime, thinking, extensions: resources.extensions,
        system: compose(spec.system, resources, packages),
        tools: skill && !rest.tools.some((t) => t.name === skill.name) ? [...rest.tools, skill] : rest.tools,
      });
      if (spec.signal.aborted) { handle.dispose(); throw spec.signal.reason; }
      let fallback = runtime.fallbackModel !== runtime.model ? runtime.fallbackModel : undefined;
      let current: Runtime = { ...runtime, thinking };
      const check = (change: RuntimeChange): Runtime => {
        if (change.model === undefined && change.thinking === undefined) throw new Block("invalid-payload", "Nothing to change");
        if (change.model !== undefined && change.model !== current.model && !caps.switchModel) throw new Block("capability", `${spec.name}: ${runtime.sdk} cannot switch models`);
        if (!handle.configure) throw new Block("capability", `${spec.name}: ${runtime.sdk} cannot change a live session`);
        const next: Runtime = { ...current, ...(change.model !== undefined ? { model: change.model } : {}), ...(change.thinking !== undefined ? { thinking: change.thinking } : {}) };
        const levels = sdk.capabilities(next).thinking;
        if (change.thinking !== undefined && !levels.includes(change.thinking)) {
          throw new Block("capability", levels.length ? `${spec.name}: ${change.thinking} is not a thinking level for ${next.model ?? "this model"} (${levels.join(", ")})` : `${spec.name}: ${next.model ?? "this model"} has no thinking level control`);
        }
        return next;
      };
      const apply = async (change: RuntimeChange, next: Runtime) => {
        await handle.configure!(change);
        current = next;
      };
      return {
        prompt: (text, options) => handle.prompt(text, options),
        steer: handle.steer && ((text) => handle.steer!(text)),
        get streaming() { return handle.streaming; },
        get runtime() { return current; },
        abort: () => handle.abort(),
        async fallback() {
          if (!fallback || !handle.configure) return false;
          const next = fallback;
          fallback = undefined;
          await apply({ model: next }, { ...current, model: next });
          spec.emit({ type: "log", text: `switched to fallback model ${next}` });
          return true;
        },
        check(change) { check(change); },
        async configure(change) {
          const next = check(change);
          await apply(change, next);
          // Main chose this runtime: a stale preset fallback no longer applies.
          if (change.model !== undefined) fallback = undefined;
          spec.emit({ type: "log", text: `runtime changed by Main: ${next.model ?? "default model"}, thinking ${next.thinking ?? "uncontrolled"}` });
        },
        dispose: () => handle.dispose(),
      };
    },
  };
}

