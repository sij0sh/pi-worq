import { assertRuntime, supportedThinking, type Driver, type Runtime } from '../sdk/contract.ts';
import { MAIN } from './config.ts';

/** One pickable model; `thinking` is the SDK's default level for it, when supported. */
export interface ModelChoice { sdk: string; model?: string; levels: readonly string[]; thinking?: string }
/** Explicit runtime fields of one launch. Absent fields inherit: Pi from Main, other SDKs from their adapter. */
export interface RuntimeRequest { sdk?: string; model?: string; thinking?: string }

/**
 * The single resolver for every launch route (/worq, worq_spawn, CLI). Loads only the requested adapter, applies
 * explicit fields first, inherits compatible defaults, then runs the adapter's local preflight. Never enumerates models.
 * Explicit unsupported values are refused; only an incompatible inherited thinking level is dropped.
 */
export async function resolveRuntime(driver: Driver, request: RuntimeRequest, signal: AbortSignal): Promise<Runtime> {
  signal.throwIfAborted();
  const sdk = request.sdk ?? MAIN.sdk;
  await driver.load?.(sdk);
  signal.throwIfAborted();
  const explicit = request.sdk !== undefined || request.model !== undefined || request.thinking !== undefined;
  const runtime: Runtime = { name: explicit ? 'launch' : MAIN.name, sdk, path: '', via: explicit ? 'launch request' : '' };
  const model = request.model ?? driver.defaultModel?.(sdk);
  if (model !== undefined) runtime.model = model;
  if (request.thinking !== undefined) runtime.thinking = request.thinking;
  const caps = driver.capabilities('agent', runtime);
  assertRuntime(runtime, caps);
  const inherited = request.thinking === undefined ? supportedThinking(driver.defaultThinking?.(sdk), caps.thinking) : undefined;
  if (inherited !== undefined) runtime.thinking = inherited;
  await driver.validate?.(runtime, signal);
  signal.throwIfAborted();
  return Object.freeze(runtime);
}

/**
 * Picker information: `current` first, then every runnable model per SDK, each SDK's default first.
 * `sdk` locks the harness (live sessions cannot change it). A failing SDK is skipped, never fatal.
 */
export async function modelChoices(driver: Driver, current: Runtime, sdk?: string): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = [{ sdk: current.sdk, model: current.model, levels: driver.capabilities('agent', current).thinking, thinking: current.thinking }];
  if (!driver.catalog) return choices;
  const add = (name: string, model: string | undefined) => {
    if (choices.some((c) => c.sdk === name && c.model === model)) return;
    const candidate: Runtime = { ...current, sdk: name, model, thinking: undefined };
    try {
      const supported = driver.capabilities('agent', candidate);
      assertRuntime(candidate, supported);
      let thinking: string | undefined;
      try { thinking = supportedThinking(driver.defaultThinking?.(name), supported.thinking); } catch { /* no default */ }
      choices.push({ sdk: name, model, levels: supported.thinking, thinking });
    } catch { /* not runnable */ }
  };
  for (const [name, models] of await driver.catalog()) {
    if (sdk !== undefined && name !== sdk) continue;
    let fallback: string | undefined;
    try { fallback = driver.defaultModel?.(name); } catch { /* none */ }
    add(name, fallback);
    for (const model of new Set(models)) add(name, model);
  }
  return choices;
}
