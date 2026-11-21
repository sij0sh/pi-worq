import type { Config } from "./config.ts";
import { Block } from "./contracts.ts";
import { piDriver } from "./pi.ts";
import type { Driver, HostContext, Spec } from "./session.ts";

/**
 * One record per harness. The record is the only runtime harness table: it carries the model-ref
 * validator `loadConfig` uses and the factory that builds the adapter.
 */
export interface HarnessRecord {
  /** Model refs this harness can resolve: `<provider>/<model>` for Pi. */
  modelRef: RegExp;
  create(ctx: HostContext, config: Config): Driver;
}

export const HARNESSES: Record<string, HarnessRecord> = {
  pi: {
    modelRef: /^[^/\s]+\/[^\s]+$/,
    // The host value is Pi's extension context; narrowing happens only here, inside the adapter's record.
    create: (ctx, config) => piDriver(ctx.host as Parameters<typeof piDriver>[0], config),
  },
};

export const KNOWN_HARNESSES = Object.keys(HARNESSES);

/**
 * One Driver that routes every session open and every capability read to the harness its role resolves to,
 * so Worq's process, prompts and four-tool surface never learn which backend runs a session.
 */
export function createDriver(ctx: HostContext, config: Config): Driver {
  const drivers = new Map<string, Driver>();
  const adapter = (name: string): Driver => {
    const record = HARNESSES[name];
    if (!record) throw new Block("config", `${config.path}: unknown harness "${name}" (available: ${KNOWN_HARNESSES.join(", ")})`);
    let driver = drivers.get(name);
    if (!driver) { driver = record.create(ctx, config); drivers.set(name, driver); }
    return driver;
  };
  const driver = (async (spec: Spec) => adapter(config.model(spec.name).harness)(spec)) as Driver;
  driver.capabilities = (name) => adapter(config.model(name).harness).capabilities(name);
  return driver;
}
