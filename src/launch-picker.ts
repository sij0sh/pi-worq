import type { Kind } from './runtime/workflows.ts';
import { execFile } from 'node:child_process';
import { getSelectListTheme, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getNativeClipboard, Editor, type Component, type TuiMouseEvent, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
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

/** `initials`: per-kind defaults (RUNTIMES.md hints applied); `initial` otherwise. */
export interface LaunchRequest { kinds: Kind[]; initial: Runtime; choices: ModelChoice[]; initials?: ReadonlyMap<string, Runtime> }
type LaunchResult = { kind: Kind; instructions: string; runtime: Runtime };
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function launchPanel(ui: ExtensionContext['ui'], { kinds, initial: fallback, choices, initials }: LaunchRequest): Promise<LaunchResult | undefined> {
  return new Promise(resolve => ui.setWidget('worq-launch', (tui, theme) => {
    // Pi 1.6 main and fullscreen TUIs both extend TuiBase.
    const screen = tui as typeof tui & { getFocusedComponent(): Component | null };
    const previous = screen.getFocusedComponent();
    const editor = new Editor(tui, { borderColor: s => theme.fg('border', s), selectList: getSelectListTheme() });
    let step = 0, agent = 0, field = 0, initial = fallback, selected = { ...initial }, closed = false;
    const finish = (result?: LaunchResult) => { resolve(result); ui.setWidget('worq-launch', undefined); };
    const paste = async () => {
      const text = await readClipboardText();
      if (!closed && step === 1 && text) { editor.insertTextAtCursor(text.replace(/\r\n?/g, '\n')); tui.requestRender(); }
    };
    const panel: Component & { focused: boolean; dispose(): void } = {
      get focused() { return editor.focused; }, set focused(value) { editor.focused = value; },
      dispose() { closed = true; if (screen.getFocusedComponent() === panel) tui.setFocus(previous); resolve(undefined); },
      invalidate() { editor.invalidate(); },
      render(width) {
        const w = Math.max(1, width - 4);
        const align = (a: string, b: string) => truncateToWidth(a, Math.max(0,w-visibleWidth(b)-1)) + ' '.repeat(Math.max(1,w-visibleWidth(a)-visibleWidth(b))) + b;
        const rule = theme.fg('border', '─'.repeat(w));
        const header = align(`◆ WORQ / ${['Launch SDK Agent','Optional instructions','Configure runtime'][step]}`, `${step+1}/3`);
        const row = (text: string, active: boolean) => active ? theme.bg('selectedBg', theme.fg('accent', text + ' '.repeat(Math.max(0,w-visibleWidth(text))))) : text;
        const height = Math.max(1,tui.terminal.rows - 14), start = Math.max(0,agent-height+1);
        let body: string[];
        if (step === 0) {
          body = kinds.slice(start, start + height).map((kind, i) => {
            const active = agent === start + i;
            const access = kind.access === 'write' ? 'Write' : 'Read-only';
            return row(`${active ? '›' : ' '} ${titleCase(kind.name).padEnd(12)} ${access}${kind.userOnly ? ' · user-only' : ''}`, active);
          });
        } else if (step === 1) {
          const lines = editor.render(w).slice(1, -1); // The panel already draws separators.
          while (lines.length < 3) lines.push(' '.repeat(w));
          body = lines.map(line => theme.bg('customMessageBg', line));
        } else {
          const model = selected.sdk === fallback.sdk && selected.model === fallback.model && fallback.model ? "Main's model" : selected.model ?? 'SDK default';
          const hinted = initial.via.includes('RUNTIMES.md') && selected.sdk === initial.sdk && selected.model === initial.model && selected.thinking === initial.thinking ? ' · RUNTIMES.md' : '';
          const values = [selected.sdk === 'pi' ? 'Pi' : selected.sdk, `${model}${hinted && (initial.model !== fallback.model || initial.sdk !== fallback.sdk) ? hinted : ''}`, `${titleCase(selected.thinking ?? 'SDK default')}${hinted}`];
          body = values.map((value, i) => row(align(`${i === field ? '›' : ' '} ${['Harness', 'Model', 'Thinking'][i]}`, `‹ ${clean(value)} ›`), i === field));
        }
        const hint = ['↑↓ Select · Enter Continue','Shift+Enter New line · Enter Continue','↑↓ Select · ←→ Change · Enter Launch'][step];
        return [truncateToWidth(`STEP ${step+1} — ${['AGENT','PROMPT','RUNTIME'][step]}`,width), ...boxed(theme,width,[theme.fg('accent',header),rule,...body,rule,theme.fg('muted',`${hint} · Esc Cancel`)])];
      },
      handleMouse(e: TuiMouseEvent) {
        if (step === 1 && e.button === 'right') { if (e.type === 'press') void paste(); return { handled: true }; }
      },
      handleInput(data) {
        if (matchesKey(data,'escape')) return finish();
        if (matchesKey(data,'enter') && !(step === 1 && data === '\n')) {
          if (step === 2) return finish({ kind: kinds[agent], instructions: editor.getExpandedText(), runtime: selected });
          if (step === 0) { initial = initials?.get(kinds[agent].name) ?? fallback; selected = { ...initial }; }
          step++;
        } else if (step === 1) {
          if (matchesKey(data,'ctrl+v')) void paste();
          else if (matchesKey(data,'ctrl+j') || matchesKey(data,'shift+enter')) editor.insertTextAtCursor('\n');
          else editor.handleInput(data);
        } else if (matchesKey(data,'up') || matchesKey(data,'down') || matchesKey(data,'tab')) {
          const d = matchesKey(data,'up') ? -1 : 1;
          if (step === 0) agent = (agent + d + kinds.length) % kinds.length; else field = (field+d+3)%3;
        } else if (step === 2 && (matchesKey(data,'left') || matchesKey(data,'right'))) {
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
        }
        tui.requestRender();
      },
    };
    tui.setFocus(panel);
    return panel;
  }, { placement: 'aboveEditor' }));
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

function run(command: string, args: string[]) {
  return new Promise<string | undefined>(resolve => {
    execFile(command, args, { timeout: 5000, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}
/** System clipboard text: platform tools first, then Pi's native helper. Undefined when unavailable or empty. */
async function readClipboardText(): Promise<string | undefined> {
  const commands: [string, string[]][] = [];
  if (process.platform === 'darwin') commands.push(['pbpaste', []]);
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY) commands.push(['wl-paste', ['--no-newline', '--type', 'text']]);
    if (process.env.DISPLAY) commands.push(['xclip', ['-selection', 'clipboard', '-out']], ['xsel', ['--clipboard', '--output']]);
  }
  for (const [command, args] of commands) {
    const text = await run(command, args);
    if (text !== undefined) return text || undefined;
  }
  try { return (await getNativeClipboard()?.getText()) || undefined; } catch { return undefined; }
}
