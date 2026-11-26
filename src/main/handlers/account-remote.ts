/** Vocs account, external/local control, relay connection, and analytics IPC handlers. */
import { z } from 'zod';
import { controlGrantInputSchema } from '../../shared/control';
import { PUSH_CHANNELS } from '../../shared/ipc';
import type { RemoteConfig } from '../../shared/types';
import { VOCS_HUB_CONNECTION_IDS, type VocsHubConnectionId } from '../../shared/vocs-account';
import { relayUrl, signInAvailable } from '../remote/relay-url';
import { createVocsAccount, vocsAccountRealm } from '../vocs-account';
import type { HandlerContext } from './context';

export function registerAccountRemoteHandlers(ctx: HandlerContext): void {
  const { deps, handle, onShutdown } = ctx;
  const { settings } = deps;

  const vocsAccount = deps.vocsAccount ?? createVocsAccount({ realm: vocsAccountRealm(), openExternal: (url) => deps.desktop.openExternal(url) });
  onShutdown(() => vocsAccount.dispose());

  for (const [channel, action] of [
    ['vocsAccount:get', () => vocsAccount.get()],
    ['vocsAccount:cancel', () => vocsAccount.cancel()],
    ['vocsAccount:signOut', () => vocsAccount.signOut()],
    ['vocsAccount:refresh', () => vocsAccount.refresh()]
  ] as const) {
    handle(channel, (input) => {
      if (input !== undefined) throw new Error('Account commands do not accept configuration.');
      return action();
    });
  }
  // The one choice the renderer makes: keep this sign-in or not. Main picks client, issuer and label.
  const signInRequest = z.strictObject({ persist: z.boolean() }).optional();
  handle('vocsAccount:signIn', (input) => {
    const parsed = signInRequest.safeParse(input);
    if (!parsed.success) throw new Error('Account commands do not accept configuration.');
    return vocsAccount.signIn(parsed.data);
  });
  // A Hub connection is named by its catalog id only; resource, issuer and scopes come from the
  // catalog main verified, never from the renderer.
  const hubRequest = z.strictObject({ connectionId: z.enum(VOCS_HUB_CONNECTION_IDS) });
  for (const [channel, action] of [
    ['vocsAccount:hubConnect', (id: VocsHubConnectionId) => vocsAccount.hubConnect(id)],
    ['vocsAccount:hubCancel', (id: VocsHubConnectionId) => vocsAccount.hubCancel(id)],
    ['vocsAccount:hubDisconnect', (id: VocsHubConnectionId) => vocsAccount.hubDisconnect(id)]
  ] as const) {
    handle(channel, (input) => {
      const parsed = hubRequest.safeParse(input);
      if (!parsed.success) throw new Error('Account commands do not accept configuration.');
      return action(parsed.data.connectionId);
    });
  }

  if (deps.control) {
    const control = deps.control;
    handle('control:get', () => control.ownerState());
    handle('control:enable', (input) => control.setEnabled(z.strictObject({ enabled: z.boolean() }).parse(input).enabled));
    handle('control:grant', (input) => control.grant(controlGrantInputSchema.parse(input)));
    handle('control:revoke', (input) => control.revoke(z.strictObject({ grantId: z.string().uuid() }).parse(input).grantId));
  }
  if (deps.localControl) {
    const local = deps.localControl;
    handle('control:local:get', () => local.ownerState());
    handle('control:local:enable', (input) => local.enable(input));
    handle('control:local:disable', () => local.disable());
  }

  // The relay connection (docs/CONTROL-MCP.md, docs/WEB-DASHBOARD.md). The device credential lives
  // in the secret store, never in settings; Connect with Vocs is the only way to register.
  if (deps.remote) {
    const remote = deps.remote;
    // Older builds kept a typed-in relay URL, view-only and offline-mirror flags here; only the
    // connection switch and analytics sharing remain.
    const remoteConfig = (): RemoteConfig => {
      const stored = settings.get().remote;
      return { enabled: stored?.enabled === true, ...(stored?.shareAnalytics !== undefined ? { shareAnalytics: stored.shareAnalytics } : {}) };
    };
    handle('remote:get', async () => ({
      config: remoteConfig(),
      state: remote.state(),
      devices: settings.get().remote?.enabled ? await remote.listDevices() : [],
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
    handle('remote:disable', async () => {
      await settings.update({ remote: { ...remoteConfig(), enabled: false } });
      await remote.disable();
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      return remote.state();
    });
    handle('remote:revoke', async ({ deviceId }) => {
      await remote.revokeDevice(deviceId);
      return undefined;
    });
    handle('remote:revokeAll', async () => {
      await remote.revokeAll();
      return remote.state();
    });
    handle('remote:setShareAnalytics', async ({ share }) => {
      await settings.update({ remote: { ...remoteConfig(), shareAnalytics: share === true } });
      deps.push(PUSH_CHANNELS.settingsChanged, settings.get());
      // Off deletes the relay copy now; a clear that cannot reach the relay is retried.
      void deps.analyticsSync?.sharingChanged();
      return remote.state();
    });
  }

  // `days: 0` is all time; only an absent request falls back to the 30-day default.
  handle('analytics:summary', (req) => deps.analytics.summary(req && typeof req === 'object' && typeof req.days === 'number' ? Math.max(0, req.days) : 30));
  handle('analytics:executions', (req) => {
    const q = req && typeof req === 'object' ? req : {};
    const ids = Array.isArray(q.ids) ? q.ids.filter((x): x is string => typeof x === 'string').slice(0, 200) : undefined;
    return deps.analytics.queryExecutions({
      ids,
      signature: typeof q.signature === 'string' ? q.signature : undefined,
      sessionId: typeof q.sessionId === 'string' ? q.sessionId : undefined,
      days: typeof q.days === 'number' ? Math.max(0, q.days) : undefined,
      limit: typeof q.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(q.limit))) : 50
    });
  });
}
