/** Pi child-process launch preparation: argv/extension assembly, MCP config splitting, effort/mode files, and sanitized env. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EffortLevel, ModelRef, PermissionMode } from '../../shared/types';
import { MEMORY_GATEWAY_TOKEN_ENV, MEMORY_GATEWAY_URL_ENV, VOCS_MEMORY_SERVER_ID } from '../mcp/memory';
import { MISSION_GATEWAY_TOKEN_ENV, MISSION_GATEWAY_URL_ENV, isMissionGatewayDef } from '../mcp/mission';
import { installPiAgentOverrides } from '../pi-agents';
import { errorMessage, withTimeout } from '../util/async';
import { PI_ENV_KEYS, piThinkingLevel } from './pi-models';
import { usesWindowsCommandShim } from './spawn';
import { missionPrompt, sessionAppendPrompt } from './system-prompt';
import type { HarnessContext } from './types';

/**
 * pi-subagents' delegation tools, kept out of a mission session (which delegates through its
 * Builders) alongside our own subagent extension, which such a session never loads.
 */
const PI_DELEGATION_TOOLS = ['Agent', 'get_subagent_result'];
/** Tells the Pi gate (resources/pi/subagent-gate.ts) the session is a Mission Builder. */
const MISSION_BUILDER_ENV = 'VOCS_CODE_MISSION_BUILDER';

const PI_TOOL_PROMPT = 'Pi tools: prefer path (file_path is accepted). edit uses edits[]; a single old_string/new_string pair is accepted, including empty new_string. replace_all:true is unsupported: use unique non-overlapping edits. bash timeout is seconds; timeout_ms explicitly means milliseconds. Never send both timeout fields or guess their units.';

/**
 * The user's extra arguments with the delegation tools excluded too. Pi 0.85.1 keeps only the last
 * `--exclude-tools`, so the user's own exclusions are folded into one flag, placed last.
 */
function withDelegationExcluded(extraArgs: readonly string[]): string[] {
  const rest: string[] = [];
  const excluded: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    const list = arg === '--exclude-tools' ? extraArgs[++i] : arg.startsWith('--exclude-tools=') ? arg.slice('--exclude-tools='.length) : undefined;
    if (list === undefined && arg !== '--exclude-tools') rest.push(arg);
    else excluded.push(...(list ?? '').split(',').map((name) => name.trim()).filter(Boolean));
  }
  return [...rest, '--exclude-tools', [...new Set([...excluded, ...PI_DELEGATION_TOOLS])].join(',')];
}

async function appendSystemPrompt(args: string[], value: string, command: string, fallbackFile: string): Promise<void> {
  let argument = value;
  if (usesWindowsCommandShim(command) && /[%\r\n]/.test(value)) {
    // Pi accepts prompt-file paths. This crosses cmd.exe without changing the prompt text.
    await fs.writeFile(fallbackFile, value, 'utf8');
    argument = fallbackFile;
  }
  args.push('--append-system-prompt', argument);
}

/**
 * Persist the effort the user chose so the bundled extension can forward it to OpenRouter. pi
 * clamps a level against the model's bundled map before each request, and that map can lag
 * OpenRouter's live catalog (it hides `low`/`max` and promotes `max` to `xhigh` for DeepSeek).
 * Only levels the live catalog advertises are written; anything else clears the file so pi's own
 * mapping stands.
 */
export async function writePiEffortConfig(
  ctx: HarnessContext,
  effortFile: string | null,
  effort: EffortLevel | undefined,
  model: ModelRef | undefined
): Promise<void> {
  if (!effortFile) return;
  const provider = model ? ctx.settings().providers.find((p) => p.kind === 'openrouter' && p.id === model.provider) : undefined;
  const supported = provider?.models.find((m) => m.id === model?.model)?.supportedEfforts;
  const payload = model && effort && supported?.includes(effort) ? { provider: model.provider, model: model.model, effort } : null;
  try {
    await fs.writeFile(effortFile, JSON.stringify(payload), 'utf8');
  } catch (e) {
    ctx.log('warn', `failed to write pi reasoning effort file: ${errorMessage(e)}`);
  }
}

export async function writePiPermissionMode(ctx: HarnessContext, modeFile: string | null, mode: PermissionMode): Promise<void> {
  // The approvals extension re-reads this file before every tool call.
  if (!modeFile) return;
  try {
    await fs.writeFile(modeFile, mode, 'utf8');
  } catch (e) {
    // Surface the failure: silently keeping the old mode active would grant or withhold
    // permissions behind the user's back.
    ctx.log('warn', `failed to write permission mode file: ${errorMessage(e)}`);
  }
}

export interface PreparedPiLaunch {
  bin: { path: string; source: string };
  args: string[];
  env: NodeJS.ProcessEnv;
  modeFile: string;
  effortFile: string;
  missionLaunch: boolean;
  intendedEffort: EffortLevel | undefined;
}

export async function preparePiLaunch(
  ctx: HarnessContext,
  opts: { extensionNonce: string; fastModeRequested: boolean }
): Promise<PreparedPiLaunch> {
  const meta = ctx.session();
  const s = ctx.settings();
  const intendedEffort = ctx.effort();
  const extraArgs = s.pi.extraArgs ?? [];
  const bin = ctx.runtime.resolve('pi');
  if (!bin) throw new Error('pi is not installed. Run `npm install -g @earendil-works/pi-coding-agent` or set the path in Settings.');
  const ext = ctx.runtime.resource('pi', 'vocs-code-approvals.ts');
  const toolsExt = ctx.runtime.resource('pi', 'vocs-code-tools.ts');
  const mcpExt = ctx.runtime.resource('pi', 'vocs-code-mcp.ts');
  const subagentsExt = ctx.runtime.resource('pi', 'vocs-code-subagents.ts');
  const sessionDir = path.join(ctx.sessionDir, 'pi');
  await fs.mkdir(sessionDir, { recursive: true });

  // Subagents inherit the session model: override pi-subagents' pinned Explore agent in pi's
  // global agent dir, without clobbering a user's file there. The same pass drops a legacy
  // project copy and turns on usage reporting so subagent spend reaches the session totals and
  // analytics.
  await installPiAgentOverrides({
    cwd: meta.cwd,
    log: (level, message) => ctx.log(level, `[pi] ${message}`)
  });

  const mcpServers = (await ctx.mcpServers()).map(({ def }) => def);
  // The bridge consumes the gateway definitions (memory, Mission) from the launch environment,
  // never the file. Also exclude incomplete gateway definitions rather than persisting any part of them.
  const gatewayServers = mcpServers.filter((server) => isMissionGatewayDef(server) || (server.id === VOCS_MEMORY_SERVER_ID
    && (server.env?.[MEMORY_GATEWAY_URL_ENV] !== undefined || server.env?.[MEMORY_GATEWAY_TOKEN_ENV] !== undefined)));
  const ephemeral = gatewayServers;
  const persisted = mcpServers.filter((server) => !gatewayServers.includes(server));
  // A mission session delegates through its Builders: no subagent extension of ours, and none of
  // pi-subagents' tools either.
  const missionLaunch = !!meta.mission;
  const args = ['--mode', 'rpc',
    '-e', ext, '-e', toolsExt, '-e', ctx.runtime.resource('pi', 'vocs-code-fast-mode.ts'), ...(missionLaunch ? [] : ['-e', subagentsExt]), '--session-dir', sessionDir];
  if (persisted.length || ephemeral.length) args.push('-e', mcpExt);
  const mcpConfigFile = path.join(sessionDir, 'mcp.json');
  if (persisted.length) await fs.writeFile(mcpConfigFile, JSON.stringify({ servers: persisted }, null, 2) + '\n', 'utf8');
  else await fs.rm(mcpConfigFile, { force: true }); // A resumed/disabled session may still have the older generated file.
  if (meta.harnessRef.piSessionFile) args.push('--session', meta.harnessRef.piSessionFile);
  if (meta.config.model) {
    if (meta.config.model.provider) args.push('--provider', meta.config.model.provider);
    args.push('--model', meta.config.model.model);
  }
  const level = piThinkingLevel(intendedEffort);
  if (level) args.push('--thinking', level);
  const append = sessionAppendPrompt(meta, await ctx.appInstructions?.(), await missionPrompt(ctx));
  if (append) {
    await appendSystemPrompt(args, append, bin.path, path.join(sessionDir, 'append-system-prompt.txt'));
  }
  await appendSystemPrompt(args, PI_TOOL_PROMPT, bin.path, path.join(sessionDir, 'tool-system-prompt.txt'));
  args.push(...(missionLaunch ? withDelegationExcluded(extraArgs) : extraArgs));

  const modeFile = path.join(sessionDir, 'permission-mode.txt');
  await fs.writeFile(modeFile, ctx.permissionMode(), 'utf8');
  const effortFile = path.join(sessionDir, 'reasoning-effort.json');
  await writePiEffortConfig(ctx, effortFile, intendedEffort, meta.config.model);

  const env: NodeJS.ProcessEnv = { ...process.env, VOCS_CODE_PERMISSION_MODE: ctx.permissionMode(), VOCS_CODE_MODE_FILE: modeFile, VOCS_CODE_PI_NONCE: opts.extensionNonce, VOCS_CODE_EFFORT_FILE: effortFile, VOCS_CODE_SUBAGENT_DIR: path.join(sessionDir, 'subagents'), VOCS_CODE_PROJECT_ROOT: meta.config.projectRoot, VOCS_CODE: '1' };
  // Explicit on every launch: resume and inherited parent env cannot restore stale Fast mode.
  env.VOCS_CODE_FAST_MODE = opts.fastModeRequested ? '1' : '0';
  // Never inherit another session's MCP config, gateway capabilities or Mission role.
  const reservedEnv = ['VOCS_CODE_MCP_EPHEMERAL', 'VOCS_CODE_MCP_CONFIG', MEMORY_GATEWAY_URL_ENV, MEMORY_GATEWAY_TOKEN_ENV, MISSION_GATEWAY_URL_ENV, MISSION_GATEWAY_TOKEN_ENV, MISSION_BUILDER_ENV];
  for (const key of Object.keys(env)) {
    if (reservedEnv.includes(process.platform === 'win32' ? key.toUpperCase() : key)) delete env[key];
  }
  if (meta.mission?.role === 'builder') env[MISSION_BUILDER_ENV] = '1';
  if (ephemeral.length) env.VOCS_CODE_MCP_EPHEMERAL = JSON.stringify({ servers: ephemeral });
  if (persisted.length) env.VOCS_CODE_MCP_CONFIG = mcpConfigFile;
  for (const [pid, envKey] of Object.entries(PI_ENV_KEYS)) {
    if (!env[envKey]) {
      const key = await ctx.getApiKey(pid);
      if (key) env[envKey] = key;
    }
  }

  return { bin, args, env, modeFile, effortFile, missionLaunch, intendedEffort };
}

/** Windows names cmd.exe in ENOENT even if the saved working directory is missing; check the folder. */
export async function checkMissingPiSessionDir(cwd: string): Promise<boolean> {
  return withTimeout(fs.stat(cwd), 1_000, 'Pi session folder check').then(
    (stat) => !stat.isDirectory(),
    (e: NodeJS.ErrnoException) => e.code === 'ENOENT' || e.code === 'ENOTDIR'
  );
}
