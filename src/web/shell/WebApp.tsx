/** The web shell root (docs/REMOTE-ACCESS.md §4): pairing screens while unpaired, then the top bar,
 *  sessions home or one session, sheets, and the store's boot/resync/reset lifecycle as the
 *  connection and the active computer change. */
import { useEffect, useRef, useState } from 'react';
import { TranscriptCapabilitiesProvider } from '@renderer/capabilities';
import { Button, ConfirmHost, Icon, Spinner, Toggle } from '@renderer/components/ui';
import { useStore } from '@renderer/store';
import type { RelayClient } from '../../../relay/src/web-client';
import { navigate, readRoute, type Route } from '../router';
import { ComputersSheet } from '../sheets/ComputersSheet';
import { DevicesSheet } from '../sheets/DevicesSheet';
import { NewSessionSheet } from '../sheets/NewSessionSheet';
import { BottomSheet } from '../sheets/BottomSheet';
import { ConnectScreen } from '../screens/ConnectScreen';
import { PairScreen } from '../screens/PairScreen';
import { SessionList } from '../screens/SessionList';
import { SessionView } from '../screens/SessionView';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { useConnection } from './useConnection';
import { useFollow } from './useFollow';
import { useKeyboardInset } from './useViewport';
import type { AccountState } from './account';
import type { RelayTransport } from '../transport/relay-transport';

/** The desktop-only affordances a browser must not offer. */
const WEB_CAPABILITIES = { contextMenu: false, editAndResend: false, openFile: false } as const;

type Sheet = 'none' | 'computers' | 'devices' | 'menu' | 'new';

export function WebApp({ client, transport, account, initialCode, connectHash }: {
  client: RelayClient;
  transport: RelayTransport;
  /** Resolved before the client exists: the account id partitions the browser vault. */
  account: AccountState;
  initialCode?: string | null;
  connectHash?: string | null;
}) {
  const [route, setRoute] = useState<Route>(() => (connectHash ? { name: 'connect', nonceHash: connectHash } : readRoute()));
  const [sheet, setSheet] = useState<Sheet>('none');
  const [restoring, setRestoring] = useState(true);
  const [storageError, setStorageError] = useState('');
  /** Which computer the store's sessions/focus belong to; the default route waits for it. */
  const [dataHost, setDataHost] = useState<string | null>(null);
  const credentials = client.credentials();
  const paired = !!credentials;
  const hostDeviceId = credentials?.hostDeviceId ?? null;
  const [online, setOnline] = useState<Map<string, boolean>>(() => new Map());
  const [, forceRender] = useState(0);
  /** Every transport state change nudges this; batching 'connecting' and 'online' into one render
   *  must not hide a host switch from the boot effect. */
  const [connVersion, setConnVersion] = useState(0);
  const connection = useConnection(transport);
  const keyboard = useKeyboardInset();
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const focus = useStore((s) => s.desktopFocus);
  const viewOnly = useStore((s) => s.remoteAccess.viewOnly);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const appRef = useRef<HTMLDivElement>(null);
  const booted = useRef(false);
  const host = useRef<string | null>(null);
  const defaulted = useRef(false);
  const seenAwaiting = useRef<Set<string>>(new Set());
  const follow = useFollow(hostDeviceId, focus, (id) => navigate({ name: 'session', host: hostDeviceId ?? '', session: id }));

  useEffect(() => {
    transport.start();
  }, [transport]);

  useEffect(() => transport.onState(() => setConnVersion((v) => v + 1)), [transport]);

  // Load the vault before deciding which screen to show: a pairing must survive a reload, and a
  // browser that cannot keep its keys (no IndexedDB) must say so instead of pairing uselessly.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await client.restore();
        if (!alive) return;
        forceRender((n) => n + 1);
        if (client.hasCredentials()) void transport.connect(true);
      } catch {
        if (alive) setStorageError('This browser cannot store pairing keys securely (IndexedDB is unavailable, for example in some private windows). Use a regular window to pair.');
      } finally {
        if (alive) setRestoring(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, transport]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // A pairing was added, removed or made active: re-render, and reconnect only when the active
  // computer actually changed. (Connect() itself persists the desktop's mirror key, which fires
  // this listener mid-handshake — reconnecting there would abort the connection being built.)
  const activeHost = useRef<string | null>(client.credentials()?.hostDeviceId ?? null);
  useEffect(
    () =>
      client.onPairingsChanged(() => {
        forceRender((n) => n + 1);
        const next = client.credentials()?.hostDeviceId ?? null;
        if (next === activeHost.current) return;
        activeHost.current = next;
        void transport.connect(true);
      }),
    [client, transport]
  );

  useEffect(() => {
    transport.setViewOnly(viewOnly);
  }, [transport, viewOnly]);

  // Presence for the computer switcher; refreshed while the app is open.
  useEffect(() => {
    if (!client.hasCredentials()) return;
    let alive = true;
    const refresh = async () => {
      try {
        const devices = await client.listDevices();
        if (!alive) return;
        const map = new Map(devices.filter((d) => d.kind === 'host').map((d) => [d.deviceId, d.online === true]));
        for (const pairing of client.pairings()) if (!map.has(pairing.hostDeviceId)) map.set(pairing.hostDeviceId, false);
        setOnline(map);
      } catch {
        // Presence is decoration; the connection state already says whether writes work.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, route, connection]);

  // Boot on the first online moment, resync after every later reconnect, reset on a computer switch.
  useEffect(() => {
    if (connection === 'mirror') {
      // Offline browsing: seed the store with the sealed snapshot instead of booting, because
      // settings and terminals are not part of the mirror. Everything else is read-only.
      const snapshot = transport.mirrorState();
      if (!snapshot) return;
      host.current = null;
      booted.current = false;
      useStore.getState().reset();
      useStore.setState({ sessions: snapshot.sessions, desktopFocus: snapshot.focus, remoteAccess: { viewOnly: true } });
      setDataHost(client.credentials()?.hostDeviceId ?? null);
      return;
    }
    if (connection !== 'online') return;
    const current = client.credentials()?.hostDeviceId ?? null;
    if (host.current !== current) {
      host.current = current;
      booted.current = false;
      defaulted.current = false;
      setDataHost(null);
      useStore.getState().reset();
    }
    if (!booted.current) {
      booted.current = true;
      void useStore.getState().boot().then(() => setDataHost(current));
    } else {
      void useStore.getState().resync().then(() => setDataHost(current)).catch(() => undefined);
    }
  }, [connection, client, transport, connVersion]);

  // Default route: a deep link wins; otherwise open the session the desktop is on; otherwise home.
  // Only once, so Back to home is not immediately bounced into the focused session. While the focus
  // is still being read, do nothing — the effect runs again when it arrives.
  useEffect(() => {
    if (defaulted.current || route.name !== 'home' || dataHost !== hostDeviceId || sessions.length === 0) return;
    if (!focus) return;
    defaulted.current = true;
    const focused = focus.sessionId;
    if (focused && sessions.some((s) => s.id === focused)) {
      navigate({ name: 'session', host: hostDeviceId ?? '', session: focused }, true);
    }
  }, [route, focus, sessions, client, dataHost, hostDeviceId]);

  // A background session that starts waiting for a person: say so without stealing the view.
  useEffect(() => {
    const awaiting = new Set(sessions.filter((s) => s.status === 'awaiting').map((s) => s.id));
    for (const id of [...seenAwaiting.current]) if (!awaiting.has(id)) seenAwaiting.current.delete(id);
    for (const session of sessions) {
      if (session.status !== 'awaiting' || session.id === activeId || seenAwaiting.current.has(session.id)) continue;
      seenAwaiting.current.add(session.id);
      useStore.getState().toast(`${session.title} needs approval`, 'info');
    }
  }, [sessions, activeId]);

  // The iOS keyboard: keep the composer above it without a style attribute (CSP forbids those).
  useEffect(() => {
    appRef.current?.style.setProperty('--w-keyboard', `${keyboard}px`);
  }, [keyboard]);

  // A deep link names a host: after a switch or an unpair, a link to the old computer's session is
  // not this computer's session, so the shell goes home and lets the default route pick again.
  useEffect(() => {
    if (route.name !== 'session' || !hostDeviceId) return;
    if (route.host !== hostDeviceId) navigate({ name: 'home' }, true);
  }, [route, hostDeviceId]);

  if (restoring) {
    return (
      <div className="w-app" ref={appRef}>
        <div className="w-loading"><Spinner /></div>
      </div>
    );
  }

  // "Add a computer" works while already paired: the route wins over the app chrome.
  if (route.name === 'pair') {
    return (
      <div className="w-app" ref={appRef}>
        <PairScreen
          client={client}
          account={account}
          storageError={storageError}
          onPaired={() => {
            forceRender((n) => n + 1);
            navigate({ name: 'home' }, true);
          }}
        />
        <ConfirmHost />
        <Toasts toasts={toasts} dismiss={dismissToast} />
      </div>
    );
  }

  if (!paired) {
    const body =
      route.name === 'connect' ? (
        account.status === 'signed-in' ? (
          <ConnectScreen
            client={client}
            nonceHash={route.nonceHash}
            cancellable={false}
            onCancel={() => navigate({ name: 'pair' })}
            onPaired={() => {
              forceRender((n) => n + 1);
              navigate({ name: 'home' }, true);
            }}
          />
        ) : (
          <section className="w-screen" data-testid="connect-unavailable">
            <div className="w-card">
              <h1>Add this computer</h1>
              <p className="w-hint">This page was opened to add a computer, but signing in is not available here. Use a pairing code instead.</p>
              <Button variant="primary" onClick={() => navigate({ name: 'pair' })}>Use a pairing code</Button>
            </div>
          </section>
        )
      ) : (
        <PairScreen
          client={client}
          account={account}
          initialCode={initialCode ?? undefined}
          storageError={storageError}
          onPaired={() => {
            forceRender((n) => n + 1);
            navigate({ name: 'home' }, true);
          }}
        />
      );
    return (
      <div className="w-app" ref={appRef}>
        {body}
        <ConfirmHost />
        <Toasts toasts={toasts} dismiss={dismissToast} />
      </div>
    );
  }

  const hostId = credentials.hostDeviceId;
  return (
    <TranscriptCapabilitiesProvider value={WEB_CAPABILITIES}>
      <div className="w-app" ref={appRef} data-connection={connection}>
        <ConnectionBanner state={connection} viewOnly={viewOnly} onRetry={() => void transport.connect(true)} />
        <header className="w-topbar">
          <button type="button" className="w-computer" onClick={() => setSheet('computers')} data-testid="computers">
            <span className={`w-dot is-${connection}`} aria-hidden />
            <span className="w-computer-name">{credentials.hostName ?? 'Computer'}</span>
            {online.get(hostId) === false && <span className="w-computer-off">offline</span>}
          </button>
          <Button variant="ghost" size="sm" icon="more" aria-label="Menu" onClick={() => setSheet('menu')} />
        </header>

        <div className="w-main" data-has-session={route.name === 'session' ? '1' : undefined}>
          <SessionList
            focus={focus?.sessionId ?? null}
            onNew={() => setSheet('new')}
            onOpen={(id) => navigate({ name: 'session', host: hostId, session: id })}
          />
          {route.name === 'session' && <SessionView sessionId={route.session} connection={connection} onBack={() => navigate({ name: 'home' })} />}
        </div>

        {sheet === 'computers' && (
          <ComputersSheet
            client={client}
            online={online}
            onClose={() => setSheet('none')}
            onAdd={() => {
              setSheet('none');
              navigate({ name: 'pair' });
            }}
            onSwitched={() => forceRender((n) => n + 1)}
          />
        )}
        {sheet === 'devices' && <DevicesSheet client={client} onClose={() => setSheet('none')} onPairingEnded={() => forceRender((n) => n + 1)} />}
        {sheet === 'new' && (
          <NewSessionSheet
            onClose={() => setSheet('none')}
            defaultRoot={route.name === 'session' ? sessions.find((s) => s.id === route.session)?.config.projectRoot : undefined}
            onCreated={(id) => navigate({ name: 'session', host: hostId, session: id }, true)}
          />
        )}
        {sheet === 'menu' && (
          <BottomSheet title="Menu" onClose={() => setSheet('none')}>
            <div className="w-menu">
              <div className="w-field-row">
                <span>Follow my computer</span>
                <Toggle checked={follow.following} onChange={() => follow.toggle()} label="Follow my computer" />
              </div>
              <Button variant="ghost" icon="terminal" onClick={() => { setSheet('devices'); }}>Devices</Button>
              <Button variant="ghost" icon="plus" onClick={() => { setSheet('none'); navigate({ name: 'pair' }); }}>Add a computer</Button>
              <Button variant="ghost" icon="x" onClick={() => { setSheet('none'); void client.unpair(); }}>Unpair this browser</Button>
              {account.status === 'signed-in' && (
                <form method="post" action="/logout" className="account-signout">
                  <span className="account-name">@{account.account.login}</span>
                  <button type="submit" className="btn btn-ghost btn-sm">Sign out of GitHub</button>
                </form>
              )}
            </div>
          </BottomSheet>
        )}

        {follow.snackbar && (
          <div className="w-snackbar" role="status" data-testid="follow-snackbar">
            <span>Your computer moved to “{follow.snackbar.title}”</span>
            <Button size="sm" variant="primary" onClick={follow.followNow}>Follow</Button>
            <Button size="sm" variant="ghost" onClick={follow.dismiss}>Dismiss</Button>
          </div>
        )}
        <ConfirmHost />
        <Toasts toasts={toasts} dismiss={dismissToast} />
      </div>
    </TranscriptCapabilitiesProvider>
  );
}

function Toasts({ toasts, dismiss }: { toasts: Array<{ id: string; kind: string; text: string }>; dismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="w-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`w-toast w-toast-${toast.kind}`} onClick={() => dismiss(toast.id)}>
          <Icon name={toast.kind === 'error' ? 'alert' : toast.kind === 'success' ? 'check' : 'info'} size={14} />
          <span>{toast.text}</span>
        </button>
      ))}
    </div>
  );
}
