/** Composer primary action controls: Send, Run (!shell), Steer/Queue + Interrupt, or Fork to continue. */
import React from 'react';
import type { HarnessCapabilities, SessionMeta } from '../../../../shared/types';
import { invoke } from '../../api';
import { useStore } from '../../store';
import { ForkIntoDropdown } from '../ForkInto';
import { Button, Dropdown, MenuItem } from '../ui';

export function ComposerSendControls({
  session,
  ended,
  shellDraft,
  busy,
  caps,
  text,
  hasAttachments,
  onSend
}: {
  session: SessionMeta;
  ended: boolean;
  shellDraft: boolean;
  busy: boolean;
  caps: HarnessCapabilities;
  text: string;
  hasAttachments: boolean;
  onSend: (mode?: 'now' | 'steer' | 'queue') => void;
}) {
  if (ended) {
    return (
      <ForkIntoDropdown
        session={session}
        onForked={(fork) => void useStore.getState().setActive(fork.id)}
        trigger={() => <Button size="sm" variant="primary" icon="fork" title="Fork this session to keep working on it">Fork to continue</Button>}
      />
    );
  }
  if (shellDraft) {
    return (
      <Button size="sm" variant="primary" icon="terminal" onClick={() => onSend()} disabled={!text.trim().slice(1).trim()} title="Run in this session's terminal without sending anything to the agent">
        Run
      </Button>
    );
  }
  if (busy) {
    return (
      <>
        <div className="composer-send-group">
          <Button size="sm" variant="primary" icon={caps.steer ? 'arrowUp' : 'clock'} onClick={() => onSend(caps.steer ? 'steer' : 'queue')} title={caps.steer ? 'Steer now (Enter)' : 'Queue (Enter)'} aria-label={caps.steer ? 'Steer' : 'Queue'}>
            <span className="composer-send-label">{caps.steer ? 'Steer' : 'Queue'}</span>
          </Button>
          {caps.steer && caps.queue && <Dropdown align="right" width={240} trigger={() => <Button size="sm" variant="primary" className="composer-send-options" icon="chevron" title="Send options" aria-label="Send options" />}>
            {(close) => <MenuItem hint="After the current turn" onClick={() => { close(); onSend('queue'); }}>Queue</MenuItem>}
          </Dropdown>}
        </div>
        <Button size="sm" variant="danger" icon="stop" className="btn-icon" onClick={() => void invoke('sessions:interrupt', { id: session.id })} title="Interrupt (Esc)" />
      </>
    );
  }
  return (
    <Button size="sm" variant="primary" icon="arrowUp" className="send-btn" onClick={() => onSend()} disabled={!text.trim() && !hasAttachments} title="Send (Enter) · Shift+Enter for a new line" aria-label="Send" />
  );
}
