/**
 * Owns the xterm.js instances behind the Terminal panel. They live outside React so a terminal keeps
 * its screen, scrollback, selection and scroll position while its tab is hidden or the panel is
 * closed; the component only mounts and unmounts an instance's element. One IPC subscription fans
 * PTY output out to the instances and acknowledges what was consumed, so the main process can pause
 * a flooding process instead of drowning the renderer.
 */
import { Terminal, type IDisposable, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { DEFAULT_TERMINAL_SETTINGS, type ShellKind, type TerminalInfo, type TerminalSettings } from '../../../shared/terminal';
import { isDarkTheme } from '../../../shared/themes';
import { ansiFromTokens, parseHex, withAlpha, type AnsiPalette } from '../../../shared/ansi';
import { invoke, isMac, on, platform } from '../api';
import { useStore } from '../store';
import { activeTheme, systemPrefersDark } from '../theme';

interface Instance {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  element: HTMLDivElement;
  /** attaching: waiting for the main-process snapshot; live: streaming; closed: disposed. */
  state: 'attaching' | 'live' | 'closed';
  /** Chunks that arrived while the snapshot was in flight; only those newer than it are written. */
  pending: { seq: number; data: string }[];
  ackPending: number;
  ackTimer: number | null;
  observer: ResizeObserver | null;
  disposables: IDisposable[];
}

const instances = new Map<string, Instance>();
let initialized = false;
let idleTimer: number | null = null;
let findHandler: ((id: string) => void) | null = null;

function init(): void {
  if (initialized) return;
  initialized = true;
  on('push:terminalData', ({ terminalId, seq, data }) => {
    const inst = instances.get(terminalId);
    if (!inst || inst.state === 'closed') return;
    if (inst.state === 'attaching') {
      inst.pending.push({ seq, data });
      return;
    }
    write(inst, data);
    bumpChangesSoon();
  });
  // Terminals closed elsewhere (another tab's ×, a deleted session, a clean `exit`) release their instance.
  useStore.subscribe((s, prev) => {
    if (s.terminals !== prev.terminals) reconcile(s.terminals);
    if (s.settings?.terminal !== prev.settings?.terminal) applySettings();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function settings(): TerminalSettings {
  return useStore.getState().settings?.terminal ?? DEFAULT_TERMINAL_SETTINGS;
}

/** Shows terminal `id` inside `host`, creating the instance (and attaching to its PTY) the first time. */
export function mount(id: string, host: HTMLElement): void {
  init();
  let inst = instances.get(id);
  const fresh = !inst;
  if (!inst) inst = create(id, host);
  else {
    host.appendChild(inst.element);
    inst.term.refresh(0, inst.term.rows - 1);
  }
  fitNow(inst);
  inst.observer?.disconnect();
  inst.observer = new ResizeObserver(() => scheduleFit(inst!));
  inst.observer.observe(host);
  if (fresh) void attach(inst);
}

/** Hides the terminal; the instance and its PTY connection stay alive. */
export function unmount(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  inst.observer?.disconnect();
  inst.observer = null;
  inst.element.remove();
}

export function dispose(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  inst.state = 'closed';
  inst.observer?.disconnect();
  if (inst.ackTimer !== null) window.clearTimeout(inst.ackTimer);
  for (const d of inst.disposables) d.dispose();
  inst.term.dispose();
  inst.element.remove();
  instances.delete(id);
}

export function focus(id: string): void {
  instances.get(id)?.term.focus();
}

export function clear(id: string): void {
  instances.get(id)?.term.clear();
}

export function selectAll(id: string): void {
  instances.get(id)?.term.selectAll();
}

export function setFindHandler(fn: ((id: string) => void) | null): void {
  findHandler = fn;
}

export function find(id: string, query: string, dir: 'next' | 'prev', opts: { caseSensitive: boolean; regex: boolean; incremental?: boolean }): boolean {
  const inst = instances.get(id);
  if (!inst) return false;
  if (!query) {
    inst.search.clearDecorations();
    return false;
  }
  const accent = cssVar('--accent') || '#5b5bd6';
  const amber = cssVar('--amber') || '#c27a10';
  const o = {
    caseSensitive: opts.caseSensitive,
    regex: opts.regex,
    incremental: opts.incremental,
    decorations: { matchBackground: withAlpha(accent, 0.35), activeMatchBackground: withAlpha(amber, 0.6), matchOverviewRuler: accent, activeMatchColorOverviewRuler: amber }
  };
  try {
    return dir === 'next' ? inst.search.findNext(query, o) : inst.search.findPrevious(query, o);
  } catch {
    return false; // an unfinished regular expression while typing
  }
}

export function clearFind(id: string): void {
  instances.get(id)?.search.clearDecorations();
}

/** The selection if there is one, else the last `maxLines` non-empty rows of screen and scrollback. */
export function recentOutput(id: string, maxLines = 80): string {
  const inst = instances.get(id);
  if (!inst) return '';
  const sel = inst.term.getSelection();
  if (sel.trim()) return sel.replace(/\s+$/, '');
  const buf = inst.term.buffer.active;
  const rows: { text: string; wrapped: boolean }[] = [];
  for (let y = buf.length - 1; y >= 0 && rows.length < maxLines; y--) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (!rows.length && !text.trim()) continue; // blank rows below the prompt
    rows.push({ text, wrapped: line.isWrapped });
  }
  rows.reverse();
  const out: string[] = [];
  for (const r of rows) {
    if (r.wrapped && out.length) out[out.length - 1] += r.text;
    else out.push(r.text);
  }
  return out.join('\n').trim();
}

/** Opens a terminal for the session, selects it and shows the Terminal tab; errors surface as a toast. */
export async function createTerminal(sessionId: string, shell?: ShellKind): Promise<TerminalInfo | null> {
  const st = useStore.getState();
  try {
    const info = await invoke('terminal:create', { sessionId, shell });
    st.setActiveTerminal(sessionId, info.id);
    st.setPanelTab('terminal');
    st.focusTerminal();
    return info;
  } catch (e) {
    st.toast(`Could not open a terminal: ${String((e as Error).message ?? e)}`, 'error');
    return null;
  }
}

function create(id: string, host: HTMLElement): Instance {
  const ts = settings();
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: ts.cursorBlink,
    cursorStyle: ts.cursorStyle,
    fontSize: ts.fontSize,
    fontFamily: cssVar('--mono') || 'Consolas, Menlo, monospace',
    scrollback: ts.scrollback,
    theme: theme(),
    macOptionIsMeta: true,
    windowsPty: platform === 'win32' ? { backend: 'conpty' } : undefined
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((_e, uri) => void invoke('app:openExternal', { url: uri })));
  const element = document.createElement('div');
  element.className = 'term-xterm';
  host.appendChild(element);
  term.open(element);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose()); // xterm falls back to its DOM renderer
    term.loadAddon(webgl);
  } catch {
    /* no WebGL here: the DOM renderer stays */
  }
  const inst: Instance = { id, term, fit, search, element, state: 'attaching', pending: [], ackPending: 0, ackTimer: null, observer: null, disposables: [] };
  inst.disposables.push(
    // Fire-and-forget: a tab can close between the keystroke and the IPC round-trip, so rejections
    // (main's must(id) throwing) are swallowed instead of becoming unhandled rejections.
    term.onData((data) => invoke('terminal:input', { terminalId: id, data }).catch(() => undefined)),
    term.onResize(({ cols, rows }) => {
      if (inst.state === 'live') invoke('terminal:resize', { terminalId: id, cols, rows }).catch(() => undefined);
    })
  );
  term.attachCustomKeyEventHandler((e) => keyHandler(inst, e));
  // Windows Terminal convention: right-click copies the selection, or pastes when there is none.
  element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      copy(inst);
      term.clearSelection();
    } else paste();
  });
  instances.set(id, inst);
  return inst;
}

async function attach(inst: Instance): Promise<void> {
  const dims = inst.fit.proposeDimensions();
  const cols = dims && dims.cols > 1 ? dims.cols : inst.term.cols;
  const rows = dims && dims.rows > 0 ? dims.rows : inst.term.rows;
  try {
    const { snapshot, seq } = await invoke('terminal:attach', { terminalId: inst.id, cols, rows });
    if (inst.state === 'closed') return;
    await new Promise<void>((r) => inst.term.write(snapshot, r));
    for (const p of inst.pending) if (p.seq > seq) write(inst, p.data);
    inst.pending = [];
    inst.state = 'live';
    inst.term.scrollToBottom();
  } catch (e) {
    if (inst.state === 'closed') return;
    inst.term.writeln(`\x1b[31m[could not attach to the terminal: ${String((e as Error).message ?? e)}]\x1b[0m`);
    inst.state = 'live';
  }
}

function write(inst: Instance, data: string): void {
  inst.term.write(data, () => {
    inst.ackPending += data.length;
    if (inst.ackTimer !== null) return;
    inst.ackTimer = window.setTimeout(() => {
      inst.ackTimer = null;
      const n = inst.ackPending;
      inst.ackPending = 0;
      if (n > 0 && inst.state === 'live') void invoke('terminal:ack', { terminalId: inst.id, chars: n });
    }, 16);
  });
}

function reconcile(list: TerminalInfo[]): void {
  const alive = new Set(list.map((t) => t.id));
  for (const id of [...instances.keys()]) if (!alive.has(id)) dispose(id);
}

/** Output stopped for a moment: the user probably ran something; let the Changes tab pick it up. */
function bumpChangesSoon(): void {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    useStore.setState((s) => ({ changesVersion: s.changesVersion + 1 }));
  }, 1500);
}

function fitNow(inst: Instance): void {
  try {
    inst.fit.fit();
  } catch {
    /* not measurable yet */
  }
}

function scheduleFit(inst: Instance): void {
  requestAnimationFrame(() => {
    if (inst.state !== 'closed' && inst.element.isConnected) fitNow(inst);
  });
}

function applySettings(): void {
  const ts = settings();
  for (const i of instances.values()) {
    i.term.options.fontSize = ts.fontSize;
    i.term.options.cursorBlink = ts.cursorBlink;
    i.term.options.cursorStyle = ts.cursorStyle;
    i.term.options.scrollback = ts.scrollback;
    scheduleFit(i);
  }
}

/** App chords the terminal must not swallow (they match App.tsx's keydown handler). */
const APP_CHORDS = new Set(['n', 'j', 'b', 'k', ',']);

function keyHandler(inst: Instance, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true;
  const key = e.key.toLowerCase();
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && !e.altKey && (APP_CHORDS.has(key) || /^[1-9]$/.test(e.key) || e.code === 'Backquote')) return false;
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return false;
  if (mod && key === 'f') {
    findHandler?.(inst.id);
    return false;
  }
  if (e.ctrlKey && e.shiftKey && key === 'c') {
    copy(inst);
    return false;
  }
  if (e.ctrlKey && e.shiftKey && key === 'v') {
    paste();
    return false;
  }
  if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey) {
    // Windows/Linux convention: Ctrl+C copies only while something is selected; Ctrl+V pastes.
    if (key === 'c' && inst.term.hasSelection()) {
      copy(inst);
      inst.term.clearSelection();
      return false;
    }
    if (key === 'v') {
      paste();
      return false;
    }
  }
  return true;
}

function copy(inst: Instance): void {
  const s = inst.term.getSelection();
  if (s) void navigator.clipboard.writeText(s);
}

/** A native paste into xterm's focused textarea, so bracketed paste and multi-line input behave. */
function paste(): void {
  void invoke('window:edit', { command: 'paste' });
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isDark(): boolean {
  return isDarkTheme(activeTheme(), systemPrefersDark());
}

/** Reads a theme token, falling back when the property is missing or not a plain hex color. */
function token(name: string, fallback: string): string {
  const v = cssVar(name);
  return parseHex(v) ? v : fallback;
}

/** The active theme's ANSI palette, so program output matches the UI in every theme. */
function ansi(dark: boolean): AnsiPalette {
  return ansiFromTokens(dark, {
    fg: token('--fg', dark ? '#e6e7ea' : '#1c1c1f'),
    bgElev: token('--bg-elev', dark ? '#191c23' : '#ffffff'),
    fgMuted: token('--fg-muted', dark ? '#9aa0aa' : '#6b6f76'),
    fgFaint: token('--fg-faint', dark ? '#6b7280' : '#9a9ea6'),
    red: token('--red', dark ? '#ff6b6e' : '#d13438'),
    green: token('--green', dark ? '#3ecf7a' : '#1f9d55'),
    amber: token('--amber', dark ? '#f0b44c' : '#c27a10'),
    blue: token('--blue', dark ? '#6ea0ff' : '#2f6fed'),
    purple: token('--purple', dark ? '#c084fc' : '#8a4fd3'),
    cyan: token('--cyan', dark ? '#4dd0e1' : '#0f8a99')
  });
}

export function theme(): ITheme {
  const dark = isDark();
  const accent = cssVar('--accent') || (dark ? '#8b8bff' : '#5b5bd6');
  const bg = cssVar('--bg-sunken') || (dark ? '#0d0f13' : '#efeff1');
  const fg = cssVar('--fg') || (dark ? '#e6e7ea' : '#1c1c1f');
  return {
    ...ansi(dark),
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: withAlpha(accent, dark ? 0.35 : 0.28),
    selectionInactiveBackground: withAlpha(accent, 0.18)
  };
}

function applyTheme(): void {
  const t = theme();
  for (const i of instances.values()) i.term.options.theme = t;
}
