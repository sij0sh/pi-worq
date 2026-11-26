import { errorText } from '../contracts.ts';
import { assertRuntime, supportedThinking, type Driver, type Runtime } from '../sdk/contract.ts';
import { MAIN } from './config.ts';
import { hintThinking, type RoutedCandidate } from './routing.ts';

/** One pickable model; `thinking` is the SDK's default level for it, when supported. */
export interface ModelChoice { sdk: string; model?: string; levels: readonly string[]; thinking?: string }
/** Explicit runtime fields of one launch. Absent fields inherit: Pi from Main, other SDKs from their adapter. */
export interface RuntimeRequest { sdk?: string; model?: string; thinking?: string }

/** Prioritized routing.json candidates and/or soft thinking cap for one role, with where to report skipped ones. */
export interface Routed {
  candidates?: readonly RoutedCandidate[];
  thinking?: string;
  role: string;
  warn?(message: string): void;
}
type Locked = { sdk?: boolean; model?: boolean; thinking?: boolean };

/**
 * The single resolver for every launch route (/worq, worq_spawn, CLI). Loads only the requested adapter, applies
 * explicit fields first, inherits compatible defaults, then runs the adapter's local preflight. Never enumerates models.
 * Explicit unsupported values are refused; only an incompatible inherited thinking level is dropped.
 */
export async function resolveRuntime(driver: Driver, request: RuntimeRequest, signal: AbortSignal, routed?: Routed): Promise<Runtime> {
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
  const locked: Locked = { sdk: request.sdk !== undefined, model: request.model !== undefined, thinking: request.thinking !== undefined };
  if (routed) {
    const selected = await applyRouting(driver, runtime, routed, signal, locked);
    if (selected) return selected;
  }
  return Object.freeze(runtime);
}

/**
 * Soft-apply prioritized routing.json candidates (and/or a role-level soft thinking cap) over an already-resolved
 * runtime: only unlocked fields change. Candidates conflicting with locked sdk/model are skipped. Candidates failing
 * local adapter preflight warn once and fall through to the next candidate/rule. Thinking snaps down or drops softly.
 */
export async function applyRouting(driver: Driver, base: Runtime, routed: Routed, signal: AbortSignal, locked: Locked = {}): Promise<Runtime | undefined> {
  if (locked.sdk && locked.model && locked.thinking) return undefined;
  const { role, warn } = routed;
  for (const candidate of routed.candidates ?? []) {
    signal.throwIfAborted();
    if (locked.sdk && candidate.sdk !== base.sdk) continue;
    if (locked.model && candidate.model !== base.model) continue;
    const sdk = locked.sdk ? base.sdk : candidate.sdk;
    const model = locked.model ? base.model : candidate.model;
    const moved = sdk !== base.sdk || model !== base.model;
    const tag = candidate.ruleName ? `routing.json (${role}: ${candidate.ruleName})` : `routing.json (${role})`;
    const thinkingHint = candidate.thinking ?? routed.thinking;
    try {
      if (moved) await driver.load?.(sdk);
      signal.throwIfAborted();
      const next: Runtime = { ...base, sdk, via: [base.via, tag].filter(Boolean).join(' + ') };
      if (model !== undefined) next.model = model; else delete next.model;
      const caps = driver.capabilities('agent', { ...next, thinking: undefined });
      const inherited = locked.thinking ? base.thinking : base.thinking ?? driver.defaultThinking?.(sdk);
      const thinking = locked.thinking
        ? base.thinking
        : thinkingHint !== undefined
          ? hintThinking(thinkingHint, inherited, caps.thinking)
          : supportedThinking(inherited, caps.thinking);
      if (thinking !== undefined) next.thinking = thinking; else delete next.thinking;
      assertRuntime(next, caps);
      if (moved) await driver.validate?.(next, signal);
      signal.throwIfAborted();
      return Object.freeze(next);
    } catch (error) {
      if (signal.aborted) throw error;
      warn?.(`${tag}: ${candidate.sdk} ${candidate.model} unavailable (${errorText(error)}); trying next candidate`);
    }
  }
  if (!locked.thinking && routed.thinking !== undefined) {
    const caps = driver.capabilities('agent', { ...base, thinking: undefined });
    const inherited = base.thinking ?? driver.defaultThinking?.(base.sdk);
    const thinking = hintThinking(routed.thinking, inherited, caps.thinking);
    const next: Runtime = { ...base, via: [base.via, `routing.json (${role})`].filter(Boolean).join(' + ') };
    if (thinking !== undefined) next.thinking = thinking; else delete next.thinking;
    assertRuntime(next, caps);
    return Object.freeze(next);
  }
  return undefined;
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
