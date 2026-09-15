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
  'opencode-go',
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

/** Which credential header a vendor's Anthropic-format route reads: a bearer token, or `x-api-key` like Anthropic itself. */
export type AnthropicAuth = 'bearer' | 'api-key';

interface AnthropicRoute {
  /** Base URL the Anthropic SDK appends `/v1/messages` to. */
  baseUrl: string;
  auth: AnthropicAuth;
}

/**
 * Vendors that publish an Anthropic-format endpoint next to their OpenAI one, so Claude Code can run
 * on their catalog with the key already stored for the provider.
 */
const ANTHROPIC_ROUTES: Partial<Record<ProviderKind, AnthropicRoute>> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api', auth: 'bearer' },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', auth: 'bearer' },
  // OpenCode Zen's Anthropic route reads x-api-key only; a bearer token is answered with
  // `401 Missing API key`, so Claude Code has to send the key the way Anthropic's own SDK does.
  'opencode-go': { baseUrl: 'https://opencode.ai/zen/go', auth: 'api-key' }
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
  return ANTHROPIC_ROUTES[provider.kind]?.baseUrl;
}

/** The credential header a provider's Anthropic route reads; anything unmapped takes a bearer token. */
export function anthropicAuthFor(provider: Pick<ProviderConfig, 'kind'>): AnthropicAuth {
  return ANTHROPIC_ROUTES[provider.kind]?.auth ?? 'bearer';
}

/** Whether Claude Code can run on this provider at all. */
export function isClaudeCapableProvider(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): boolean {
  return !!anthropicBaseUrlFor(provider);
}

/** A Claude-capable provider that is not Anthropic itself: it needs a base URL and a stored key. */
export function isClaudeGatewayProvider(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'> | undefined): boolean {
  if (!provider) return false;
  const baseUrl = anthropicBaseUrlFor(provider);
  return !!baseUrl && baseUrl !== ANTHROPIC_DEFAULT_BASE_URL;
}
