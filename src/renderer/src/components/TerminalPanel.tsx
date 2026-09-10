/** The Terminal tab: a strip of PTY-backed shells per session, a find bar, and the xterm mount. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { baseName, type ShellOption, type TerminalInfo } from '../../../shared/terminal';
import { invoke, isMac } from '../api';
import { useStore } from '../store';
import * as host from '../terminal/host';
import { Button, Dropdown, EmptyState, Icon, Kbd, MenuItem } from './ui';

export function TerminalPanel({ session }: { session: SessionMeta }) {
  const all = useStore((s) => s.terminals);
  const loaded = useStore((s) => s.terminalsLoaded);
  const activeId = useStore((s) => s.activeTerminal[session.id]);
  const focusNonce = useStore((s) => s.terminalFocusNonce);
  const setActiveTerminal = useStore((s) => s.setActiveTerminal);
  const toast = useStore((s) => s.toast);
  const insertIntoComposer = useStore((s) => s.insertIntoComposer);
  const terminals = useMemo(() => all.filter((t) => t.sessionId === session.id), [all, session.id]);
  const active = terminals.find((t) => t.id === activeId) ?? terminals[terminals.length - 1];
  const [finding, setFinding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [shells, setShells] = useState<ShellOption[]>([]);
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    void invoke('terminal:shells', undefined).then(setShells).catch(() => undefined);
  }, []);

  // Opening the tab (or switching sessions under it) with no terminal starts a shell, like an
  // editor's terminal panel. Closing the last tab leaves the empty state instead of respawning.
  useEffect(() => {
    if (loaded && terminals.length === 0) void host.createTerminal(session.id);
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active && active.id !== activeId) setActiveTerminal(session.id, active.id);
  }, [active, activeId, session.id, setActiveTerminal]);

  // Focus the shell when the user opens the tab, picks a terminal or presses Ctrl+`; not when the
  // session changes underneath the panel (the composer takes focus then).
  useEffect(() => {
    const switched = shownFor.current !== null && shownFor.current !== session.id;
    shownFor.current = session.id;
    if (active && !switched) host.focus(active.id);
  }, [focusNonce, active?.id, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    host.setFindHandler(() => setFinding(true));
    return () => host.setFindHandler(null);
  }, []);

  const close = (id: string) => void invoke('terminal:close', { terminalId: id });
  const restart = (id: string) => void invoke('terminal:restart', { terminalId: id }).catch((e) => toast(String((e as Error).message ?? e), 'error'));
  const sendToAgent = () => {
    if (!active) return;
    const text = host.recentOutput(active.id);
    if (!text) {
      toast('Nothing in the terminal to send yet', 'info');
      return;
    }
    insertIntoComposer(['Terminal output (' + active.title + '):', '```', text, '```', ''].join('\n'));
  };

  return (
    <div className="term">
      <div className="term-tabs" role="tablist">
        {terminals.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active?.id}
            className={`term-tab ${t.id === active?.id ? 'active' : ''} ${t.exit ? 'exited' : ''}`}
            onClick={() => setActiveTerminal(session.id, t.id)}
            onAuxClick={(e) => e.button === 1 && close(t.id)}
            onDoubleClick={() => {
              setActiveTerminal(session.id, t.id);
              setRenaming(true);
            }}
            title={`${t.shellName} · ${t.cwd}${t.exit ? ` · exited (${t.exit.code})` : t.restored ? ' · restored' : ''}`}
          >
            <Icon name="terminal" size={12} />
            <span className="term-tab-title">{t.title}</span>
            <span
              className="term-tab-close"
              role="button"
              aria-label="Close terminal"
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
            >
              <Icon name="x" size={11} />
            </span>
          </button>
        ))}
        <span className="term-new">
          <Button variant="ghost" size="sm" icon="plus" title="New terminal (Ctrl+Shift+`)" aria-label="New terminal" onClick={() => void host.createTerminal(session.id)} />
          {shells.length > 1 && (
            <Dropdown trigger={() => <Button variant="ghost" size="sm" icon="chevron" aria-label="Choose shell" className="term-new-more" />}>
              {(closeMenu) =>
                shells.map((s) => (
                  <MenuItem
                    key={s.kind}
                    onClick={() => {
                      closeMenu();
                      void host.createTerminal(session.id, s.kind);
                    }}
                  >
                    {s.name}
                  </MenuItem>
                ))
              }
            </Dropdown>
          )}
        </span>
        <span className="spacer" />
        {active && (
          <>
            <span className="term-cwd mono" title={`${active.shellName} in ${active.cwd}`}>
              {baseName(active.cwd)}
            </span>
            <Button variant="ghost" size="sm" icon="search" title={`Find (${isMac ? '⌘' : 'Ctrl'}+F)`} aria-label="Find" onClick={() => setFinding((f) => !f)} />
            <Button variant="ghost" size="sm" icon="sparkles" title="Send the selection, or the recent output, to the agent" aria-label="Send output to agent" onClick={sendToAgent} />
            <Dropdown align="right" trigger={() => <Button variant="ghost" size="sm" icon="more" aria-label="Terminal menu" />}>
              {(closeMenu) => (
                <>
                  <MenuItem
                    onClick={() => {
                      closeMenu();
                      setRenaming(true);
                    }}
                  >
                    Rename tab…
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMenu();
                      host.clear(active.id);
                      void invoke('terminal:clear', { terminalId: active.id });
                    }}
                  >
                    Clear
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMenu();
                      host.selectAll(active.id);
                    }}
                  >
                    Select all
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      closeMenu();
                      restart(active.id);
                    }}
                  >
                    Restart shell
                  </MenuItem>
                  <MenuItem
                    disabled={!!active.exit}
                    danger
                    onClick={() => {
                      closeMenu();
                      void invoke('terminal:kill', { terminalId: active.id });
                    }}
                  >
                    Kill process
                  </MenuItem>
                  <MenuItem
                    danger
                    onClick={() => {
                      closeMenu();
                      close(active.id);
                    }}
                  >
                    Close terminal
                  </MenuItem>
                </>
              )}
            </Dropdown>
          </>
        )}
      </div>
      {finding && active && (
        <FindBar
          id={active.id}
          onClose={() => {
            setFinding(false);
            host.clearFind(active.id);
            host.focus(active.id);
          }}
        />
      )}
      {renaming && active && (
        <RenameBar
          terminal={active}
          onDone={() => {
            setRenaming(false);
            host.focus(active.id);
          }}
        />
      )}
      <div className="term-body">
        {active ? (
          <>
            <TerminalView id={active.id} />
            {active.exit && (
              <div className="term-exit-bar">
                <span>Process exited with code {active.exit.code}</span>
                <span className="spacer" />
                <Button size="sm" icon="refresh" onClick={() => restart(active.id)}>
                  Restart
                </Button>
                <Button size="sm" variant="ghost" icon="x" onClick={() => close(active.id)}>
                  Close
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyState icon="terminal" title="No terminal open">
            <p>
              Open a shell in <span className="mono">{baseName(session.cwd)}</span>. It keeps running while you work elsewhere in the app, and its tabs come back after a restart.
            </p>
            <Button variant="primary" icon="plus" onClick={() => void host.createTerminal(session.id)}>
              New terminal
            </Button>
            <p className="muted small">
              <Kbd>Ctrl+`</Kbd> focus · <Kbd>Ctrl+Shift+`</Kbd> new · <Kbd>Ctrl+F</Kbd> find
            </p>
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function TerminalView({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    host.mount(id, el);
    return () => host.unmount(id);
  }, [id]);
  return <div className="term-view" ref={ref} />;
}

function FindBar({ id, onClose }: { id: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hit, setHit] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    setHit(q ? host.find(id, q, 'next', { caseSensitive, regex, incremental: true }) : null);
  }, [q, caseSensitive, regex, id]);
  const step = (dir: 'next' | 'prev') => setHit(host.find(id, q, dir, { caseSensitive, regex }));
  return (
    <div className="term-find">
      <Icon name="search" size={13} />
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find in terminal"
        spellCheck={false}
        className={hit === false ? 'no-hit' : ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter') step(e.shiftKey ? 'prev' : 'next');
          else if (e.key === 'Escape') onClose();
        }}
      />
      <button type="button" className={`term-find-opt ${caseSensitive ? 'on' : ''}`} onClick={() => setCaseSensitive((v) => !v)} title="Match case">
        Aa
      </button>
      <button type="button" className={`term-find-opt ${regex ? 'on' : ''}`} onClick={() => setRegex((v) => !v)} title="Regular expression">
        .*
      </button>
      <Button variant="ghost" size="sm" icon="arrowUp" aria-label="Previous match" onClick={() => step('prev')} />
      <Button variant="ghost" size="sm" icon="chevron" aria-label="Next match" onClick={() => step('next')} />
      <Button variant="ghost" size="sm" icon="x" aria-label="Close find" onClick={onClose} />
    </div>
  );
}

function RenameBar({ terminal, onDone }: { terminal: TerminalInfo; onDone: () => void }) {
  const [title, setTitle] = useState(terminal.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = () => {
    void invoke('terminal:rename', { terminalId: terminal.id, title });
    onDone();
  };
  return (
    <div className="term-rename">
      <span className="muted small">Tab name</span>
      <input
        ref={input}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={terminal.shellName}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') onDone();
        }}
      />
      <Button size="sm" variant="primary" onClick={commit}>
        Rename
      </Button>
      <Button size="sm" variant="ghost" icon="x" aria-label="Cancel" onClick={onDone} />
    </div>
  );
}
