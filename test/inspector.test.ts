import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { agentDock } from '../src/dock.ts';
import { hasGlance, Inspector } from '../src/inspector.ts';
import { Telemetry } from '../src/telemetry.ts';
import { pass, planSubmission, repo, setup } from './fake.ts';

const theme = { fg: (_: string, value: string) => value } as never;
test('PQ gets a width-safe question preview and complete detail', () => {
  const data = new Telemetry();
  const question = 'Which source 株 explains why the greeting appears twice in the output?';
  data.add('private-owner', 'check-greeting', 'plan', undefined, undefined, undefined, 'Check greeting');
  data.add('private-child', 'check-greeting', 'PQ', 'private-owner', undefined, question);
  const dock = agentDock(data, theme, () => false, () => {}, () => {}, () => 24);
  for (const width of [18, 36, 84]) {
    const lines = dock.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.some(line => /^\s*↳ Which/.test(line)));
  }
  assert.match(dock.render(84).join('\n'), /● Check greeting/);
  const title = 'Check why the greeting appears twice';
  data.rows.get('private-owner')!.title = title;
  const [,, narrowOwner, narrowChild] = dock.render(18);
  assert.match(narrowOwner!, /^Check why/);
  assert.match(narrowChild!, /^↳ Which source/);
  data.sink('private-owner')({ start: 'task', name: 'read_file' });
  data.sink('private-child')({ start: 'task', name: 'search' });
  for (const [width, activity, age] of [[64, 30, 46], [140, 84, 104]] as const) {
    const [, labels, owner, child] = dock.render(width);
    assert.equal(labels!.indexOf('ACTIVITY'), activity);
    assert.equal(labels!.indexOf('AGE', activity), age);
    for (const [line, tool] of [[owner!, 'read_file'], [child!, 'search']] as const) {
      const start = line.indexOf(tool);
      assert.ok(start >= 0);
      assert.equal(visibleWidth(line.slice(0, start)), activity);
    }
    if (width === 140) {
      assert.ok(owner!.includes(title));
      assert.ok(child!.includes(question));
    }
  }
  data.rows.get('private-owner')!.title = 'Check greeting';
  const owner = new Inspector(data, 'check-greeting', theme, () => 24, () => {}, () => {}, 'private-owner');
  assert.match(owner.render(120).join('\n'), /Check greeting \(check-greeting\)/);
  const panel = new Inspector(data, 'check-greeting', theme, () => 24, () => {}, () => {}, 'private-child');
  assert.match(panel.render(120).map(line => line.split(' │ ')[1] ?? '').join('').replace(/ +/g, ' '), /Which source 株 explains why the greeting appears twice in the output\?/);
  assert.doesNotMatch(panel.render(120).join('\n'), /private-owner|private-child/);
});

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
  const agent = await worq.spawn('plan', task, { title: 'Inspect plans' });
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
    const rows = agentDock(data, theme, () => false, () => {}, () => {}, () => 24).render(width);
    assert.ok(rows.length <= 9);
    assert.ok([...rows, ...panel.render(width)].every(line => visibleWidth(line) <= width));
  }
  assert.match(panel.render(140).join('\n'), /exit 7/);
  panel.handleInput('\t');
  assert.match(panel.render(30).join('\n'), /Evidence gap/);
  panel.handleInput('\x1b');
  assert.equal(closed, false);
  panel.handleInput('\x1b');
  assert.equal(closed, true);
});


test('20-column dock retains actor and status without counting failures as live', () => {
  const data = new Telemetry();
  data.add('failed', '0000', 'plan');
  data.state('failed', 'failed', 'failure');
  const dock = agentDock(data, theme, () => false, () => {}, () => {}, () => 24);
  assert.match(dock.render(20).join(' '), /0 live.*0000 failed Main/);
  assert.equal(hasGlance(data), true);
  for (let i = 1; i < 99; i++) data.add(String(i), i.toString(16).padStart(4, '0'), 'execute');
  data.state('1', 'waiting', 'ask');
  data.state('2', 'review-ready', 'adjudicate');
  const narrow = dock.render(20);
  assert.match(narrow.join(' '), /98 live/);
  assert.ok(narrow.every(line => visibleWidth(line) <= 20));
  data.state('1', 'closed');
  assert.match(dock.render(20)[0], /97 live/);
  const panel = new Inspector(data, '0002', theme, () => 24, () => {}, () => {});
  panel.handleInput('\x1b');
  assert.match(panel.render(20).join(' '), /0002 rev-rdy Main/);
  assert.equal(hasGlance(new Telemetry()), false);
});


test('inspector groups interleaved children under owners and preserves selection identity', () => {
  const data = new Telemetry();
  data.add('a', 'aaaa', 'plan');
  data.add('b', 'bbbb', 'execute');
  data.add('b1', 'bbbb', 'PQ d1', 'b');
  data.add('a1', 'aaaa', 'PQ d1', 'a');
  const panel = new Inspector(data, undefined, theme, () => 24, () => {}, () => {});
  panel.handleInput('\x1b');
  panel.handleInput('\x1b[Z');
  panel.render(65);
  panel.handleInput('\x1b[B');
  panel.handleInput('\x1b[B');
  data.add('a2', 'aaaa', 'PQ d2', 'a');
  data.add('r11', 'aaaa', 'reviewer same-long-name', 'a', { round: 1, slot: 1 });
  data.add('r12', 'aaaa', 'reviewer same-long-prefix', 'a', { round: 1, slot: 2 });
  data.add('r21', 'aaaa', 'reviewer same-long-name', 'a', { round: 2, slot: 1 });
  for (const width of [20, 40, 80, 81, 120]) {
    const lines = panel.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `bounded at ${width}`);
    const roster = lines.slice(2).map(line => line.split(' │ ')[0]!.trimEnd());
    assert.deepEqual(roster.filter(line => line.includes('↳')).map(line => line.trim()), [
      '↳ PQ d1 queued', '↳ PQ d2 queued',
      ...['R1.1', 'R1.2', 'R2.1'].map(id => {
        const label = roster.find(line => line.includes(`↳ ${id} `))?.trim();
        assert.match(label ?? '', /^↳ R\d+\.\d+ (?:same\S* )?queued$/);
        return label;
      }),
      '↳ PQ d1 queued',
    ], `child labels and order at ${width}`);
    assert.match(roster.filter(line => line.startsWith('›')).join('\n'), /^› bbbb\b/);
  }
  const roster = panel.render(65).slice(2).join('\n');
  assert.match(roster, /aaaa.*plan[\s\S]*↳ PQ d1[\s\S]*↳ PQ d2[\s\S]*› bbbb.*execute[\s\S]*↳ PQ d1/);
  data.sink('b')({ cache: { read: 0 } });
  panel.handleInput('\r');
  const details = panel.render(65).join('\n');
  assert.match(details, /SDK-normalized cache/);
  assert.match(details, /Read: 0 · 1\/1 with SDK field/);
  assert.match(details, /zero may be an SDK default/);
});


test('Activity follows across roles, pauses on scroll, and jumps live without moving selection', () => {
  const data = new Telemetry();
  data.add('a', 'aaaa', 'plan');
  data.add('b', 'bbbb', 'execute');
  data.add('b1', 'bbbb', 'PQ d1', 'b');
  const panel = new Inspector(data, undefined, theme, () => 7, () => {}, () => {});
  const screen = () => panel.render(40).join('\n');
  for (let i = 0; i < 4; i++) data.sink('a')({ start: String(i), name: `older-${i}` });
  data.sink('b1')({ start: '1', name: 'newest' });
  assert.match(screen(), /Activity.*\n[^\n]*\nLive.*\nbbbb PQ d1 · start newest\b[^\n]*\naaaa · start older-3/);
  panel.handleInput('\x1b[B');
  const paused = screen();
  assert.match(paused, /Paused · J Jump to live.*\naaaa · start older-3/);
  for (let i = 0; i < 240; i++) data.sink('b')({ start: String(i), name: `fresh-${i}` });
  assert.equal(screen(), paused);
  panel.handleInput('\x1b[Z');
  assert.match(screen(), /Agents.*\n[^\n]*\naaaa .*plan/);
  panel.handleInput('\t');
  assert.equal(screen(), paused);
  panel.handleInput('j');
  assert.match(screen(), /Live.*\nbbbb · start fresh-239/);
  data.sink('b')({ start: 'final', name: 'following' });
  assert.match(screen(), /Live.*\nbbbb · start following/);
  panel.handleInput('\x1b');
  assert.match(screen(), /› aaaa .*plan/);
});

test('filtered Activity includes only its family and handles empty history', () => {
  const data = new Telemetry();
  data.add('a', 'aaaa', 'plan');
  data.add('a1', 'aaaa', 'PQ d1', 'a');
  data.add('b', 'bbbb', 'execute');
  const render = (ref: string) => new Inspector(data, ref, theme, () => 24, () => {}, () => {}).render(40).join('\n');
  assert.match(render('aaaa'), /aaaa PQ d1 · queued.*\naaaa · starting/);
  assert.doesNotMatch(render('aaaa'), /bbbb/);
  assert.match(render('cccc'), /No activity observed/);
});


test('paused Activity at 20 columns shows Jump to live without hiding navigation', () => {
  const data = new Telemetry();
  data.add('a', 'aaaa', 'plan');
  const panel = new Inspector(data, undefined, theme, () => 7, () => {}, () => {});
  for (let i = 0; i < 4; i++) data.sink('a')({ start: String(i), name: `old${i}` });
  panel.render(20);
  panel.handleInput('\x1b[B');
  const paused = panel.render(20);
  assert.ok(paused.every(line => visibleWidth(line) <= 20));
  assert.equal(paused[1], '↑↓ scroll ↵ Tab Esc');
  assert.equal(paused[2], 'J · Jump to live');
  data.sink('a')({ start: 'new', name: 'new' });
  assert.deepEqual(panel.render(20), paused);
  panel.handleInput('J');
  const live = panel.render(20);
  assert.equal(live[2], 'Live');
  assert.match(live[3], /^aaaa · start new/);
});
