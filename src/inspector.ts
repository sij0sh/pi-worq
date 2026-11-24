import { elapsed, metrics, shade } from './dock.ts';
import { type TuiMouseEvent, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Outcome, Row, Telemetry } from './telemetry.ts';

const age = (time: number) => elapsed(Date.now()-time);
const active = (r: Row) => !['closed', 'failed', 'cancelled', 'done', 'answered'].includes(r.state);
const headline = (r: Row) => `${r.question ?? (r.title ? `${r.title} (${r.ref})` : r.ref)} ${r.state}${r.actor ? ` · ${r.actor}: ${r.blocker}` : ''} · ${r.role}`;
const fit = (s: string, w: number) => w > 0 ? truncateToWidth(s, w, w >= 3 ? '…' : '') : '';
const tone = (r: Row) => r.state === 'failed' ? 'error' : r.blocker ? 'warning' : active(r) ? 'accent' : 'muted';
const displayable = (r: Row) => !r.parent && (active(r) || !!r.actor);
export const hasGlance = (data: Telemetry) => [...data.rows.values()].some(displayable);
const compact = (r: Row) => `${r.title ?? r.ref} ${r.state === 'review-ready' ? 'rev-rdy' : r.state}${r.actor ? ` ${r.actor}` : ''}`;
const reviewId = (review: NonNullable<Row['review']>) => `R${review.round}.${review.slot}`;
function childIdentity(row: Row, width: number) {
  if (!row.review) return `${row.role} ${row.state}`;
  const id = reviewId(row.review);
  const nameWidth = width - visibleWidth(`${id} ${row.state}`) - 1;
  const name = nameWidth > 0 ? truncateToWidth(row.role.slice('reviewer '.length), nameWidth, '') : '';
  return `${id}${name ? ' ' + name : ''} ${row.state}`;
}
const identity = (r: Row, width: number) => width < 34 ? compact(r) : headline(r);
export function outcome(o?: Outcome): string {
  if (!o) return 'outcome not recorded';
  switch (o.kind) {
    case 'exit': return `exit ${o.code} · ${o.stdout ? 'stdout present' : 'no stdout'} · ${o.stderr ? 'stderr present' : 'no stderr'}`;
    case 'search': return `${o.count} returned${o.capped ? ' · capped' : ''}`;
    case 'timeout': return 'timeout · check duration and time limit';
    case 'launch': return 'launch failure · check executable/environment';
    case 'output-limit': return 'output limit · narrow output';
    case 'cleanup-unconfirmed': return `cleanup unconfirmed${o.cancelled ? ' after abort' : ''} · check process before retry`;
    case 'cancelled': return 'cancelled';
    case 'process-exit': return 'ended without numeric exit';
    case 'sdk-error': return 'SDK tool error';
    case 'missing': return 'outcome not recorded';
    case 'ok': return 'completed';
  }
}
const ACTIVITY = 1;
const tabs = ['Agents', 'Activity', 'Evidence'];
export class Inspector {
  private tab = ACTIVITY;
  private focusDetail = true;
  private activityPage = { offset: 0, maxOffset: 0 };
  private shownActivity: string[] = [];
  private pausedActivity?: string[];
  private key?: string;
  private offset = 0;
  private maxOffset = 0;
  private readonly data: Telemetry;
  private readonly ref?: string;
  private readonly theme: Theme;
  private readonly height: () => number;
  private readonly redraw: () => void;
  private readonly close: () => void;
  constructor(data: Telemetry, ref: string | undefined, theme: Theme, height: () => number, redraw: () => void, close: () => void, key?: string) {
    if (key) { this.key = key; this.tab = 0; }
    this.data = data;
    this.ref = ref;
    this.theme = theme;
    this.height = height;
    this.redraw = redraw;
    this.close = close;
  }
  private roster() {
    const owners: Row[] = [];
    const children = new Map<string, Row[]>();
    for (const row of this.data.rows.values()) {
      if (this.ref && row.ref !== this.ref) continue;
      if (!row.parent) owners.push(row);
      else {
        let family = children.get(row.parent);
        if (!family) children.set(row.parent, family = []);
        family.push(row);
      }
    }
    return owners.flatMap(owner => [owner, ...(children.get(owner.key) ?? [])]);
  }
  handleInput(input: string) {
    if (matchesKey(input, 'escape')) { if (!this.focusDetail) return this.close(); this.focusDetail = false; }
    else if (matchesKey(input, 'tab') || matchesKey(input, 'shift+tab')) { this.tab = (this.tab + (matchesKey(input, 'tab') ? 1 : 2)) % tabs.length; this.offset = 0; }
    else if (matchesKey(input, 'enter')) { this.focusDetail = !this.focusDetail; this.offset = 0; }
    else if (this.tab === ACTIVITY && (matchesKey(input, 'j') || matchesKey(input, 'shift+j'))) {
      this.pausedActivity = undefined;
      this.activityPage.offset = 0;
      this.focusDetail = true;
    }
    else if (matchesKey(input, 'up') || matchesKey(input, 'down')) {
      const delta = matchesKey(input, 'up') ? -1 : 1;
      if (this.focusDetail && this.tab === ACTIVITY) {
        const page = this.activityPage;
        const next = Math.max(0, Math.min(page.maxOffset, page.offset + delta));
        if (next > page.offset) this.pausedActivity ??= this.shownActivity;
        page.offset = next;
      } else if (this.focusDetail) this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
      else {
        const rows = this.roster();
        const i = Math.max(0, rows.findIndex(r => r.key === this.key));
        this.key = rows[Math.max(0, Math.min(rows.length - 1, i + delta))]?.key;
        this.offset = 0;
      }
    } else return;
    this.redraw();
  }
  private hitRows: Row[] = [];
  handleMouse(e: TuiMouseEvent) {
    if (e.type === 'wheel') { this.handleInput((e.wheelDelta ?? 0) > 0 ? '\x1b[B' : '\x1b[A'); return { handled: true }; }
    if (e.type !== 'click' || e.button !== 'left') return;
    if (e.y === 0 && e.width >= 64 && e.x >= e.width-30) {
      const x = e.x - (e.width-30);
      this.tab = x < 9 ? 0 : x < 20 ? 1 : 2; this.focusDetail = true; this.offset = 0;
    } else if (this.tab === ACTIVITY && e.y === 2) this.handleInput('j');
    else {
      const r = this.hitRows[e.y-(this.tab === ACTIVITY ? 3 : 2)];
      if (!r || (e.width < 80 ? this.focusDetail : e.x >= Math.min(40, Math.floor(e.width*.4)))) return;
      this.key = r.key; this.tab = 0; this.offset = 0; this.focusDetail = true;
    }
    this.redraw(); return { handled: true };
  }
  invalidate() {}
  private activityLines(): string[] {
    const lines = this.data.activity.slice().reverse().flatMap(e => {
      const row = this.data.rows.get(e.key);
      if (!row || (this.ref && row.ref !== this.ref)) return [];
      const source = row.question ?? `${row.title ?? row.ref}${row.parent ? ` ${row.role}${row.review ? ` ${reviewId(row.review)}` : ''}` : ''}`;
      return [`${source} · ${e.text}${e.outcome ? ' · ' + outcome(e.outcome) : ''} · ${age(e.at)} ago`];
    });
    if (!lines.length) lines.push('No activity observed.');
    if (this.data.activityGap) lines.push(`Activity gap · ${this.data.activityGap} older events evicted session-wide`);
    return lines;
  }
  private detail(row?: Row): string[] {
    if (!row) return ['No Worq agents observed in this session.'];
    if (this.tab === 0) {
      const c = row.cache;
      const [cache, speed, turns] = metrics(row);
      const children = [...this.data.rows.values()].filter(r => r.parent === row.key && r.question);
      return [headline(row), `${cache} cache · ${speed} tok/s · ${turns} turns`, ...(row.question ? [`${row.parent ? '↳' : 'Task:'} ${row.question}`] : []), ...children.map(r => `↳ ${r.role} · ${r.state}: ${r.question}`), `Age ${age(row.born)} · state ${age(row.since)}`, `Lineage: ${row.parent ? 'child of ' + row.ref + (row.review ? ' · ' + reviewId(row.review) : '') : 'owner'}`, `Observed phase: ${row.phase ?? 'unavailable'}`,
        ...[...row.current.values()].map(c => `Current: ${c.name} · ${age(c.at)}`),
        row.last ? `Last: ${row.last.name} · ${outcome(row.last.outcome)}` : 'Last tool: not recorded',
        `Model: ${row.setup?.model ?? 'unavailable'}`, `Thinking: ${row.setup?.thinking ?? 'unavailable'}`,
        `Injected pinned skills: ${row.setup ? row.setup.skills.join(', ') || 'none' : 'unavailable'}`,
        `Child context estimate: ${row.context?.percent == null ? 'unavailable' : `${row.context.percent.toFixed(1)}%${row.phase === 'closed' || Date.now() - row.context.at > 60_000 ? ' (stale)' : ''}`}`,
        `SDK-normalized cache · child session, finalized responses (${c.responses})`, `Read: ${c.reads ? c.read : 'unavailable'} · ${c.reads}/${c.responses} with SDK field`, 'Provider coverage unverified; zero may be an SDK default.', `Write: ${c.writes ? c.write : 'unavailable'} · ${c.writes}/${c.responses} with SDK field`];
    }
    const key = row.parent ?? row.key;
    const live = this.data.live.get(key);
    const history = this.data.settled.filter(r => r.run === key && r.round !== live?.round).reverse();
    return ['Session-only exact revision evidence', 'Full finding text not copied · merge not observed',
      ...(this.data.evidenceGap ? [`Evidence gap · ${this.data.evidenceGap} settled rounds evicted session-wide`] : []),
      ...(!live && !history.length ? ['Evidence not recorded'] : []), ...[...(live ? [live] : []), ...history].flatMap(r => [
        `Round ${r.round} · ${r.ready ? 'review-ready · ' : ''}${r.status === 'pass' ? 'review roster pass' : r.status}`, 'sha' in r.identity ? `SHA ${r.identity.sha}` : `Digest ${r.identity.digest}`,
        r.source ? `Matching run record: ${row.ref} · round ${r.round} (/worq list)` : 'Historical prose unavailable',
        ...(r.rewritten ? ['Worq rewrote the plan location'] : []),
        ...r.reviews.flatMap(v => [`${v.name}: ${v.verdict} · ${v.findings.length} findings · ${v.artifacts} saved artifacts`, ...v.findings.map((need, i) => `  #${i + 1}${need ? ' · requester needed' : ''}`)]),
      ])];
  }
  render(width: number): string[] {
    if (width <= 0) return [];
    const rows = this.roster();
    let index = rows.findIndex(r => r.key === this.key);
    if (index < 0) index = 0;
    const selected = rows[index];
    this.key = selected?.key;
    const height = Math.max(1, Math.min(24, this.height() - 4));
    const wide = width >= 80;
    const bar = fit(`◈ Worq · ${tabs[this.tab]} · ${rows.length} roles`, width);
    const buttons = width >= 64 ? '[Agents] [Activity] [Evidence]' : '';
    const header = bar + ' '.repeat(Math.max(0,width-visibleWidth(bar)-buttons.length)) + buttons;
    const title = shade(this.theme, header);
    const activity = this.tab === ACTIVITY;
    const follow = this.pausedActivity
      ? (width >= 23 ? 'Paused · J Jump to live' : 'J · Jump to live')
      : 'Live';
    const arrows = `↑↓ ${this.focusDetail ? 'scroll' : 'select'}`;
    const hint = fit(width < 24 ? `${arrows} ↵ Tab Esc` : width < 56 ? `${arrows} · ↵ · Tab · Esc`
      : `${arrows} · Enter ${this.focusDetail ? 'roster' : 'detail'} · Tab views · Esc back/close`, width);
    const start = Math.max(0, index - height + 1);
    const left = Math.min(40, Math.floor(width * .4));
    const rosterWidth = wide ? left : width;
    this.hitRows = rows.slice(start, start + height);
    const lanes = new Map<string,string[]>();
    const now = Date.now();
    if (activity && wide) for (const event of this.data.activity) {
      const i = 11 - Math.floor((now-event.at)/5000);
      if (i<0 || i>11) continue;
      const lane = lanes.get(event.key) ?? Array<string>(12).fill('·');
      lane[i] = /^(start|end) /.test(event.text) ? '▆' : event.text === 'request' ? '◉' : '▪'; lanes.set(event.key,lane);
    }
    const roster = this.hitRows.map(r => {
      const prefix = `${r === selected ? '›' : ' '} ${r.parent ? '↳ ' : ''}`;
      const budget = rosterWidth - visibleWidth(prefix);
      const text = r.parent ? (r.question ?? childIdentity(r, budget)) : identity(r, budget);
      const lane = activity && wide ? (lanes.get(r.key)?.join('') ?? '············') : '';
      const name = fit(prefix + text, rosterWidth - (lane ? 13 : 0));
      return { r, text: lane ? name + ' '.repeat(rosterWidth-12-visibleWidth(name)) + lane : name };
    });
    const detailWidth = wide ? width - left - 3 : width;
    const detailLines = activity ? (this.shownActivity = this.pausedActivity ?? this.activityLines()) : this.detail(selected);
    const detail = detailLines.flatMap(line => {
      // Preserve exact revision IDs and diagnostics even in a narrow detail pane.
      const chunks: string[] = [];
      let chunk = '';
      for (const char of line) {
        if (chunk && visibleWidth(chunk + char) > detailWidth) { chunks.push(chunk); chunk = ''; }
        chunk += char;
      }
      chunks.push(chunk);
      return chunks;
    });
    const maxOffset = Math.max(0, detail.length - height);
    let offset: number;
    if (activity) {
      this.activityPage.maxOffset = maxOffset;
      offset = this.activityPage.offset = Math.min(this.activityPage.offset, maxOffset);
    } else {
      this.maxOffset = maxOffset;
      offset = this.offset = Math.min(this.offset, maxOffset);
    }
    const page = detail.slice(offset, offset + height);
    let lines: string[];
    if (wide) {
      lines = Array.from({ length: Math.max(roster.length, page.length) }, (_, i) => {
        const item = roster[i];
        const text = fit(item?.text ?? '', left);
        const label = this.theme.fg(item ? tone(item.r) : 'muted', text + ' '.repeat(Math.max(0, left - visibleWidth(text))));
        const rail = item && item.r === selected ? shade(this.theme,label) : label;
        return rail + this.theme.fg('muted',' │ ') + fit(page[i] ?? '', width - left - 3);
      });
    } else lines = (this.focusDetail || !rows.length ? page : roster.map(x => x.text)).map(s => fit(s, width));
    return [title, this.theme.fg('muted', hint),
      ...(activity ? [this.theme.fg('muted', fit(follow + (wide ? '   60s lanes · ▆ tool  ◉ request  ▪ state' : ''), width))] : []), ...lines];
  }
}
