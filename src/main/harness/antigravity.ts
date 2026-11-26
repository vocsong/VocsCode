import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { ModelInfo } from '../../shared/types';
import { ANTHROPIC_STATIC_MODELS, OPENAI_STATIC_MODELS } from '../models/static-models';
import { withTimeout } from '../util/async';
import { acpModelCatalog, type ConfigOptionLike } from './acp-config';
import { shutdownChild, spawnTool } from './spawn';

// Ask the ACP client about every tool. A vendor allowlist or saved Auto preference must not
// make Vocs Code's permission mode silently less restrictive: the app's mode alone decides.
const antigravitySettings = JSON.stringify({ modelProvider: '', toolPermission: 'strict', allowNonWorkspaceAccess: false });
export const ANTIGRAVITY_ACP_ARGS = ['--settings', antigravitySettings, 'acp'] as const;
export const ANTIGRAVITY_SIGN_IN_MESSAGE = 'Sign in with Google in Settings → Providers & keys → Harness logins, then retry.';

type Pricing = NonNullable<ModelInfo['pricing']>;

/**
 * Gemini API paid-tier Standard rates (USD per 1M tokens; thinking bills as output) from Google's
 * pricing page, read 2026-11-26. Antigravity runs on a Google AI subscription and reports tokens
 * but never a price, so a turn is priced at what the same tokens cost on the API — the way Codex
 * on a ChatGPT sign-in is. Gemini caches implicitly with no write charge. Some rates step up on a
 * published date, so each model lists its periods oldest first and a turn takes the one it fell in.
 * Orchestrator models are absent on purpose: they split one turn between two models at an
 * undisclosed ratio, so no single rate is honest.
 */
const GEMINI_RATES: Record<string, { from?: string; pricing: Pricing }[]> = {
  'gemini-4-neon': [{ pricing: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 } }],
  'gemini-4-hydrogen': [{ pricing: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 } }],
  'gemini-4-carbon': [
    { pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } },
    { from: '2026-12-01', pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } }
  ],
  'gemini-4-argon': [
    { pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } },
    { from: '2026-12-01', pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } }
  ],
  'gemini-3.8-flash': [
    { pricing: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 } },
    { from: '2027-01-01', pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 } }
  ]
};

/**
 * The API-equivalent rate for an Antigravity model at `now`. Partner models it hosts (Claude, GPT)
 * price from the bundled catalogs by exact id only — a prefix match would put `claude-sonnet-5-5` on
 * Sonnet 5's older rate. Anything unpriced returns undefined and the turn stays $0.
 */
export function antigravityPricing(model: string | undefined, now = Date.now()): ModelInfo['pricing'] | undefined {
  if (!model) return undefined;
  const periods = GEMINI_RATES[model];
  if (periods) {
    // Periods start at UTC midnight on the date Google publishes.
    const current = periods.filter((p) => !p.from || Date.parse(`${p.from}T00:00:00Z`) <= now).at(-1);
    return current?.pricing;
  }
  return [...ANTHROPIC_STATIC_MODELS, ...OPENAI_STATIC_MODELS].find((m) => m.id === model)?.pricing;
}

// Use the CLI's saved sign-in even if Gemini API keys or Cloud ADC are set for other integrations.
export const ANTIGRAVITY_AUTH_ENV_OVERRIDES: readonly string[] = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS'
];

export function antigravityAccountEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (ANTIGRAVITY_AUTH_ENV_OVERRIDES.includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

export function isAntigravityAuthRequired(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === -32000;
}

export function connectAcp(child: ChildProcess, handlers: () => acp.Client): acp.ClientSideConnection {
  if (!child.stdin || !child.stdout) throw new Error('ACP agent has no stdio');
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  return new acp.ClientSideConnection(handlers, acp.ndJsonStream(output, input));
}

/** An ACP list request checks the active CLI account without creating a chat or prompting a model. */
export async function checkAntigravityAccount(binary: string, cwd: string): Promise<boolean | 'unknown'> {
  const child = spawnTool(binary, [...ANTIGRAVITY_ACP_ARGS], { cwd, env: antigravityAccountEnv() });
  child.on('error', () => undefined);
  child.stderr?.resume();
  try {
    const connection = connectAcp(child, () => ({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined
    }));
    const check = async () => {
      const init = await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      if (!init.agentCapabilities?.sessionCapabilities?.list) return 'unknown' as const;
      await connection.listSessions({ cwd });
      return true;
    };
    return await withTimeout(check(), 12_000, 'Antigravity sign-in check');
  } catch (error) {
    return isAntigravityAuthRequired(error) ? false : 'unknown';
  } finally {
    await shutdownChild(child);
  }
}

/**
 * Reads the account's model catalog for New Session. The CLI offers models only as session
 * config options, so this opens a session, reads them and closes it. It never sends a prompt,
 * and a session without a prompt is not kept in the CLI's history.
 */
export async function listAntigravityModels(binary: string, cwd: string): Promise<ModelInfo[]> {
  const child = spawnTool(binary, [...ANTIGRAVITY_ACP_ARGS], { cwd, env: antigravityAccountEnv() });
  child.on('error', () => undefined);
  child.stderr?.resume();
  try {
    const connection = connectAcp(child, () => ({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined
    }));
    const read = async () => {
      const init = await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const session = await connection.newSession({ cwd, mcpServers: [] });
      if (init.agentCapabilities?.sessionCapabilities?.close) {
        await connection.closeSession({ sessionId: session.sessionId }).catch(() => undefined);
      }
      return acpModelCatalog((session.configOptions ?? []) as ConfigOptionLike[], 'antigravity').map(({ model }) => model);
    };
    return await withTimeout(read(), 30_000, 'Antigravity model list');
  } catch (error) {
    if (isAntigravityAuthRequired(error)) throw new Error(ANTIGRAVITY_SIGN_IN_MESSAGE);
    throw error;
  } finally {
    await shutdownChild(child);
  }
}
