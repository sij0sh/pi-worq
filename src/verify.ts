import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Block, coverage, distinct, type Contract, type Journey } from "./contracts.ts";
import { runProcess } from "./process.ts";
import { journeyPty } from "./pty.ts";
import { digest, digestFile, runtimeEnv, scoped, snapshot, writeScoped, type Project } from "./workspace.ts";

export function catalog(project: Project, contract?: Contract) {
  const required = contract ? coverage(contract, project.profile) : undefined;
  return project.profile.checks.filter((c) => !required || required.includes(c.id)).map((c) => ({
    id: c.id, outcome: c.outcome, ...(required ? { scenarios: c.scenarios.map((s) => ({ id: s.id, name: s.name })) } : {}),
  }));
}
export interface Evidence {
  criterion: string;
  check: string;
  scenario: string;
  traceStep: string;
  expected: string;
  observed: string;
  pass: boolean;
}
export async function verify(project: Project, contract: Contract, journey: Journey, target: { run: string; attempt: number; commit: string }, directory: string, signal: AbortSignal, progress: (activity: string) => void) {
  const profile = project.profile;
  if (journey.blocker) throw new Block("journey-blocked", journey.blocker);
  const required = coverage(contract, profile);
  const ids = journey.cases.map((x) => x.check);
  distinct(ids, "Selected verification checks");
  if (ids.length !== required.length || ids.some((key) => !required.includes(key))) throw new Block("journey-coverage", "The journey must select one scenario for each required check");
  const scenarios = journey.cases.map(({ check, scenario }) => {
    const selected = profile.checks.find((x) => x.id === check)?.scenarios.find((x) => x.id === scenario);
    if (!selected) throw new Block("journey-scenario", `Unknown scenario ${check}/${scenario}`);
    return { check, selected };
  });
  const scratch = join(directory, `verify-${target.attempt}`);
  await mkdir(scratch, { mode: 0o700 });
  await writeFile(join(scratch, "journey.json"), JSON.stringify({ target, profile: project.profileDigest, journey }), { flag: "wx", mode: 0o600 });
  const stage = await snapshot(project, scratch, target.commit, signal);
  if (profile.build) {
    progress("Staging candidate with the approved build");
    const result = await runProcess(profile.build.executable, profile.build.args, { cwd: stage, env: await runtimeEnv(join(scratch, "build-env")), signal, ms: 60_000 });
    if (result.code !== 0) throw new Block("build", `Approved build failed (${result.code}): ${result.stderr.slice(0, 600)}`);
  }
  const artifact = await scoped(stage, profile.entry);
  if (!(await stat(artifact)).isFile()) throw new Block("entry", "The staged product entry must be a regular file");
  const interpreter = profile.interpreter ? await realpath(profile.interpreter) : undefined;
  const executable = interpreter ?? artifact;
  await access(executable, 1); // X_OK
  const artifactDigest = await digestFile(artifact);
  const evidence: Evidence[] = [];
  const observations: unknown[] = [];
  for (const [index, { check, selected }] of scenarios.entries()) {
    signal.throwIfAborted();
    progress(`Exercising ${selected.name} through the ${profile.surface.toUpperCase()}`);
    const caseDir = join(scratch, `case-${index + 1}`);
    const cwd = join(caseDir, "input");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    for (const fixture of selected.fixtures ?? []) await writeScoped(cwd, fixture.path, fixture.content);
    const env = await runtimeEnv(join(caseDir, "env"));
    const args = interpreter ? [artifact, ...selected.args] : selected.args;
    let observation: { screen?: string; stdout?: string; stderr?: string; exit?: number };
    let step: string;
    if (profile.surface === "tui") {
      const screens = await journeyPty(executable, args, selected.steps!, cwd, env, signal);
      const last = screens.at(-1);
      if (!last) throw new Block("no-screen", "No PTY screen observation was captured");
      observation = { screen: last.screen };
      step = `${index + 1}.${last.step}`;
      observations.push({ case: index + 1, check, scenario: selected.id, argv: [executable, ...args], screens, actions: selected.steps });
    } else {
      const result = await runProcess(executable, args, { cwd, env, signal, ms: 15_000, stdin: selected.stdin });
      observation = { stdout: result.stdout, stderr: result.stderr, exit: result.code };
      step = `${index + 1}.1`;
      observations.push({ case: index + 1, check, scenario: selected.id, argv: [executable, ...args], ...observation });
    }
    if (await digestFile(await scoped(stage, profile.entry)) !== artifactDigest) throw new Block("target-mutated", "The staged entry changed while it was under verification");
    for (const expected of selected.expect) {
      const observed = observation[expected.channel];
      if (observed === undefined) throw new Block("unobserved", `Missing ${expected.channel} observation`);
      const pass = expected.op === "equals" ? expected.value === observed : typeof observed === "string" && observed.includes(String(expected.value));
      for (const criterion of contract.criteria.filter((c) => c.checks.includes(check))) {
        evidence.push({ criterion: criterion.id, check, scenario: selected.id, traceStep: step,
          expected: `${expected.channel} ${expected.op} ${JSON.stringify(expected.value)}`,
          observed: `${expected.channel}: ${JSON.stringify(observed).slice(0, 550)}`, pass });
      }
    }
  }
  signal.throwIfAborted();
  const receipt = { version: 1, ...target, profileDigest: project.profileDigest, artifact, executable, artifactDigest, contractDigest: digest(JSON.stringify(contract)), journey, evidence, observations };
  const serialized = JSON.stringify(receipt, null, 2) + "\n";
  const path = join(scratch, "receipt.json");
  await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
  // The receipt is produced here, consumed from memory, and never loaded from a previous attempt.
  return { pass: evidence.length > 0 && evidence.every((e) => e.pass), evidence, path, digest: digest(serialized) };
}
