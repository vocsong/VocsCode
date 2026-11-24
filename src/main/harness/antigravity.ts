import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { ModelInfo } from '../../shared/types';
import { withTimeout } from '../util/async';
import { acpModelCatalog, type ConfigOptionLike } from './acp-config';
import { shutdownChild, spawnTool } from './spawn';

// Ask the ACP client about every tool. A vendor allowlist or saved Auto preference must not
// make Vocs Code's permission mode silently less restrictive: the app's mode alone decides.
const antigravitySettings = JSON.stringify({ modelProvider: '', toolPermission: 'strict', allowNonWorkspaceAccess: false });
export const ANTIGRAVITY_ACP_ARGS = ['--settings', antigravitySettings, 'acp'] as const;
export const ANTIGRAVITY_SIGN_IN_MESSAGE = 'Sign in with Google in Settings → Providers & keys → Harness logins, then retry.';

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
