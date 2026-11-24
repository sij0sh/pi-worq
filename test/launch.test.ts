import test from 'node:test';
import assert from 'node:assert/strict';
import type { Component } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { launchPicker } from '../src/launch-picker.ts';
import { loadConfig, MAIN } from '../src/runtime/config.ts';
import { prepareLaunch, type LaunchRequest } from '../src/runtime/launch.ts';
import { rm, writeFile } from 'node:fs/promises';
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
const request = (): LaunchRequest => ({ initial: { ...MAIN, model: 'p/a', thinking: 'high' }, seconds: 5,
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
  assert.match(s.render(), /Thinking: high/);
  s.input('\x1b[B'); s.input('\x1b[C'); // model p/b
  assert.match(s.render(), /paused · reviewer.intent/);
  assert.match(s.render(), /Thinking: SDK default/);
  t.mock.timers.tick(5000);
  assert.deepEqual(await b, req.initial);
  assert.equal(launched, false);
  s.input('\r');
  assert.deepEqual(await a, { ...req.initial, model: 'p/b', thinking: undefined });
});

test('harness changes refresh the model and levels; cancellation never confirms', async () => {
  const s = surface(), req = request(), controller = new AbortController();
  const a = s.pick(req), b = s.pick(req), c = s.pick({ ...req, signal: controller.signal });
  controller.abort(); await assert.rejects(c, /abort/i);
  s.input('\x1b'); await assert.rejects(a, /cancelled/);
  s.input('\x1b[C');
  assert.match(s.render(), /Harness: other/); assert.match(s.render(), /Model: c/);
  s.input('a'); assert.equal((await b).thinking, undefined);
});

test('worker and selected reviewer each pick once for the sealed batch', async t => {
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
  assert.throws(() => agent.send('revise'), /review-ready/);
  assert.deepEqual(seen.map(s => s.name), ['agent.plan', 'reviewer.subtraction']);
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
  let model = 'p/main', thinking = 'high';
  driver.defaultModel = () => model;
  driver.defaultThinking = () => thinking;
  const signal = request().signal;
  const first = await prepareLaunch(config, driver, 0, 'agent.plan', '', signal);
  assert.deepEqual(first, { ...MAIN, model: 'p/main', thinking: 'high' });
  config.launch = { countdownSeconds: 0, interactive: true };
  model = 'p/new'; thinking = 'off';
  assert.deepEqual(await prepareLaunch(config, driver, 0, 'subagent.evidence', '', signal, surface().pick), { ...MAIN, model: 'p/new', thinking: 'off' });
  thinking = 'unsupported';
  assert.equal((await prepareLaunch(config, driver, 0, 'agent.plan', '', signal)).thinking, undefined);
  config.runtime = () => ({ ...MAIN, model: 'p/override', thinking: 'medium' });
  assert.deepEqual(await prepareLaunch(config, driver, 0, 'agent.plan', '', signal), { ...MAIN, model: 'p/override', thinking: 'medium' });
});


test('repository and clean-write checks precede runtime selection; dirty planning still launches', async t => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(`${root}/app.py`, 'dirty');
  const picked: string[] = [];
  function at(cwd: string) {
    const driver = fakeDriver({ agent: async turn => { await turn.tool('submit', planSubmission); }, reviewer: async turn => { await turn.tool('report', pass); } });
    driver.catalog = async () => new Map();
    return new Worq({ driver, config: loadConfig(dir), prompts: loadPrompts(), state, cwd, select: async req => { picked.push(req.label); return req.initial; }, notify() {} });
  }
  const outside = at(dir), inside = at(root);
  t.after(async () => { await outside.shutdown(); await inside.shutdown(); });
  await assert.rejects(outside.spawn('plan', 'check', { title: 'Outside repo' }), /repository/i);
  await assert.rejects(inside.spawn('execute', 'check', { title: 'Dirty execute' }), /commit or stash/i);
  assert.deepEqual(picked, []);
  const plan = await inside.spawn('plan', 'check', { title: 'Dirty plan', mode: 'fast' });
  await plan.done;
  assert.equal(plan.state, 'review-ready');
  assert.equal(picked.length, 2);
});
