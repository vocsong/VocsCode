/** Keyboard → terminal input for the web terminal view (docs/REMOTE-ACCESS.md P3.5). Covers what a
 *  shell and common full-screen programs need: printable text, control chords, editing keys,
 *  arrows (with application cursor mode) and F1–F12. Pure: no DOM. */

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const ARROWS: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };

const EDITING: Record<string, string> = {
  Home: '\x1b[H',
  End: '\x1b[F',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~'
};

/** Control chords on punctuation, beyond Ctrl+letter. */
const CTRL_PUNCT: Record<string, string> = { '@': '\x00', ' ': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '?': '\x7f' };

/**
 * The bytes a key press sends, or null to leave the event to the browser (Cmd chords, bare
 * modifiers, keys a terminal has no sequence for). `appCursor` is the program's DECCKM mode.
 */
export function keyToSequence(e: KeyLike, appCursor = false): string | null {
  if (e.metaKey) return null;
  const arrow = ARROWS[e.key];
  if (arrow) {
    const mod = (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
    if (mod) return `\x1b[1;${mod + 1}${arrow}`;
    return `${appCursor ? '\x1bO' : '\x1b['}${arrow}`;
  }
  if (EDITING[e.key]) return EDITING[e.key];
  switch (e.key) {
    case 'Enter':
      return e.altKey ? '\x1b\r' : '\r';
    case 'Backspace':
      return e.ctrlKey ? '\x08' : e.altKey ? '\x1b\x7f' : '\x7f';
    case 'Tab':
      return e.shiftKey ? '\x1b[Z' : '\t';
    case 'Escape':
      return '\x1b';
  }
  if (e.key.length !== 1) return null; // Shift, Unidentified, dead keys…
  if (e.ctrlKey && !e.altKey) {
    const lower = e.key.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
    if (CTRL_PUNCT[e.key] !== undefined) return CTRL_PUNCT[e.key];
    return null;
  }
  // Ctrl+Alt is AltGr on many layouts: the key already carries the composed character.
  if (e.altKey && !e.ctrlKey) return `\x1b${e.key}`;
  return e.key;
}

/** Pasted text as the shell expects it: CR line ends, wrapped in bracketed-paste markers when the
 *  program asked for them, and with any marker inside the paste removed so it cannot break out. */
export function pasteSequence(text: string, bracketed: boolean): string {
  const body = text.replace(/\r?\n/g, '\r');
  if (!bracketed) return body;
  return `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~`;
}
