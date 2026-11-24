import { mixColors, MouseRegion, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Row, Telemetry } from './telemetry.ts';

export const shade = (theme: Theme, text: string) => theme.style?.(text, { bg: mixColors(theme.colors.customMessageBg, theme.colors.accent, 0.55) }) ?? text;
export const working = (r: Row) => !['closed','handed-off','answered','done','failed','cancelled'].includes(r.state);
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms/1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m ${s%60}s` : `${Math.floor(s/3600)}h ${Math.floor(s/60)%60}m`;
}
const cell = (s: string, n: number) => { const t = truncateToWidth(s,n,'…'); return t + ' '.repeat(Math.max(0,n-visibleWidth(t))); };
export const metrics = (r: Row) => [r.rate == null ? '—' : `${r.rate.toFixed(1)}%`, r.speed == null ? '—' : `${Math.round(r.speed)}`, String(r.turns ?? '—')];
/** The dock's `harness/model/thinking` label; the model ref's provider/id stays in the inspector. Empty when setup was not observed. */
const modelLabel = (r: Row) => [r.setup?.sdk, r.setup?.model?.split('/').filter(Boolean).at(-1), r.setup?.thinking].filter(Boolean).join('/');
const contextUsage = ({ context }: Row) => {
  if (context?.percent == null) return '—';
  const n = context.contextWindow;
  const total = n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : String(n);
  return `${context.percent.toFixed(1)}%/${total}`;
};
export function agentDock(data: Telemetry, theme: Theme, folded: () => boolean, toggle: () => void, inspect: (ref?: string, key?: string) => void, height: () => number) {
  let visible: Row[] = [];
  return new MouseRegion({ invalidate() {}, render(w) {
    const all = [...data.rows.values()];
    const owners = all.filter(r => !r.parent && (working(r) || r.actor)).reverse().sort((a,b) => Number(!!b.actor)-Number(!!a.actor));
    const children = new Map<string, Row[]>();
    for (const r of all) if (r.parent && working(r)) {
      const siblings = children.get(r.parent);
      if (siblings) siblings.push(r); else children.set(r.parent,[r]);
    }
    const rows = owners.flatMap(r => [r,...(children.get(r.key) ?? [])]);
    visible = folded() ? [] : rows.slice(0, Math.max(1, Math.min(6, height()-12)));
    const band = (s: string) => shade(theme,cell(s,w));
    const control = (s: string) => theme.bold?.(s) ?? s;
    const more = folded() || rows.length <= visible.length ? '' : ` · +${rows.length-visible.length}`;
    const live = `${rows.filter(working).length} live${more}`;
    const header = w < 35 ? band(`${folded()?'[+]':'[−]'} ${live} · WORQ`) : band(`${control(`${folded()?'[+]':'[−]'} [Inspect]`)}  ◈ WORQ   ${live} · ${owners.filter(r=>r.actor).length} need Main`);
    if (folded()) return [header];
    // Keep Activity readable, but give extra space to titles and PQ questions.
    const activityWidth = w >= 74 ? Math.min(20, w-58) : Math.min(16, w-35);
    // MODEL sits against ACTIVITY and takes only what the longest visible label needs, so the slack stays with titles.
    const longest = Math.max(0, ...visible.map(r => visibleWidth(modelLabel(r))));
    const modelWidth = Math.max(12, longest+1);
    const showModel = w >= 74 && longest > 0 && w-40-activityWidth-modelWidth >= 18;
    const sizes = w >= 74 ? [w-40-activityWidth-(showModel ? modelWidth : 0),...(showModel ? [modelWidth] : []),activityWidth,7,7,7,7,12]
      : w >= 45 ? [w-18-activityWidth,activityWidth,8,10]
      : [Math.floor(w*.5),w-Math.floor(w*.5)];
    const table = (values:string[]) => sizes.map((n,i)=>cell(values[i]??'',n)).join('');
    const labels = w < 35 ? cell(' AGENT · STATE',w) : table([' AGENT',...(showModel ? ['MODEL'] : []),'ACTIVITY','AGE','CACHE','TOK/S','TURNS','CTX']);
    return [header,theme.fg('muted',labels),...visible.map(r=>{
      const age = elapsed((working(r) ? Date.now() : r.since) - r.born);
      const [cache,speed,turns] = metrics(r);
      if(w < 35 && r.question && r.parent) return cell(`↳ ${r.question}`,w);
      const prefix = !r.parent && r.title != null
        ? r.workflow ? 'Workflow : ' : r.role === 'plan' || r.role === 'execute' ? `${r.role}: ` : ''
        : '';
      const title = prefix ? `${prefix}${r.title}` : r.title;
      if(w < 35) return cell(`${title ?? r.ref} ${r.actor ? `${r.state} Main` : prefix ? r.state : `${r.role} ${r.state}`}`,w);
      const id = `${r.parent?' ↳':r.state==='failed'?' ×':r.actor?' ◆':' ●'} ${r.question ?? (r.parent ? r.role : title ?? `${r.role} ${r.ref}`)}`;
      const activity = r.blocker ? `${r.state} · Main` : r.current.values().next().value?.name ?? r.phase ?? r.state;
      const rest = table(['',...(showModel ? [modelLabel(r) || '—'] : []),activity,age,cache,speed,turns,contextUsage(r)]).slice(sizes[0]);
      return theme.fg(r.state==='failed'?'error':r.blocker?'warning':working(r)?'success':'muted',cell(id,sizes[0])) + rest;
    })];
  } }, e=>{
    if(e.type!=='click'||e.button!=='left') return;
    if(e.y===0 && e.x<3) toggle(); else if(e.y===0 && e.width>=35 && e.x<13) inspect(); else if(e.y>=2 && visible[e.y-2]) inspect(visible[e.y-2].ref,visible[e.y-2].key); else return;
    return {handled:true};
  });
}
