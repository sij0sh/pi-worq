import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Outcome, Row, Telemetry } from './telemetry.ts';

const age = (time: number) => `${Math.max(0, Math.floor((Date.now() - time) / 1000))}s`;
const active = (r: Row) => !['closed', 'failed', 'cancelled', 'done', 'answered'].includes(r.state);
const headline = (r: Row) => `@${r.ref} ${r.state}${r.actor ? ` · ${r.actor}: ${r.blocker}` : ''} · ${r.role}`;
const fit = (s: string, w: number) => w > 0 ? truncateToWidth(s, w, w >= 3 ? '…' : '') : '';
const tone = (r: Row) => r.state === 'failed' ? 'error' : r.blocker ? 'warning' : active(r) ? 'accent' : 'muted';
const displayable = (r: Row) => !r.parent && (active(r) || !!r.actor);
export const hasGlance = (data: Telemetry) => [...data.rows.values()].some(displayable);
const priority = (r: Row) => active(r) ? (r.actor ? 0 : 2) : 1;
const compact = (r: Row) => `@${r.ref} ${r.state === 'review-ready' ? 'rev-rdy' : r.state}${r.actor ? ` ${r.actor}` : ''}`;
const reviewId = (review: NonNullable<Row['review']>) => `R${review.round}.${review.slot}`;
function childIdentity(row: Row, width: number) {
  if (!row.review) return `${row.role} ${row.state}`;
  const id = reviewId(row.review);
  const nameWidth = width - visibleWidth(`${id} ${row.state}`) - 1;
  const name = nameWidth > 0 ? truncateToWidth(row.role.slice('reviewer '.length), nameWidth, '') : '';
  return `${id}${name ? ' ' + name : ''} ${row.state}`;
}
const identity = (r: Row, width: number) => width < 34 ? compact(r) : headline(r);
export function glance(data: Telemetry, width: number, theme: Theme) {
  const rows = [...data.rows.values()].filter(displayable).sort((a, b) => priority(a) - priority(b));
  if (!rows.length || width <= 0) return [];
  const live = rows.filter(active).length;
  const failed = rows.length - live;
  const overflow = rows.length > 2 ? ` +${rows.length - 2}` : '';
  const compactHeader = `${live} live${failed ? ` ${failed} fail` : ''}${overflow}`;
  const narrowHeader = `${overflow.trim()}${overflow ? ' · ' : ''}${live}L${failed ? ` ${failed}F` : ''}`;
  const fullHeader = `Worq ${live} live${failed ? ` · ${failed} failed` : ''}${overflow} · ${rows.filter(r => r.blocker).length} need Main`;
  const header = [fullHeader, compactHeader, narrowHeader].find(s => visibleWidth(s) <= width) ?? (overflow.trim() || narrowHeader);
  return [theme.fg('accent', fit(header, width)),
    ...rows.slice(0, 2).map(r => {
      const line = identity(r, width);
      const activity = r.current.values().next().value?.name ?? r.phase;
      const detail = `${line}${activity ? ` · ${activity}` : ''} ${age(r.since)}`;
      return theme.fg(tone(r), fit(width >= 34 ? detail : line, width));
    }),
    ...(width >= '/worq-inspect'.length ? [theme.fg('muted', '/worq-inspect')] : [])];
}
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
  constructor(data: Telemetry, ref: string | undefined, theme: Theme, height: () => number, redraw: () => void, close: () => void) {
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
  invalidate() {}
  private activityLines(): string[] {
    const lines = this.data.activity.slice().reverse().flatMap(e => {
      const row = this.data.rows.get(e.key);
      if (!row || (this.ref && row.ref !== this.ref)) return [];
      const source = `@${row.ref}${row.parent ? ` ${row.role}${row.review ? ` ${reviewId(row.review)}` : ''}` : ''}`;
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
      return [headline(row), `Age ${age(row.born)} · state ${age(row.since)}`, `Lineage: ${row.parent ? 'child of @' + row.ref + (row.review ? ' · ' + reviewId(row.review) : '') : 'owner'}`, `Observed phase: ${row.phase ?? 'unavailable'}`,
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
        r.source ? `Matching legacy record: @${row.ref} · round ${r.round} (/worq list)` : 'Historical prose unavailable',
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
    const title = this.theme.fg('accent', fit(`Worq · ${tabs[this.tab]} · ${rows.length} roles`, width));
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
    const roster = rows.slice(start, start + height).map(r => {
      const prefix = `${r === selected ? '›' : ' '} ${r.parent ? '↳ ' : ''}`;
      const budget = rosterWidth - visibleWidth(prefix);
      const text = r.parent ? childIdentity(r, budget) : identity(r, budget);
      return { r, text: fit(prefix + text, rosterWidth) };
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
        return this.theme.fg(item ? tone(item.r) : 'muted', text + ' '.repeat(Math.max(0, left - visibleWidth(text)))) + ' │ ' + fit(page[i] ?? '', width - left - 3);
      });
    } else lines = (this.focusDetail || !rows.length ? page : roster.map(x => x.text)).map(s => fit(s, width));
    return [title, this.theme.fg('muted', hint),
      ...(activity ? [this.theme.fg('muted', fit(follow, width))] : []), ...lines];
  }
}
