/** Connect with GitHub, in the browser the desktop opened (docs/REMOTE-ACCESS.md §6.3.1): add
 *  that computer to the signed-in account, wait for it to collect its credential and come online,
 *  then pair this browser with it — the desktop still asks for Allow. */
import { useState } from 'react';
import { Button, Field } from '@renderer/components/ui';
import { connectCheckCode } from '@shared/pairing';
import { relayBaseFor, type RelayClient } from '../../../relay/src/web-client';
import { PairingWait } from './PairingWait';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ConnectScreen({ client, nonceHash, onPaired, onCancel, cancellable }: {
  client: RelayClient;
  nonceHash: string;
  onPaired: () => void;
  onCancel: () => void;
  cancellable: boolean;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const base = relayBaseFor(window.location.origin, new URLSearchParams(window.location.search).get('relay'));

  const add = async () => {
    setBusy(true);
    setError('');
    setStatus('Adding the computer…');
    try {
      await client.addComputer(base, nonceHash);
      setStatus('Waiting for the computer to finish connecting…');
      let added: { status: string; hostDeviceId?: string } = { status: 'granted' };
      for (let i = 0; i < 90 && added.status !== 'redeemed'; i++) {
        await sleep(1000);
        added = await client.addedComputer(base, nonceHash);
        if (added.status === 'missing') throw new Error('the request expired; click Connect with GitHub in Vocs Code again');
      }
      if (added.status !== 'redeemed' || !added.hostDeviceId) throw new Error('the computer did not finish connecting; is Vocs Code still open on it?');
      // A pairing request only reaches an online computer: wait for presence rather than race it.
      setStatus('Added. Waiting for the computer to come online…');
      for (let i = 0; i < 30; i++) {
        const hosts = await client.ownerHosts(base).catch(() => []);
        if (hosts.some((host) => host.deviceId === added.hostDeviceId && host.online)) break;
        await sleep(1000);
      }
      setStatus('Now click Allow in Vocs Code on the computer to pair this browser.');
      setWaiting(true);
      await client.pairWithHost({ relayBase: base, hostDeviceId: added.hostDeviceId, deviceName: name.trim() || 'Browser' });
      onPaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWaiting(false);
      setBusy(false);
      setStatus('');
    }
  };

  if (waiting) return <PairingWait onCancel={() => { setWaiting(false); setBusy(false); }} />;

  return (
    <section className="w-screen" data-testid="connect-screen">
      <div className="w-card">
        <h1>Add this computer?</h1>
        <p className="w-hint">A computer running Vocs Code asked to join your account. Continue only if you just clicked <strong>Connect with GitHub</strong> on it and it shows this code:</p>
        <p className="w-check-code" data-testid="connect-code">{connectCheckCode(nonceHash)}</p>
        <ol className="w-steps">
          <li className={busy ? 'is-current' : ''}>Adding the computer</li>
          <li className={busy && status.startsWith('Waiting for the computer') ? 'is-current' : ''}>Waiting for the computer</li>
          <li className={busy && status.includes('Allow') ? 'is-current' : ''}>Click Allow in Vocs Code</li>
        </ol>
        <Field label="Name this browser">
          <input data-testid="connect-name" value={name} placeholder="My laptop" onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="w-actions">
          <Button variant="primary" disabled={busy} onClick={() => void add()} data-testid="connect-add">Add this computer</Button>
          <Button variant="ghost" onClick={onCancel}>{cancellable ? 'Cancel' : 'Start over'}</Button>
        </div>
        <p className="w-hint" role="status" aria-live="polite">{status}</p>
        {error && <p className="w-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
