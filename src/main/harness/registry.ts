/** Maps a harness id to its adapter factory and to the model list that harness can reach. */
import type { AppSettings, HarnessId, ModelInfo } from '../../shared/types';
import { applyModelOverrides } from '../../shared/model-overrides';
import { errorMessage } from '../util/async';
import type { RuntimeResolver } from '../runtime';
import { ANTHROPIC_STATIC_MODELS, CODEX_STATIC_MODELS, STATIC_MODELS_BY_PROVIDER } from '../models/static-models';
import { AcpAdapter } from './acp';
import { ClaudeAdapter } from './claude';
import { CodexAppServerAdapter, listCodexModels } from './codex-app-server';
import { CodexExecAdapter } from './codex-exec';
import { NativeAdapter } from './native';
import { PiAdapter, listPiModels } from './pi';
import type { HarnessAdapter, HarnessContext } from './types';

export function createAdapter(id: HarnessId, ctx: HarnessContext): HarnessAdapter {
  switch (id) {
    case 'claude':
      return new ClaudeAdapter(ctx);
    case 'codex':
      return new CodexAppServerAdapter(ctx);
    case 'codex-exec':
      return new CodexExecAdapter(ctx);
    case 'pi':
      return new PiAdapter(ctx);
    case 'acp':
      return new AcpAdapter(ctx);
    case 'native':
      return new NativeAdapter(ctx);
  }
}

/** Models offered in the New Session dialog before any process exists. */
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
        const p = settings.providers.find((x) => x.id === 'anthropic');
        return { models: p?.models.length ? p.models : ANTHROPIC_STATIC_MODELS };
      }
      case 'codex':
      case 'codex-exec': {
        const bin = runtime.resolve('codex');
        if (!bin) return { models: CODEX_STATIC_MODELS, error: 'Codex CLI not found; showing the built-in catalog.' };
        try {
          const models = await listCodexModels(bin.path);
          return { models: models.length ? models : CODEX_STATIC_MODELS };
        } catch (e) {
          return { models: CODEX_STATIC_MODELS, error: `model/list failed (${errorMessage(e)}); showing the built-in catalog.` };
        }
      }
      case 'pi': {
        const bin = runtime.resolve('pi');
        if (!bin) return { models: [], error: 'pi is not installed.' };
        const env: NodeJS.ProcessEnv = {};
        for (const [pid, envKey] of Object.entries({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY' })) {
          if (!process.env[envKey]) {
            const k = await opts.getApiKey(pid);
            if (k) env[envKey] = k;
          }
        }
        return { models: await listPiModels(bin.path, env) };
      }
      case 'acp':
        return { models: [], error: 'ACP agents advertise their models once the session starts; pick one from the header afterwards.' };
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
