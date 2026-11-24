import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Action } from '../src/contracts.ts';
import { observePty } from '../src/pty.ts';

test('offline native Pi inspector opens, tabs, resizes, and restores the editor', {
  skip: process.platform !== 'linux' ? 'PTY smoke requires Linux' :
    process.env.WORQ_NATIVE_INSPECTOR !== '1' && 'set WORQ_NATIVE_INSPECTOR=1 to run Linux PTY smoke',
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = resolve(import.meta.dirname, '..');
  await mkdir(join(dir,'pi')); await writeFile(join(dir,'pi/settings.json'), JSON.stringify({tuiMode:'fullscreen'}));
  const key = (key: Extract<Action, { type: 'press' }>['key']): Action => ({ type: 'press', key });
  const wait = (ms: number): Action => ({ type: 'wait', ms });
  const observe: Action = { type: 'observe' };
  const screens = await observePty(process.execPath, [join(cwd, 'node_modules/.bin/pi'), '--offline', '--no-session',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--provider', 'openai', '--model', 'gpt-4o-mini', '-e', join(cwd, 'test/fixtures/dashboard.ts')], [
    wait(1800), observe,
    { type: 'type', text: '\x1b[<0;2;17M\x1b[<0;2;17m' }, wait(180), observe,
    { type: 'type', text: '/worq-dock' }, key('enter'), wait(180),
    { type: 'type', text: '\x1b[<0;7;17M\x1b[<0;7;17m' }, wait(350), observe,
    key('down'), wait(100), observe, { type: 'type', text: 'j' }, wait(100), observe,
    key('tab'), { type: 'resize', cols: 40, rows: 24 }, wait(250), observe,
    key('tab'), observe, key('escape'), wait(150), key('escape'), wait(150), observe,
    { type: 'resize', cols: 80, rows: 24 }, wait(200),
    { type: 'type', text: '\x1b[<0;7;20M\x1b[<0;7;20m' }, wait(200), observe,
  ], dir, {
    PI_TUI_WRITE_LOG: process.env.WORQ_CAPTURE_ANSI,
    PATH: process.env.PATH, HOME: dir, TERM: 'xterm-256color', PI_TELEMETRY: '0', OPENAI_API_KEY: 'offline-tui-fixture',
    PI_CODING_AGENT_DIR: join(dir, 'pi'), WORQ_STATE_DIR: join(dir, 'state'),
  }, AbortSignal.timeout(12_000));
  const [dock, collapsed, activity, paused, resumed, evidence, agents, editor, child] = screens.map(s => s.screen);
  assert.match(collapsed, /\[\+\]/); assert.doesNotMatch(collapsed, /PQ d1/);
  assert.match(paused, /Paused/); assert.match(resumed, /Live/);
  assert.match(activity, /Worq · Activity/);
  if (process.env.WORQ_CAPTURE) console.log(screens.map(s => s.screen).join('\n===\n'));
  assert.match(dock, /◈ WORQ/);
  assert.match(dock, /PQ d1.*read_file.*94.0%/);
  assert.match(activity, /read_file/);
  assert.doesNotMatch(activity, /control socket unavailable/);
  assert.match(evidence, /Worq · Evidence/);
  assert.match(agents, /Worq · Agents/);
  assert.doesNotMatch(editor, /Worq · Agents/);
  assert.match(editor, /─{30}/);
  assert.match(child, /Can recovery resume/); assert.match(child, /Injected pinned skills: review/);
});
