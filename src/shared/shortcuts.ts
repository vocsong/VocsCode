/**
 * Keyboard shortcuts: the commands a custom shortcut can trigger, accelerator parsing and
 * formatting, and the built-in shortcut reference shown in Settings → Shortcuts. Shared so the
 * main process can normalize stored bindings with the same rules the renderer applies.
 * No Node/Electron imports.
 */

/** Functions a custom keyboard shortcut can trigger. */
export type ShortcutCommand =
  | 'session.archive'
  | 'session.fork'
  | 'session.interrupt'
  | 'session.pin'
  | 'session.newTerminal'
  | 'session.export'
  | 'session.compact'
  | 'app.newSession'
  | 'app.newSessionQuick'
  | 'app.palette'
  | 'app.toggleSidebar'
  | 'app.togglePanel'
  | 'app.toggleThinking'
  | 'app.focusTerminal'
  | 'app.showChanges'
  | 'app.showGoal'
  | 'app.settings'
  | 'app.analytics'
  | 'app.skills'
  | 'app.back'
  | 'app.forward';

export interface ShortcutCommandInfo {
  id: ShortcutCommand;
  label: string;
  description: string;
  /** Icon name from the renderer's icon set. */
  icon: string;
  /** True when the command acts on the active session and is a no-op without one. */
  needsSession?: boolean;
}

export const SHORTCUT_COMMANDS: ShortcutCommandInfo[] = [
  { id: 'session.archive', label: 'Archive session', description: 'Archive the session you are on (a worktree is confirmed first).', icon: 'archive', needsSession: true },
  { id: 'session.fork', label: 'Fork session', description: 'Fork the current session into a copy on the same worktree.', icon: 'fork', needsSession: true },
  { id: 'session.interrupt', label: 'Interrupt turn', description: 'Interrupt the current turn of the active session.', icon: 'stop', needsSession: true },
  { id: 'session.pin', label: 'Pin / unpin session', description: 'Toggle the active session’s pin in the sidebar.', icon: 'pin', needsSession: true },
  { id: 'session.newTerminal', label: 'New terminal', description: 'Open a new terminal tab for the active session.', icon: 'terminal', needsSession: true },
  { id: 'session.export', label: 'Export transcript', description: 'Export the active session’s transcript as Markdown.', icon: 'download', needsSession: true },
  { id: 'session.compact', label: 'Compact context', description: 'Ask the harness to compact the active session’s context.', icon: 'compact', needsSession: true },
  { id: 'app.newSession', label: 'New session', description: 'Pick a project folder and configure a new session.', icon: 'plus' },
  { id: 'app.newSessionQuick', label: 'New session in folder', description: 'Quick-pick a known folder and start with defaults.', icon: 'folder' },
  { id: 'app.palette', label: 'Command palette', description: 'Toggle the command palette.', icon: 'search' },
  { id: 'app.toggleSidebar', label: 'Toggle sidebar', description: 'Show or hide the left sidebar.', icon: 'sidebar' },
  { id: 'app.togglePanel', label: 'Toggle side panel', description: 'Show or hide the right panel.', icon: 'layout' },
  { id: 'app.toggleThinking', label: 'Toggle thinking', description: 'Show or hide the model’s thinking blocks.', icon: 'brain' },
  { id: 'app.focusTerminal', label: 'Focus terminal', description: 'Switch the side panel to the terminal and focus it.', icon: 'terminal' },
  { id: 'app.showChanges', label: 'Show changes', description: 'Switch the side panel to the changes view.', icon: 'diff' },
  { id: 'app.showGoal', label: 'Show goal', description: 'Switch the side panel to the goal view.', icon: 'target' },
  { id: 'app.settings', label: 'Open settings', description: 'Go to the settings screen.', icon: 'settings' },
  { id: 'app.analytics', label: 'Open analytics', description: 'Go to the analytics dashboard.', icon: 'chart' },
  { id: 'app.skills', label: 'Open skills', description: 'Go to the skills screen.', icon: 'puzzle' },
  { id: 'app.back', label: 'Back', description: 'Go back in view history.', icon: 'arrowLeft' },
  { id: 'app.forward', label: 'Forward', description: 'Go forward in view history.', icon: 'arrowRight' }
];

const COMMAND_IDS = new Set<string>(SHORTCUT_COMMANDS.map((c) => c.id));

export function isShortcutCommand(v: unknown): v is ShortcutCommand {
  return typeof v === 'string' && COMMAND_IDS.has(v);
}

const COMMAND_BY_ID = new Map(SHORTCUT_COMMANDS.map((c) => [c.id, c]));

export function shortcutCommandInfo(id: ShortcutCommand): ShortcutCommandInfo | undefined {
  return COMMAND_BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Accelerators: canonical text like 'Ctrl+Alt+A'. 'Ctrl' means the Ctrl key on
// Windows/Linux and either Ctrl or Cmd on macOS, matching how the app's own
// shortcuts treat the modifier. Only Ctrl and/or Alt (plus optional Shift) are
// accepted so plain typing can never fire a shortcut.
// ---------------------------------------------------------------------------

const ACCEL_MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const;

/** Key names that map straight from a KeyboardEvent.code. */
const CODE_KEYS: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space'
};

/** Codes that are reserved for focus, dialogs and composer flow — never captured. */
const EXCLUDED_CODES = new Set(['Escape', 'Tab', 'Enter', 'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu']);

/** True when the code is a bare modifier key. */
function isModifierCode(code: string): boolean {
  return /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code);
}

/** Canonical key token for a KeyboardEvent.code (F-keys, arrows and numpad codes pass through). */
function keyForCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_KEYS[code] ?? code;
}

export interface ParsedAccelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Canonical key token: 'A', '3', '`', 'F5', 'ArrowUp', … */
  key: string;
}

const MOD_NAMES: Record<string, 'ctrl' | 'alt' | 'shift'> = { ctrl: 'ctrl', alt: 'alt', shift: 'shift' };

/** Parses accelerator text; returns null when it is not a valid bindable combo. */
export function parseAccelerator(text: string): ParsedAccelerator | null {
  const parts = text.split('+').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 4) return null;
  const key = parts.pop()!;
  const accel: ParsedAccelerator = { ctrl: false, alt: false, shift: false, key: '' };
  for (const p of parts) {
    const mod = MOD_NAMES[p.toLowerCase()];
    if (!mod || accel[mod]) return null;
    accel[mod] = true;
  }
  if (!accel.ctrl && !accel.alt) return null;
  if (!key) return null;
  accel.key = key.length === 1 ? key.toUpperCase() : key;
  return accel;
}

/** Canonical text for a parsed accelerator, e.g. 'Ctrl+Alt+A'. */
export function accelToString(a: ParsedAccelerator): string {
  const parts: string[] = [];
  if (a.ctrl) parts.push('Ctrl');
  if (a.alt) parts.push('Alt');
  if (a.shift) parts.push('Shift');
  parts.push(a.key);
  return parts.join('+');
}

/** Valid accelerator text in canonical form, or null. */
export function canonicalAccelerator(text: string): string | null {
  const a = parseAccelerator(text);
  return a ? accelToString(a) : null;
}

const canonOrNull = canonicalAccelerator;

/**
 * The accelerator a keyboard event represents, or null when it is not bindable: bare modifiers,
 * reserved keys (Escape/Tab/Enter), or combos without Ctrl/Alt (so typing never fires shortcuts).
 * Mirrors the app's fixed shortcuts: Ctrl and Cmd count as the same modifier.
 */
export function accelFromEvent(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }): string | null {
  if (isModifierCode(e.code) || EXCLUDED_CODES.has(e.code)) return null;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl && !e.altKey) return null;
  return accelToString({ ctrl, alt: e.altKey, shift: e.shiftKey, key: keyForCode(e.code) });
}

/** Display text for an accelerator: ⌘/⌥/⇧ glyphs on macOS, plain modifier names elsewhere. */
export function formatAccelerator(text: string, mac: boolean): string {
  const a = parseAccelerator(text);
  if (!a) return text;
  if (!mac) return accelToString(a);
  const parts: string[] = [];
  if (a.ctrl) parts.push('⌘');
  if (a.alt) parts.push('⌥');
  if (a.shift) parts.push('⇧');
  parts.push(a.key);
  return parts.join('');
}

/**
 * Fixed shortcuts the app always handles itself; custom bindings may not take them. Includes the
 * text-editing basics so a custom combo can never swallow copy/paste/undo while typing.
 */
export const RESERVED_ACCELS: string[] = [
  'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+K', 'Ctrl+B', 'Ctrl+J', 'Ctrl+,', 'Ctrl+[', 'Ctrl+]',
  'Ctrl+ArrowUp', 'Ctrl+ArrowDown', 'Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown',
  'Alt+ArrowLeft', 'Alt+ArrowRight',
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => `Ctrl+${d}`),
  'Ctrl+F', 'Ctrl+`', 'Ctrl+Shift+`',
  'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y'
];

export function isReservedAccel(text: string): boolean {
  const canon = canonOrNull(text);
  return canon !== null && RESERVED_ACCELS.includes(canon);
}

/** Maximum stored custom bindings; defensive cap against a runaway settings file. */
const MAX_CUSTOM_SHORTCUTS = 32;

/** Keep only well-formed custom shortcuts (valid accelerators, known commands, one per command). */
export function normalizeCustomShortcuts(stored: unknown): Record<string, ShortcutCommand> {
  if (!stored || typeof stored !== 'object') return {};
  const out: Record<string, ShortcutCommand> = {};
  for (const [accel, cmd] of Object.entries(stored as Record<string, unknown>)) {
    const canon = canonOrNull(accel);
    if (!canon || canon.length === 0 || !isShortcutCommand(cmd)) continue;
    if (Object.values(out).includes(cmd)) continue;
    out[canon] = cmd;
    if (Object.keys(out).length >= MAX_CUSTOM_SHORTCUTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read-only reference of the app's fixed shortcuts, rendered in Settings → Shortcuts.
// Keys use the same canonical tokens as custom accelerators.
// ---------------------------------------------------------------------------

export interface BuiltinShortcutRow {
  label: string;
  keys: string[];
}

export interface BuiltinShortcutGroup {
  title: string;
  rows: BuiltinShortcutRow[];
}

export const BUILTIN_SHORTCUT_GROUPS: BuiltinShortcutGroup[] = [
  {
    title: 'General',
    rows: [
      { label: 'New session', keys: ['Ctrl+N'] },
      { label: 'New session in folder (quick picker)', keys: ['Ctrl+Shift+N'] },
      { label: 'Command palette', keys: ['Ctrl+K'] },
      { label: 'Settings', keys: ['Ctrl+,'] },
      { label: 'Toggle sidebar', keys: ['Ctrl+B'] },
      { label: 'Toggle side panel', keys: ['Ctrl+J'] },
      { label: 'Back', keys: ['Alt+ArrowLeft', 'Ctrl+['] },
      { label: 'Forward', keys: ['Alt+ArrowRight', 'Ctrl+]'] }
    ]
  },
  {
    title: 'Sessions',
    rows: [
      { label: 'Previous / next session', keys: ['Ctrl+ArrowUp', 'Ctrl+ArrowDown'] },
      { label: 'First session of the previous / next folder', keys: ['Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown'] },
      { label: 'Switch to session 1–9', keys: ['Ctrl+1-9'] },
      { label: 'Find in transcript', keys: ['Ctrl+F'] },
      { label: 'Interrupt current turn', keys: ['Escape'] }
    ]
  },
  {
    title: 'Terminal',
    rows: [
      { label: 'Focus the terminal (again to return to the composer)', keys: ['Ctrl+`'] },
      { label: 'New terminal', keys: ['Ctrl+Shift+`'] },
      { label: 'Copy / paste with a selection', keys: ['Ctrl+Shift+C', 'Ctrl+Shift+V'] },
      { label: 'Copy selected text, otherwise interrupt / paste', keys: ['Ctrl+C', 'Ctrl+V'] }
    ]
  }
];
