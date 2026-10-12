/** Pairing from a phone (docs/REMOTE-ACCESS.md §6.3): the code from the desktop, or — when the
 *  landing recognises a signed-in owner — one tap on a computer of the account. Either way the
 *  desktop still shows the request and a human clicks Allow there. */
import { useEffect, useState } from 'react';
import { Button, Field, Spinner } from '@renderer/components/ui';
import { relayBaseFor, type OwnerHost, type RelayClient } from '../../../relay/src/web-client';
import type { AccountState } from '../shell/account';
import { PairingWait } from './PairingWait';
import { suggestedName } from '../device-name';

export function PairScreen({ client, account, initialCode, storageError, onPaired }: {
  client: RelayClient;
  account: AccountState;
  initialCode?: string;
  storageError?: string;
  onPaired: () => void;
}) {
  const [code, setCode] = useState(initialCode ?? '');
  const [name, setName] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [hosts, setHosts] = useState<OwnerHost[] | null>(null);
  const base = relayBaseFor(window.location.origin, new URLSearchParams(window.location.search).get('relay'));
  const deviceName = name.trim() || suggestedName();

  const refreshHosts = async () => {
    if (account.status !== 'signed-in') return;
    try {
      setHosts(await client.ownerHosts(base));
    } catch {
      // Signed in but owner actions are not set up on this relay: the code form still works.
      setHosts(null);
    }
  };
  useEffect(() => {
    void refreshHosts();
    // Only account changes matter here; a relay that gains owner support mid-session is rare.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.status]);

  const start = async (run: () => Promise<unknown>) => {
    setWaiting(true);
    setError('');
    try {
      await run();
      onPaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWaiting(false);
    }
  };

  if (waiting) return <PairingWait onCancel={() => setWaiting(false)} />;

  const paired = new Set(client.pairings().map((p) => p.hostDeviceId));
  const hasPairings = client.hasCredentials();
  const signedIn = account.status === 'signed-in';
  return (
    <section className="w-screen" data-testid="pair-screen">
      <div className="w-screen-inner">
        <div className="w-screen-brand">
          <span className="w-brand">Vocs Code</span>
          {hasPairings && <Button type="button" size="sm" variant="ghost" onClick={onPaired}>Cancel</Button>}
        </div>
        <div className="w-card">
          <p className="w-label">{hasPairings ? 'Add a computer' : 'Remote access'}</p>
          <h1>{hasPairings ? 'Add another computer' : 'Your computer, from anywhere'}</h1>
          <p className="w-lead">
            Pair this browser with Vocs Code on your computer. Sessions keep running there; this browser
            follows and drives them over an end-to-end encrypted relay.
          </p>
          {signedIn && hosts && (
            <div className="w-owner-hosts">
              <h2>Your computers</h2>
              {hosts.length === 0 && (
                <p className="w-hint">None yet. On your computer, open Vocs Code → Settings → Remote access and choose Connect with GitHub.</p>
              )}
              <ul className="w-list">
                {hosts.map((host) => (
                  <li key={host.deviceId} className="w-list-row">
                    <span className="w-list-main">
                      <span className="w-list-name">{host.name}</span>
                      <span className="w-list-hint">{paired.has(host.deviceId) ? 'Paired with this browser' : host.online ? 'Online' : 'Offline'}</span>
                    </span>
                    <Button
                      size="sm"
                      variant={paired.has(host.deviceId) ? 'ghost' : 'primary'}
                      data-testid="owner-pair"
                      disabled={!paired.has(host.deviceId) && !host.online}
                      onClick={() => {
                        if (paired.has(host.deviceId)) {
                          void client.select(host.deviceId).then(onPaired);
                        } else {
                          void start(() => client.pairWithHost({ relayBase: base, hostDeviceId: host.deviceId, deviceName }));
                        }
                      }}
                    >
                      {paired.has(host.deviceId) ? 'Open' : 'Pair'}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="w-divider">or use a pairing code</div>
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (storageError) return;
              void start(() => client.pair({ relayBase: base, code, deviceName }));
            }}
          >
            <div className="w-pair-code">
              <Field label="Pairing code">
                <input
                  data-testid="pair-code"
                  value={code}
                  maxLength={9}
                  placeholder="ABCD2345"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  required
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
              </Field>
            </div>
            <Field label="Name this browser">
              <input data-testid="pair-name" value={name} placeholder={suggestedName()} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="w-actions">
              <Button type="submit" variant="primary" className="w-block" data-testid="pair-submit" disabled={!!storageError}>Pair</Button>
            </div>
            {storageError && <p className="w-error" role="alert">{storageError}</p>}
            {error && <p className="w-error" role="alert">{error}</p>}
          </form>
          <details className="w-help">
            <summary>Where do I find the code?</summary>
            <ol className="w-steps">
              <li>On the computer, open Vocs Code → Settings → Remote access and click Connect.</li>
              <li>Scan the QR code it shows with this device, or type its code above.</li>
              <li>Press Pair, then click Allow on the computer.</li>
            </ol>
          </details>
          {signedIn && (
            <div className="w-account">
              <span className="account-name">Signed in as @{account.account.login}</span>
              <form method="post" action="/logout" className="account-signout">
                <button type="submit" className="btn btn-ghost btn-sm">Sign out of GitHub</button>
              </form>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
