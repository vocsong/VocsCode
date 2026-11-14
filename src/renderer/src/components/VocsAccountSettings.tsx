import React, { useEffect, useRef, useState } from 'react';
import type { VocsAccountState } from '../../../shared/vocs-account';
import { invoke, isWeb } from '../api';
import { Button } from './ui';
import { SettingsGroup, SettingsNote } from './SettingsPrimitives';

const statusUnavailable = 'Account status is unavailable. Retry to check this desktop connection.';
const signedOut: VocsAccountState = { realm: 'staging', status: 'signed_out', refreshing: false, revision: -1, connections: [] };
/** Descriptive account state only. Tokens and catalog authorization stay in main. */
export function VocsAccountSettings() {
  const [state, setState] = useState<VocsAccountState | null>(null);
  const [busy, setBusy] = useState<'signIn' | 'cancel' | 'signOut' | 'refresh' | null>(null);
  const [error, setError] = useState('');
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
      if (pending.current === 'signIn') void invoke('vocsAccount:cancel', undefined).catch(() => undefined);
    };
  }, []);
  async function action(kind: NonNullable<typeof busy>) {
    // Synchronous guard also covers repeated clicks before React commits a render.
    if (pending.current === kind || (pending.current && kind !== 'cancel' && kind !== 'signOut')) return;
    const generation = ++epoch.current;
    pending.current = kind; setBusy(kind); setError('');
    if (kind === 'cancel' || kind === 'signOut') setState({ ...signedOut, revision: revision.current });
    if (kind === 'signIn') setState({ ...signedOut, status: 'signing_in', revision: revision.current });
    try {
      const next = await invoke(`vocsAccount:${kind}`, undefined);
      if (mounted.current && epoch.current === generation) apply(next);
    } catch {
      if (mounted.current && epoch.current === generation) {
        setError(kind === 'signIn' ? 'Sign-in did not complete. Try again when you are ready.' : 'The account action could not be confirmed. Retry the status check.');
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
  return <section className="settings-section vocs-account-settings" data-testid="vocs-account-settings">
    <SettingsGroup id="vocs-account-login" title="Vocs account" icon="shield" description="One identity for Vocs cloud features. Local projects and existing tools remain available while signed out.">
      <div className="vocs-account-heading"><span className="vocs-account-badge">Staging only</span><span className="muted">Read-only integration test</span></div>
      <SettingsNote>This connects only to the isolated Vocs staging environment, not your production account. Sign-in opens your system browser. No provider key or paid request is used.</SettingsNote>
      {isWeb ? <p role="status">Open Vocs Code on this computer to manage account sign-in. Remote browser access cannot authorize this desktop.</p> : <>
        <p role="status" aria-live="polite" className="vocs-account-status">{signingIn ? 'Waiting for browser sign-in…' : connected ? 'Connected to Vocs staging' : state ? 'Signed out' : 'Checking account status…'}</p>
        {(error || state?.error) && <div className="vocs-account-error" role="alert"><p>{error || state?.error}</p><Button disabled={!!busy} onClick={() => void retry()}>Retry status</Button></div>}
        {connected && <dl className="vocs-account-details"><div><dt>Account</dt><dd data-testid="vocs-account-id">{state.accountId}</dd></div><div><dt>Session</dt><dd>{state.expiresAt ? `Expires at ${new Date(state.expiresAt).toLocaleTimeString()}` : 'Temporary session'}</dd></div></dl>}
        <div className="vocs-account-actions">
          {signingIn ? <Button key="cancel-sign-in" onClick={() => void action('cancel')} disabled={busy === 'cancel'}>Cancel sign-in</Button> : connected ? <>
            <Button disabled={!!busy || state.refreshing} onClick={() => void action('refresh')}>{busy === 'refresh' || state.refreshing ? 'Refreshing…' : 'Refresh connections'}</Button>
            <Button disabled={busy === 'signOut'} onClick={() => void action('signOut')}>Sign out</Button>
          </> : <Button key="start-sign-in" variant="primary" disabled={!state || !!busy} onClick={() => void action('signIn')}>Sign in to staging</Button>}
        </div>
        <p className="muted">This session lasts up to five minutes and is kept only in memory. Restarting or signing out clears it. Persistent sign-in is not enabled.</p>
      </>}
    </SettingsGroup>
    <SettingsGroup id="vocs-account-catalog" title="Hub connections" icon="globe" description="A catalog is not an execution grant. Connections are not added to any harness or workspace automatically.">
      {!connected ? <p className="muted">Sign in to view this account’s available staging connections.</p> : state.connections.length === 0 ? <p className="muted">No connections are currently permitted for this staging account. Signing in does not create access.</p> : <ul className="vocs-account-connections">{state.connections.map((connection) => <li key={connection.id}>
        <div className="vocs-account-connection-title"><strong>{connection.name}</strong><span className="vocs-account-badge">{connection.authorization === 'oauth_required' ? 'Separate authorization required' : 'Authorization unavailable'}</span></div>
        <p className="vocs-account-resource">{connection.resource}</p>
        <p className="muted">Account scope: {connection.accountScopes.join(', ') || 'None'}</p>
        <p className="muted">Execution readiness has not been checked. This page cannot run tools.</p>
      </li>)}</ul>}
    </SettingsGroup>
  </section>;
}
