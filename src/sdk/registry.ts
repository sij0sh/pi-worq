import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Block, errorText } from "../contracts.ts";
import { MAIN } from "../runtime/config.ts";
import { compose, EMPTY, skillTool, type Resources } from "../runtime/resources.ts";
import { contained, exists, outsideCheckout } from "../runtime/skills.ts";
import { assertRuntime, supportedThinking, type CoreHandle, type Driver, type Runtime, type RuntimeChange, type SDKAdapter, type SessionEvent } from "./contract.ts";
import type { PiHost } from "./pi.ts";

/** Explicit host dependencies. Only the shipped Pi adapter needs any; installed adapters get `AdapterContext`. */
export interface HostServices { pi?: PiHost }

/** One SDK: a lazy loader. Discovery never imports it. */
export interface SDKRecord {
  load(host: HostServices): Promise<SDKAdapter>;
}
export const PI: SDKRecord = { load: async (host) => (await import("./pi.ts")).piAdapter(host.pi) };

/** What an installed adapter's factory receives. */
export interface AdapterContext { id: string; dir: string; agentDir: string }
/**
 * Installed adapter entry: `<agentDir>/worq/adapters/<id>/adapter.mjs`, default export
 * `{ version: 1, create(context: AdapterContext): SDKAdapter | Promise<SDKAdapter> }`.
 * Installing one is the trust opt-in: it runs in-process as operator code (not a sandbox).
 */
export interface AdapterFactory { version: 1; create(context: AdapterContext): SDKAdapter | Promise<SDKAdapter> }
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const METHODS = ["models", "capabilities", "validateRuntime", "open"] as const;

/**
 * The shipped Pi record plus every adapter folder in the operator's global directory. Folder = id.
 * Never project-local, never a path from a launch request. Broken folders are reported; siblings still register.
 */
export function discoverAdapters(agentDir: string): { records: Record<string, SDKRecord>; problems: { path: string; message: string }[] } {
  const records: Record<string, SDKRecord> = { pi: PI };
  const problems: { path: string; message: string }[] = [];
  const base = join(agentDir, "worq", "adapters");
  try {
    if (!exists(base)) return { records, problems };
    const root = realpathSync(base);
    outsideCheckout(root);
    for (const id of readdirSync(root).sort()) {
      if (id.startsWith(".")) continue;
      const path = join(root, id);
      try {
        if (!lstatSync(path).isDirectory()) continue;
        if (!ID.test(id)) throw new Block("sdk", "adapter folder name must be lowercase letters and digits, hyphen-separated");
        if (id === "pi") throw new Block("sdk", "pi is the shipped adapter and cannot be replaced");
        const dir = contained(root, path);
        const entry = join(dir, "adapter.mjs");
        if (!exists(entry)) throw new Block("sdk", "add adapter.mjs");
        const file = contained(dir, entry);
        if (!lstatSync(file).isFile()) throw new Block("sdk", "adapter.mjs must be a regular file");
        records[id] = { load: () => importAdapter(id, file, dir, agentDir) };
      } catch (error) { problems.push({ path, message: errorText(error) }); }
    }
  } catch (error) { problems.push({ path: base, message: errorText(error) }); }
  return { records, problems };
}
async function importAdapter(id: string, file: string, dir: string, agentDir: string): Promise<SDKAdapter> {
  const module = await import(pathToFileURL(file).href) as { default?: Partial<AdapterFactory> };
  const factory = module.default;
  if (factory?.version !== 1 || typeof factory.create !== "function") throw new Block("sdk", `${file}: default export must be { version: 1, create(context) }`);
  const adapter = await factory.create({ id, dir, agentDir });
  const missing = METHODS.filter((name) => typeof (adapter as unknown as Record<string, unknown> | undefined)?.[name] !== "function");
  if (missing.length) throw new Block("sdk", `${file}: adapter lacks ${missing.join(", ")}`);
  return adapter;
}

/**
 * The core's single Driver. Imports each SDK lazily by id (once, in-flight loads shared), judges runtimes
 * against the SDK's capabilities and prepares the shared environment (instructions, skill index + `skill` tool, extensions).
 */
export async function createDriver(host: HostServices, resources: Resources = EMPTY, sdks: Record<string, SDKRecord> = { pi: PI }): Promise<Driver> {
  const loading = new Map<string, Promise<SDKAdapter>>();
  const adapters = new Map<string, SDKAdapter>();
  const installed = () => Object.keys(sdks).sort((a, b) => a === "pi" ? -1 : b === "pi" ? 1 : a.localeCompare(b));
  const load = async (sdk: string) => {
    if (adapters.has(sdk)) return adapters.get(sdk)!;
    const record = Object.hasOwn(sdks, sdk) ? sdks[sdk] : undefined;
    if (!record) throw new Block("sdk", `Unknown sdk "${sdk}" (installed: ${installed().join(", ")})`);
    let pending = loading.get(sdk);
    if (!pending) {
      pending = record.load(host).then((adapter) => { adapters.set(sdk, adapter); return adapter; }, (error) => {
        loading.delete(sdk);
        throw new Block("sdk", `sdk "${sdk}" could not load: ${errorText(error)}`);
      });
      loading.set(sdk, pending);
    }
    return pending;
  };
  const adapter = (sdk: string) => {
    const found = adapters.get(sdk);
    if (!found) throw new Block("sdk", `sdk "${sdk}" is not loaded`);
    return found;
  };

  return {
    sdks: installed,
    async load(sdk) { await load(sdk); },
    async catalog() {
      const catalog = new Map<string, readonly string[]>();
      for (const sdk of installed()) {
        // Picker information only: one failing adapter must not hide the others.
        try { await load(sdk); catalog.set(sdk, await adapter(sdk).models()); }
        catch { if (adapters.has(sdk)) catalog.set(sdk, []); }
      }
      return catalog;
    },
    defaultModel(sdk) { return adapter(sdk).defaultModel?.(); },
    defaultThinking(sdk) { return adapter(sdk).defaultThinking?.(); },
    capabilities(_role, runtime = MAIN) {
      return adapter(runtime.sdk).capabilities(runtime);
    },
    async validate(runtime, signal) {
      signal.throwIfAborted();
      await (await load(runtime.sdk)).validateRuntime(runtime, signal);
      signal.throwIfAborted();
    },
    async open(spec): Promise<CoreHandle> {
      spec.signal.throwIfAborted();
      const preset = spec.runtime ?? MAIN;
      const sdk = await load(preset.sdk);
      const runtime = spec.runtime ?? { ...preset, model: preset.model ?? sdk.defaultModel?.() };
      const caps = sdk.capabilities(runtime);
      assertRuntime(runtime, caps, resources.extensions.length);
      // A supplied selection was resolved at admission, even if it leaves thinking to the SDK.
      const thinking = runtime.thinking ?? (spec.runtime ? undefined : supportedThinking(sdk.defaultThinking?.(), caps.thinking));
      const { skills: own = [], ...rest } = spec;
      const packages = [...resources.skills, ...own.filter((s) => !resources.skills.some((r) => r.name === s.name))];
      const skill = skillTool(packages);
      const skills = packages.map((s) => s.name);
      const emit = (event: SessionEvent) => spec.emit(event.type === "telemetry" && "setup" in event.value
        ? { type: "telemetry", value: { setup: { ...event.value.setup, sdk: runtime.sdk, skills } } } : event);
      spec.emit({ type: "log", text: `Role ${spec.name}: runtime ${runtime.name} (${runtime.sdk}, ${runtime.model ?? "Main's model"}), thinking ${thinking ?? "uncontrolled"}, turn unit ${caps.turnUnit}; via ${runtime.via || "Main's defaults"}` });
      const handle = await sdk.open({
        ...rest, emit, runtime, thinking, extensions: resources.extensions,
        system: compose(spec.system, resources, packages),
        tools: skill && !rest.tools.some((t) => t.name === skill.name) ? [...rest.tools, skill] : rest.tools,
      });
      if (spec.signal.aborted) { handle.dispose(); throw spec.signal.reason; }
      let current: Runtime = { ...runtime, thinking, ...handle.selection };
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
      return {
        prompt: (text) => handle.prompt(text),
        steer: handle.steer && ((text) => handle.steer!(text)),
        get streaming() { return handle.streaming; },
        get runtime() { return current; },
        abort: () => handle.abort(),
        check(change) { check(change); },
        async configure(change) {
          const next = check(change);
          await handle.configure!(change);
          current = { ...next, ...handle.selection };
          spec.emit({ type: "log", text: `runtime changed by Main: ${current.model ?? "default model"}, thinking ${current.thinking ?? "uncontrolled"}` });
        },
        dispose: () => handle.dispose(),
      };
    },
  };
}

