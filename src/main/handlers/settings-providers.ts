/** Settings, folders, secrets, providers, model overrides, and dictation IPC handlers. */
import { localModel } from '../../shared/dictation';
import { assertEndpointUrl } from '../../shared/endpoint-policy';
import { PUSH_CHANNELS } from '../../shared/ipc';
import { applyModelOverrides, modelOverrideKey } from '../../shared/model-overrides';
import type { AppSettings } from '../../shared/types';
import { DictationService } from '../dictation/service';
import { assertProviderEndpoint, fallbackModels, fetchProviderModels, resolveProviderApiKey, testProvider } from '../models/providers';
import { enrichModelsFromProviders } from '../models/static-models';
import { isReservedSecretId } from '../secret-ids';
import { errorMessage } from '../util/async';
import type { HandlerContext } from './context';

export function registerSettingsProviderHandlers(ctx: HandlerContext): void {
  const { deps, handle, modelCatalog, trackHousekeepWrite, onShutdown } = ctx;
  const { settings, secrets, sessions, terminals } = deps;

  let dictationService: DictationService | undefined = deps.dictation;
  const dictation = (): DictationService =>
    (dictationService ??= new DictationService({
      settings,
      secrets,
      userData: deps.desktop.userDataPath(),
      log: deps.log,
      push: (status) => deps.push(PUSH_CHANNELS.dictationStatus, status)
    }));
  onShutdown(() => dictationService?.dispose());

  handle('settings:get', () => settings.get());
  handle('settings:update', async (patch) => {
    const changesHousekeep = !!patch && typeof patch === 'object' && Object.hasOwn(patch, 'housekeepRecentDays');
    const next = changesHousekeep ? await trackHousekeepWrite(() => settings.update(patch)) : await settings.update(patch);
    if (patch?.intelligence && next.intelligence?.gateway === false) deps.revokeMemoryGrants?.();
    // Keys only: provider entries carry custom headers, and window bounds change every drag.
    const keys = patch && typeof patch === 'object' ? Object.keys(patch).filter((k) => k !== 'windowBounds') : [];
    if (keys.length) deps.log('debug', `settings updated: ${keys.join(', ')}`);
    // `/goal` ownership follows the goal defaults, so a change there has to reach every open session.
    if (patch && typeof patch === 'object' && 'goalDefaults' in patch) await sessions.refreshGoalDrivers();
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next;
  });

  /**
   * Takes a project folder out of the app: its sessions (and their worktrees, exactly as the
   * per-session delete does) plus every setting keyed by that root. Nothing on disk is removed —
   * the project itself stays where it is, and re-adding it starts from a clean slate.
   */
  handle('folders:remove', async ({ root }) => {
    const doomed = sessions.list().filter((s) => s.config.projectRoot === root);
    // Shells hold their cwd open; take them down before any worktree is removed.
    for (const s of doomed) await terminals.closeForSession(s.id);
    const removedSessions = await sessions.deleteMany(doomed.map((s) => s.id));
    const cur = settings.get();
    const patch: Partial<AppSettings> = {};
    const without = (key: 'folders' | 'folderOrder' | 'collapsedFolders' | 'recentProjects' | 'gitSetupSkipped') => {
      const list = cur[key];
      if (list?.includes(root)) patch[key] = list.filter((p) => p !== root);
    };
    without('folders');
    without('folderOrder');
    without('collapsedFolders');
    without('recentProjects');
    without('gitSetupSkipped');
    for (const key of ['folderStyles', 'mcpProjectState', 'folderSessionDefaults'] as const) {
      const map = cur[key];
      if (map && root in map) {
        const next = { ...map };
        delete next[root];
        (patch as Record<string, unknown>)[key] = next;
      }
    }
    if (Object.keys(patch).length) deps.push(PUSH_CHANNELS.settingsChanged, await settings.update(patch));
    deps.log('info', `folder removed from app: ${root} (${removedSessions} session${removedSessions === 1 ? '' : 's'})`);
    return { removedSessions };
  });

  // Identity material shares the store with API keys; provider ids can never name it.
  const assertProviderSecretId = (id: string) => {
    if (isReservedSecretId(id)) throw new Error('That id is reserved and cannot hold a provider key.');
  };
  async function syncProviderKeyFlags(): Promise<AppSettings> {
    const s = settings.get();
    const providers = s.providers.map((p) => ({ ...p, hasApiKey: secrets.has(p.id) }));
    const next = await settings.update({ providers });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next;
  }

  handle('secrets:set', async ({ providerId, apiKey }) => {
    assertProviderSecretId(providerId);
    await secrets.set(providerId, apiKey);
    await syncProviderKeyFlags();
    await modelCatalog().clear();
  });
  handle('secrets:clear', async ({ providerId }) => {
    assertProviderSecretId(providerId);
    await secrets.clear(providerId);
    await syncProviderKeyFlags();
    await modelCatalog().clear();
  });
  handle('secrets:has', ({ providerId }) => !isReservedSecretId(providerId) && secrets.has(providerId));
  handle('secrets:status', () => secrets.status);

  handle('providers:list', () => {
    const s = settings.get();
    return s.providers.map((p) => {
      const models = enrichModelsFromProviders(p.models.length ? p.models : fallbackModels(p), s.providers);
      return { ...p, hasApiKey: secrets.has(p.id), models: applyModelOverrides(models, s.modelOverrides) };
    });
  });
  handle('providers:save', async (provider) => {
    assertProviderSecretId(provider.id);
    if (provider.baseUrl !== undefined && provider.baseUrl !== '') assertEndpointUrl(provider.baseUrl);
    const s = settings.get();
    const idx = s.providers.findIndex((p) => p.id === provider.id);
    const providers = [...s.providers];
    if (idx >= 0) providers[idx] = { ...providers[idx], ...provider, hasApiKey: secrets.has(provider.id) };
    else providers.push({ ...provider, hasApiKey: secrets.has(provider.id), builtin: false });
    const next = await settings.update({ providers });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next.providers;
  });
  handle('providers:delete', async ({ id }) => {
    assertProviderSecretId(id);
    const s = settings.get();
    const next = await settings.update({ providers: s.providers.filter((p) => p.id !== id || p.builtin) });
    await secrets.clear(id);
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next.providers;
  });
  handle('providers:refreshModels', async ({ id }) => {
    const s = settings.get();
    const p = s.providers.find((x) => x.id === id);
    if (!p) return { models: [], error: 'Unknown provider' };
    try {
      assertProviderEndpoint(p);
      const key = await resolveProviderApiKey(p, (pid) => secrets.get(pid));
      const models = await fetchProviderModels(p, key);
      const providers = s.providers.map((x) => (x.id === id ? { ...x, models, modelsUpdatedAt: Date.now() } : x));
      const next = await settings.update({ providers });
      deps.push(PUSH_CHANNELS.settingsChanged, next);
      return { models: applyModelOverrides(enrichModelsFromProviders(models, next.providers), next.modelOverrides) };
    } catch (e) {
      deps.log('warn', `model list refresh failed for ${id}: ${errorMessage(e)}`);
      const models = enrichModelsFromProviders(fallbackModels(p), s.providers);
      return { models: applyModelOverrides(models, s.modelOverrides), error: errorMessage(e) };
    }
  });
  handle('providers:test', async ({ id }) => {
    const p = settings.get().providers.find((x) => x.id === id);
    if (!p) return { ok: false, detail: 'Unknown provider' };
    try {
      assertProviderEndpoint(p);
    } catch (e) {
      return { ok: false, detail: errorMessage(e) };
    }
    const key = await resolveProviderApiKey(p, (pid) => secrets.get(pid));
    if (!key && !['ollama', 'lmstudio'].includes(p.kind)) return { ok: false, detail: `No API key stored and ${p.envKey ?? 'no env var'} is not set.` };
    return testProvider(p, key);
  });
  handle('models:setOverride', async ({ provider, model, supportsImages }) => {
    const s = settings.get();
    const key = modelOverrideKey(provider, model);
    const modelOverrides = { ...s.modelOverrides };
    if (supportsImages === null) delete modelOverrides[key];
    else modelOverrides[key] = { ...modelOverrides[key], supportsImages };
    const next = await settings.update({ modelOverrides });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    // Running sessions already have a model list; re-publish it so the change lands without a restart.
    sessions.republishModels();
    return next.modelOverrides;
  });

  handle('dictation:transcribe', ({ audio }) => dictation().transcribe(audio));
  handle('dictation:cloudModels', ({ provider }) => dictation().cloudModels(String(provider ?? '')));
  handle('dictation:status', () => dictation().status());
  handle('dictation:install', () => dictation().install());
  handle('dictation:cancelInstall', () => dictation().cancelInstall());
  handle('dictation:removeModel', ({ model }) => {
    const known = localModel(model);
    if (!known) throw new Error(`Unknown dictation model ${String(model)}`);
    return dictation().removeModel(known.id);
  });
  handle('dictation:stopLocal', () => dictation().stopLocal());
}
