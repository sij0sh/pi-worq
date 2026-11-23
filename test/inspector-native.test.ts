import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Action } from '../src/contracts.ts';
import { observePty } from '../src/pty.ts';

test('offline native Pi inspector opens, tabs, resizes, and restores the editor', {
  skip: process.env.WORQ_NATIVE_INSPECTOR !== '1' && 'set WORQ_NATIVE_INSPECTOR=1 to run Linux PTY smoke',
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = resolve(import.meta.dirname, '..');
  const key = (key: Extract<Action, { type: 'press' }>['key']): Action => ({ type: 'press', key });
  const wait = (ms: number): Action => ({ type: 'wait', ms });
  const observe: Action = { type: 'observe' };
  const screens = await observePty(process.execPath, [join(cwd, 'node_modules/.bin/pi'), '--offline', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--provider', 'openai', '--model', 'gpt-4o-mini', '-e', join(cwd, 'index.ts')], [
    wait(1500),
    { type: 'type', text: '/worq-inspect' }, key('enter'), wait(350), observe,
    key('tab'), { type: 'resize', cols: 40, rows: 24 }, wait(250), observe,
    key('tab'), observe, key('escape'), observe,
  ], dir, {
    PATH: process.env.PATH, HOME: dir, TERM: 'xterm-256color', PI_TELEMETRY: '0', OPENAI_API_KEY: 'offline-tui-fixture',
    PI_CODING_AGENT_DIR: join(dir, 'pi'), WORQ_STATE_DIR: join(dir, 'state'),
  }, AbortSignal.timeout(12_000));
  const [agents, activity, evidence, editor] = screens.map(s => s.screen);
  assert.match(agents, /Worq · Agents/);
  assert.match(agents, /No Worq agents observed/);
  assert.doesNotMatch(agents, /control socket unavailable/);
  assert.match(activity, /Worq · Activity/);
  assert.match(evidence, /Worq · Evidence/);
  assert.doesNotMatch(editor, /Worq · Evidence/);
  assert.match(editor, /─{30}/);
});
