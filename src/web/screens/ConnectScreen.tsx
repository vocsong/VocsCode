/** Connect with Vocs, in the browser the desktop opened (docs/RELAY.md): add that
 *  computer to the signed-in account and wait for it to collect its credential. Its analytics then
 *  arrive on the dashboard on their own; no browser pairing is involved any more. */
import { useState } from 'react';
import { connectCheckCode } from '@shared/pairing';
import { addComputer, addedComputer } from '../owner-api';
import { FocusStage } from '../shell/FocusStage';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ConnectScreen({ nonceHash, onDone, poll = { attempts: 90, intervalMs: 1000 } }: { nonceHash: string; onDone: () => void; poll?: { attempts: number; intervalMs: number } }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);

  const add = async () => {
    setBusy(true);
    setError('');
    setStatus('Adding the computer…');
    try {
      await addComputer(nonceHash);
      setStatus('Waiting for the computer to finish connecting…');
      let state: { status: string } = { status: 'granted' };
      for (let i = 0; i < poll.attempts && state.status !== 'redeemed'; i++) {
        await sleep(poll.intervalMs);
        state = await addedComputer(nonceHash);
        if (state.status === 'missing') throw new Error('the request expired; click Connect with Vocs in Vocs Code again');
      }
      if (state.status !== 'redeemed') throw new Error('the computer did not finish connecting; is Vocs Code still open on it?');
      setAdded(true);
      setStatus('Added. Its analytics appear on your dashboard after its first sync.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FocusStage testId="connect-screen">
      <div>
        <p className="v-eyebrow v-eyebrow-sm">Connect with Vocs</p>
        <h1 className="v-h1" id="focus-title">{added ? 'Computer added' : 'Add this computer?'}</h1>
        {!added && <p className="v-text w-focus-description">A computer running Vocs Code asked to join your account. Continue only if you just clicked <strong>Connect with Vocs</strong> on it and it shows this code:</p>}
      </div>
      {!added && <p className="w-check-code v-mono" data-testid="connect-code">{connectCheckCode(nonceHash)}</p>}
      <div className="w-focus-actions">
        {added ? (
          <button type="button" className="v-btn v-btn-primary" onClick={onDone} data-testid="connect-done">Open the dashboard</button>
        ) : (
          <>
            <button type="button" className="v-btn v-btn-primary" disabled={busy} onClick={() => void add()} data-testid="connect-add">Add this computer</button>
            <button type="button" className="v-btn v-btn-ghost" disabled={busy} onClick={onDone}>Cancel</button>
          </>
        )}
      </div>
      <p className={`v-text w-focus-status${added ? ' v-note' : ''}`} role="status" data-testid="connect-status">{status}</p>
      {error && <p className="v-note v-note-danger" role="alert">{error}</p>}
    </FocusStage>
  );
}
