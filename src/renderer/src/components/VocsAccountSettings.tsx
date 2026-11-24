import React, { useEffect, useRef, useState } from 'react';
import type { VocsAccountConnection, VocsAccountState, VocsHubConnectionId, VocsHubConnectionState } from '../../../shared/vocs-account';
import { invoke, isWeb } from '../api';
import { Button } from './ui';
import { SettingsGroup, SettingsNote } from './SettingsPrimitives';

const statusUnavailable = 'Account status is unavailable. Retry to check this desktop connection.';
const actionUnconfirmed = 'The account action could not be confirmed. Retry the status check.';
const leftNotice = 'Sign-in was cancelled because you left this page. Start it again when you are ready.';
const noKeychain = 'This computer has no secure keychain, so you’ll be signed out when Vocs Code closes.';
const temporaryNote = 'This sign-in lasts up to five minutes and is kept only in memory. Restarting or signing out clears it.';
/** Survives the unmount that cancelled a pending sign-in, so the next visit can say why it stopped. */
let leftDuringSignIn = false;
const signedOut: VocsAccountState = { realm: 'production', status: 'signed_out', refreshing: false, revision: -1, connections: [] };
/** Names for Hub connections shown while signed out (no catalog then). */
const HUB_NAMES: Record<string, string> = { openrouter: 'OpenRouter' };
type HubKind = 'connect' | 'cancel' | 'disconnect';
const HUB_CHANNELS = { connect: 'vocsAccount:hubConnect', cancel: 'vocsAccount:hubCancel', disconnect: 'vocsAccount:hubDisconnect' } as const;

/** One Hub connection's status line and controls. Main owns the grant; this only asks. */
function HubConnection(props: { hub?: VocsHubConnectionState; connection?: VocsAccountConnection; signedIn: boolean; busy: HubKind | null; disabled: boolean; onAction: (kind: HubKind) => void }) {
  const { hub, connection, signedIn, busy } = props;
  const connecting = hub?.status === 'connecting' || busy === 'connect';
  const linked = hub?.status === 'connected' && busy !== 'disconnect';
  const connectable = signedIn && connection?.authorization === 'oauth_required' && !!connection.authorizationServer;
  const name = connection?.name ?? HUB_NAMES[hub?.id ?? ''] ?? hub?.id ?? '';
  const serverId = hub?.serverId ?? `vocs-${connection?.id ?? ''}`;
  const status = linked ? `Connected · ${(hub.scopes ?? []).join(', ')}`
    : connecting ? 'Waiting for approval in your browser…'
    : busy === 'disconnect' ? 'Disconnecting…'
    : connectable || !connection ? 'Not connected' : '';
  return <div className="vocs-hub-connection" data-testid={`vocs-hub-${hub?.id ?? connection?.id}`}>
    {status && <p role="status" className="vocs-hub-status">{status}</p>}
    {hub?.error && !connecting && !linked && <p className="vocs-account-error" role="alert">{hub.error}</p>}
    {linked && <p className="muted">New agent sessions on this computer get its tools as <code>{serverId}</code>. The Hub token stays in Vocs Code.</p>}
    {linked && hub.saved === false && <p className="vocs-account-notice" role="alert">This computer could not save the connection, so it ends when Vocs Code closes.</p>}
    {linked && hub.scopes?.includes('speech:write') && <p className="muted">Speech requests wait for your approval on mcp.vocs.io before they run.</p>}
    {!linked && !connecting && !signedIn && hub?.error && <p className="muted">Sign in to connect {name} again.</p>}
    <div className="vocs-account-actions">
      {linked || busy === 'disconnect' ? <Button disabled={props.disabled || busy === 'disconnect'} onClick={() => props.onAction('disconnect')}>{busy === 'disconnect' ? 'Disconnecting…' : `Disconnect ${name}`}</Button>
        : connectable ? <>
          {/* Connect stays mounted, disabled, with Cancel beside it: a double-click never cancels. */}
          <Button key="hub-connect" variant="primary" disabled={props.disabled || connecting} onClick={() => props.onAction('connect')}>{`Connect ${name}`}</Button>
          {connecting && <Button key="hub-cancel" disabled={busy === 'cancel'} onClick={() => props.onAction('cancel')}>Cancel</Button>}
        </> : null}
    </div>
  </div>;
}

/** Descriptive account state only. Tokens and catalog authorization stay in main. */
export function VocsAccountSettings() {
  const [state, setState] = useState<VocsAccountState | null>(null);
  const [busy, setBusy] = useState<'signIn' | 'cancel' | 'signOut' | 'refresh' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // "Keep me signed in on this computer" is on by default (owner decision).
  const [keep, setKeep] = useState(true);
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
      const next = kind === 'signIn' ? await invoke('vocsAccount:signIn', { persist }) : await invoke(`vocsAccount:${kind}`, undefined);
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
  /** Hub actions run beside account polling (Connect waits on the browser), one per connection. */
  const [hubBusy, setHubBusy] = useState<{ id: VocsHubConnectionId; kind: HubKind } | null>(null);
  const hubPending = useRef<{ id: VocsHubConnectionId; kind: HubKind } | null>(null);
  async function hubAction(id: VocsHubConnectionId, kind: HubKind) {
    const current = hubPending.current;
    // Only Cancel may join a pending Connect; repeated clicks never start a second flow.
    if (current && !(current.id === id && current.kind === 'connect' && kind === 'cancel')) return;
    const entry = { id, kind };
    hubPending.current = entry; setHubBusy(entry); setError('');
    try {
      const next = await invoke(HUB_CHANNELS[kind], { connectionId: id });
      if (mounted.current) apply(next);
    } catch {
      if (mounted.current) setError(actionUnconfirmed);
    } finally {
      if (mounted.current && hubPending.current === entry) { hubPending.current = null; setHubBusy(null); }
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
  const staging = state?.realm === 'staging';
  /** The realm offers kept sign-ins (without a keychain they last until Vocs Code closes). */
  const offersKeep = state?.deviceSignIn === true;
  const persist = keep && offersKeep;
  const signingIn = state?.status === 'signing_in';
  const connected = state?.status === 'signed_in';
  const restoring = state?.status === 'restoring';
  const offline = state?.status === 'offline';
  /** A kept sign-in that is not usable right now: it can be retried or signed out, not signed in over. */
  const kept = restoring || offline;
  const statusText = signingIn ? 'Waiting for browser sign-in…'
    : restoring ? 'Restoring your sign-in…'
    : offline ? 'Can’t reach Vocs. Your sign-in is still kept on this computer.'
    : connected ? (staging ? 'Connected to Vocs staging' : 'Connected to Vocs')
    : state ? 'Signed out' : 'Checking account status…';
  const session = !connected ? '' : state.persistent
    ? (state.keychain === false ? 'Signed in until Vocs Code closes' : state.deviceExpiresAt ? `Stays signed in on this computer until ${new Date(state.deviceExpiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}` : 'Stays signed in on this computer')
    : state.expiresAt ? `Expires at ${new Date(state.expiresAt).toLocaleTimeString()}` : 'Temporary session';
  const signInLabel = staging ? 'Sign in to staging' : 'Sign in with Vocs';
  /** Signed out, there is no catalog; a connection this computer still holds (or just lost) shows on its own. */
  const hubShown = (state?.hub ?? []).filter((hub) => hub.status !== 'disconnected' || !!hub.error || hubBusy?.id === hub.id);
  return <section className="settings-section vocs-account-settings" data-testid="vocs-account-settings">
    <SettingsGroup id="vocs-account-login" title="Vocs account" icon="shield" description="One identity for Vocs cloud features. Local projects and existing tools remain available while signed out.">
      {staging && <div className="vocs-account-heading"><span className="vocs-account-badge">Staging only</span><span className="muted">Integration test</span></div>}
      <SettingsNote>{staging
        ? 'This connects only to the isolated Vocs staging environment, not your production account. Sign-in opens your system browser. Signing in uses no provider key or paid request; connecting one below is a separate approval on the staging Hub.'
        : 'Sign-in opens your system browser at auth.vocs.io and reads which Vocs Hub connections your account may use. Signing in uses no provider key or paid request; connecting one below is a separate approval on mcp.vocs.io.'}</SettingsNote>
      {isWeb ? <p role="status">Open Vocs Code on this computer to manage account sign-in. Remote browser access cannot authorize this desktop.</p> : <>
        <p role="status" aria-live="polite" className="vocs-account-status">{statusText}</p>
        {/* Retry re-reads status, so it is offered only when reading or confirming status failed;
            after a refused or expired sign-in the retry is the sign-in button. */}
        {(error || state?.error) && <div className="vocs-account-error" role="alert"><p>{error || state?.error}</p>{(error === statusUnavailable || error === actionUnconfirmed) && <Button disabled={!!busy} onClick={() => void retry()}>Retry status</Button>}</div>}
        {notice && <p className="muted vocs-account-notice">{notice}</p>}
        {state?.notice && <p className="vocs-account-notice" role="alert">{state.notice}</p>}
        {connected && <dl className="vocs-account-details"><div><dt>Account</dt><dd data-testid="vocs-account-id">{state.accountId ?? 'Loading…'}</dd></div><div><dt>Session</dt><dd data-testid="vocs-account-session">{session}</dd></div></dl>}
        <div className="vocs-account-actions">
          {/* The sign-in button stays mounted, disabled, while waiting, and Cancel sits beside it:
              the second click of a double-click must land on it, never on Cancel. */}
          {connected ? <>
            <Button disabled={!!busy || state.refreshing} onClick={() => void action('refresh')}>{busy === 'refresh' || state.refreshing ? 'Refreshing…' : 'Refresh connections'}</Button>
            <Button disabled={busy === 'signOut'} onClick={() => void action('signOut')}>Sign out</Button>
          </> : kept ? <>
            {/* Retry renews the kept sign-in (main treats refresh from offline as a retry). */}
            {offline && <Button variant="primary" disabled={!!busy} onClick={() => void action('refresh')}>{busy === 'refresh' ? 'Retrying…' : 'Retry'}</Button>}
            <Button disabled={busy === 'signOut'} onClick={() => void action('signOut')}>Sign out</Button>
          </> : <>
            <Button key="start-sign-in" variant="primary" disabled={!state || !!busy || signingIn} onClick={() => void action('signIn')}>{signInLabel}</Button>
            {signingIn && <Button key="cancel-sign-in" onClick={() => void action('cancel')} disabled={busy === 'cancel'}>Cancel sign-in</Button>}
          </>}
        </div>
        {!connected && !kept && (offersKeep ? <div className="vocs-account-keep">
          <label><input type="checkbox" checked={persist} disabled={!state || !!busy || signingIn} onChange={(event) => setKeep(event.target.checked)} /> Keep me signed in on this computer</label>
          <p className="muted">{!keep ? temporaryNote
            : state?.keychain === false ? noKeychain
            : 'Stays signed in for up to a year (90 days unused) in this computer’s keychain. Sign out here, or revoke it under Account & security on Vocs Login.'}</p>
        </div> : state && <p className="muted">{temporaryNote}</p>)}
        {connected && !state.persistent && <p className="muted">This session lasts up to five minutes and is kept only in memory. Restarting or signing out clears it.</p>}
        {connected && state.persistent && state.keychain === false && <p className="muted">{noKeychain}</p>}
      </>}
    </SettingsGroup>
    <SettingsGroup id="vocs-account-catalog" title="Hub connections" icon="globe" description="Signing in grants no tools. Connecting a connection is a separate approval on the Hub; while connected, new agent sessions on this computer get its tools through a local proxy, and the Hub token never leaves Vocs Code.">
      {!connected ? <>
        {hubShown.length > 0 && <ul className="vocs-account-connections">{hubShown.map((hub) => <li key={hub.id}>
          <div className="vocs-account-connection-title"><strong>{HUB_NAMES[hub.id] ?? hub.id}</strong><span className="vocs-account-badge">{hub.status === 'connected' ? 'Connected' : hub.status === 'connecting' ? 'Connecting…' : 'Not connected'}</span></div>
          <HubConnection hub={hub} signedIn={false} busy={hubBusy?.id === hub.id ? hubBusy.kind : null} disabled={!!hubBusy && hubBusy.id !== hub.id} onAction={(kind) => void hubAction(hub.id, kind)} />
        </li>)}</ul>}
        <p className="muted">{staging ? 'Sign in to view this account’s available staging connections.' : 'Sign in to view the Hub connections your Vocs account may use.'}</p>
      </> : state.connections.length === 0 ? <p className="muted">No connections are currently permitted for this account. Signing in does not create access.</p> : <ul className="vocs-account-connections">{state.connections.map((connection) => {
        const hub = state.hub?.find((entry) => entry.id === connection.id);
        const id = connection.id as VocsHubConnectionId;
        return <li key={connection.id}>
          <div className="vocs-account-connection-title"><strong>{connection.name}</strong><span className="vocs-account-badge">{hub?.status === 'connected' ? 'Connected' : hub?.status === 'connecting' ? 'Connecting…' : connection.authorization === 'oauth_required' ? 'Separate authorization required' : 'Authorization unavailable'}</span></div>
          <p className="vocs-account-resource">{connection.resource}</p>
          <p className="muted">Account scope: {connection.accountScopes.join(', ') || 'None'}</p>
          <HubConnection hub={hub} connection={connection} signedIn busy={hubBusy?.id === connection.id ? hubBusy.kind : null} disabled={!!busy || state.refreshing || (!!hubBusy && hubBusy.id !== connection.id)} onAction={(kind) => void hubAction(id, kind)} />
        </li>;
      })}</ul>}
    </SettingsGroup>
  </section>;
}
