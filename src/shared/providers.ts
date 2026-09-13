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

/** Anthropic's own endpoint; anything else is a gateway or a vendor's own Anthropic-format route. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Vendors that publish an Anthropic-format endpoint next to their OpenAI one, so Claude Code can run
 * on their catalog with the key already stored for the provider. The value is the base URL the
 * Anthropic SDK appends `/v1/messages` to.
 */
const ANTHROPIC_ENDPOINTS: Partial<Record<ProviderKind, string>> = {
  openrouter: 'https://openrouter.ai/api',
  deepseek: 'https://api.deepseek.com/anthropic'
};

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * The Anthropic-format base URL a provider can host Claude Code on: its own base URL for an
 * anthropic-kind provider (Anthropic itself or a gateway), or the vendor's published Anthropic
 * route for a mapped kind.
 */
export function anthropicBaseUrlFor(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): string | undefined {
  if (provider.kind === 'anthropic') return normalizeBaseUrl(provider.baseUrl) || ANTHROPIC_DEFAULT_BASE_URL;
  return ANTHROPIC_ENDPOINTS[provider.kind];
}

/** Whether Claude Code can run on this provider at all. */
export function isClaudeCapableProvider(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): boolean {
  return !!anthropicBaseUrlFor(provider);
}

/** A Claude-capable provider that is not Anthropic itself: it needs a base URL and a bearer token. */
export function isClaudeGatewayProvider(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'> | undefined): boolean {
  if (!provider) return false;
  const baseUrl = anthropicBaseUrlFor(provider);
  return !!baseUrl && baseUrl !== ANTHROPIC_DEFAULT_BASE_URL;
}
