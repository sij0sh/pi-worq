import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { AgentEvent } from "../src/agent.ts";
import { DEFAULT_LIMITS, type Config, type Limits } from "../src/config.ts";
import { errorText } from "../src/contracts.ts";
import { loadPrompts } from "../src/prompts.ts";
import type { Driver, Handle, Spec } from "../src/session.ts";
import { Worq } from "../src/worq.ts";

export interface Turn {
  spec: Spec;
  text: string;
  /** Call a tool like the SDK would: errors come back as text, not exceptions. */
  tool(name: string, params: object): Promise<string>;
  steered: string[];
}
export type Script = (turn: Turn) => Promise<void> | void;
/** Scripts keyed by spec.name (agent.plan, subagent, reviewer.intent …); the first matching prefix wins. */
export function fakeDriver(scripts: Record<string, Script>, seen: Spec[] = []): Driver {
  return async (spec) => {
    seen.push(spec);
    const key = Object.keys(scripts).find((k) => spec.name === k || spec.name.startsWith(`${k}.`)) ?? Object.keys(scripts).find((k) => spec.name.startsWith(k));
    const script = key ? scripts[key] : undefined;
    const steered: string[] = [];
    let streaming = false;
    const controller = new AbortController();
    const handle: Handle = {
      async prompt(first) {
        streaming = true;
        // Steered text joins the same run, as the SDK does: replay it as a further turn.
        try {
          for (let text: string | undefined = first; text !== undefined; text = steered.shift()) {
          spec.turn();
          await script?.({
            spec, text, steered,
            async tool(name, params) {
              const found = spec.tools.find((t) => t.name === name);
              if (!found) return `No tool ${name}`;
              const fail = (message: string) => { spec.toolError(name, message); return `Error: ${message}`; };
              if (!Value.Check(found.parameters, params)) return fail(`Invalid ${name} arguments`);
              try { const out = await found.run(params, controller.signal); return typeof out === "string" ? out : out.text; }
              catch (error) { return fail(errorText(error)); }
            },
          });
          }
        } finally { streaming = false; }
        return false;
      },
      async steer(text) { steered.push(text); },
      get streaming() { return streaming; },
      async abort() { controller.abort(); },
      async fallback() { return false; },
      dispose() {},
    };
    return handle;
  };
}

export async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "worq-test-"));
  const root = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await writeFile(join(root, "app.py"), "print('hello')\n");
  await writeFile(join(root, ".gitignore"), ".agents/\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, root, state: join(dir, "state"), git };
}

export function setup(root: string, state: string, scripts: Record<string, Script>, limits: Partial<Limits> = {}) {
  const events: AgentEvent[] = [];
  const seen: Spec[] = [];
  const config: Config = { path: "test", limits: { ...DEFAULT_LIMITS, ...limits }, model: () => ({}) };
  let wake: (() => void) | undefined;
  const worq = new Worq({ driver: fakeDriver(scripts, seen), prompts: loadPrompts(), config, state, cwd: root,
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
  criteria: ["Running app.py prints HELLO"],
  decisions: [{ id: "D1", choice: "Edit the literal", basis: "observed app.py:1", alternative: "call .upper()", tradeoff: "none material", revisit: "if greeting becomes dynamic" }],
  assumptions: [],
  tree: "Root: what decides the approach? → greeting source (observed app.py:1) → literal",
};
export const pass = { verdict: "pass", summary: "No consequential findings", findings: [] };
