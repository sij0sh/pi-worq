import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess, cleanEnv } from '../src/process.ts';
import { readTools } from '../src/tools.ts';
import type { Outcome } from '../src/telemetry.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native process metadata comes from the failure boundary, preserving rejection', async () => {
  const run = (executable: string, args: string[], signal: AbortSignal, ms = 2000) => {
    const records: Outcome[] = [];
    return { records, result: runProcess(executable, args, { cwd: process.cwd(), env: cleanEnv, signal, ms, report: o => records.push(o) }) };
  };
  const signal = new AbortController().signal;
  for (const [executable, args, kind, ms] of [
    [join(process.cwd(), 'nonexistent-command'), [], 'launch', 2000],
    [process.execPath, ['-e', 'setInterval(()=>{},1000)'], 'timeout', 60],
    [process.execPath, ['-e', 'process.stdout.write("x".repeat(256000))'], 'output-limit', 2000],
    [process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'], 'process-exit', 2000],
  ] as const) {
    const r = run(executable, [...args], signal, ms);
    await assert.rejects(r.result, { code: kind });
    assert.deepEqual(r.records, [{ kind }]);
  }
  const controller = new AbortController();
  const sameText = new Error('Process timed out');
  const r = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], controller.signal);
  controller.abort(sameText);
  await assert.rejects(r.result, error => error === sameText);
  assert.deepEqual(r.records, [{ kind: 'cancelled' }]);
});

test('search outcome counts only returned matches and contains no search prose', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'worq-search-metadata-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'hidden-filename'), 'PrintableSecret\n'.repeat(230));
  const search = readTools(cwd).find(tool => tool.name === 'search')!;
  const records: Outcome[] = [];
  const value = await search.run({ pattern: 'PrintableSecret' }, new AbortController().signal, result => records.push(result));
  assert.match(String(value), /hidden-filename:1:PrintableSecret/);
  assert.deepEqual(records, [{ kind: 'search', count: 200, capped: true }]);
});
