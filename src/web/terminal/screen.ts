/** Turns a headless xterm buffer into rows of styled runs for the web terminal view
 *  (docs/REMOTE-ACCESS.md P3.5). The app's CSP admits no injected stylesheets, which rules out
 *  xterm's DOM renderer; colors travel as inline style properties instead, which React sets through
 *  the CSSOM and the policy allows. Pure: no DOM, no React. */
import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless';
import type { AnsiPalette } from '@shared/ansi';

export interface ScreenRun {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** The cursor sits on this run's single cell. */
  cursor?: boolean;
}

export interface ScreenRow {
  /** Absolute buffer line, stable while scrollback does not trim. */
  line: number;
  runs: ScreenRun[];
}

/** The 16 ANSI slots in index order. */
export function paletteSlots(p: AnsiPalette): string[] {
  return [p.black, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.white,
    p.brightBlack, p.brightRed, p.brightGreen, p.brightYellow, p.brightBlue, p.brightMagenta, p.brightCyan, p.brightWhite];
}

const hex = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

/** xterm's 256-color table above the 16 ANSI slots: a 6×6×6 cube, then a 24-step gray ramp. */
export function color256(index: number): string {
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return hex((v << 16) | (v << 8) | v);
  }
  const i = index - 16;
  const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
  return hex((level(Math.floor(i / 36)) << 16) | (level(Math.floor(i / 6) % 6) << 8) | level(i % 6));
}

function resolve(cell: IBufferCell, which: 'fg' | 'bg', slots: string[]): string | undefined {
  const isDefault = which === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  const value = which === 'fg' ? cell.getFgColor() : cell.getBgColor();
  const rgb = which === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  if (rgb) return hex(value);
  return value < 16 ? slots[value] : color256(value);
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

function styleOf(cell: IBufferCell, slots: string[], theme: { fg: string; bg: string }): Style {
  let fg = resolve(cell, 'fg', slots);
  let bg = resolve(cell, 'bg', slots);
  const bold = !!cell.isBold();
  // Bold text in one of the eight normal colors is drawn bright, as xterm does by default.
  if (bold && !cell.isFgRGB() && !cell.isFgDefault() && cell.getFgColor() < 8) fg = slots[cell.getFgColor() + 8];
  if (cell.isInverse()) {
    const swapped = fg ?? theme.fg;
    fg = bg ?? theme.bg;
    bg = swapped;
  }
  if (cell.isInvisible()) fg = bg ?? theme.bg;
  return {
    fg, bg,
    bold: bold || undefined,
    dim: !!cell.isDim() || undefined,
    italic: !!cell.isItalic() || undefined,
    underline: !!cell.isUnderline() || undefined,
    strike: !!cell.isStrikethrough() || undefined
  };
}

const sameStyle = (a: Style, b: Style): boolean =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike;

function rowRuns(line: IBufferLine, cols: number, cell: IBufferCell, slots: string[], theme: { fg: string; bg: string }, cursorX: number): ScreenRun[] {
  const runs: ScreenRun[] = [];
  let current: (ScreenRun & Style) | null = null;
  for (let x = 0; x < cols; x++) {
    if (!line.getCell(x, cell)) break;
    if (cell.getWidth() === 0) continue; // the second half of a wide character
    const text = cell.getChars() || ' ';
    const style = styleOf(cell, slots, theme);
    if (x === cursorX) {
      runs.push(...(current ? [current] : []), { text, ...style, cursor: true });
      current = null;
      continue;
    }
    if (current && sameStyle(current, style)) current.text += text;
    else {
      if (current) runs.push(current);
      current = { text, ...style };
    }
  }
  if (current) runs.push(current);
  // Trailing blanks with no background are padding, not output.
  while (runs.length) {
    const last = runs[runs.length - 1];
    if (last.cursor || last.bg) break;
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed) {
      last.text = trimmed;
      break;
    }
    runs.pop();
  }
  return runs;
}

/**
 * The rows to draw: up to `scrollback` lines of history plus the screen. Blank screen rows under
 * the cursor are dropped on the normal buffer (a phone has no room for them) but kept on the
 * alternate buffer, where full-screen programs place text by row.
 */
export function screenRows(term: Terminal, palette: AnsiPalette, theme: { fg: string; bg: string }, opts: { scrollback?: number; cursor?: boolean } = {}): ScreenRow[] {
  const buffer = term.buffer.active;
  const slots = paletteSlots(palette);
  const cell = buffer.getNullCell();
  const cursorLine = buffer.baseY + buffer.cursorY;
  const first = Math.max(0, buffer.baseY - (opts.scrollback ?? 500));
  const rows: ScreenRow[] = [];
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const cursorX = opts.cursor !== false && y === cursorLine ? buffer.cursorX : -1;
    rows.push({ line: y, runs: rowRuns(line, term.cols, cell, slots, theme, cursorX) });
  }
  if (buffer.type === 'normal') {
    while (rows.length && rows[rows.length - 1].line > cursorLine && rows[rows.length - 1].runs.length === 0) rows.pop();
  }
  return rows;
}
