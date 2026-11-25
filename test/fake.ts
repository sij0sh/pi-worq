import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { AgentEvent } from "../src/agent.ts";
import { DEFAULT_LIMITS, type Config, type Limits } from "../src/runtime/config.ts";
import { errorText } from "../src/contracts.ts";
import { loadCatalog, type Kind } from "../src/runtime/workflows.ts";
import type { Capabilities, CoreHandle, Driver, Spec } from "../src/sdk/contract.ts";
import { Worq } from "../src/worq.ts";

export interface Turn {
  spec: Spec;
  text: string;
  /** What the model actually sees: exactly spec.system when the harness isolates it. */
  system: string;
  /** Call a tool like the SDK would: errors come back as text, not exceptions. */
  tool(name: string, params: object): Promise<string>;
  /** Simulate an adapter's awaited pre-request admission for a continuation. */
  admit(): Promise<boolean>;
  steered: string[];
}
export type Script = (turn: Turn) => Promise<void> | void;
export interface FakeOptions {
  /** settle: abort() settles the running prompt (the duty). dangle: it does not (an adapter bug). */
  abort?: "settle" | "dangle";
  /** throw: steer rejects, so the core queues the message and logs one downgrade line. none: no steer at all. */
  steer?: "queue" | "throw" | "none";
  /** Number of model requests that fail before one succeeds. */
  failures?: number;
  /** Image payloads a tool returned. */
  images?: { mimeType: string; data: string }[];
  /** Argument-validation failures the fake reported as tool-error events. */
  toolErrors?: { name: string; message: string }[];
  /** Every prompt() text, in order. */
  prompts?: string[];
  /** Count of abort() calls. */
  aborts?: { n: number };
  /** Count of prompt() calls. */
  calls?: { n: number };
  /** Adapter opts into awaited request admission and asks before each scripted request. */
  admission?: boolean;
  /** Count of admitted outbound requests. */
  requests?: { n: number };
  /** The adapter settles a terminal submit as part of the tool call, so there is no live turn to abort. */
  earlyTerminate?: boolean;
  /** contextFork: what Handle.snapshot returns for a session (by spec). */
  snapshot?: (spec: Spec) => unknown[];
}
export const FULL_CAPS: Capabilities = {
  switchModel: true,
  thinking: ["off", "minimal", "low", "medium", "high"],
  context: { system: "replace", ambientInstructions: false },
  turnUnit: "request",
};
export const MINIMAL_CAPS: Capabilities = {
  switchModel: false,
  thinking: [],
  context: { system: "append", ambientInstructions: true },
  turnUnit: "prompt",
};

/** Scripts keyed by spec.name (agent.plan, subagent, review …); the first matching prefix wins. */
export function fakeDriver(scripts: Record<string, Script>, seen: Spec[] = [], caps: Capabilities = FULL_CAPS, options: FakeOptions = {}): Driver {
  const open = async (spec: Spec): Promise<CoreHandle> => {
    seen.push(spec);
    const key = Object.keys(scripts).find((k) => spec.name === k || spec.name.startsWith(`${k}.`)) ?? Object.keys(scripts).find((k) => spec.name.startsWith(k));
    const script = key ? scripts[key] : undefined;
    const steered: string[] = [];
    const isolated = caps.context.system === "replace" && !caps.context.ambientInstructions;
    const system = isolated ? spec.system : `${spec.system}\n\n# AGENTS.md\n\nDecoy ambient project instructions.\n`;
    let streaming = false;
    let stopRequested = false;
    let release: (() => void) | undefined;
    let failures = options.failures ?? 0;
    let controller = new AbortController();
    const handle: CoreHandle = {
      async prompt(first, promptSignal) {
        controller = new AbortController();
        const signal = promptSignal ?? controller.signal;
        if (options.calls) options.calls.n++;
        if (options.prompts) options.prompts.push(first);
        // A request that failed before any work: no turn, no tool call.
        if (first.startsWith("fail") && (failures > 0 || options.failures === undefined)) { if (failures > 0) failures--; return "preflight-failed"; }
        streaming = true;
        stopRequested = false;
        try {
          // Steered text joins the same run, as the SDK does: replay it as a further turn.
          let initial = true;
          for (let text: string | undefined = first; text !== undefined; text = steered.shift()) {
            if (!initial && options.prompts) options.prompts.push(text);
            initial = false;
            if (options.admission) {
              const decision = await spec.admitRequest?.(signal);
              if (decision && !decision.allowed) { stopRequested = true; break; }
              if (options.requests) options.requests.n++;
            }
            spec.emit({ type: "turn" });
            if (stopRequested) break;
            const work = Promise.resolve(script?.({
              spec, text, system, steered,
              async admit() {
                if (!options.admission) return true;
                const decision = await spec.admitRequest?.(signal);
                if (!decision) return true;
                if (!decision.allowed) { stopRequested = true; return false; }
                if (options.requests) options.requests.n++;
                return true;
              },
              async tool(name, params) {
                const found = spec.tools.find((t) => t.name === name);
                if (!found) return `No tool ${name}`;
                const fail = (message: string) => { spec.emit({ type: "tool-error", name, message }); options.toolErrors?.push({ name, message }); return `Error: ${message}`; };
                if (!Value.Check(found.parameters, params)) return fail(`Invalid ${name} arguments`);
                try {
                  const out = await found.run(params, AbortSignal.any([controller.signal, signal]));
                  if (typeof out !== "string" && out.image) options.images?.push(out.image);
                  return typeof out === "string" ? out : out.text;
                }
                catch (error) { return fail(errorText(error)); }
              },
            }));
            work.catch(() => {});
            await Promise.race([work, new Promise<void>((resolve) => { release = resolve; })]);
            release = undefined;
            if (stopRequested) break;
          }
        } finally { streaming = false; release = undefined; }
        return stopRequested ? "aborted" : "completed";
      },
      ...(options.steer === "none" ? {} : { async steer(text: string) {
        if (options.steer === "throw") throw new Error("the harness cannot steer into this run");
        steered.push(text);
      } }),
      get streaming() { return streaming; },
      async abort() {
        if (options.aborts) options.aborts.n++;
        controller.abort();
        if (options.abort !== "dangle") { stopRequested = true; release?.(); }
      },
      ...(options.snapshot ? { snapshot: () => options.snapshot!(spec) } : {}),
      dispose() {},
    };
    return handle;
  };
  return { open, capabilities: () => caps };
}

/** The scripted reference adapter with explicit capabilities. */
export function fakeHarness(caps: Capabilities, scripts: Record<string, Script>, options: FakeOptions = {}): Driver {
  return fakeDriver(scripts, [], caps, options);
}

export async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "worq-test-"));
  const root = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git("config", "core.autocrlf", "false");
  await writeFile(join(root, "app.py"), "print('hello')\n");
  await writeFile(join(root, ".gitignore"), ".agents/\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, root, state: join(dir, "state"), git };
}

/** The shipped packages, provisioned into a throwaway profile exactly as a first start would. */
export function shippedKinds(): Map<string, Kind> {
  const profile = mkdtempSync(join(tmpdir(), "worq-profile-"));
  return loadCatalog(profile).kinds;
}
export const KINDS: ReadonlyMap<string, Kind> = shippedKinds();
export const config = (limits: Partial<Limits> = {}): Config => ({ path: "test", limits: { ...DEFAULT_LIMITS, ...limits } });

export function setup(root: string, state: string, scripts: Record<string, Script>, limits: Partial<Limits> = {}, telemetry?: import('../src/telemetry.ts').Telemetry, kinds: ReadonlyMap<string, Kind> = KINDS) {
  const events: AgentEvent[] = [];
  const seen: Spec[] = [];
  let wake: (() => void) | undefined;
  const worq = new Worq({ telemetry, driver: fakeDriver(scripts, seen), kinds, config: config(limits), state, cwd: root,
    notify: (event) => { events.push(event); wake?.(); } });
  /** Resolve when an event of this type for this ref arrives. */
  const next = async (type: AgentEvent["type"], ref?: string, count = 1) => {
    const match = () => events.filter((e) => e.type === type && (!ref || e.ref === ref));
    const deadline = Date.now() + 20_000;
    while (match().length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got ${JSON.stringify(events.map((e) => e.type))}`);
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 50); });
    }
    return match().at(-1)!;
  };
  return { worq, events, seen, next };
}

export const planSubmission = {
  summary: "Change the greeting to uppercase in app.py.",
  report: "**Criteria:** running app.py prints HELLO\n\n**Decisions:** edit the literal (observed app.py:1); alternative .upper(), no material tradeoff",
};
export const pass = { verdict: "pass", summary: "No consequential findings", findings: [] };
