/**
 * Remote access (docs/REMOTE-ACCESS.md §6): relay connection, browser pairing, devices.
 * The enrollment secret is stored in the OS keychain via secrets:set, never in settings. The relay
 * is not configurable here: main reports the one this desktop uses (code.vocs.io in production).
 */
import React, { useEffect, useState } from 'react';
import { DEFAULT_REMOTE_ORIGIN, pairingLink as pairingLinkFor, remoteOrigin } from '../../../../shared/pairing';
import type { AppSettings, RemoteAuditEntry, RemoteDeviceInfo, RemoteState } from '../../../../shared/types';
import { invoke, on } from '../../api';
import { useStore } from '../../store';
import { PairingQr } from '../PairingQr';
import { askConfirm, Button, Field, Toggle } from '../ui';

export function RemoteSection({ settings }: { settings: AppSettings; update?: (p: Partial<AppSettings>) => void }) {
  const toast = useStore((s) => s.toast);
  const config = settings.remote ?? { enabled: false };
  const [state, setState] = useState<RemoteState | null>(null);
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([]);
  const [audit, setAudit] = useState<RemoteAuditEntry[]>([]);
  const [relay, setRelay] = useState(DEFAULT_REMOTE_ORIGIN);
  // A registered computer has its own relay credential: the enrollment secret is a first-time step.
  const [storedRegistered, setRegistered] = useState(false);
  // The relay's origin has a Vocs sign-in (the landing's login gate): each computer must be
  // enrolled through its signed-in account, never the incumbent account's shared legacy secret.
  const [signInAvailable, setSignInAvailable] = useState(false);
  const [enroll, setEnroll] = useState('');
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const applyResult = (r: { state: RemoteState; devices: RemoteDeviceInfo[]; audit: RemoteAuditEntry[]; relayUrl: string; registered: boolean; signInAvailable: boolean }) => {
    setState(r.state);
    setDevices(r.devices);
    setPairing(r.state.pairing ?? null);
    setAudit(r.audit ?? []);
    setRelay(r.relayUrl);
    setRegistered(r.registered === true);
    setSignInAvailable(r.signInAvailable === true);
  };

  /** Connect, then put a pairing QR code on screen straight away when no browser is paired yet:
   *  pairing a phone is the reason to connect in the first place. */
  const connect = () =>
    act(async () => {
      await invoke('remote:enable', { enrollToken: enroll.trim() || undefined });
      setEnroll('');
      const after = await invoke('remote:get', undefined);
      if (!after.registered || !after.devices.some((d) => d.kind === 'web')) await invoke('remote:pairStart', { hostName: undefined });
    });

  useEffect(() => {
    const refresh = () => {
      void invoke('remote:get', undefined)
        .then((r) => applyResult(r))
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
      void invoke('remote:get', undefined).then((r) => applyResult(r));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000)) : 0;
  // The browser claims the code against the origin it opened, so the link must be this relay's.
  const pairingLink = pairing && secondsLeft > 0 ? pairingLinkFor(relay, pairing.code) : null;
  const webHost = new URL(remoteOrigin(relay)).host;
  // Where the web client lives; its name in the text opens it in the default browser.
  const webApp = `${remoteOrigin(relay)}/app`;
  const openWebApp = () => void invoke('app:openExternal', { url: webApp });
  const copyPairingLink = async () => {
    if (!pairingLink) return;
    try {
      await navigator.clipboard.writeText(pairingLink);
      toast('Pairing link copied', 'success');
    } catch {
      setError('Could not copy the link. Select the link above and copy it manually.');
    }
  };
  const statusLine = state ? `${state.status}${state.detail ? ` — ${state.detail}` : ''}` : 'unknown';
  // Live from the host once it runs (a sign-in that just finished shows at once), stored otherwise.
  const registered = storedRegistered || state?.registered === true;
  // An unregistered computer on a relay with Vocs sign-in: that is the way in, not the secret.
  const offerSignIn = !registered && signInAvailable;
  const signingIn = state?.signIn;

  return (
    <div className="settings-remote">
      <p className="muted small">
        Let a paired browser at{' '}
        <button type="button" className="link-btn" data-testid="remote-relay" title={`Open ${webApp}`} onClick={openWebApp}>
          {webHost}
        </button>{' '}
        drive sessions on this computer.
        Sessions, keys and terminals stay on this machine; the traffic is end-to-end encrypted and the relay sees
        metadata only.
      </p>
      {!config.enabled && (offerSignIn ? (
        <ol className="muted small" data-testid="remote-steps">
          <li>Connect with Vocs: your browser opens; sign in and click Add this computer.</li>
          <li>That browser then asks to pair; click Allow here.</li>
          <li>On your phone, open {webHost}/app, sign in the same way and tap this computer.</li>
        </ol>
      ) : (
        <ol className="muted small" data-testid="remote-steps">
          <li>Connect this computer{registered ? '' : ' (the first time, with the enrollment secret)'}.</li>
          <li>Scan the QR code that appears with your phone, or open {webHost}/app and enter the code.</li>
          <li>Press Pair in the browser, then Allow here.</li>
        </ol>
      ))}
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
      {!registered && !offerSignIn && !signingIn && (
        <Field label="Enrollment secret" hint="Legacy/manual enrollment for the original v1 account only. New accounts must use Connect with Vocs so their computers stay in their own account. Stored in the OS keychain.">
          <input data-testid="remote-enroll" type="password" value={enroll} placeholder="Paste the secret" onChange={(e) => setEnroll(e.target.value)} />
        </Field>
      )}
      <div className="settings-actions">
        {offerSignIn && !signingIn ? (
          <>
            <Button size="sm" variant="primary" data-testid="remote-sign-in" disabled={busy} onClick={() => void act(() => invoke('remote:signIn', undefined))}>
              {busy ? 'Opening your browser…' : 'Connect with Vocs'}
            </Button>
          </>
        ) : !signingIn ? (
          <Button
            size="sm"
            variant="primary"
            data-testid="remote-connect"
            disabled={busy || (!registered && !enroll.trim())}
            onClick={() => void connect()}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        ) : null}
        {(config.enabled || signingIn) && (
          <Button size="sm" variant="ghost" disabled={busy} data-testid="remote-disconnect" onClick={() => void act(() => invoke('remote:disable', undefined))}>
            {signingIn ? 'Cancel' : 'Disconnect'}
          </Button>
        )}
      </div>
      <p className="muted small" data-testid="remote-status">
        Status: <strong>{statusLine}</strong>
        {state?.onlineClients?.length ? ` · ${state.onlineClients.length} browser${state.onlineClients.length === 1 ? '' : 's'} connected` : ''}
      </p>
      {error && <p className="small" style={{ color: 'var(--red, #d00)' }}>{error}</p>}

      {config.enabled && (
        <Field label="View-only mode" hint="Paired browsers can browse sessions, transcripts, files and git, and watch terminals, but cannot send prompts, approve actions, type into terminals or change anything. Refused attempts still appear below.">
          <Toggle
            checked={config.viewOnly === true}
            disabled={busy}
            onChange={(v) => void act(() => invoke('remote:setViewOnly', { viewOnly: v }))}
            label="Only allow reading from paired browsers"
          />
        </Field>
      )}

      {config.enabled && (
        <Field label="Offline mirror" hint="Upload sealed transcript snapshots so a paired browser can read history while this computer is offline. The relay stores ciphertext only and can never open it.">
          <Toggle
            checked={config.mirror === true}
            disabled={busy}
            onChange={(v) => void act(() => invoke('remote:setMirror', { mirror: v }))}
            label="Let paired browsers read history while this computer is off"
          />
        </Field>
      )}

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

      {config.enabled && (state?.status === 'online' || state?.status === 'connecting') && (
        <>
          <h3>Pair a browser</h3>
          {pairing && pairingLink ? (
            <div>
              <p className="muted small">
                Scan the QR code with your phone, or enter this code at{' '}
                <button type="button" className="link-btn" data-testid="remote-web-app" title={`Open ${webApp}`} onClick={openWebApp}>
                  {webHost}/app
                </button>{' '}
                and press Pair; then Allow the request here (expires in {secondsLeft}s):
              </p>
              <p data-testid="remote-pair-code" style={{ fontSize: 28, letterSpacing: 6, fontWeight: 600 }}>{pairing.code}</p>
              <Field label="Pairing link" hint="Open in a browser to fill the code, then press Pair. Approve the request here to finish pairing.">
                <div className="row gap8">
                  <input data-testid="remote-pair-link" aria-label="Pairing link" readOnly value={pairingLink} onFocus={(e) => e.currentTarget.select()} />
                  <Button size="sm" variant="ghost" icon="copy" onClick={() => void copyPairingLink()}>
                    Copy link
                  </Button>
                </div>
              </Field>
              <Field label="Scan to pair" hint="Point a phone camera at the code to open the pairing link. The request still needs your approval here.">
                <PairingQr link={pairingLink} />
              </Field>
            </div>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void act(() => invoke('remote:pairStart', { hostName: undefined }))}>
              Show pairing code
            </Button>
          )}
        </>
      )}

      {state?.pendingRequest && (
        <div>
          <h3>Pairing request</h3>
          <p className="muted small">
            “{state.pendingRequest.name}” ({state.pendingRequest.platform}) wants to pair with this computer.
          </p>
          <div className="settings-actions">
            <Button size="sm" variant="primary" onClick={() => void act(() => invoke('remote:pairRespond', { decision: 'approve' }))}>
              Allow
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void act(() => invoke('remote:pairRespond', { decision: 'deny' }))}>
              Deny
            </Button>
          </div>
        </div>
      )}

      {devices.length > 0 && (
        <>
          <h3>Paired devices</h3>
          {devices.map((d) => (
            <Field
              key={d.deviceId}
              label={`${d.kind === 'host' ? 'Computer' : 'Browser'}: ${d.name}`}
              hint={`${d.platform} · last seen ${new Date(d.lastSeen).toLocaleString()}${state?.onlineClients.includes(d.deviceId) ? ' · connected now' : ''}`}
            >
              <Button size="sm" variant="ghost" onClick={() => void act(() => invoke('remote:revoke', { deviceId: d.deviceId }))}>
                Revoke
              </Button>
            </Field>
          ))}
          {devices.length > 1 && (
            <Field label="Revoke every device" hint="The kill switch: signs out every paired browser and every other computer at once, cancels pending pairing codes and re-keys the offline mirror. This computer stays connected.">
              <Button
                size="sm"
                variant="danger"
                data-testid="remote-revoke-all"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    const confirmed = await askConfirm({
                      title: 'Revoke every paired device?',
                      body: 'Every browser and every other computer paired with this account loses access immediately. Pairing any of them again needs a new code and your approval here.',
                      confirmLabel: 'Revoke all',
                      danger: true
                    });
                    if (confirmed) await act(() => invoke('remote:revokeAll', undefined));
                  })()
                }
              >
                Revoke all
              </Button>
            </Field>
          )}
        </>
      )}

      {audit.length > 0 && (
        <>
          <h3>Recent activity</h3>
          <p className="muted small">Pairing, connection, revocation and refused actions for remote access.</p>
          <div className="remote-audit" data-testid="remote-audit">
            {audit.map((entry, i) => (
              <p key={`${entry.at}-${i}`} className="muted small mono">
                {new Date(entry.at).toLocaleString()} · {entry.action}
                {entry.detail ? ` · ${entry.detail}` : ''}
                {entry.device ? ` · ${entry.device}` : ''}
              </p>
            ))}
          </div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => invoke('remote:clearAudit', undefined))}>
            Clear activity
          </Button>
        </>
      )}
    </div>
  );
}
