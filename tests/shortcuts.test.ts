// Shared shortcut model: accelerator capture/parsing, reserved combos and settings normalization.
import { describe, expect, it } from 'vitest';
import {
  accelFromEvent,
  canonicalAccelerator,
  formatAccelerator,
  isReservedAccel,
  normalizeCustomShortcuts,
  SHORTCUT_COMMANDS,
  shortcutCommandInfo
} from '../src/shared/shortcuts';
import type { ShortcutCommand } from '../src/shared/shortcuts';

const ev = (patch: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string }>) => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  code: 'KeyA',
  ...patch
});

describe('accelFromEvent', () => {
  it('canonicalizes ctrl+alt+letter', () => {
    expect(accelFromEvent(ev({ ctrlKey: true, altKey: true, code: 'KeyA' }))).toBe('Ctrl+Alt+A');
  });

  it('treats Cmd like Ctrl, mirroring the fixed shortcuts', () => {
    expect(accelFromEvent(ev({ metaKey: true, code: 'KeyF' }))).toBe('Ctrl+F');
    expect(accelFromEvent(ev({ metaKey: true, altKey: true, code: 'KeyF' }))).toBe('Ctrl+Alt+F');
  });

  it('requires ctrl or alt so plain typing never fires a shortcut', () => {
    expect(accelFromEvent(ev({}))).toBeNull();
    expect(accelFromEvent(ev({ shiftKey: true, code: 'KeyA' }))).toBeNull();
  });

  it('ignores bare modifiers and keys reserved for focus and dialogs', () => {
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'ControlLeft' }))).toBeNull();
    expect(accelFromEvent(ev({ altKey: true, code: 'AltRight' }))).toBeNull();
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'Escape' }))).toBeNull();
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'Tab' }))).toBeNull();
  });

  it('maps punctuation and digit codes to display keys', () => {
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'Backquote' }))).toBe('Ctrl+`');
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'Comma' }))).toBe('Ctrl+,');
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'BracketLeft' }))).toBe('Ctrl+[');
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'Digit3' }))).toBe('Ctrl+3');
  });

  it('passes through function and arrow keys', () => {
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'F5' }))).toBe('Ctrl+F5');
    expect(accelFromEvent(ev({ ctrlKey: true, code: 'ArrowUp' }))).toBe('Ctrl+ArrowUp');
  });
});

describe('canonicalAccelerator', () => {
  it('orders modifiers canonically and uppercases single keys', () => {
    expect(canonicalAccelerator('alt+ctrl+shift+a')).toBe('Ctrl+Alt+Shift+A');
    expect(canonicalAccelerator('Ctrl+Alt+A')).toBe('Ctrl+Alt+A');
  });

  it('rejects non-bindable text', () => {
    expect(canonicalAccelerator('Shift+A')).toBeNull();
    expect(canonicalAccelerator('Ctrl')).toBeNull();
    expect(canonicalAccelerator('Ctrl+Ctrl+A')).toBeNull();
    expect(canonicalAccelerator('')).toBeNull();
  });
});

describe('formatAccelerator', () => {
  it('keeps modifier names off macOS', () => {
    expect(formatAccelerator('Ctrl+Alt+A', false)).toBe('Ctrl+Alt+A');
    expect(formatAccelerator('Ctrl+Shift+`', false)).toBe('Ctrl+Shift+`');
  });

  it('renders macOS glyphs', () => {
    expect(formatAccelerator('Ctrl+Alt+A', true)).toBe('⌘⌥A');
    expect(formatAccelerator('Ctrl+Shift+`', true)).toBe('⌘⇧`');
  });

  it('passes text it cannot parse through untouched', () => {
    expect(formatAccelerator('Escape', true)).toBe('Escape');
  });
});

describe('isReservedAccel', () => {
  it('flags the fixed shortcuts and editing basics, case-insensitively', () => {
    expect(isReservedAccel('Ctrl+N')).toBe(true);
    expect(isReservedAccel('ctrl+n')).toBe(true);
    expect(isReservedAccel('Ctrl+1')).toBe(true);
    expect(isReservedAccel('Ctrl+C')).toBe(true);
    expect(isReservedAccel('Alt+ArrowLeft')).toBe(true);
  });

  it('leaves free combinations alone', () => {
    expect(isReservedAccel('Ctrl+Alt+A')).toBe(false);
    expect(isReservedAccel('Ctrl+Alt+F')).toBe(false);
    expect(isReservedAccel('Alt+K')).toBe(false);
    expect(isReservedAccel('nonsense')).toBe(false);
  });
});

describe('normalizeCustomShortcuts', () => {
  it('keeps valid entries and canonicalizes their accelerators', () => {
    expect(normalizeCustomShortcuts({ 'ctrl+alt+a': 'session.archive', 'Ctrl+Alt+F': 'session.fork' })).toEqual({
      'Ctrl+Alt+A': 'session.archive',
      'Ctrl+Alt+F': 'session.fork'
    });
  });

  it('drops invalid accelerators and unknown commands', () => {
    expect(
      normalizeCustomShortcuts({
        'Shift+A': 'session.archive',
        'Ctrl+Alt+Q': 'bogus.command',
        'Ctrl+Alt+A': 42
      })
    ).toEqual({});
  });

  it('keeps one binding per command (first wins)', () => {
    expect(normalizeCustomShortcuts({ 'Ctrl+Alt+A': 'session.archive', 'Ctrl+Alt+B': 'session.archive' })).toEqual({
      'Ctrl+Alt+A': 'session.archive'
    });
  });

  it('returns nothing for malformed input', () => {
    expect(normalizeCustomShortcuts(undefined)).toEqual({});
    expect(normalizeCustomShortcuts('nope')).toEqual({});
    expect(normalizeCustomShortcuts([['Ctrl+Alt+A', 'session.archive']])).toEqual({});
  });
});

describe('command catalog', () => {
  it('labels and describes every command, and session commands declare needsSession', () => {
    expect(SHORTCUT_COMMANDS.length).toBeGreaterThan(15);
    for (const c of SHORTCUT_COMMANDS) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.icon.length).toBeGreaterThan(0);
      expect(c.needsSession ?? false).toBe(c.id.startsWith('session.'));
    }
    expect(shortcutCommandInfo('session.archive' as ShortcutCommand)?.label).toBe('Archive session');
    expect(shortcutCommandInfo('nope' as ShortcutCommand)).toBeUndefined();
  });
});
