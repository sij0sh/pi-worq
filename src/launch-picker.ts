import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { Block } from './contracts.ts';
import { clean } from './render.ts';
import type { LaunchRequest, ModelChoice, SelectLaunch } from './runtime/launch.ts';
import type { Runtime, RuntimeChange } from './sdk/contract.ts';

interface Pending extends LaunchRequest {
  selected: Runtime; deadline?: number; finish(error?: unknown): void;
}
function boxed(theme: { fg(color: string, s: string): string }, width: number, lines: string[]) {
  if (width < 4) return lines.map(line => truncateToWidth(line, width));
  const border = (s: string) => theme.fg('border', s);
  const rule = '─'.repeat(width - 2);
  return [border(`╭${rule}╮`), ...lines.map(line => {
    const body = truncateToWidth(line, width - 4);
    return `${border('│')} ${body}${' '.repeat(width - 3 - visibleWidth(body))}${border('│')}`;
  }), border(`╰${rule}╯`)];
}
function cycle<T>(values: readonly T[], value: T, delta: number) {
  return values[(values.indexOf(value) + values.length + delta) % values.length];
}

/** One overlay per Worq instance. Editing a row never delays its siblings. */
export function launchPicker(ui: ExtensionContext['ui']): SelectLaunch {
  const rows: Pending[] = [];
  let showing = false, active: Pending | undefined, field = 0;
  let refresh: (() => void) | undefined;
  async function show() {
    if (showing || !rows.length) return;
    showing = true;
    let clock: ReturnType<typeof setInterval> | undefined;
    try {
      await ui.custom<void>((tui, theme, _keys, done) => {
        refresh = () => {
          if (!rows.length) { refresh = undefined; done(); return; }
          if (!active || !rows.includes(active)) { active = rows[0]; field = 0; }
          tui.requestRender();
        };
        active = rows[0];
        field = 0;
        clock = setInterval(() => {
          for (const row of [...rows]) if (row.deadline !== undefined && row.deadline <= Date.now()) row.finish();
          refresh?.();
        }, 100);
        if (!rows.length) queueMicrotask(() => refresh?.());
        return {
          invalidate() {},
          dispose() { for (const row of [...rows]) row.finish(new Block('cancelled', 'Launch picker closed')); },
          render(width) {
            if (!active) return [];
            const r = active.selected;
            const visibleCount = Math.max(1, Math.min(6, tui.terminal.rows - 10));
            const start = Math.max(0, rows.indexOf(active) - visibleCount + 1);
            const lines = [theme.fg('accent', `Launch SDK agent · ${rows.length} pending`),
              ...rows.slice(start, start + visibleCount).map(row => `${row === active ? '▸' : ' '} ${row.deadline === undefined ? 'paused' : `${Math.max(0, Math.ceil((row.deadline - Date.now()) / 1000))}s`} · ${clean(row.label).replace(/\s+/g, ' ')}`),
              `Preset: ${active.initial.name}`, ...[`Harness: ${r.sdk}`, `Model: ${r.model ?? 'SDK default'}`, `Thinking: ${r.thinking ?? 'SDK default'}`].map((s,i) => `${field === i ? '›' : ' '} ${clean(s).replace(/\s+/g, ' ')}`),
              '↑↓ field · ←→ change · Tab next agent', 'Enter launch now · A launch all · Esc cancel selected'];
            return boxed(theme, width, lines);
          },
          handleInput(data) {
            const row = active;
            if (!row || !rows.includes(row)) return;
            if (matchesKey(data, 'enter')) return row.finish();
            if (matchesKey(data, 'escape')) return row.finish(new Block('cancelled', 'SDK launch cancelled'));
            if (data.toLowerCase() === 'a') { for (const r of [...rows]) r.finish(); return; }
            if (matchesKey(data, 'tab')) { active = cycle(rows, row, 1); active.deadline = undefined; field = 0; }
            else if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
              row.deadline = undefined; field = (field + (matchesKey(data, 'up') ? 2 : 1)) % 3;
            } else if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
              row.deadline = undefined;
              const delta = matchesKey(data, 'left') ? -1 : 1;
              const r = row.selected;
              let choice = row.choices.find(c => c.sdk === r.sdk && c.model === r.model)!;
              if (field === 0) {
                const sdk = cycle([...new Set(row.choices.map(c => c.sdk))], r.sdk, delta);
                if (sdk !== r.sdk) choice = row.choices.find(c => c.sdk === sdk)!;
              } else if (field === 1) choice = cycle(row.choices.filter(c => c.sdk === r.sdk), choice, delta);
              const thinking = field === 2 ? cycle(choice.levels, r.thinking ?? '', delta) : choice.levels.includes(r.thinking ?? '') ? r.thinking : choice.levels.includes('low') ? 'low' : choice.levels[0];
              row.selected = { ...r, sdk: choice.sdk, model: choice.model, thinking,
                fallbackModel: choice.sdk === row.initial.sdk && choice.model === row.initial.model ? row.initial.fallbackModel : undefined };
            } else return;
            refresh?.();
          },
        };
      }, { overlay: true, overlayOptions: { width: '85%', anchor: 'center' } });
    } catch (error) { for (const row of [...rows]) row.finish(error); }
    finally { clearInterval(clock); refresh = undefined; showing = false; if (rows.length) void show(); }
  }
  return request => new Promise((resolve, reject) => {
    request.signal.throwIfAborted();
    const abort = () => row.finish(request.signal.reason);
    const row: Pending = { ...request, selected: request.initial, deadline: Date.now() + request.seconds * 1000,
      finish(error) {
        const i = rows.indexOf(row);
        if (i < 0) return;
        rows.splice(i, 1); request.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(row.selected);
        refresh?.();
      } };
    rows.push(row); request.signal.addEventListener('abort', abort, { once: true }); refresh?.(); void show();
  });
}

export interface RuntimeRequest { label: string; current: Runtime; choices: ModelChoice[]; pending?: RuntimeChange }
/**
 * Live-session variant of the launch picker: no countdown, harness locked. Resolves the change
 * (only fields that differ from the current runtime), or undefined when dismissed or unchanged.
 */
export async function runtimePicker(ui: ExtensionContext['ui'], request: RuntimeRequest): Promise<RuntimeChange | undefined> {
  const { current, choices } = request;
  const start = { model: request.pending?.model ?? current.model, thinking: request.pending?.thinking ?? current.thinking };
  let choice = choices.find(c => c.model === start.model) ?? choices[0];
  if (!choice) throw new Block('capability', 'No models available for this harness');
  let thinking = start.thinking !== undefined && choice.levels.includes(start.thinking) ? start.thinking : choice.levels.includes('low') ? 'low' : choice.levels[0];
  let field = 0;
  return ui.custom<RuntimeChange | undefined>((tui, theme, _keys, done) => ({
    invalidate() {},
    render(width) {
      const lines = [theme.fg('accent', `Runtime · ${clean(request.label).replace(/\s+/g, ' ')}`),
        `  Harness: ${current.sdk} (locked)`,
        ...[`Model: ‹ ${choice.model ?? 'SDK default'} ›`, `Thinking: ‹ ${thinking ?? 'not controllable'} ›`].map((s, i) => `${field === i ? '›' : ' '} ${clean(s)}`),
        theme.fg('muted', request.pending ? 'A change is already queued; this replaces it.' : 'Keeps the session; applies at the next safe execution boundary.'),
        '↑↓ select · ←→ change · Enter apply · Esc dismiss'];
      return boxed(theme, width, lines);
    },
    handleInput(data) {
      if (matchesKey(data, 'escape')) return done(undefined);
      if (matchesKey(data, 'enter')) {
        const change: RuntimeChange = {};
        if (choice.model !== current.model && choice.model !== undefined) change.model = choice.model;
        if (thinking !== current.thinking && thinking !== undefined) change.thinking = thinking;
        return done(change.model || change.thinking ? change : undefined);
      }
      if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'tab')) field = 1 - field;
      else if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        const delta = matchesKey(data, 'left') ? -1 : 1;
        if (field === 0) {
          choice = cycle(choices, choice, delta);
          if (thinking === undefined || !choice.levels.includes(thinking)) thinking = choice.levels.includes('low') ? 'low' : choice.levels[0];
        } else if (choice.levels.length) thinking = cycle(choice.levels, thinking ?? choice.levels[0], delta);
      } else return;
      tui.requestRender();
    },
  }), { overlay: true, overlayOptions: { width: '70%', anchor: 'center' } });
}
