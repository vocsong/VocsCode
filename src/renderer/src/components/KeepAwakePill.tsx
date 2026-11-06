import React, { useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { canInvoke } from '../api';
import { setSessionKeepAwake } from '../sessionActions';
import { useStore } from '../store';
import { Icon } from './ui';

/** Asks the desktop to keep this computer awake while the session is working. Hidden on a paired
 *  browser: the choice is about the host's power state, so only the host's own window offers it. */
export function KeepAwakePill({ session }: { session: SessionMeta }) {
  const toast = useStore((s) => s.toast);
  const [pending, setPending] = useState(false);
  if (!canInvoke('sessions:setKeepAwake')) return null;
  const on = !!session.keepAwake;
  const working = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  const awake = on && working;

  const change = async () => {
    if (pending) return;
    setPending(true);
    try {
      await setSessionKeepAwake(session.id, !on);
    } catch (e) {
      toast(`Keep awake failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      className={`pill pill-tip ${on ? 'pill-on' : ''}`}
      role="switch"
      aria-label="Keep computer awake"
      aria-checked={on}
      aria-busy={pending}
      disabled={pending}
      data-awake={awake ? 'held' : on ? 'armed' : 'off'}
      data-tip={awake ? 'Keep computer awake · On. Only for this session. Holding your computer awake while it works; closing the lid still sleeps it.' : on ? 'Keep computer awake · On. Only for this session. Stays awake whenever it is working, then lets the computer sleep. Resets when the app restarts.' : 'Keep computer awake. Only for this session. Stops your computer from idle-sleeping while this session works.'}
      onClick={() => void change()}
    >
      <Icon name="coffee" size={13} /> Awake
    </button>
  );
}
