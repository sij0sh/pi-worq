import test from 'node:test';
import assert from 'node:assert/strict';
import type { Component } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { launchPicker, type LaunchRequest } from '../src/launch-picker.ts';
import { MAIN } from '../src/runtime/config.ts';
import { resolveRuntime } from '../src/runtime/launch.ts';
import { rm, writeFile } from 'node:fs/promises';
import { loadPrompts } from '../src/prompts.ts';
import { Worq } from '../src/worq.ts';
import type { Runtime, Spec } from '../src/sdk/contract.ts';
import { config, fakeDriver, KINDS, planSubmission, pass, repo } from './fake.ts';

function surface(request: LaunchRequest) {
  let component!: Component;
  const tui = { terminal: { rows: 24 }, requestRender() {} }, theme = { fg: (_: string, s: string) => s };
  const ui = { custom: (factory: (t: typeof tui, th: typeof theme, keys: unknown, done: (value: Runtime | undefined) => void) => Component) =>
    new Promise<Runtime | undefined>(resolve => { component = factory(tui, theme, {}, resolve); }) };
  const picked = launchPicker(ui as unknown as ExtensionContext['ui'], request);
  return { picked, input: (key: string) => component.handleInput!(key), render: () => component.render(80).join('\n') };
}
const request = (): LaunchRequest => ({ label: 'plan', initial: { ...MAIN, model: 'p/a', thinking: 'high' },
  choices: [{ sdk: 'pi', model: 'p/a', levels: ['low', 'high'], thinking: 'high' }, { sdk: 'pi', model: 'p/b', levels: ['off'] }, { sdk: 'other', model: 'c', levels: ['off', 'low'], thinking: 'low' }] });

test('picker: explicit Enter, no countdown; model change keeps only supported thinking', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const s = surface(request());
  assert.match(s.render(), /Thinking: ‹ high ›/);
  t.mock.timers.tick(60_000);
  let settled = false;
  void s.picked.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'waits for the user');
  s.input('\x1b[B'); s.input('\x1b[C'); // model p/b
  assert.match(s.render(), /Thinking: ‹ SDK default ›/);
  s.input('\r');
  assert.deepEqual(await s.picked, { ...request().initial, model: 'p/b', thinking: undefined });
});

test('picker: harness change resets model and thinking to that harness defaults; Esc cancels', async () => {
  const s = surface(request());
  s.input('\x1b[C');
  assert.match(s.render(), /Harness: ‹ other ›/); assert.match(s.render(), /Model: ‹ c ›/); assert.match(s.render(), /Thinking: ‹ low ›/);
  s.input('\r');
  assert.deepEqual(await s.picked, { ...request().initial, sdk: 'other', model: 'c', thinking: 'low' });
  const cancelled = surface(request());
  cancelled.input('\x1b');
  assert.equal(await cancelled.picked, undefined);
});

test('resolveRuntime: explicit fields first, Main defaults otherwise; incompatible inherited thinking is dropped', async () => {
  const driver = fakeDriver({});
  driver.catalog = () => { throw new Error('unexpected discovery'); };
  let model = 'p/main', thinking = 'high';
  driver.defaultModel = () => model;
  driver.defaultThinking = () => thinking;
  const signal = new AbortController().signal;
  assert.deepEqual(await resolveRuntime(driver, 0, {}, signal), { ...MAIN, model: 'p/main', thinking: 'high' });
  model = 'p/new'; thinking = 'off';
  assert.deepEqual(await resolveRuntime(driver, 0, {}, signal), { ...MAIN, model: 'p/new', thinking: 'off' });
  thinking = 'unsupported';
  assert.equal((await resolveRuntime(driver, 0, {}, signal)).thinking, undefined);
  assert.deepEqual(await resolveRuntime(driver, 0, { model: 'p/override', thinking: 'medium' }, signal),
    { name: 'launch', sdk: 'pi', path: '', via: 'launch request', model: 'p/override', thinking: 'medium' });
  await assert.rejects(resolveRuntime(driver, 0, { thinking: 'unsupported' }, signal), /not a pi thinking level/, 'explicit values are never dropped');
});

test('runtime preflight precedes repository checks, and children inherit the owner runtime', async t => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(`${root}/app.py`, 'dirty');
  const order: string[] = [], seen: Spec[] = [];
  const driver = fakeDriver({ agent: async turn => { await turn.tool('submit', planSubmission); }, review: async turn => { await turn.tool('submit', pass); } }, seen);
  driver.validate = async runtime => { order.push(`validate ${runtime.model}`); if (runtime.model === 'p/bad') throw new Error('unknown model p/bad'); };
  const at = (cwd: string) => new Worq({ driver, config: config(), kinds: KINDS, prompts: loadPrompts(), state, cwd, notify() {} });
  const outside = at(dir), inside = at(root);
  t.after(async () => { await outside.shutdown(); await inside.shutdown(); });
  await assert.rejects(inside.spawn('plan', 'check', { title: 'Bad model', model: 'p/bad' }), /unknown model/);
  assert.equal(inside.list(), 'No Worq agents in this session.', 'no pending slot or agent');
  await assert.rejects(outside.spawn('plan', 'check', { title: 'Outside repo', model: 'p/b' }), /repository/i);
  await assert.rejects(inside.spawn('execute', 'check', { title: 'Dirty execute', model: 'p/b' }), /commit or stash/i);
  assert.deepEqual(order, ['validate p/bad', 'validate p/b', 'validate p/b']);
  const plan = await inside.spawn('plan', 'check', { title: 'Dirty plan', model: 'p/b', thinking: 'high' });
  for (let i = 0; i < 400 && plan.state !== 'parked'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(plan.state, 'parked');
  assert.deepEqual(seen.map(s => s.name), ['agent.plan', 'review']);
  assert.ok(seen.every(s => s.runtime?.model === 'p/b' && s.runtime.thinking === 'high'), 'review inherits the owner runtime');
  assert.match(inside.list(plan.ref), /"model":"p\/b"/);
});

test('shutdown aborts an admission still in preflight', async () => {
  const driver = fakeDriver({});
  let mounted!: () => void;
  const visible = new Promise<void>(resolve => { mounted = resolve; });
  driver.validate = (_runtime, signal) => { mounted(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const worq = new Worq({ config: config(), kinds: KINDS, driver, prompts: loadPrompts(), state: '', cwd: '', notify() {} });
  const pending = worq.spawn('plan', 'test', { title: 'Test launch' });
  await visible; await worq.shutdown(); await assert.rejects(pending, /closed/);
  assert.equal(worq.size, 0);
});
