import { errorText } from '../contracts.ts';
import { assertRuntime, supportedThinking, type Driver, type Runtime } from '../sdk/contract.ts';
import { MAIN } from './config.ts';
import { hintThinking, type RuntimeHint } from './hints.ts';

/** One pickable model; `thinking` is the SDK's default level for it, when supported. */
export interface ModelChoice { sdk: string; model?: string; levels: readonly string[]; thinking?: string }
/** Explicit runtime fields of one launch. Absent fields inherit: Pi from Main, other SDKs from their adapter. */
export interface RuntimeRequest { sdk?: string; model?: string; thinking?: string }

/**
 * The single resolver for every launch route (/worq, worq_spawn, CLI). Loads only the requested adapter, applies
 * explicit fields first, inherits compatible defaults, then runs the adapter's local preflight. Never enumerates models.
 * Explicit unsupported values are refused; only an incompatible inherited thinking level is dropped.
 */
export async function resolveRuntime(driver: Driver, request: RuntimeRequest, signal: AbortSignal, hinted?: Hinted): Promise<Runtime> {
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
  if (!hinted) return Object.freeze(runtime);
  return applyHint(driver, runtime, hinted, signal, { sdk: request.sdk !== undefined, model: request.model !== undefined, thinking: request.thinking !== undefined });
}

/** A RUNTIMES.md hint for one role, with where to report a skipped one. */
export interface Hinted { hint?: RuntimeHint; role: string; warn?(message: string): void }
type Locked = { sdk?: boolean; model?: boolean; thinking?: boolean };

/**
 * Soft-apply a hint over an already-resolved runtime: only unlocked (non-explicit) fields change. A hint naming
 * another harness than an explicit sdk is ignored for sdk/model. A hinted model failing local preflight warns and
 * falls back to `base`'s model. Thinking hints never throw: unsupported levels snap down or drop.
 */
export async function applyHint(driver: Driver, base: Runtime, hinted: Hinted, signal: AbortSignal, locked: Locked = {}): Promise<Runtime> {
  const { hint, role, warn } = hinted;
  if (!hint) return base;
  const crossSdk = locked.sdk && (hint.sdk ?? MAIN.sdk) !== base.sdk;
  const sdk = !locked.sdk && !locked.model && hint.sdk ? hint.sdk : base.sdk;
  const model = !locked.model && !crossSdk && hint.model ? hint.model : sdk !== base.sdk ? undefined : base.model;
  const moved = sdk !== base.sdk || model !== base.model;
  const thinkingHint = locked.thinking ? undefined : hint.thinking;
  if (!moved && thinkingHint === undefined) return base;
  try {
    if (moved) await driver.load?.(sdk);
    signal.throwIfAborted();
    const next: Runtime = { ...base, sdk, via: [base.via, `RUNTIMES.md (${role})`].filter(Boolean).join(' + ') };
    const chosen = model ?? (sdk !== base.sdk ? driver.defaultModel?.(sdk) : undefined);
    if (chosen !== undefined) next.model = chosen; else delete next.model;
    const caps = driver.capabilities('agent', { ...next, thinking: undefined });
    const inherited = locked.thinking ? base.thinking : base.thinking ?? driver.defaultThinking?.(sdk);
    const thinking = locked.thinking ? base.thinking
      : thinkingHint !== undefined ? hintThinking(thinkingHint, inherited, caps.thinking) : supportedThinking(inherited, caps.thinking);
    if (thinking !== undefined) next.thinking = thinking; else delete next.thinking;
    assertRuntime(next, caps);
    if (moved) await driver.validate?.(next, signal);
    signal.throwIfAborted();
    return Object.freeze(next);
  } catch (error) {
    if (signal.aborted || !moved) throw error;
    warn?.(`RUNTIMES.md (${role}): ${[hint.sdk, hint.model].filter(Boolean).join(' ')} unavailable (${errorText(error)}); falling back to ${base.model ?? base.sdk}`);
    return applyHint(driver, base, { ...hinted, hint: { ...hint, sdk: undefined, model: undefined } }, signal, locked);
  }
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
  for (const [name, models] of await driver.catalog(sdk)) {
    if (sdk !== undefined && name !== sdk) continue;
    let fallback: string | undefined;
    try { fallback = driver.defaultModel?.(name); } catch { /* none */ }
    add(name, fallback);
    for (const model of new Set(models)) add(name, model);
  }
  return choices;
}
