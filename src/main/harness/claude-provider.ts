/** Claude Code provider routing, launch env scrubbing, project instructions, commands, and pre-session model discovery. */
import path from 'node:path';
import { query, type SDKUserMessage, type SettingSource, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { assertEndpointUrl } from '../../shared/endpoint-policy';
import type { HarnessCommand } from '../../shared/harness-commands';
import { anthropicAuthFor, anthropicBaseUrlFor, ANTHROPIC_DEFAULT_BASE_URL, isClaudeCapableProvider } from '../../shared/providers';
import type { AppSettings, ModelInfo, ModelRef, ProviderConfig } from '../../shared/types';
import { hasClaudeAgentPins } from '../claude-agents';
import { claudeSdkCatalog } from '../models/claude-catalog';
import { resolveProviderApiKey } from '../models/providers';
import { AsyncQueue, withTimeout } from '../util/async';
import { exists } from '../util/fs';
import { projectInstructionBlock } from './project-instructions';

export const APP_ID = 'vocs-code/0.1.0';

/**
 * How many subagents one session may run at once. Claude Code's own default is 20, a number tuned
 * for a single terminal; a session here fans out deliberately (a review spread across thirty
 * areas), and a spawn past the cap is refused outright, so the tail of that fan-out is lost. Each
 * concurrent run is its own conversation, so cost is the real brake, not this number.
 */
export const MAX_CONCURRENT_SUBAGENTS = 32;

/**
 * Claude Code's own project-document names. With `'project'` in `settingSources` its engine
 * discovers these itself (following `@` imports), so the adapter must leave them to it: handing the
 * same instructions over again costs context and buries the file that was actually missing. The
 * bundled CLI reads no other instruction file, so a project whose rules live only in `AGENTS.md` —
 * the convention pi, Codex and the native loop follow — would otherwise run unprimed.
 */
const CLAUDE_PROJECT_DOC_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

/**
 * The project instructions the Claude engine does not read. `AGENTS.md` is added only where the
 * directory has no Claude document, matching the engine's own fallback rule (never both for one
 * directory) so a repo that maintains `CLAUDE.md` — e.g. `@AGENTS.md` — is not duplicated.
 * `.vocs-code/INSTRUCTIONS.md` has no engine equivalent, so it is added whenever it exists.
 */
export async function claudeProjectInstructions(cwd: string): Promise<string | undefined> {
  let agents = true;
  for (const name of CLAUDE_PROJECT_DOC_FILES) {
    if (await exists(path.join(cwd, name))) {
      agents = false;
      break;
    }
  }
  const names = [...(agents ? ['AGENTS.md'] : []), '.vocs-code/INSTRUCTIONS.md'];
  return (await projectInstructionBlock(cwd, names)) || undefined;
}

/**
 * The CLI's command rows as the composer offers them. Rows can share a name; `/name` runs the
 * built-in one when a built-in row has it, so that is the row kept. Anything not built in is a user,
 * project, plugin or MCP command — all of which Claude Code now loads as skills.
 */
export function claudeHarnessCommands(commands: readonly SlashCommand[]): HarnessCommand[] {
  const builtin = new Set(commands.filter((c) => c.builtin).map((c) => c.name.trim().toLowerCase()));
  return commands
    .filter((c) => c.builtin || !builtin.has(c.name.trim().toLowerCase()))
    .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases, kind: c.builtin ? 'command' : 'skill' }));
}

/** Scrubs nested-Claude host variables (and any extra gateway/ephemeral keys) from a launch env. */
export function scrubClaudeLaunchEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraStripNames?: ReadonlySet<string>
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv, CLAUDE_AGENT_SDK_CLIENT_APP: APP_ID };
  // Never let this app's own Claude Code host variables leak into a nested session.
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_USE_BEDROCK' && k !== 'CLAUDE_CODE_USE_VERTEX' && k !== 'CLAUDE_CODE_USE_FOUNDRY') delete env[k];
    if (extraStripNames) {
      const name = process.platform === 'win32' ? k.toUpperCase() : k;
      if (extraStripNames.has(name)) delete env[k];
    }
  }
  delete env.CLAUDECODE;
  return env;
}

/**
 * Make a delegated agent run on the session's own model.
 *
 * Claude Code resolves a subagent's model from its definition before anything else, and its
 * built-ins (`Explore`, `Plan`) declare `inherit` — which on a provider that is not Anthropic does
 * not mean the session's model but Claude's own default, an Anthropic id the endpoint answers with
 * a 401. So naming the model here is what makes "a subagent runs on the model this session runs
 * on" true rather than merely intended.
 *
 * `_FORCE` is required as well, not belt-and-braces: the built-ins' `inherit` is resolved before
 * the plain variable and wins over it. It is withheld exactly when the project pins a model of its
 * own, because FORCE outranks a definition's `model:` line too and would silently ignore the pin.
 */
export async function subagentModelEnv(projectRoot: string, model: string | undefined): Promise<Record<string, string | undefined>> {
  if (!model) return {};
  const env: Record<string, string | undefined> = { CLAUDE_CODE_SUBAGENT_MODEL: model };
  const pinned = await hasClaudeAgentPins(projectRoot).catch(() => false);
  if (!pinned) env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  return env;
}

/** The Claude-capable provider that backs a session: the provider its model came from when that
 *  provider can host Claude Code, else the built-in Anthropic provider. */
export function claudeProviderFor(settings: AppSettings, model: ModelRef | undefined): ProviderConfig | undefined {
  const capable = settings.providers.filter(isClaudeCapableProvider);
  return capable.find((p) => p.id === model?.provider) ?? capable.find((p) => p.id === 'anthropic') ?? capable[0];
}

/**
 * Env overlay that points Claude Code at a provider's Anthropic-format endpoint. Every non-Anthropic
 * route is wired from that base URL automatically, with the stored key sent in the header that route
 * reads (a bearer token for most gateways, `x-api-key` for OpenCode Zen) and an inherited Anthropic
 * x-api-key cleared so it is never sent to the gateway. Anthropic's own endpoint passes the stored
 * key only when the user opted in, and otherwise keeps the login.
 */
export function claudeProviderEnv(settings: AppSettings, provider: ProviderConfig | undefined, apiKey: string | undefined): Record<string, string | undefined> {
  if (!provider) return {};
  const baseUrl = anthropicBaseUrlFor(provider);
  if (baseUrl) assertEndpointUrl(baseUrl);
  if (baseUrl && baseUrl !== ANTHROPIC_DEFAULT_BASE_URL) {
    // Zen's Anthropic route reads x-api-key and answers a bearer token with "Missing API key".
    if (anthropicAuthFor(provider) === 'api-key') {
      return { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: baseUrl };
    }
    const overlay: Record<string, string | undefined> = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: baseUrl };
    if (apiKey) overlay.ANTHROPIC_AUTH_TOKEN = apiKey;
    return overlay;
  }
  return settings.claude.useProviderKey && apiKey ? { ANTHROPIC_API_KEY: apiKey } : {};
}

/**
 * claudeProviderEnv with the provider's stored key or, failing that, the key in its env var. That
 * key still has to be handed over explicitly: the child inherits the process env, but a gateway
 * reads a header this app has to set. Sessions and the pre-session model probe both resolve their
 * credentials here, so the probe starts with the endpoint and key of the session it lists models for.
 */
export async function resolveClaudeProviderEnv(settings: AppSettings, provider: ProviderConfig | undefined, getApiKey: (id: string) => Promise<string | undefined>): Promise<Record<string, string | undefined>> {
  const baseUrl = provider && anthropicBaseUrlFor(provider);
  if (baseUrl) assertEndpointUrl(baseUrl);
  // The default route does not overlay the child's base URL. Before injecting an app key,
  // validate the inherited endpoint too; external CLI-owned config remains the CLI's responsibility.
  if (provider && settings.claude.useProviderKey && baseUrl === ANTHROPIC_DEFAULT_BASE_URL && process.env.ANTHROPIC_BASE_URL) assertEndpointUrl(process.env.ANTHROPIC_BASE_URL);
  const key = provider ? await resolveProviderApiKey(provider, getApiKey) : undefined;
  return claudeProviderEnv(settings, provider, key);
}

/**
 * Discover the models the selected Claude Code runtime offers to its current login. The streaming
 * input stays open only long enough for the SDK initialization handshake; no user turn is sent.
 * `settingSources` are the ones sessions load (`settings.claude.settingSources`).
 */
export async function listClaudeModels(
  pathToClaudeCodeExecutable: string,
  envOverlay: Record<string, string | undefined> = {},
  settingSources: SettingSource[] = []
): Promise<ModelInfo[]> {
  const input = new AsyncQueue<SDKUserMessage>();
  const abortController = new AbortController();
  const env = scrubClaudeLaunchEnv(process.env);
  Object.assign(env, envOverlay);

  const q = query({
    prompt: input,
    options: {
      // Model discovery is global to the runtime/login. Do not let an IPC-provided project path load
      // project settings, hooks or MCP servers into this short-lived process.
      cwd: process.cwd(),
      pathToClaudeCodeExecutable,
      permissionMode: 'plan',
      // ~/.claude/settings.json decides what a session runs against: its env (base URL, Bedrock or
      // Vertex), apiKeyHelper and model. Read it whenever sessions do, or the list describes a
      // different endpoint. Project and local settings resolve against cwd, which here is this app's
      // own directory rather than any project, so they stay out.
      settingSources: settingSources.filter((source) => source === 'user'),
      // User settings also declare hooks and MCP servers; this process only answers supportedModels().
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      persistSession: false,
      env,
      abortController
    }
  });
  try {
    return claudeSdkCatalog(await withTimeout(q.supportedModels(), 20_000, 'Claude supportedModels'));
  } finally {
    input.close();
    abortController.abort();
    q.close();
  }
}
