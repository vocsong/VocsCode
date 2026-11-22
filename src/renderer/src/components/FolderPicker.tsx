/**
 * The New session dialog's folder switcher: a header button that opens a filterable list of the
 * known folders (name over full path, most recently worked in first), with the native folder
 * picker pinned at the bottom.
 */
import React, { useRef, useState } from 'react';
import { relTime } from '../format';
import { matchesFolder, type FolderChoice } from '../folderChoices';
import { Dropdown, Icon } from './ui';

export function FolderPicker({ value, choices, onChoose, onBrowse }: {
  value: string;
  choices: FolderChoice[];
  onChoose: (root: string) => void;
  /** Absent where the native picker is unavailable (the web client). */
  onBrowse?: () => void;
}) {
  return (
    <Dropdown
      align="right"
      trigger={() => (
        <button type="button" className="ns-root-btn" title={value ? `${value} — change folder` : 'Choose a folder'}>
          <Icon name="folder" size={13} />
          <span className="ns-root"><bdi>{value || 'No folder selected'}</bdi></span>
          <Icon name="chevron" size={12} />
        </button>
      )}
    >
      {(close) => <FolderMenu value={value} choices={choices} onChoose={(root) => { close(); onChoose(root); }} onBrowse={onBrowse && (() => { close(); onBrowse(); })} />}
    </Dropdown>
  );
}

function FolderMenu({ value, choices, onChoose, onBrowse }: {
  value: string;
  choices: FolderChoice[];
  onChoose: (root: string) => void;
  onBrowse?: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = choices.filter((c) => matchesFolder(c, query));
  // While filtering, Enter in the box takes the top row, so that row is marked as the one it takes.
  const enterTarget = query.trim() ? shown[0]?.root : undefined;

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const top = shown[0];
    if (top) onChoose(top.root);
  };
  // Typing while a row has focus goes on filtering, as in any type-to-search list.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 || e.key === 'Backspace') inputRef.current?.focus();
  };

  return (
    <div className="folder-picker">
      <label className="folder-picker-search">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          data-menu-autofocus
          type="text"
          aria-label="Filter folders"
          placeholder={choices.length > 1 ? `Filter ${choices.length} folders…` : 'Filter folders…'}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
        />
      </label>
      <div className="folder-picker-list" role="group" aria-label="Folders" onKeyDown={onListKey}>
        {shown.map((c) => {
          const checked = c.root === value;
          return (
            <button
              key={c.root}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              className={`menu-item folder-choice${checked ? ' active' : ''}${c.root === enterTarget ? ' enter-target' : ''}`}
              title={c.root}
              onClick={() => onChoose(c.root)}
            >
              <Icon name="folder" size={14} />
              <span className="folder-choice-text">
                <span className="folder-choice-name">{c.name}</span>
                <span className="folder-choice-path"><bdi>{c.root}</bdi></span>
              </span>
              <span className="folder-choice-meta">{c.lastActiveAt ? relTime(c.lastActiveAt) : 'No sessions'}</span>
              <span className="folder-choice-check">{checked && <Icon name="check" size={14} />}</span>
            </button>
          );
        })}
        {shown.length === 0 && <div className="menu-empty">No folder matches “{query.trim()}”.</div>}
      </div>
      {onBrowse && (
        <div className="folder-picker-footer">
          <button type="button" role="menuitem" className="menu-item" onClick={onBrowse}>
            <Icon name="plus" size={14} />
            <span className="menu-item-label">Choose another folder…</span>
          </button>
        </div>
      )}
    </div>
  );
}
