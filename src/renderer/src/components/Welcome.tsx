/**
 * What the workspace shows with no session open. The app opens a neighbouring session whenever the
 * open one is archived or removed, so this only appears before there is any session: it is a start,
 * not a session list.
 */
import React from 'react';
import { modKey } from '../api';
import { useStore } from '../store';
import { Button, Icon, Kbd } from './ui';

export function Welcome() {
  const keys: [string, string][] = [
    [`${modKey}+N`, 'New session'],
    [`${modKey}+Alt+N`, 'New in a folder…'],
    [`${modKey}+K`, 'Command palette'],
    [`${modKey}+Shift+F`, 'Search sessions'],
    [`${modKey}+1…9`, 'Switch session'],
    [`${modKey}+J`, 'Toggle panel']
  ];
  return (
    <div className="main-empty">
      <div className="welcome">
        <div className="welcome-mark">
          <Icon name="logo" size={26} />
        </div>
        <h1 className="welcome-title">Welcome to Vocs Code</h1>
        <p className="welcome-sub">
          One desktop for every coding agent. Pick a harness per session — Claude Agent SDK, Codex, Pi, DeepSeek Harness or any ACP agent, or the built-in loop — and any model it can reach.
        </p>
        <div className="welcome-actions">
          <Button variant="primary" icon="plus" onClick={() => void useStore.getState().startNewSession()}>
            New session
          </Button>
          <Button icon="settings" onClick={() => useStore.getState().setView('settings')}>
            Settings
          </Button>
        </div>
        <div className="welcome-keys">
          {keys.map(([k, label]) => (
            <div key={k} className="welcome-key">
              <Kbd>{k}</Kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
