import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { Block } from './contracts.ts';
import { clean } from './render.ts';
import type { ModelChoice } from './runtime/launch.ts';
import { supportedThinking, type Runtime, type RuntimeChange } from './sdk/contract.ts';

function boxed(theme: { fg(color: string, s: string): string }, width: number, lines: string[]) {
  if (width < 4) return lines.map(line => truncateToWidth(line, width));
  const border = (s: string) => theme.fg('border', s);
  const rule = '─'.repeat(width - 2);
  return [border(`╭${rule}╮`), ...lines.map(line => {
    const body = truncateToWidth(line, width - 4);
    return `${border('│')} ${body}${' '.repeat(width - 3 - visibleWidth(body))}${border('│')}`;
  }), border(`╰${rule}╯`)];
}
function cycle<T>(values: readonly T[], value: T | undefined, delta: number) {
  const at = value === undefined ? -1 : values.indexOf(value);
  const start = at < 0 && delta < 0 ? 0 : at;
  return values[(start + values.length + delta) % values.length];
}

export interface LaunchRequest { label: string; initial: Runtime; choices: ModelChoice[] }
/**
 * The /worq runtime step: harness, model and thinking, confirmed explicitly with Enter (no countdown).
 * Resolves the selection, or undefined when dismissed. Changing harness resets model and thinking to its defaults.
 */
export function launchPicker(ui: ExtensionContext['ui'], request: LaunchRequest): Promise<Runtime | undefined> {
  const { choices } = request;
  let selected: Runtime = { ...request.initial };
  let field = 0;
  return ui.custom<Runtime | undefined>((tui, theme, _keys, done) => ({
    invalidate() {},
    render(width) {
      const r = selected;
      const lines = [theme.fg('accent', `Configure SDK agent · ${clean(request.label).replace(/\s+/g, ' ')}`),
        ...[`Harness: ‹ ${r.sdk} ›`, `Model: ‹ ${r.model ?? 'SDK default'} ›`, `Thinking: ‹ ${r.thinking ?? 'SDK default'} ›`].map((s, i) => `${field === i ? '›' : ' '} ${clean(s).replace(/\s+/g, ' ')}`),
        '↑↓ field · ←→ change', 'Enter launch · Esc cancel'];
      return boxed(theme, width, lines);
    },
    handleInput(data) {
      if (matchesKey(data, 'enter')) return done(selected);
      if (matchesKey(data, 'escape')) return done(undefined);
      if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'tab')) field = (field + (matchesKey(data, 'up') ? 2 : 1)) % 3;
      else if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        const delta = matchesKey(data, 'left') ? -1 : 1;
        const r = selected;
        const current = choices.find(c => c.sdk === r.sdk && c.model === r.model);
        if (field === 0) {
          const sdk = cycle([...new Set(choices.map(c => c.sdk))], r.sdk, delta);
          const first = choices.find(c => c.sdk === sdk);
          if (sdk !== r.sdk && first) selected = { ...r, sdk, model: first.model, thinking: first.thinking };
        } else if (field === 1) {
          const next = cycle(choices.filter(c => c.sdk === r.sdk), current, delta);
          if (next) selected = { ...r, model: next.model, thinking: supportedThinking(r.thinking, next.levels) };
        } else if (current?.levels.length) selected = { ...r, thinking: cycle(current.levels, r.thinking, delta) };
      } else return;
      tui.requestRender();
    },
  }), { overlay: true, overlayOptions: { width: '85%', anchor: 'center' } });
}

export interface RuntimeRequest { label: string; current: Runtime; choices: ModelChoice[]; pending?: RuntimeChange }
/**
 * Live-session variant of the launch picker: harness locked. Resolves the change
 * (only fields that differ from the pending selection or current runtime), or undefined when dismissed or unchanged.
 */
export async function runtimePicker(ui: ExtensionContext['ui'], request: RuntimeRequest): Promise<RuntimeChange | undefined> {
  const { current, choices } = request;
  const start = { model: request.pending?.model ?? current.model, thinking: request.pending?.thinking ?? current.thinking };
  let choice = choices.find(c => c.model === start.model) ?? choices[0];
  if (!choice) throw new Block('capability', 'No models available for this harness');
  let thinking = supportedThinking(start.thinking, choice.levels);
  let field = 0;
  return ui.custom<RuntimeChange | undefined>((tui, theme, _keys, done) => ({
    invalidate() {},
    render(width) {
      const lines = [theme.fg('accent', `Runtime · ${clean(request.label).replace(/\s+/g, ' ')}`),
        `  Harness: ${current.sdk} (locked)`,
        ...[`Model: ‹ ${choice.model ?? 'SDK default'} ›`, `Thinking: ‹ ${thinking ?? 'SDK default'} ›`].map((s, i) => `${field === i ? '›' : ' '} ${clean(s)}`),
        theme.fg('muted', request.pending ? 'Editing a queued change.' : 'Keeps the session; applies at the next safe execution boundary.'),
        '↑↓ select · ←→ change · Enter apply · Esc dismiss'];
      return boxed(theme, width, lines);
    },
    handleInput(data) {
      if (matchesKey(data, 'escape')) return done(undefined);
      if (matchesKey(data, 'enter')) {
        const change: RuntimeChange = {};
        if (choice.model !== start.model && choice.model !== undefined) change.model = choice.model;
        if (thinking !== start.thinking && thinking !== undefined) change.thinking = thinking;
        return done(change.model || change.thinking ? change : undefined);
      }
      if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'tab')) field = 1 - field;
      else if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        const delta = matchesKey(data, 'left') ? -1 : 1;
        if (field === 0) {
          choice = cycle(choices, choice, delta);
          thinking = supportedThinking(thinking, choice.levels);
        } else if (choice.levels.length) thinking = cycle(choice.levels, thinking, delta);
      } else return;
      tui.requestRender();
    },
  }), { overlay: true, overlayOptions: { width: '70%', anchor: 'center' } });
}

/** Yes/No as an overlay, so it stacks above the inspector and keeps focus. Defaults to No. */
export function confirmOverlay(ui: ExtensionContext['ui'], title: string, message: string): Promise<boolean> {
  let yes = false;
  return ui.custom<boolean>((tui, theme, _keys, done) => ({
    invalidate() {},
    render: (width) => boxed(theme, width, [theme.fg('warning', clean(title)), clean(message),
      `${yes ? '›' : ' '} Yes   ${yes ? ' ' : '›'} No`, theme.fg('muted', 'Y yes · N/Esc no · ←→ choose · Enter confirm')]),
    handleInput(data) {
      if (data.toLowerCase() === 'y') return done(true);
      if (data.toLowerCase() === 'n' || matchesKey(data, 'escape')) return done(false);
      if (matchesKey(data, 'enter')) return done(yes);
      if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab')) { yes = !yes; tui.requestRender(); }
    },
  }), { overlay: true, overlayOptions: { width: '60%', anchor: 'center' } });
}
