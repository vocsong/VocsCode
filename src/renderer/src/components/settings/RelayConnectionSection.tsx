/**
 * The relay connection (docs/CONTROL-MCP.md, docs/WEB-DASHBOARD.md): Connect with Vocs registers this
 * computer with the owner's account so external MCP controllers can reach it through their grants
 * and the code.vocs.io dashboard can show its analytics. The device credential stays in the OS
 * keychain; the relay is not configurable here (main reports the one this desktop uses).
 */
import React, { useEffect, useState } from 'react';
import { DEFAULT_REMOTE_ORIGIN, remoteOrigin } from '../../../../shared/pairing';
import type { AppSettings, RemoteDeviceInfo, RemoteState } from '../../../../shared/types';
import { invoke, on } from '../../api';
import { askConfirm, Button, Field, Toggle } from '../ui';

interface RemoteSnapshot {
  state: RemoteState;
  devices: RemoteDeviceInfo[];
  relayUrl: string;
  registered: boolean;
  signInAvailable: boolean;
}

export function RelayConnectionSection({ settings }: { settings: AppSettings }) {
  const config = settings.remote ?? { enabled: false };
  const [state, setState] = useState<RemoteState | null>(null);
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([]);
  const [relay, setRelay] = useState(DEFAULT_REMOTE_ORIGIN);
  const [storedRegistered, setRegistered] = useState(false);
  // The relay's origin has a Vocs sign-in; a relay without one (a bare development relay) cannot
  // register a new computer.
  const [signInAvailable, setSignInAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const apply = (r: RemoteSnapshot) => {
    setState(r.state);
    setDevices(r.devices);
    setRelay(r.relayUrl);
    setRegistered(r.registered === true);
    setSignInAvailable(r.signInAvailable === true);
  };

  useEffect(() => {
    const refresh = () => {
      void invoke('remote:get', undefined)
        .then((r) => apply(r))
        .catch(() => undefined);
    };
    refresh();
    const un = on('push:remoteState', (s) => setState(s));
    const tick = setInterval(refresh, 5000);
    return () => {
      un();
      clearInterval(tick);
    };
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      void invoke('remote:get', undefined).then((r) => apply(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const webHost = new URL(remoteOrigin(relay)).host;
  const registered = storedRegistered || state?.registered === true;
  const signingIn = state?.signIn;
  const connected = config.enabled && (state?.status === 'online' || state?.status === 'connecting');
  const statusLine = state ? `${state.status}${state.detail ? ` — ${state.detail}` : ''}` : 'unknown';
  const computers = devices.filter((d) => d.kind === 'host');
  // Browsers an older version paired: they can no longer reach this computer, but stay on the
  // account until revoked.
  const legacyBrowsers = devices.filter((d) => d.kind === 'web');

  return (
    <div className="settings-relay">
      <p className="muted small">
        Connect this computer to your Vocs account. MCP clients such as Dots and Muse can then reach it,
        but only through the grants you set below, and {webHost} shows its analytics. The connection is
        outbound only: nothing on this computer listens for incoming traffic.
      </p>
      {signingIn && (
        <div className="small" data-testid="remote-sign-in-waiting">
          <p>
            Finish in your browser: sign in with your Vocs account, check that the page shows <strong data-testid="remote-sign-in-code">{signingIn.checkCode}</strong>,
            and click Add this computer.{' '}
            <button type="button" className="link-btn" onClick={() => void invoke('app:openExternal', { url: signingIn.link })}>
              Open the page again
            </button>
          </p>
        </div>
      )}
      <div className="settings-actions">
        {!signingIn && !connected && (
          <Button
            size="sm"
            variant="primary"
            data-testid="remote-sign-in"
            disabled={busy || (!registered && !signInAvailable)}
            title={!registered && !signInAvailable ? `${webHost} has no Vocs sign-in, so it cannot add this computer` : undefined}
            onClick={() => void act(() => invoke('remote:signIn', undefined))}
          >
            {busy ? 'Connecting…' : registered ? 'Connect' : 'Connect with Vocs'}
          </Button>
        )}
        {(config.enabled || signingIn) && (
          <Button size="sm" variant="ghost" disabled={busy} data-testid="remote-disconnect" onClick={() => void act(() => invoke('remote:disable', undefined))}>
            {signingIn ? 'Cancel' : 'Disconnect'}
          </Button>
        )}
      </div>
      <p className="muted small" data-testid="remote-status">
        Status: <strong>{statusLine}</strong>
      </p>
      {error && <p className="small" style={{ color: 'var(--red, #d00)' }}>{error}</p>}

      {config.enabled && (
        <Field label="Analytics dashboard" hint="Upload this computer's usage analytics so code.vocs.io shows every computer in one dashboard. Sent: spend, tokens, models, tools, reliability, session titles and project folder names. Never sent: file paths, full project paths, prompts or transcripts. Turning this off deletes the uploaded copy.">
          <Toggle
            checked={config.shareAnalytics !== false}
            disabled={busy}
            onChange={(v) => void act(() => invoke('remote:setShareAnalytics', { share: v }))}
            label="Share analytics with code.vocs.io"
          />
        </Field>
      )}

      {computers.length > 0 && (
        <>
          <h3>Your computers</h3>
          {computers.map((d) => (
            <Field
              key={d.deviceId}
              label={d.name}
              hint={`${d.platform} · ${d.online ? 'connected now' : `last seen ${new Date(d.lastSeen).toLocaleString()}`}`}
            >
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => invoke('remote:revoke', { deviceId: d.deviceId }))}>
                Remove
              </Button>
            </Field>
          ))}
        </>
      )}
      {legacyBrowsers.length > 0 && (
        <p className="muted small" data-testid="remote-legacy-browsers">
          {legacyBrowsers.length === 1 ? 'A browser' : `${legacyBrowsers.length} browsers`} paired by an earlier version {legacyBrowsers.length === 1 ? 'is' : 'are'} still
          on your account. Browser access has been retired, so {legacyBrowsers.length === 1 ? 'it' : 'they'} can no longer reach this computer; Remove all clears {legacyBrowsers.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {devices.length > 1 && (
        <Field label="Remove every other device" hint="The kill switch: signs out every other computer on your account, and any browser an earlier version paired. This computer stays connected.">
          <Button
            size="sm"
            variant="danger"
            data-testid="remote-revoke-all"
            disabled={busy}
            onClick={() =>
              void (async () => {
                const confirmed = await askConfirm({
                  title: 'Remove every other device?',
                  body: 'Every other computer on this account loses its connection immediately, and MCP controllers can no longer reach it. Each one needs Connect with Vocs again.',
                  confirmLabel: 'Remove all',
                  danger: true
                });
                if (confirmed) await act(() => invoke('remote:revokeAll', undefined));
              })()
            }
          >
            Remove all
          </Button>
        </Field>
      )}
    </div>
  );
}
