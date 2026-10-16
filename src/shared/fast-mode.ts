import type { HarnessId, ModelRef, ProviderConfig } from './types';

export const FAST_MODE_COST_WARNING = 'Fast mode uses premium inference at higher cost or usage. Claude subscription users need usage credits. Reasoning effort is unchanged.';

export interface FastModeSupport {
  supported: boolean;
  reason?: string;
}

/** Conservative candidates, not account entitlement or proof that a request used a fast tier. */
export function fastModeSupport(harness: HarnessId, model: ModelRef | undefined, providers: ProviderConfig[] = []): FastModeSupport {
  const no = (reason: string): FastModeSupport => ({ supported: false, reason });
  if (harness === 'cursor' || harness === 'acp') return no('This harness does not expose Fast mode.');
  if (!model) return harness === 'codex' || harness === 'codex-exec'
    ? { supported: true }
    : no('Choose a supported OpenAI or Claude Opus model to use Fast mode.');
  const provider = providers.find((p) => p.id === model.provider);
  const openai = ['openai', 'openai-codex', 'codex'].includes(model.provider);
  const anthropic = model.provider === 'anthropic';
  if (!openai && !anthropic) return no('Fast mode is available only through first-party OpenAI or Anthropic providers.');
  if (provider?.baseUrl) {
    try {
      const url = new URL(provider.baseUrl);
      if (url.protocol !== 'https:' || url.hostname !== (openai ? 'api.openai.com' : 'api.anthropic.com')) {
        return no('Fast mode is not enabled for custom endpoints or gateways.');
      }
    } catch {
      return no('Fast mode requires a first-party provider endpoint.');
    }
  }
  if ((harness === 'codex' || harness === 'codex-exec') && !openai) return no('Codex Fast mode requires an OpenAI model.');
  if (harness === 'claude' && !anthropic) return no('Claude Fast mode requires a supported Anthropic Opus model.');
  const id = model.model.toLowerCase().replace(/\[1m\]$/, '');
  if (openai) return /^gpt-(?:5|6)(?:[.-]|$)/.test(id) && !id.includes('spark')
    ? { supported: true }
    : no('Fast mode is not available for this OpenAI model.');
  return id === 'opus' || /^claude-opus-(?:4[.-]8|5)(?:[.-]|$)/.test(id)
    ? { supported: true }
    : no('Fast mode requires a supported Claude Opus model (Opus 4.8 or Opus 5).');
}
