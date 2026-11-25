/** Maps a harness id to its adapter factory and to the model list that harness can reach. */
import { promises as fs } from 'node:fs';
import type { AppSettings, HarnessId, ModelInfo } from '../../shared/types';
import { applyModelOverrides } from '../../shared/model-overrides';
import { errorMessage } from '../util/async';
import { spawnableCodex, type RuntimeResolver } from '../runtime';
import { CODEX_STATIC_MODELS, CURSOR_STATIC_MODELS, STATIC_MODELS_BY_PROVIDER } from '../models/static-models';
import { claudeNativeModels, mergeClaudeCatalog, withSavedClaudeModels } from '../models/claude-catalog';
import { mergeCodexCatalog } from '../models/codex-catalog';
import { mergePiCatalog } from '../models/pi-catalog';
import { AcpAdapter } from './acp';
import { listAntigravityModels } from './antigravity';
import { ClaudeAdapter, listClaudeModels, resolveClaudeProviderEnv } from './claude';
import { CodexAppServerAdapter, listCodexModels } from './codex-app-server';
import { CursorAdapter, listCursorModels } from './cursor';
import { CodexExecAdapter } from './codex-exec';
import { NativeAdapter } from './native';
import { PiAdapter, listPiModels } from './pi';
import { PROVIDER_ENV_KEYS } from './provider-env';
import type { HarnessAdapter, HarnessContext } from './types';

export function createAdapter(id: HarnessId, ctx: HarnessContext): HarnessAdapter {
  switch (id) {
    case 'claude':
      return new ClaudeAdapter(ctx);
    case 'codex':
      return new CodexAppServerAdapter(ctx);
    case 'codex-exec':
      return new CodexExecAdapter(ctx);
    case 'cursor':
      return new CursorAdapter(ctx);
    case 'pi':
      return new PiAdapter(ctx);
    case 'acp':
      return new AcpAdapter(ctx);
    case 'antigravity':
      return new AcpAdapter(ctx, 'antigravity');
    case 'native':
      return new NativeAdapter(ctx);
  }
}

/** Models offered before a session process exists; some harnesses use a short-lived catalog probe. */
export async function listHarnessModels(opts: {
  harness: HarnessId;
  settings: AppSettings;
  runtime: RuntimeResolver;
  getApiKey: (id: string) => Promise<string | undefined>;
  log?: (m: string) => void;
}): Promise<{ models: ModelInfo[]; error?: string }> {
  const res = await listHarnessModelsRaw(opts);
  return { ...res, models: applyModelOverrides(res.models, opts.settings.modelOverrides) };
}

async function listHarnessModelsRaw(opts: {
  harness: HarnessId;
  settings: AppSettings;
  runtime: RuntimeResolver;
  getApiKey: (id: string) => Promise<string | undefined>;
  log?: (m: string) => void;
}): Promise<{ models: ModelInfo[]; error?: string }> {
  const { harness, settings, runtime } = opts;
  try {
    switch (harness) {
      case 'claude': {
        const fallback = claudeNativeModels(settings);
        const bin = runtime.resolve('claude');
        if (!bin) return { models: mergeClaudeCatalog(fallback, settings), error: 'Claude Code runtime not found; showing the saved catalog.' };
        try {
          const provider = settings.providers.find((p) => p.id === 'anthropic');
          // The endpoint, key and user settings a session on this provider starts with; the useProviderKey opt-in is applied inside.
          const env = await resolveClaudeProviderEnv(settings, provider, opts.getApiKey);
          const live = await listClaudeModels(bin.path, env, settings.claude.settingSources);
          if (!live.length) return { models: mergeClaudeCatalog(fallback, settings), error: 'Claude Code reported no models; showing the saved catalog.' };
          return { models: mergeClaudeCatalog(withSavedClaudeModels(live, fallback), settings) };
        } catch (e) {
          return { models: mergeClaudeCatalog(fallback, settings), error: `Claude model discovery failed (${errorMessage(e)}); showing the saved catalog.` };
        }
      }
      case 'codex':
      case 'codex-exec': {
        const native = await codexNativeModels(runtime, harness);
        // Only the app-server harness can register a custom provider, so only it lists their models.
        const models = harness === 'codex' ? mergeCodexCatalog(native.models, settings) : native.models;
        return { models, error: native.error };
      }
      case 'cursor': {
        const key = await opts.getApiKey('cursor');
        try {
          const models = await listCursorModels(key);
          return { models: models.length ? models : CURSOR_STATIC_MODELS };
        } catch (e) {
          return { models: CURSOR_STATIC_MODELS, error: `Cursor.models.list failed (${errorMessage(e)}); showing the built-in catalog.` };
        }
      }
      case 'pi': {
        const bin = runtime.resolve('pi');
        if (!bin) return { models: [], error: 'pi is not installed.' };
        const env: NodeJS.ProcessEnv = {};
        for (const [pid, envKey] of Object.entries(PROVIDER_ENV_KEYS)) {
          if (!process.env[envKey]) {
            const k = await opts.getApiKey(pid);
            if (k) env[envKey] = k;
          }
        }
        return { models: mergePiCatalog(await listPiModels(bin.path, env), settings) };
      }
      case 'acp':
        return { models: [], error: 'ACP agents advertise their models once the session starts; pick one from the header afterwards.' };
      case 'antigravity': {
        const bin = runtime.resolve('agy');
        if (!bin) return { models: [], error: 'Antigravity CLI (agy) was not found; install it to list your Google account’s models.' };
        const cwd = runtime.runtimePaths.appRuntimeDir;
        await fs.mkdir(cwd, { recursive: true });
        try {
          const models = await listAntigravityModels(bin.path, cwd);
          return models.length ? { models } : { models, error: 'Antigravity CLI reported no models; pick one from the session header after it starts.' };
        } catch (e) {
          return { models: [], error: `Antigravity model discovery failed (${errorMessage(e)}).` };
        }
      }
      case 'native': {
        const out: ModelInfo[] = [];
        for (const p of settings.providers.filter((p) => p.enabled)) {
          const models = p.models.length ? p.models : STATIC_MODELS_BY_PROVIDER[p.id] ?? [];
          out.push(...models.map((m) => ({ ...m, provider: p.id })));
        }
        return { models: out };
      }
    }
  } catch (e) {
    return { models: [], error: errorMessage(e) };
  }
}

/**
 * Codex's own catalog, or the built-in fallback when the CLI is missing or `model/list` fails.
 * Codex exec lists from the binary it will spawn, not the shim the app-server harness runs, so it
 * never offers a model only a newer install knows.
 */
async function codexNativeModels(runtime: RuntimeResolver, harness: 'codex' | 'codex-exec'): Promise<{ models: ModelInfo[]; error?: string }> {
  const resolved = runtime.resolve('codex');
  const bin = harness === 'codex-exec' ? spawnableCodex(resolved, runtime.runtimePaths?.appRoot) : resolved;
  if (!bin) return { models: CODEX_STATIC_MODELS, error: 'Codex CLI not found; showing the built-in catalog.' };
  try {
    const models = await listCodexModels(bin.path);
    return models.length ? { models } : { models: CODEX_STATIC_MODELS, error: 'Codex reported no models; showing the built-in catalog.' };
  } catch (e) {
    return { models: CODEX_STATIC_MODELS, error: `model/list failed (${errorMessage(e)}); showing the built-in catalog.` };
  }
}
