/** Provider-kind helpers shared by main and renderer. No runtime deps, no Electron imports. */
import type { ProviderConfig, ProviderKind } from './types';

/**
 * Provider kinds that speak the OpenAI wire protocol. Codex can target these through a
 * `model_providers` entry; Anthropic and Cursor speak their own protocols and cannot.
 */
const OPENAI_WIRE_KINDS: readonly ProviderKind[] = [
  'openai',
  'openai-compatible',
  'deepseek',
  'openrouter',
  'ollama',
  'lmstudio',
  'groq',
  'xai',
  'mistral',
  'gemini-openai'
];

export function isOpenAiWireProvider(provider: Pick<ProviderConfig, 'kind'>): boolean {
  return OPENAI_WIRE_KINDS.includes(provider.kind);
}

/** Codex ships an `openai` provider; every other id has to be registered as a `model_providers` entry. */
export function isCodexBuiltinProvider(id: string | undefined): boolean {
  return !id || id === 'openai' || id === 'codex';
}

/** Anthropic's own endpoint; anything else on an anthropic-kind provider is a third-party gateway. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Provider kinds that speak the Anthropic wire protocol. Claude Code can be pointed at these. */
export function isAnthropicWireProvider(provider: Pick<ProviderConfig, 'kind'>): boolean {
  return provider.kind === 'anthropic';
}

/** An anthropic-kind provider aimed somewhere other than Anthropic itself (GLM, Kimi, LiteLLM, …). */
export function isAnthropicGateway(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'> | undefined): boolean {
  if (!provider) return false;
  const baseUrl = (provider.baseUrl ?? '').trim().replace(/\/+$/, '');
  return isAnthropicWireProvider(provider) && !!baseUrl && baseUrl !== ANTHROPIC_DEFAULT_BASE_URL;
}
