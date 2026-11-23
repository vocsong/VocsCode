/** Settings → Terminal configuration. */
import React, { useEffect, useState } from 'react';
import type { ShellKind, ShellOption, TerminalSettings } from '../../../../shared/terminal';
import type { AppSettings } from '../../../../shared/types';
import { invoke, isMac, platform } from '../../api';
import { SettingsGroup } from '../SettingsPrimitives';
import { Field, Kbd, Toggle } from '../ui';

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];
const SCROLLBACKS = [1_000, 5_000, 10_000, 20_000, 50_000, 100_000];

export function TerminalSection({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const t = settings.terminal;
  const [shells, setShells] = useState<ShellOption[]>([]);
  useEffect(() => {
    void invoke('terminal:shells', undefined).then(setShells).catch(() => undefined);
  }, []);
  const patch = (p: Partial<TerminalSettings>) => update({ terminal: { ...t, ...p } });
  const known = t.shell === 'auto' || t.shell === 'custom' || shells.some((s) => s.kind === t.shell);
  const mod = isMac ? '⌘' : 'Ctrl';
  return (
    <div className="settings-section">
      <h2>Terminal</h2>
      <SettingsGroup id="terminal-shell" title="Shell & startup" icon="terminal" description="Interactive programs, shell profiles and colors work just as they do in your terminal app.">
        <Field label="Default shell" hint="New terminals start this shell in the session's working directory. Auto picks PowerShell on Windows and your login shell elsewhere.">
          <select value={t.shell} onChange={(e) => patch({ shell: e.target.value as ShellKind })}>
            <option value="auto">Auto</option>
            {shells.map((s) => (
              <option key={s.kind} value={s.kind}>
                {s.name} — {s.path}
              </option>
            ))}
            {!known && <option value={t.shell}>{t.shell} (not found on this machine)</option>}
            <option value="custom">Custom…</option>
          </select>
        </Field>
        {t.shell === 'custom' && (
          <div className="row gap12">
            <Field label="Shell executable">
              <input value={t.customShellPath} placeholder={platform === 'win32' ? 'C:\\tools\\nu.exe' : '/usr/local/bin/nu'} onChange={(e) => patch({ customShellPath: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="Arguments" hint="Space separated.">
              <input value={t.customShellArgs.join(' ')} onChange={(e) => patch({ customShellArgs: e.target.value.split(/\s+/).filter(Boolean) })} spellCheck={false} />
            </Field>
          </div>
        )}
        <Toggle checked={t.restoreOnStartup} onChange={(v) => patch({ restoreOnStartup: v })} label="Restore terminals on startup: tabs come back with their scrollback, and the shell starts again when you open one" />
      </SettingsGroup>
      <SettingsGroup id="terminal-display" title="Text & cursor" icon="edit" description="Make your terminal comfortable to read.">
        <div className="row gap12">
          <Field label="Font size">
            <select value={t.fontSize} onChange={(e) => patch({ fontSize: Number(e.target.value) })}>
              {(FONT_SIZES.includes(t.fontSize) ? FONT_SIZES : [...FONT_SIZES, t.fontSize].sort((a, b) => a - b)).map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scrollback">
            <select value={t.scrollback} onChange={(e) => patch({ scrollback: Number(e.target.value) })}>
              {(SCROLLBACKS.includes(t.scrollback) ? SCROLLBACKS : [...SCROLLBACKS, t.scrollback].sort((a, b) => a - b)).map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()} lines
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cursor">
            <select value={t.cursorStyle} onChange={(e) => patch({ cursorStyle: e.target.value as TerminalSettings['cursorStyle'] })}>
              <option value="block">Block</option>
              <option value="underline">Underline</option>
              <option value="bar">Bar</option>
            </select>
          </Field>
        </div>
        <Toggle checked={t.cursorBlink} onChange={(v) => patch({ cursorBlink: v })} label="Blinking cursor" />
      </SettingsGroup>
      <SettingsGroup title="Terminal shortcuts" icon="keyboard">
        <p className="muted small">
          <Kbd>{mod}+`</Kbd> focus the terminal (again to return to the composer) · <Kbd>{mod}+Shift+`</Kbd> new terminal · <Kbd>{mod}+F</Kbd> find · <Kbd>Ctrl+Shift+C</Kbd> / <Kbd>Ctrl+Shift+V</Kbd> copy / paste
          {!isMac && (
            <>
              {' '}
              · <Kbd>Ctrl+C</Kbd> copies while text is selected, otherwise interrupts · <Kbd>Ctrl+V</Kbd> pastes
            </>
          )}{' '}
          · right-click copies the selection or pastes · double-click a tab to rename it.
        </p>
      </SettingsGroup>
    </div>
  );
}
