import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { glance, hasGlance, Inspector } from '../src/inspector.ts';
import { Telemetry } from '../src/telemetry.ts';
import { pass, planSubmission, repo, setup } from './fake.ts';

const theme = { fg: (_: string, value: string) => value } as never;
test('plan revisions bind exact reviewed bytes; keep legacy text out of the projection', async t => {
  const { root, state, dir } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = new Telemetry();
  const captured = new Map<number, string>();
  const task = 'Printable Private Task Mango';
  let round = 0;
  const { worq, next } = setup(root, state, {
    'agent.plan': async turn => { await turn.tool('submit', { ...planSubmission, summary: `Report Secret ${++round}` }); },
    reviewer: async turn => {
      const { round, submission } = JSON.parse(turn.text);
      captured.set(round, submission);
      await turn.tool('report', { ...pass, summary: 'Reviewer Secret' });
    },
  }, {}, data);
  t.after(() => worq.shutdown());
  const agent = await worq.spawn('plan', task);
  await next('review-ready', agent.ref);
  worq.send(agent.ref, 'Try a second round');
  await next('review-ready', agent.ref, 2);
  assert.equal(data.settled.length, 2);
  for (const r of data.settled) assert.deepEqual(r.identity, { digest: createHash('sha256').update(captured.get(r.round)!).digest('hex') });
  assert.equal(data.settled[0].rewritten, true);
  assert.equal(data.settled[0].source, false);
  assert.equal(data.settled[1].source, true);
  const safe = JSON.stringify({ revisions: data.settled, activity: data.activity, rows: [...data.rows] });
  assert.doesNotMatch(safe, /Printable Private Task Mango|printable-private-task-mango|Reviewer Secret|Report Secret|\.agents\/plans\//);
  assert.match(worq.list(agent.ref), /Printable Private Task Mango/);
});

test('bounded layouts and independent evidence retention through out-of-order tool churn', () => {
  const data = new Telemetry();
  for (let i = 0; i < 22; i++) {
    const key = `run${i}`;
    data.add(key, i.toString(16).padStart(4, '0'), 'plan');
    data.revision({ run: key, round: 1, identity: { digest: 'f'.repeat(64) }, status: 'pass', source: true, reviews: [] }, true);
    if (i > 0) data.live.delete(key);
  }
  data.state('run0', 'waiting', 'ask');
  const sink = data.sink('run0');
  sink({ start: 'a', name: 'run_command' });
  sink({ start: 'b', name: 'search' });
  sink({ end: 'b', outcome: { kind: 'search', count: 2, capped: true } });
  assert.deepEqual([...data.rows.get('run0')!.current.keys()], ['a']);
  for (let i = 0; i < 140; i++) {
    sink({ start: 'b', name: 'search' });
    sink({ end: 'b', outcome: { kind: 'sdk-error' } });
  }
  sink({ end: 'a', outcome: { kind: 'exit', code: 7, stdout: true, stderr: false } });
  assert.equal(data.activity.length, 240);
  assert.ok(data.activityGap > 0);
  assert.equal(data.evidenceGap, 2);
  assert.equal(data.settled.length, 20);
  assert.equal(data.live.get('run0')?.round, 1);
  assert.equal(new Telemetry().settled.length, 0);
  let closed = false;
  const panel = new Inspector(data, undefined, theme, () => 30, () => {}, () => { closed = true; });
  for (const width of [1, 4, 22, 79, 80, 140]) {
    const rows = glance(data, width, theme);
    assert.ok(rows.length <= 4);
    assert.ok([...rows, ...panel.render(width)].every(line => visibleWidth(line) <= width));
  }
  panel.handleInput('\t');
  assert.match(panel.render(140).join('\n'), /exit 7/);
  panel.handleInput('\t');
  panel.handleInput('\r');
  assert.match(panel.render(30).join('\n'), /Evidence gap/);
  panel.handleInput('\x1b');
  assert.equal(closed, false);
  panel.handleInput('\x1b');
  assert.equal(closed, true);
});


test('20-column glance retains actor, status and overflow without counting failures as live', () => {
  const data = new Telemetry();
  data.add('failed', '0000', 'plan');
  data.state('failed', 'failed', 'failure');
  assert.match(glance(data, 20, theme).join(' '), /0 live 1 fail.*@0000 failed Main/);
  assert.equal(hasGlance(data), true);
  for (let i = 1; i < 99; i++) data.add(String(i), i.toString(16).padStart(4, '0'), 'execute');
  data.state('1', 'waiting', 'ask');
  data.state('2', 'review-ready', 'adjudicate');
  const narrow = glance(data, 20, theme);
  assert.deepEqual(narrow, ['98 live 1 fail +97', '@0001 waiting Main', '@0002 rev-rdy Main', '/worq-inspect']);
  assert.ok(narrow.every(line => visibleWidth(line) <= 20));
  data.state('1', 'closed');
  assert.equal(glance(data, 20, theme)[2], '@0000 failed Main');
  const panel = new Inspector(data, '0002', theme, () => 24, () => {}, () => {});
  assert.match(panel.render(20).join(' '), /@0002 rev-rdy Main/);
  assert.equal(hasGlance(new Telemetry()), false);
});


test('inspector groups interleaved children under owners and preserves selection identity', () => {
  const data = new Telemetry();
  data.add('a', 'aaaa', 'plan');
  data.add('b', 'bbbb', 'execute');
  data.add('b1', 'bbbb', 'PQ d1', 'b');
  data.add('a1', 'aaaa', 'PQ d1', 'a');
  const panel = new Inspector(data, undefined, theme, () => 24, () => {}, () => {});
  panel.render(65);
  panel.handleInput('\x1b[B');
  panel.handleInput('\x1b[B');
  data.add('a2', 'aaaa', 'PQ d2', 'a');
  const roster = panel.render(65).slice(2).join('\n');
  assert.match(roster, /@aaaa.*plan[\s\S]*↳ PQ d1[\s\S]*↳ PQ d2[\s\S]*› @bbbb.*execute[\s\S]*↳ PQ d1/);
  data.sink('b')({ cache: { read: 0 } });
  panel.handleInput('\r');
  const details = panel.render(65).join('\n');
  assert.match(details, /SDK-normalized cache/);
  assert.match(details, /Read: 0 · 1\/1 with SDK field/);
  assert.match(details, /zero may be an SDK default/);
});
