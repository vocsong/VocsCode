/** Sidebar pickers and status pills: StatusLabelPicker, FolderStyleButton, and UpdatePill. */
import React, { useState } from 'react';
import type { SessionMeta } from '../../../../shared/types';
import { invoke } from '../../api';
import { basename } from '../../format';
import { useStore } from '../../store';
import { Button, Dropdown, Icon, MenuItem } from '../ui';

/** Icon choices for folder headers (names from the renderer icon set). */
const FOLDER_ICONS = [
  'folder', 'bolt', 'brain', 'shield', 'star', 'sparkles', 'target', 'branch', 'terminal', 'chart',
  'play', 'file', 'code', 'bug', 'wrench', 'rocket', 'globe', 'lock', 'key', 'cpu',
  'database', 'cloud', 'fire', 'cube', 'layers', 'box', 'flag', 'bulb', 'link', 'map',
  'moon', 'sun', 'palette', 'puzzle', 'robot', 'server', 'tag', 'heart', 'home', 'book',
  'mail', 'bell', 'coffee', 'music', 'camera', 'video', 'gamepad', 'leaf', 'compass', 'gift'
] as const;

/** Swatch palette for folder headers. */
const FOLDER_COLORS = [
  '#5b9bf8', '#2563eb', '#0ea5e9', '#22d3ee', '#2dd4bf', '#34d399', '#4ade80', '#84cc16',
  '#a3e635', '#fbbf24', '#facc15', '#fb923c', '#f97316', '#f87171', '#ef4444', '#fb7185',
  '#f472b6', '#e879f9', '#c084fc', '#a78bfa', '#818cf8', '#94a3b8', '#64748b', '#e2e8f0'
] as const;

/** Built-in status labels offered in the picker; user-added labels extend these via settings. */
const STATUS_LABEL_CHOICES = ['Idle', 'Starting', 'Working', 'Awaiting', 'Error', 'Stopped', 'PR', 'Merged', 'Todo'];

export function UpdatePill() {
  const { status, version, progress, deferred } = useStore((s) => s.updateState);
  let label: string;
  let title: string;
  let action: 'update:download' | 'update:install' | undefined;

  switch (status) {
    case 'available':
      label = 'Update';
      title = `Download Vocs Code ${version}`;
      action = 'update:download';
      break;
    case 'downloading':
      label = `Updating… ${Math.round(progress?.percent ?? 0)}%`;
      title = `Downloading Vocs Code ${version}`;
      break;
    case 'restart-pending':
      label = deferred ? 'Update ready' : 'Install update';
      title = deferred
        ? `Vocs Code ${version} is ready. Restart now or wait for sessions to finish.`
        : `Restart to install Vocs Code ${version}`;
      action = 'update:install';
      break;
    default:
      return null;
  }

  return (
    <button type="button" className="update-pill" title={title} disabled={!action} onClick={action ? () => void invoke(action, undefined) : undefined}>
      {label}
    </button>
  );
}

/** Status-label picker: built-in choices, user-added labels, an add field, and a reset. */
export function StatusLabelPicker({ session: s, customLabels, onPick, close }: {
  session: SessionMeta;
  customLabels: string[];
  onPick: (label?: string, nextCustom?: string[]) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState('');
  const extras = customLabels.filter((l) => !STATUS_LABEL_CHOICES.some((c) => c.toLowerCase() === l.toLowerCase()));
  const add = () => {
    const label = draft.trim().slice(0, 24);
    if (!label) return;
    onPick(label, [...customLabels, label].filter((l, i, all) => all.findIndex((x) => x.toLowerCase() === l.toLowerCase()) === i).slice(0, 30));
    setDraft('');
    close();
  };
  return (
    <div className="status-label-picker">
      {[...STATUS_LABEL_CHOICES, ...extras].map((label) => (
        <MenuItem key={label} active={s.statusLabel === label} onClick={() => { onPick(label); close(); }}>{label}</MenuItem>
      ))}
      <div className="status-label-add">
        <input
          placeholder="Add label"
          value={draft}
          maxLength={24}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <Button size="sm" variant="ghost" icon="plus" aria-label="Add label" onClick={add} />
      </div>
      {s.statusLabel && <MenuItem onClick={() => { onPick(undefined); close(); }}>Reset to status</MenuItem>}
    </div>
  );
}

/** Folder icon button opening a popover to pick the folder's icon and color. */
export function FolderStyleButton({ root, style, onPick }: {
  root: string;
  style?: { color?: string; icon?: string };
  onPick: (patch?: { color?: string; icon?: string }) => void;
}) {
  const name = basename(root);
  return (
    <Dropdown align="left" width={240} trigger={() => (
      <button
        type="button"
        className="project-icon-btn"
        style={style?.color ? { color: style.color } : undefined}
        title={`Customize ${name}`}
        aria-label={`Customize ${name}`}
      >
        <Icon name={style?.icon ?? 'folder'} size={13} />
      </button>
    )}>
      {() => (
        <div className="folder-style-picker">
          <div className="picker-label">Icon</div>
          <div className="picker-grid">
            {FOLDER_ICONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`picker-opt ${style?.icon === n ? 'active' : ''}`}
                title={n}
                aria-label={`Icon ${n}`}
                onClick={() => onPick({ icon: n })}
              >
                <Icon name={n} size={14} />
              </button>
            ))}
          </div>
          <div className="picker-label">Color</div>
          <div className="picker-grid">
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`picker-swatch ${style?.color === c ? 'active' : ''}`}
                style={{ background: c }}
                title={c}
                aria-label={`Color ${c}`}
                onClick={() => onPick({ color: c })}
              />
            ))}
          </div>
          <MenuItem onClick={() => onPick(undefined)}>Reset to default</MenuItem>
        </div>
      )}
    </Dropdown>
  );
}
