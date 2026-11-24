import type { Config } from './config.ts';
import { assertRuntime, type Driver, type Runtime } from '../sdk/contract.ts';

export interface ModelChoice { sdk: string; model?: string; levels: readonly string[] }
export interface LaunchRequest { label: string; initial: Runtime; choices: ModelChoice[]; seconds: number; signal: AbortSignal }
export type SelectLaunch = (request: LaunchRequest) => Promise<Runtime>;

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
    const choices: ModelChoice[] = [{ sdk: initial.sdk, model: initial.model, levels: caps.thinking }];
    for (const [sdk, models] of await driver.catalog()) for (const model of new Set(models)) {
      if (sdk === initial.sdk && model === initial.model) continue;
      const candidate = { ...initial, sdk, model, thinking: undefined, fallbackModel: undefined };
      const supported = driver.capabilities(role, candidate);
      try { assertRuntime(candidate, supported, extensions); } catch { continue; }
      choices.push({ sdk, model, levels: supported.thinking });
    }
    signal.throwIfAborted();
    runtime = await select({ label, initial, choices, seconds, signal });
    assertRuntime(runtime, driver.capabilities(role, runtime), extensions);
  }
  signal.throwIfAborted();
  return Object.freeze(runtime);
}
