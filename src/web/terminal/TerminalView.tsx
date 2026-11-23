/// <reference path="./xterm-headless.d.ts" />
/** A live desktop terminal in the browser (docs/REMOTE-ACCESS.md P3.5, read/write). Output is parsed
 *  by a headless xterm at the desktop's geometry — the desktop owns the size, a viewer never resizes
 *  it — and drawn as styled rows. Typing goes through a hardware keyboard on the view, or the line
 *  field and key strip on a phone. */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { Terminal } from '@xterm/headless';
import { invoke, on } from '@renderer/api';
import { Spinner } from '@renderer/components/ui';
import { ansiFromTokens, parseHex } from '@shared/ansi';
import { keyToSequence, pasteSequence } from './keys';
import { RemoteTerminalStream, type TerminalLink } from './remote-terminal';
import { screenRows, type ScreenRow } from './screen';

const link: TerminalLink = { invoke, on };
/** History drawn above the screen; the desktop keeps the full scrollback. */
const DRAWN_SCROLLBACK = 300;
const RENDER_MS = 50;

/** The phone key strip: what an on-screen keyboard cannot type. */
const KEYS: { label: string; title: string; data: string }[] = [
  { label: 'Esc', title: 'Escape', data: '\x1b' },
  { label: 'Tab', title: 'Tab', data: '\t' },
  { label: '^C', title: 'Ctrl+C (interrupt)', data: '\x03' },
  { label: '^D', title: 'Ctrl+D (end of input)', data: '\x04' },
  { label: '↑', title: 'Up', data: '\x1b[A' },
  { label: '↓', title: 'Down', data: '\x1b[B' },
  { label: '←', title: 'Left', data: '\x1b[D' },
  { label: '→', title: 'Right', data: '\x1b[C' }
];

function readTheme(): { fg: string; bg: string; dark: boolean; palette: ReturnType<typeof ansiFromTokens> } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => {
    const value = css.getPropertyValue(name).trim();
    return parseHex(value) ? value : fallback;
  };
  const bg = v('--bg-sunken', '#efeff1');
  const rgb = parseHex(bg) ?? [239, 239, 241];
  const dark = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5;
  const fg = v('--fg', dark ? '#e6e7ea' : '#1c1c1f');
  const palette = ansiFromTokens(dark, {
    fg,
    bgElev: v('--bg-elev', dark ? '#191c23' : '#ffffff'),
    fgMuted: v('--fg-muted', dark ? '#9aa0aa' : '#6b6f76'),
    fgFaint: v('--fg-faint', dark ? '#6b7280' : '#9a9ea6'),
    red: v('--red', dark ? '#ff6b6e' : '#d13438'),
    green: v('--green', dark ? '#3ecf7a' : '#1f9d55'),
    amber: v('--amber', dark ? '#f0b44c' : '#c27a10'),
    blue: v('--blue', dark ? '#6ea0ff' : '#2f6fed'),
    purple: v('--purple', dark ? '#c084fc' : '#8a4fd3'),
    cyan: v('--cyan', dark ? '#4dd0e1' : '#0f8a99')
  });
  return { fg, bg, dark, palette };
}

export function TerminalView({ terminalId, online, canType, running = true, onClosed }: { terminalId: string; online: boolean; canType: boolean; running?: boolean; onClosed: () => void }) {
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const [cols, setCols] = useState(80);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(false);
  const [fit, setFit] = useState(false);
  const [line, setLine] = useState('');
  const [width, setWidth] = useState(0);
  const theme = useMemo(readTheme, []);
  const termRef = useRef<Terminal | null>(null);
  const streamRef = useRef<RemoteTerminalStream | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  // One headless terminal and one stream per terminal id.
  useEffect(() => {
    let alive = true;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    const render = () => {
      renderTimer = null;
      const term = termRef.current;
      if (alive && term) setRows(screenRows(term, theme.palette, theme, { scrollback: DRAWN_SCROLLBACK }));
    };
    const renderSoon = () => {
      if (!renderTimer) renderTimer = setTimeout(render, RENDER_MS);
    };
    void (async () => {
      // By path: the package's `module` field points at a file it does not ship (see xterm-headless.d.ts).
      const { Terminal: Headless } = await import('@xterm/headless/lib-headless/xterm-headless.mjs');
      if (!alive) return;
      const term = new Headless({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
      termRef.current = term;
      const stream = new RemoteTerminalStream(link, terminalId, {
        // reset() and resize() act at once while writes are queued: run them behind what is already
        // queued, or older output would land on the fresh screen.
        reset: (snap) => {
          term.write('', () => {
            term.reset();
            term.resize(Math.max(2, snap.cols), Math.max(1, snap.rows));
            term.write(snap.snapshot, renderSoon);
          });
          setCols(snap.cols);
          setReady(true);
          setError('');
        },
        write: (data) => term.write(data, renderSoon),
        resize: (c, r) => {
          term.write('', () => {
            term.resize(Math.max(2, c), Math.max(1, r));
            renderSoon();
          });
          setCols(c);
        },
        closed: () => {
          setClosed(true);
          onClosedRef.current();
        },
        // A desktop older than the live terminal refuses the watch channel outright.
        error: (message) => setError(message === 'channel not available remotely' ? 'This computer runs an older Vocs Code: update it to use the live terminal.' : message)
      });
      streamRef.current = stream;
      void stream.start();
    })();
    return () => {
      alive = false;
      if (renderTimer) clearTimeout(renderTimer);
      streamRef.current?.stop();
      streamRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [terminalId, theme]);

  // A reconnect drops the desktop's stream: watch again, from a fresh snapshot.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current && !closed) void streamRef.current?.start();
    wasOnline.current = online;
  }, [online, closed]);

  useEffect(() => {
    const el = viewRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const send = (data: string) => streamRef.current?.send(data);
  // Keystrokes reach only a running shell (the desktop refuses the rest).
  const typing = canType && online && !closed && running;
  // Monospace glyphs are about 0.6em wide: fit the desktop's columns to the view when asked.
  const fontSize = fit && width ? Math.max(6, Math.min(14, (width - 20) / (cols * 0.6))) : 12;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!typing) return;
    // Leave Ctrl+C to the browser while text is selected: that is a copy, not an interrupt.
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && window.getSelection()?.toString()) return;
    const data = keyToSequence(e, termRef.current?.modes.applicationCursorKeysMode ?? false);
    if (data === null) return;
    e.preventDefault();
    send(data);
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!typing) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    send(pasteSequence(text, termRef.current?.modes.bracketedPasteMode ?? false));
  };

  const submitLine = (e: FormEvent) => {
    e.preventDefault();
    send(`${line}\r`);
    setLine('');
  };

  return (
    <div className="w-term-wrap">
      <div
        ref={viewRef}
        className="w-term"
        data-testid="remote-terminal"
        data-ready={ready ? 'true' : 'false'}
        tabIndex={0}
        role="log"
        aria-label="Terminal output"
        aria-live="off"
        style={{ fontSize: `${fontSize}px`, color: theme.fg, backgroundColor: theme.bg }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!ready && !error && <div className="w-loading"><Spinner /> Connecting to the terminal…</div>}
        {rows.map((row) => (
          <div className="w-term-row" key={row.line}>
            {row.runs.map((run, i) => (
              <span
                key={i}
                className={[run.bold && 'w-term-b', run.dim && 'w-term-d', run.italic && 'w-term-i', run.underline && 'w-term-u', run.strike && 'w-term-s', run.cursor && typing && 'w-term-cursor'].filter(Boolean).join(' ') || undefined}
                style={run.fg || run.bg ? { color: run.fg, backgroundColor: run.bg } : undefined}
              >{run.text}</span>
            ))}
            {row.runs.length === 0 && ' '}
          </div>
        ))}
      </div>
      {error && <p className="w-error" role="alert">{error}</p>}
      {closed && <p className="w-hint">This terminal was closed on the computer.</p>}
      {!online && !closed && <p className="w-hint">Reconnecting to the computer…</p>}
      <div className="w-term-tools">
        <button type="button" className="w-chip" aria-pressed={fit} onClick={() => setFit((f) => !f)}>Fit width</button>
        {typing && KEYS.map((k) => (
          <button key={k.label} type="button" className="w-chip w-term-key" title={k.title} aria-label={k.title} onClick={() => send(k.data)}>{k.label}</button>
        ))}
      </div>
      {typing ? (
        <form className="w-term-line" onSubmit={submitLine}>
          <input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="Type a command, Enter to run"
            aria-label="Terminal input"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          <button type="submit" className="w-chip">Run</button>
        </form>
      ) : (
        closed ? null : canType ? (online && !running ? <p className="w-hint">This terminal's shell is not running, so it cannot take input.</p> : null)
          : <p className="w-hint" data-testid="terminal-view-only">View only: typing into terminals is turned off on the computer.</p>
      )}
    </div>
  );
}
