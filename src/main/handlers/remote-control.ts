/**
 * Remote access host control IPC handlers (`remote:*`).
 */
import { PUSH_CHANNELS } from '../../shared/ipc';
import type { RemoteConfig } from '../../shared/types';
import { relayUrl, signInAvailable } from '../remote/relay-url';
import type { HandlerContext } from './types';

export function registerRemoteHandlers(ctx: HandlerContext): void {
  const { deps, handle } = ctx;
  const { settings, secrets } = deps;

  // Remote access (docs/REMOTE-ACCESS.md). The enrollment and device tokens live in the
  // secret store, never in settings; enable() stores them and opens the relay socket.
  if (!deps.remote) return;
  const remote = deps.remote;
  // Older builds stored a typed-in relay URL here; the relay is fixed now, so drop it.
  const remoteConfig = (): RemoteConfig => {
    const { relayUrl: _legacy, ...config } = (settings.get().remote ?? { enabled: false }) as RemoteConfig & { relayUrl?: unknown };
    return config;
  };
  handle('remote:get', async () => ({
    config: remoteConfig(),
    state: remote.state(),
    devices: settings.get().remote?.enabled ? await remote.listDevices() : [],
    audit: remote.auditEntries(),
    relayUrl: relayUrl(),
    registered: await remote.isRegistered(),
    signInAvailable: signInAvailable(relayUrl())
  }));
  handle('remote:signIn', async () => {
    const relay = relayUrl();
    await settings.update({ remote: { ...remoteConfig(), enabled: true } });
    // The page opens in the default browser; openExternal only ever opens http(s) URLs.
    await remote.signIn(relay, (url) => deps.desktop.openExternal(url));
    deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
    return remote.state();
  });
  handle('remote:enable', async ({ enrollToken }) => {
    const relay = relayUrl();
    // The secret registers this computer once; after that it connects with its own credential,
    // so an empty field reuses whatever secret is stored (possibly none).
    const secret = typeof enrollToken === 'string' ? enrollToken.trim() : '';
    if (secret) await secrets.set('remote-enroll', secret);
    // Keep the view-only policy across a reconnect; enable() only replaces relay fields.
    await settings.update({ remote: { ...remoteConfig(), enabled: true } });
    await remote.enable(relay, secret || ((await secrets.get('remote-enroll')) ?? ''));
    // The renderer's copy of settings drives the toggle/Disconnect UI, so push it like settings:update.
    deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
    return remote.state();
  });
  handle('remote:disable', async () => {
    await settings.update({ remote: { ...remoteConfig(), enabled: false } });
    await remote.disable();
    deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
    return remote.state();
  });
  handle('remote:pairStart', ({ hostName }) => remote.startPairing(hostName || 'This computer'));
  handle('remote:pairRespond', async ({ decision }) => {
    await remote.respondPairing(decision);
    return undefined;
  });
  handle('remote:revoke', async ({ deviceId }) => {
    await remote.revokeDevice(deviceId);
    return undefined;
  });
  handle('remote:revokeAll', async () => {
    await remote.revokeAll();
    return remote.state();
  });
  handle('remote:setViewOnly', async ({ viewOnly }) => {
    await settings.update({ remote: { ...remoteConfig(), viewOnly: viewOnly === true } });
    deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
    // Live policy change: refresh the desktop state and tell paired browsers to hide write controls.
    void remote.broadcastPolicy();
    return remote.state();
  });
  handle('remote:setMirror', ({ mirror }) => {
    remote.auditMirror(mirror === true);
    void (async () => {
      await settings.update({ remote: { ...remoteConfig(), mirror: mirror === true } });
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      if (mirror === true) deps.remoteMirror?.sync();
      else await deps.remoteMirror?.disable();
    })();
    return remote.state();
  });
  handle('remote:clearAudit', () => {
    remote.clearAudit();
    return undefined;
  });
}
