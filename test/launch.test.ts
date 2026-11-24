import test from 'node:test';
import assert from 'node:assert/strict';
import type { Component } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { launchPicker } from '../src/launch-picker.ts';
import { loadConfig, MAIN } from '../src/runtime/config.ts';
import { prepareLaunch, type LaunchRequest } from '../src/runtime/launch.ts';
import { rm } from 'node:fs/promises';
import { loadPrompts } from '../src/prompts.ts';
import { Worq } from '../src/worq.ts';
import type { Spec } from '../src/sdk/contract.ts';
import { fakeDriver, planSubmission, pass, repo } from './fake.ts';

function surface() {
  let component: Component, opens = 0;
  const tui = { terminal: { rows: 24 }, requestRender() {} }, theme = { fg: (_: string, s: string) => s };
  const ui = { custom: (factory: (t: typeof tui, th: typeof theme, keys: unknown, done: () => void) => Component) => new Promise<void>(resolve => {
    opens++; component = factory(tui, theme, {}, resolve);
  }) };
  return { pick: launchPicker(ui as unknown as ExtensionContext['ui']), input: (key: string) => component.handleInput!(key), render: () => component.render(80).join('\n'), get opens() { return opens; } };
}
const request = (): LaunchRequest => ({ initial: { ...MAIN, model: 'p/a', fallbackModel: 'p/b', thinking: 'high' }, seconds: 5,
  choices: [{ sdk: 'pi', model: 'p/a', levels: ['low','high'] }, { sdk: 'pi', model: 'p/b', levels: ['off'] }, { sdk: 'other', model: 'c', levels: ['off','low'] }],
  label: 'reviewer.intent', signal: new AbortController().signal });

test('parallel launches share a surface, editing pauses only one countdown', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const s = surface(), req = request();
  let launched = false;
  const a = s.pick(req).then(r => { launched = true; return r; });
  const b = s.pick({ ...req, label: 'subagent' });
  assert.equal(s.opens, 1);
  assert.match(s.render(), /5s · subagent/);
  s.input('\x1b[B'); s.input('\x1b[C'); // model p/b
  assert.match(s.render(), /paused · reviewer.intent/);
  assert.match(s.render(), /Thinking: off/);
  t.mock.timers.tick(5000);
  assert.deepEqual(await b, req.initial);
  assert.equal(launched, false);
  s.input('\r');
  assert.deepEqual(await a, { ...req.initial, model: 'p/b', fallbackModel: undefined, thinking: 'off' });
  assert.equal(req.initial.fallbackModel, 'p/b');
});

test('harness changes refresh the model and levels; cancellation never confirms', async () => {
  const s = surface(), req = request(), controller = new AbortController();
  const a = s.pick(req), b = s.pick(req), c = s.pick({ ...req, signal: controller.signal });
  controller.abort(); await assert.rejects(c, /abort/i);
  s.input('\x1b'); await assert.rejects(a, /cancelled/);
  s.input('\x1b[C');
  assert.match(s.render(), /Harness: other/); assert.match(s.render(), /Model: c/);
  s.input('a'); assert.equal((await b).thinking, 'low');
});

test('worker keeps its override on repair; each new reviewer selects once', async t => {
  const { dir, root, state } = await repo();
  const config = loadConfig(dir), seen: Spec[] = [], picked: string[] = [];
  const driver = fakeDriver({ agent: async turn => { await turn.tool('submit', planSubmission); }, reviewer: async turn => { await turn.tool('report', pass); } }, seen);
  driver.catalog = async () => new Map([['pi', ['p/b']]]);
  let ready!: () => void;
  const next = () => new Promise<void>(resolve => { ready = resolve; });
  const worq = new Worq({ driver, config, prompts: loadPrompts(), state, cwd: root, select: async req => {
    picked.push(req.label); return { ...req.initial, model: 'p/b', thinking: 'high' };
  }, notify(event) { if (event.type === 'review-ready') setImmediate(ready); } });
  t.after(async () => { await worq.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const first = next();
  const agent = await worq.spawn('plan', 'Plan the change', { title: 'Review change', mode: 'fast' });
  await first;
  const second = next(); agent.send('revise'); await second;
  assert.deepEqual(seen.map(s => s.name), ['agent.plan', 'reviewer.subtraction', 'reviewer.subtraction']);
  assert.equal(picked.length, seen.length);
  assert.ok(seen.every(s => s.runtime?.model === 'p/b' && s.runtime.thinking === 'high'));
  assert.match(worq.list(agent.ref), /"model":"p\/b"/);
  assert.equal(config.runtime('agent.plan').model, undefined);
});

test('shutdown aborts an admission still in the picker', async () => {
  const driver = fakeDriver({}), config = loadConfig('/nonexistent/worq-test');
  driver.catalog = async () => new Map();
  let mounted!: () => void;
  const visible = new Promise<void>(resolve => { mounted = resolve; });
  const s = surface();
  const worq = new Worq({ config, driver, prompts: loadPrompts(), state: '', cwd: '', notify() {},
    select(req) { mounted(); return s.pick(req); } });
  const pending = worq.spawn('plan', 'test', { title: 'Test launch' });
  await visible; await worq.shutdown(); await assert.rejects(pending, /closed/);
  assert.equal(worq.size, 0);
});

test('defaults skip discovery without UI or with countdown disabled', async () => {
  const config = loadConfig('/nonexistent/worq-test'), driver = fakeDriver({});
  driver.catalog = () => { throw new Error('unexpected discovery'); };
  driver.defaultModel = () => 'p/main';
  assert.equal((await prepareLaunch(config, driver, 0, 'agent.plan', '', request().signal)).model, 'p/main');
  config.launch = { countdownSeconds: 0, interactive: true };
  assert.equal((await prepareLaunch(config, driver, 0, 'agent.plan', '', request().signal, surface().pick)).model, 'p/main');
});
