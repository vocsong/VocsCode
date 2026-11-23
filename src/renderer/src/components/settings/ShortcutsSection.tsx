/** Settings → Shortcuts: custom bindings for common functions, plus a read-only reference of the fixed ones. */
import React, { useState } from 'react';
import { BUILTIN_SHORTCUT_GROUPS, SHORTCUT_COMMANDS, accelFromEvent, formatAccelerator, isReservedAccel, shortcutCommandInfo, type ShortcutCommand } from '../../../../shared/shortcuts';
import type { AppSettings } from '../../../../shared/types';
import { invoke, isMac } from '../../api';
import { SettingsGroup } from '../SettingsPrimitives';
import { Button, Icon, Kbd } from '../ui';

export function ShortcutsSection({ settings }: { settings: AppSettings }) {
  const custom = settings.customShortcuts ?? {};
  const [draft, setDraft] = useState<{ command: ShortcutCommand; accel: string | null }>({ command: 'session.archive', accel: null });
  const entries = Object.entries(custom);

  const save = (next: Record<string, ShortcutCommand>) => void invoke('settings:update', { customShortcuts: next });

  const add = () => {
    if (!draft.accel || isReservedAccel(draft.accel)) return;
    // One binding per command: drop the command's previous accelerator, then bind the new one.
    const next: Record<string, ShortcutCommand> = { ...custom };
    for (const [accel, cmd] of Object.entries(next)) if (cmd === draft.command) delete next[accel];
    next[draft.accel] = draft.command;
    save(next);
    setDraft({ ...draft, accel: null });
  };

  const reserved = !!draft.accel && isReservedAccel(draft.accel);
  const replacedByAccel = draft.accel && custom[draft.accel] && custom[draft.accel] !== draft.command ? shortcutCommandInfo(custom[draft.accel]) : undefined;
  const movedFrom = draft.accel ? Object.entries(custom).find(([, cmd]) => cmd === draft.command) : undefined;

  return (
    <div className="settings-section">
      <h2>Shortcuts</h2>
      <p className="muted">The built-in combinations below always work. Add your own bindings for common actions — they work app-wide, and session actions apply to the session you are on.</p>

      <SettingsGroup id="shortcuts-custom" title="Custom shortcuts" icon="keyboard">
        {entries.length === 0 && <p className="muted small">No custom shortcuts yet. Pick a command, press a key combination, then Add.</p>}
        {entries.map(([accel, cmd]) => {
          const info = shortcutCommandInfo(cmd);
          return (
            <div key={accel} className="shortcut-row">
              <Icon name={info?.icon ?? 'bolt'} size={15} />
              <div className="shortcut-row-main">
                <div className="shortcut-row-title">{info?.label ?? cmd}</div>
                <div className="shortcut-row-desc muted small">{info?.description}</div>
              </div>
              <Kbd>{formatAccelerator(accel, isMac)}</Kbd>
              <Button size="sm" variant="ghost" icon="trash" title="Remove shortcut" onClick={() => {
                const next = { ...custom };
                delete next[accel];
                save(next);
              }} />
            </div>
          );
        })}

        <div className="row gap8 shortcut-add">
          <select value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value as ShortcutCommand })} aria-label="Command">
            {SHORTCUT_COMMANDS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <ShortcutCapture value={draft.accel} onChange={(accel) => setDraft({ ...draft, accel })} />
          <Button size="sm" variant="primary" disabled={!draft.accel || reserved} onClick={add}>
            Add
          </Button>
          {draft.accel && (
            <Button size="sm" variant="ghost" icon="x" title="Clear captured keys" onClick={() => setDraft({ ...draft, accel: null })} />
          )}
        </div>
        {draft.accel && reserved && (
          <p className="shortcut-warn small">
            <Icon name="alert" size={12} /> {formatAccelerator(draft.accel, isMac)} is reserved by a built-in shortcut — pick another combination.
          </p>
        )}
        {draft.accel && !reserved && replacedByAccel && (
          <p className="muted small">Replaces the custom binding for {replacedByAccel.label}.</p>
        )}
        {draft.accel && !reserved && !replacedByAccel && movedFrom && (
          <p className="muted small">Moves the binding for {shortcutCommandInfo(movedFrom[1])?.label ?? movedFrom[1]} from {formatAccelerator(movedFrom[0], isMac)}.</p>
        )}
      </SettingsGroup>

      <SettingsGroup id="shortcuts-reference" title="Built-in shortcuts" icon="book" description="Fixed combinations the app handles itself; custom bindings cannot take these.">
        {BUILTIN_SHORTCUT_GROUPS.map((g) => (
          <div key={g.title} className="shortcut-ref">
            <div className="shortcut-ref-title">{g.title}</div>
            {g.rows.map((r) => (
              <div key={r.label} className="shortcut-ref-row">
                <span>{r.label}</span>
                <span className="shortcut-ref-keys">
                  {r.keys.map((k) => (
                    <Kbd key={k}>{formatAccelerator(k, isMac)}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </SettingsGroup>
    </div>
  );
}

/** Input that captures a pressed key combination into an accelerator; it never accumulates typed text. */
function ShortcutCapture({ value, onChange }: { value: string | null; onChange: (accel: string | null) => void }) {
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Keep the capture from also reaching the global handler (Ctrl+N must not open a dialog mid-capture).
    e.stopPropagation();
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      onChange(null);
      return;
    }
    const accel = accelFromEvent(e);
    if (accel) onChange(accel);
  };
  return (
    <input
      className="shortcut-capture"
      value={value ?? ''}
      placeholder="Press keys…"
      spellCheck={false}
      aria-label="Key combination"
      onKeyDown={onKey}
      onChange={() => undefined}
    />
  );
}
