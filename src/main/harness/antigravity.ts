import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { AntigravityQuota } from '../../shared/harness-setup';
import type { ModelInfo } from '../../shared/types';
import { withTimeout } from '../util/async';
import { acpModelCatalog, type ConfigOptionLike } from './acp-config';
import { shutdownChild, spawnTool } from './spawn';

// Ask the ACP client about every tool. A vendor allowlist or saved Auto preference must not
// make Vocs Code's Ask and Plan modes silently less restrictive.
const antigravitySettings = JSON.stringify({ modelProvider: '', toolPermission: 'strict', allowNonWorkspaceAccess: false });
export const ANTIGRAVITY_ACP_ARGS = ['--settings', antigravitySettings, 'acp'] as const;
export const ANTIGRAVITY_QUOTA_ARGS = ['--settings', antigravitySettings, '-p', '/usage', '--output-format', 'json'] as const;
export const ANTIGRAVITY_SIGN_IN_MESSAGE = 'Sign in with Google in Settings → Providers & keys → Harness logins, then retry.';

export function antigravityAccountEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The Antigravity account route uses the CLI's saved sign-in even when this app or the
  // launching shell has a Gemini API key or Cloud ADC configured for another integration.
  for (const key of Object.keys(env)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(key)) delete env[key];
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

const quotaBucket = z.object({
  name: z.string().trim().min(1).max(120),
  disabled: z.literal(false).optional(),
  remaining_fraction: z.number().min(0).max(1),
  reset_time: z.iso.datetime({ offset: true }).nullish().catch(undefined)
});

const quotaEnvelope = z.object({
  status: z.literal('SUCCESS'),
  num_turns: z.literal(0),
  command: z.object({
    name: z.literal('usage'),
    data: z.object({
      groups: z.array(z.object({
        name: z.string().trim().min(1).max(120),
        buckets: z.array(z.unknown()).max(20)
      })).max(30)
    })
  })
});

export function parseAntigravityQuota(stdout: string): AntigravityQuota | undefined {
  try {
    const parsed = quotaEnvelope.safeParse(JSON.parse(stdout));
    if (!parsed.success) return undefined;
    const groups: AntigravityQuota['groups'] = [];
    for (const group of parsed.data.command.data.groups) {
      const buckets: AntigravityQuota['groups'][number]['buckets'] = [];
      for (const row of group.buckets) {
        const bucket = quotaBucket.safeParse(row);
        if (bucket.success) {
          buckets.push({ name: bucket.data.name, remainingFraction: bucket.data.remaining_fraction, resetAt: bucket.data.reset_time ?? undefined });
        }
      }
      if (buckets.length) groups.push({ name: group.name, buckets });
    }
    return groups.length ? { groups } : undefined;
  } catch {
    return undefined;
  }
}
