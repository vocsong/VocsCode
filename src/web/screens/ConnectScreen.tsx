/** Connect with Vocs, in the browser the desktop opened (docs/REMOTE-ACCESS.md §6.3.1): add that
 *  computer to the signed-in account and wait for it to collect its credential. Its analytics then
 *  arrive on the dashboard on their own; no browser pairing is involved any more. */
import { useState } from 'react';
import { Button } from '@renderer/components/ui';
import { connectCheckCode } from '@shared/pairing';
import { addComputer, addedComputer } from '../owner-api';

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
    <section className="w-screen" data-testid="connect-screen">
      <div className="w-screen-inner">
        <div className="w-card">
          <p className="w-label">Connect with Vocs</p>
          <h1>{added ? 'Computer added' : 'Add this computer?'}</h1>
          {!added && (
            <>
              <p className="w-lead">A computer running Vocs Code asked to join your account. Continue only if you just clicked <strong>Connect with Vocs</strong> on it and it shows this code:</p>
              <p className="w-check-code" data-testid="connect-code">{connectCheckCode(nonceHash)}</p>
            </>
          )}
          <div className="w-actions">
            {added ? (
              <Button variant="primary" onClick={onDone} data-testid="connect-done">Open the dashboard</Button>
            ) : (
              <>
                <Button variant="primary" disabled={busy} onClick={() => void add()} data-testid="connect-add">Add this computer</Button>
                <Button variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
              </>
            )}
          </div>
          <p className="w-hint" role="status" aria-live="polite" data-testid="connect-status">{status}</p>
          {error && <p className="w-error" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}
