import type { Config } from "./config.ts";
import type { Driver, HostContext } from "./session.ts";

/**
 * One record per harness. The record is the only runtime harness table: it carries the model-ref
 * validator `loadConfig` uses, and (from S3) the factory that builds the adapter.
 */
export interface HarnessRecord {
  /** Model refs this harness can resolve: `<provider>/<model>` for Pi. */
  modelRef: RegExp;
  create?(ctx: HostContext, config: Config): Driver;
}

export const HARNESSES: Record<string, HarnessRecord> = {
  pi: { modelRef: /^[^/\s]+\/[^\s]+$/ },
};

export const KNOWN_HARNESSES = Object.keys(HARNESSES);
