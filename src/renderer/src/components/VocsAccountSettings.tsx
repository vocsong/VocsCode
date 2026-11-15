import React, { useEffect, useRef, useState } from 'react';
import type { VocsAccountState } from '../../../shared/vocs-account';
import { invoke, isWeb } from '../api';
import { Button } from './ui';
import { SettingsGroup, SettingsNote } from './SettingsPrimitives';

const statusUnavailable = 'Account status is unavailable. Retry to check this desktop connection.';
const actionUnconfirmed = 'The account action could not be confirmed. Retry the status check.';
const leftNotice = 'Sign-in was cancelled because you left this page. Start it again when you are ready.';
/** Survives the unmount that cancelled a pending sign-in, so the next visit can say why it stopped. */
let leftDuringSignIn = false;
const signedOut: VocsAccountState = { realm: 'production', status: 'signed_out', refreshing: false, revision: -1, connections: [] };
/** Descriptive account state only. Tokens and catalog authorization stay in main. */
export function VocsAccountSettings() {
  const [state, setState] = useState<VocsAccountState | null>(null);
  const [busy, setBusy] = useState<'signIn' | 'cancel' | 'signOut' | 'refresh' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const epoch = useRef(0);
  const pending = useRef<typeof busy>(null);
  const revision = useRef(-1);
  const apply = (next: VocsAccountState) => {
    if (!mounted.current || next.revision < revision.current) return;
    revision.current = next.revision;
    setState(next);
  };
  useEffect(() => {
    mounted.current = true;
    if (leftDuringSignIn) { leftDuringSignIn = false; setNotice(leftNotice); }
    if (isWeb) return () => { mounted.current = false; };
    let reading = false;
    const read = async () => {
      if (reading || pending.current) return;
      reading = true;
      const generation = epoch.current;
      try {
        const next = await invoke('vocsAccount:get', undefined);
        if (mounted.current && generation === epoch.current) { apply(next); setError((current) => current === statusUnavailable ? '' : current); }
      } catch {
        if (mounted.current && generation === epoch.current) setError(statusUnavailable);
      } finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      mounted.current = false; epoch.current++; clearInterval(timer);
      if (pending.current === 'signIn') { leftDuringSignIn = true; void invoke('vocsAccount:cancel', undefined).catch(() => undefined); }
    };
  }, []);
  async function action(kind: NonNullable<typeof busy>) {
    // Synchronous guard also covers repeated clicks before React commits a render.
    if (pending.current === kind || (pending.current && kind !== 'cancel' && kind !== 'signOut')) return;
    const generation = ++epoch.current;
    pending.current = kind; setBusy(kind); setError(''); setNotice('');
    if (kind === 'cancel' || kind === 'signOut') setState({ ...signedOut, revision: revision.current });
    if (kind === 'signIn') setState({ ...signedOut, status: 'signing_in', revision: revision.current });
    try {
      const next = await invoke(`vocsAccount:${kind}`, undefined);
      if (mounted.current && epoch.current === generation) apply(next);
    } catch {
      if (mounted.current && epoch.current === generation) {
        setError(kind === 'signIn' ? 'Sign-in did not complete. Try again when you are ready.' : actionUnconfirmed);
        if (kind === 'signIn') setState({ ...signedOut, revision: revision.current });
      }
    } finally {
      if (mounted.current && epoch.current === generation) { pending.current = null; setBusy(null); }
    }
  }
  async function retry() {
    if (pending.current) return;
    const generation = ++epoch.current;
    pending.current = 'refresh'; setBusy('refresh'); setError('');
    try { const next = await invoke('vocsAccount:get', undefined); if (mounted.current && generation === epoch.current) apply(next); }
    catch { if (mounted.current && generation === epoch.current) setError(statusUnavailable); }
    finally { if (mounted.current && generation === epoch.current) { pending.current = null; setBusy(null); } }
  }
  const signingIn = state?.status === 'signing_in';
  const connected = state?.status === 'signed_in';
  const staging = state?.realm === 'staging';
  const signInLabel = staging ? 'Sign in to staging' : 'Sign in with Vocs';
  return <section className="settings-section vocs-account-settings" data-testid="vocs-account-settings">
    <SettingsGroup id="vocs-account-login" title="Vocs account" icon="shield" description="One identity for Vocs cloud features. Local projects and existing tools remain available while signed out.">
      {staging && <div className="vocs-account-heading"><span className="vocs-account-badge">Staging only</span><span className="muted">Read-only integration test</span></div>}
      <SettingsNote>{staging
        ? 'This connects only to the isolated Vocs staging environment, not your production account. Sign-in opens your system browser. No provider key or paid request is used.'
        : 'Sign-in opens your system browser at auth.vocs.io. This page only reads which Vocs Hub connections your account may use; no provider key or paid request is used.'}</SettingsNote>
      {isWeb ? <p role="status">Open Vocs Code on this computer to manage account sign-in. Remote browser access cannot authorize this desktop.</p> : <>
        <p role="status" aria-live="polite" className="vocs-account-status">{signingIn ? 'Waiting for browser sign-in…' : connected ? (staging ? 'Connected to Vocs staging' : 'Connected to Vocs') : state ? 'Signed out' : 'Checking account status…'}</p>
        {/* Retry re-reads status, so it is offered only when reading or confirming status failed;
            after a refused or expired sign-in the retry is the sign-in button. */}
        {(error || state?.error) && <div className="vocs-account-error" role="alert"><p>{error || state?.error}</p>{(error === statusUnavailable || error === actionUnconfirmed) && <Button disabled={!!busy} onClick={() => void retry()}>Retry status</Button>}</div>}
        {notice && <p className="muted vocs-account-notice">{notice}</p>}
        {connected && <dl className="vocs-account-details"><div><dt>Account</dt><dd data-testid="vocs-account-id">{state.accountId}</dd></div><div><dt>Session</dt><dd>{state.expiresAt ? `Expires at ${new Date(state.expiresAt).toLocaleTimeString()}` : 'Temporary session'}</dd></div></dl>}
        <div className="vocs-account-actions">
          {/* The sign-in button stays mounted, disabled, while waiting, and Cancel sits beside it:
              the second click of a double-click must land on it, never on Cancel. */}
          {connected ? <>
            <Button disabled={!!busy || state.refreshing} onClick={() => void action('refresh')}>{busy === 'refresh' || state.refreshing ? 'Refreshing…' : 'Refresh connections'}</Button>
            <Button disabled={busy === 'signOut'} onClick={() => void action('signOut')}>Sign out</Button>
          </> : <>
            <Button key="start-sign-in" variant="primary" disabled={!state || !!busy || signingIn} onClick={() => void action('signIn')}>{signInLabel}</Button>
            {signingIn && <Button key="cancel-sign-in" onClick={() => void action('cancel')} disabled={busy === 'cancel'}>Cancel sign-in</Button>}
          </>}
        </div>
        <p className="muted">This session lasts up to five minutes and is kept only in memory. Restarting or signing out clears it. Persistent sign-in is not enabled.</p>
      </>}
    </SettingsGroup>
    <SettingsGroup id="vocs-account-catalog" title="Hub connections" icon="globe" description="A catalog is not an execution grant. Connections are not added to any harness or workspace automatically.">
      {!connected ? <p className="muted">{staging ? 'Sign in to view this account’s available staging connections.' : 'Sign in to view the Hub connections your Vocs account may use.'}</p> : state.connections.length === 0 ? <p className="muted">No connections are currently permitted for this account. Signing in does not create access.</p> : <ul className="vocs-account-connections">{state.connections.map((connection) => <li key={connection.id}>
        <div className="vocs-account-connection-title"><strong>{connection.name}</strong><span className="vocs-account-badge">{connection.authorization === 'oauth_required' ? 'Separate authorization required' : 'Authorization unavailable'}</span></div>
        <p className="vocs-account-resource">{connection.resource}</p>
        <p className="muted">Account scope: {connection.accountScopes.join(', ') || 'None'}</p>
        <p className="muted">Execution readiness has not been checked. This page cannot run tools.</p>
      </li>)}</ul>}
    </SettingsGroup>
  </section>;
}
