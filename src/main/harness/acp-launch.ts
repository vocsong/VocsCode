/** ACP launch resolution: preset/Antigravity binary & env assembly and absolute-path MCP server filtering. */
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import type { AcpAgentPreset, McpServerDef } from '../../shared/types';
import { toAcp } from '../mcp/effective';
import { which } from '../runtime';
import { errorMessage } from '../util/async';
import { ANTIGRAVITY_ACP_ARGS, antigravityAccountEnv } from './antigravity';
import { PROVIDER_ENV_KEYS } from './provider-env';
import type { HarnessContext } from './types';

function resolveAcpPreset(ctx: HarnessContext): AcpAgentPreset {
  const s = ctx.settings();
  const id = ctx.session().config.acpAgent ?? 'dsh';
  const preset = s.acpAgents.find((a) => a.id === id) ?? s.acpAgents[0];
  if (!preset) throw new Error('No ACP agent preset configured.');
  return preset;
}

export async function resolveAcpLaunch(
  ctx: HarnessContext,
  id: 'acp' | 'antigravity'
): Promise<{ preset: AcpAgentPreset; command: string; args: string[]; env: NodeJS.ProcessEnv }> {
  if (id === 'antigravity') {
    const binary = ctx.runtime.resolve('agy');
    if (!binary) throw new Error('Install Antigravity CLI (agy) from Settings → Providers & keys → Harness logins.');
    const preset: AcpAgentPreset = {
      id, name: HARNESS_BY_ID[id].name, description: '',
      command: binary.path, args: [...ANTIGRAVITY_ACP_ARGS]
    };
    return { preset, command: preset.command, args: preset.args, env: antigravityAccountEnv() };
  }
  const preset = resolveAcpPreset(ctx);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(preset.env ?? {}) };
  for (const [pid, envKey] of Object.entries(PROVIDER_ENV_KEYS)) {
    if (!env[envKey]) {
      const key = await ctx.getApiKey(pid);
      if (key) env[envKey] = key;
    }
  }
  let command = preset.command;
  let args = preset.args;
  const explicit = (ctx.settings().binaries as Record<string, string | undefined>)[command];
  if (explicit) command = explicit;
  else {
    const resolved = which(command, [ctx.runtime.runtimePaths.appRuntimeDir]);
    if (resolved) command = resolved;
    else if (command === 'dsh') {
      // Fall back to npx when dsh is not installed globally.
      const npx = which('npx');
      if (npx) {
        command = npx;
        args = ['-y', '@deepseek-ai/dsh', ...preset.args];
      }
    }
  }
  return { preset, command, args, env };
}

/**
 * Resolves the session's MCP servers for ACP. ACP requires an absolute `command` and the agent
 * rejects the whole handshake when one is relative — Windows' `cmd /c` shim wrapper is exactly
 * that case. Resolve what we can and drop the rest: losing one server beats losing the session.
 */
export async function resolveAcpMcpServers(
  ctx: HarnessContext,
  mcpCaps: { http?: boolean; sse?: boolean },
  warn: (message: string) => void
): Promise<acp.NewSessionRequest['mcpServers']> {
  const mcpDefs: McpServerDef[] = [];
  const skippedMcp: string[] = [];
  for (const { def } of await ctx.mcpServers().catch((e) => {
    ctx.log('warn', `mcp: ${errorMessage(e)}`);
    return [];
  })) {
    if (def.transport !== 'stdio' || !def.command) {
      mcpDefs.push(def);
      continue;
    }
    const command = path.isAbsolute(def.command) ? def.command : which(def.command, [ctx.runtime.runtimePaths.appRuntimeDir]);
    if (!command) {
      skippedMcp.push(def.id);
      ctx.log('warn', `mcp ${def.id}: cannot resolve "${def.command}" to an absolute path; skipping`);
      continue;
    }
    mcpDefs.push(command === def.command ? def : { ...def, command });
  }
  if (skippedMcp.length) {
    const what = skippedMcp.length > 1 ? 'servers' : 'server';
    warn(`Skipped MCP ${what} with a command that is not an absolute path: ${skippedMcp.join(', ')}`);
  }
  return toAcp(mcpDefs, mcpCaps) as unknown as acp.NewSessionRequest['mcpServers'];
}
