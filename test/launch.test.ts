import test from 'node:test';
import assert from 'node:assert/strict';
import type { Component } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { launchPanel, type LaunchRequest } from '../src/launch-picker.ts';
import { MAIN } from '../src/runtime/config.ts';
import { resolveRuntime } from '../src/runtime/launch.ts';
import type { UsageSnapshot, UsageView } from '../src/runtime/usage.ts';
import { rm, writeFile } from 'node:fs/promises';
import { Worq } from '../src/worq.ts';
import type { Spec } from '../src/sdk/contract.ts';
import { config, fakeDriver, KINDS, planSubmission, pass, repo } from './fake.ts';

function surface(request: LaunchRequest) {
  let component!: Component;
  const prior = { render: () => [], invalidate() {} }; let focus: Component | null = prior;
  const tui = { terminal: { rows: 24 }, requestRender() {}, getFocusedComponent: () => focus, setFocus: (c: Component | null) => { focus = c; } };
  const color = (_: string, s: string) => s;
  const ui = { setWidget(_key: string, factory?: Function) {
    if (factory) component = factory(tui, {fg:color,bg:color}); else (component as Component & {dispose():void}).dispose();
  } };
  const picked = launchPanel(ui as unknown as ExtensionContext['ui'], request).then(result => { assert.equal(focus,prior); return result; });
  return { picked, input: (key: string) => component.handleInput!(key), render: () => component.render(80).join('\n') };
}
const request = (): LaunchRequest => ({ kinds: [...KINDS.values()], initial: { ...MAIN, model: 'p/a', thinking: 'high' },
  choices: [{ sdk: 'pi', model: 'p/a', levels: ['low', 'high'], thinking: 'high' }, { sdk: 'pi', model: 'p/b', levels: ['off'] }, { sdk: 'other', model: 'c', levels: ['off', 'low'], thinking: 'low' }] });

test('picker: explicit Enter, no countdown; model change keeps only supported thinking', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const s = surface(request());
  assert.match(s.render(),/1\/3/); s.input('\x1b[B'); s.input('\r');
  s.input('A'); s.input('\x1b[13;2u'); s.input('B'); s.input('\n'); s.input('\x1b[200~C\nD\x1b[201~'); s.input('\r');
  assert.match(s.render(), /Thinking +‹ High ›/);
  t.mock.timers.tick(60_000);
  let settled = false;
  void s.picked.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'waits for the user');
  s.input('\x1b[B'); s.input('\x1b[C'); // model p/b
  assert.match(s.render(), /Thinking +‹ SDK default ›/);
  s.input('\r');
  const result = await s.picked; assert.equal(result?.instructions,'A\nB\nC\nD'); assert.equal(result?.kind.name,request().kinds[1].name);
  assert.deepEqual(result?.runtime, { ...request().initial, model: 'p/b', thinking: undefined });
});

test('picker: harness change resets model and thinking to that harness defaults; Esc cancels', async () => {
  const s = surface(request());
  s.input('\r'); s.input('\r'); s.input('\x1b[C');
  assert.match(s.render(), /Harness +‹ other ›/); assert.match(s.render(), /Model +‹ c ›/); assert.match(s.render(), /Thinking +‹ Low ›/);
  s.input('\r');
  assert.deepEqual((await s.picked)?.runtime, { ...request().initial, sdk: 'other', model: 'c', thinking: 'low' });
  const cancelled = surface(request());
  cancelled.input('\x1b');
  assert.equal(await cancelled.picked, undefined);
});

test('picker: step 3 shows checking state, updates live when usage resolves, highlights matched provider, and unsubscribes on close', async () => {
  let snap: UsageSnapshot | undefined;
  const listeners = new Set<() => void>();
  const usage: UsageView = {
    current: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  let renders = 0;
  let component!: Component;
  const prior = { render: () => [], invalidate() {} }; let focus: Component | null = prior;
  const tui = { terminal: { rows: 24 }, requestRender() { renders++; }, getFocusedComponent: () => focus, setFocus: (c: Component | null) => { focus = c; } };
  const color = (tone: string, s: string) => tone === 'accent' || tone === 'warning' || tone === 'error' ? `<${tone}>${s}</${tone}>` : s;
  const ui = { setWidget(_key: string, factory?: Function) {
    if (factory) component = factory(tui, { fg: color, bg: (_: string, s: string) => s });
    else (component as Component & { dispose(): void }).dispose();
  } };
  const req: LaunchRequest = {
    kinds: [...KINDS.values()],
    initial: { ...MAIN, model: 'anthropic/claude-sonnet-4-5', thinking: 'high' },
    choices: [
      { sdk: 'pi', model: 'anthropic/claude-sonnet-4-5', levels: ['low', 'high'], thinking: 'high' },
      { sdk: 'pi', model: 'openai-codex/gpt-5.3-codex', levels: ['low', 'high'], thinking: 'high' },
    ],
    usage,
  };
  const picked = launchPanel(ui as unknown as ExtensionContext['ui'], req);
  component.handleInput!('\r');
  component.handleInput!('\r');
  assert.match(component.render(80).join('\n'), /Usage · checking…/);
  assert.equal(listeners.size, 1);

  snap = {
    fetchedAt: 1,
    providers: [
      { provider: 'claude', available: true, fiveHour: { usedPercent: 75, remainingPercent: 25, resetsAt: null }, weekly: { usedPercent: 20, remainingPercent: 80, resetsAt: null }, fetchedAt: '' },
      { provider: 'codex', available: true, fiveHour: { usedPercent: 10, remainingPercent: 90, resetsAt: null }, weekly: null, fetchedAt: '' },
    ],
  };
  const before = renders;
  for (const fn of listeners) fn();
  assert.equal(renders, before + 1);
  const rendered = component.render(120).join('\n');
  assert.match(rendered, /<accent>●<\/accent> <accent>claude\s+<\/accent> <warning>5h 25% left · 7d 80% left<\/warning>/);
  assert.match(rendered, /codex\s+5h 90% left/);

  component.handleInput!('\x1b');
  assert.equal(await picked, undefined);
  assert.equal(listeners.size, 0, 'unsubscribes on dispose');
});

test('resolveRuntime: explicit fields first, Main defaults otherwise; incompatible inherited thinking is dropped', async () => {
  const driver = fakeDriver({});
  driver.catalog = () => { throw new Error('unexpected discovery'); };
  let model = 'p/main', thinking = 'high';
  driver.defaultModel = () => model;
  driver.defaultThinking = () => thinking;
  const signal = new AbortController().signal;
  assert.deepEqual(await resolveRuntime(driver, {}, signal), { ...MAIN, model: 'p/main', thinking: 'high' });
  model = 'p/new'; thinking = 'off';
  assert.deepEqual(await resolveRuntime(driver, {}, signal), { ...MAIN, model: 'p/new', thinking: 'off' });
  thinking = 'unsupported';
  assert.equal((await resolveRuntime(driver, {}, signal)).thinking, undefined);
  assert.deepEqual(await resolveRuntime(driver, { model: 'p/override', thinking: 'medium' }, signal),
    { name: 'launch', sdk: 'pi', path: '', via: 'launch request', model: 'p/override', thinking: 'medium' });
  await assert.rejects(resolveRuntime(driver, { thinking: 'unsupported' }, signal), /not a pi thinking level/, 'explicit values are never dropped');
});

test('runtime preflight precedes repository checks, and children inherit the owner runtime', async t => {
  const { dir, root, state } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(`${root}/app.py`, 'dirty');
  const order: string[] = [], seen: Spec[] = [];
  const driver = fakeDriver({ agent: async turn => { await turn.tool('submit', planSubmission); }, review: async turn => { await turn.tool('submit', pass); } }, seen);
  driver.validate = async runtime => { order.push(`validate ${runtime.model}`); if (runtime.model === 'p/bad') throw new Error('unknown model p/bad'); };
  const at = (cwd: string) => new Worq({ driver, config: config(), kinds: KINDS, state, cwd, notify() {} });
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
  const worq = new Worq({ config: config(), kinds: KINDS, driver, state: '', cwd: '', notify() {} });
  const pending = worq.spawn('plan', 'test', { title: 'Test launch' });
  await visible; await worq.shutdown(); await assert.rejects(pending, /closed/);
  assert.equal(worq.size, 0);
});
