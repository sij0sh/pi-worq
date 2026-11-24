import type { Config } from './config.ts';
import { assertRuntime, type Driver, type Runtime } from '../sdk/contract.ts';

export interface ModelChoice { sdk: string; model?: string; levels: readonly string[] }
export interface LaunchRequest { label: string; initial: Runtime; choices: ModelChoice[]; seconds: number; signal: AbortSignal }
export type SelectLaunch = (request: LaunchRequest) => Promise<Runtime>;

/** Every model a role may run on, current first. `sdk` locks the harness (live sessions cannot change it). */
export async function modelChoices(driver: Driver, role: string, current: Runtime, extensions: number, sdk?: string): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = [{ sdk: current.sdk, model: current.model, levels: driver.capabilities(role, current).thinking }];
  if (!driver.catalog) return choices;
  for (const [name, models] of await driver.catalog()) {
    if (sdk !== undefined && name !== sdk) continue;
    for (const model of new Set(models)) {
      if (name === current.sdk && model === current.model) continue;
      const candidate = { ...current, sdk: name, model, thinking: undefined, fallbackModel: undefined };
      try {
        const supported = driver.capabilities(role, candidate);
        assertRuntime(candidate, supported, extensions);
        choices.push({ sdk: name, model, levels: supported.thinking });
      } catch { continue; }
    }
  }
  return choices;
}

/** Resolve once per conversation, before allocating its workspace, slot or budget. */
export async function prepareLaunch(config: Config, driver: Driver, extensions: number, role: string, label: string, signal: AbortSignal, select?: SelectLaunch) {
  signal.throwIfAborted();
  const preset = config.runtime(role);
  const initial: Runtime = { ...preset, model: preset.model ?? driver.defaultModel?.(preset.sdk) };
  const caps = driver.capabilities(role, initial);
  assertRuntime(initial, caps, extensions);
  initial.thinking ??= caps.thinking.includes('low') ? 'low' : undefined;
  let runtime = initial;
  const { interactive = true, countdownSeconds: seconds = 5 } = config.launch ?? {};
  if (select && driver.catalog && interactive && seconds > 0) {
    const choices = await modelChoices(driver, role, initial, extensions);
    signal.throwIfAborted();
    runtime = await select({ label, initial, choices, seconds, signal });
    assertRuntime(runtime, driver.capabilities(role, runtime), extensions);
  }
  signal.throwIfAborted();
  return Object.freeze(runtime);
}
