/** Vesta's capability allowlist: the only part of the IPC surface the model can reach.
 *
 *  The handler registry serves 100+ channels, including keychain writes and raw PTY input,
 *  so the default is closed: a capability exists here or it does not exist at all. Each entry
 *  owns its own JSON Schema, its risk tier, a human summary for the proposal card and a
 *  projection that trims the channel's reply down to what the model actually needs.
 *
 *  Adding a capability is deliberately a code change with a test, not configuration. */
import type { IpcChannel } from './ipc';
import type { AppSettings, HarnessId, McpServerDef, ModelInfo, ModelRef, SessionMeta } from './types';
import type { RiskTier } from './agent';
import { HARNESSES } from './harness-meta';
import { modelName, parseTypedModel } from './model-names';
import { rememberedModel, resolveNewSessionDefaults } from './session-defaults';

/** What a capability can consult while building its channel request. */
export interface CapabilityContext {
  settings: AppSettings;
  /** The models a harness offers before any process exists: the New Session dialog's list (`harness:models`). */
  models(harness: HarnessId): Promise<{ models: ModelInfo[]; error?: string }>;
}

export interface AgentCapability {
  /** Tool name exposed to the model. */
  name: string;
  channel: IpcChannel;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Risk of this particular request. A stdio MCP probe spawns a command, so it is not a read. */
  tier(args: Record<string, unknown>): RiskTier;
  /** One line naming exactly what will happen, shown on the proposal card and the tool row. */
  summarize(args: Record<string, unknown>): string;
  /** Maps tool args onto the channel's request shape. May consult the context asynchronously; a throw
   *  is reported to the model as invalid arguments and the channel is never invoked. */
  request(args: Record<string, unknown>, ctx: CapabilityContext): unknown | Promise<unknown>;
  /** Trims the channel reply before the model sees it; also keeps bulky payloads out of history. */
  project?(result: unknown): unknown;
}

/* ------------------------------------------------------------------ */
/* Shared schema fragments                                            */
/* ------------------------------------------------------------------ */

const MCP_SERVER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short unique id, e.g. "gitnexus".' },
    transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
    command: { type: 'string', description: 'stdio only: the executable, e.g. "npx".' },
    args: { type: 'array', items: { type: 'string' }, description: 'stdio only.' },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'stdio only. Use ${VAR} to reference a secret; never inline a real token.' },
    url: { type: 'string', description: 'http/sse only: the endpoint URL.' },
    headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'http/sse only. Use ${VAR} for secrets.' },
    description: { type: 'string' }
  },
  required: ['id', 'transport'],
  additionalProperties: false
} as const;

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v ? v : fallback;
}

function serverOf(args: Record<string, unknown>): Partial<McpServerDef> {
  const s = args.server;
  return s && typeof s === 'object' ? (s as Partial<McpServerDef>) : {};
}

function describeServer(s: Partial<McpServerDef>): string {
  if (s.transport === 'stdio') return `${str(s.command, '?')} ${(Array.isArray(s.args) ? s.args : []).join(' ')}`.trim();
  return str(s.url, '(no url)');
}

const HARNESS_IDS = HARNESSES.map((h) => h.id);

function isHarnessId(v: string): v is HarnessId {
  return (HARNESS_IDS as string[]).includes(v);
}

/** The harness a new session runs on: the argument when given, else the configured default. */
export function sessionHarness(args: Record<string, unknown>, settings: AppSettings, fallback: HarnessId = settings.defaultHarness): HarnessId {
  const harness = str(args.harness) || fallback;
  if (!isHarnessId(harness)) throw new Error(`Unknown harness "${harness}". Harness ids: ${HARNESS_IDS.join(', ')}.`);
  return harness;
}

/** How many catalog names an error lists before it counts the rest. */
const MODEL_HINTS = 30;

/**
 * Reads create_session's `model` argument against the harness's own catalog, the list the New
 * Session dialog offers, so a session never starts on an id the harness would reject. Accepts the
 * canonical `provider/model` name or a bare model id when only one provider offers it.
 */
export async function resolveSessionModel(typed: string, harness: HarnessId, ctx: CapabilityContext): Promise<ModelRef> {
  const { models, error } = await ctx.models(harness);
  if (!models.length) {
    throw new Error(`The ${harness} harness lists no models to check "${typed}" against${error ? ` (${error})` : ''}. Omit model to start on the harness default.`);
  }
  const names = models.map((m) => modelName(m.provider, m.id));
  const providers = Array.from(new Set(models.map((m) => m.provider)));
  // No fallback provider: a head that names no known provider is part of the id (`z-ai/glm-4.6`).
  const ref = parseTypedModel(typed.trim(), providers, '');
  const matches = ref.provider ? models.filter((m) => m.provider === ref.provider && m.id === ref.model) : models.filter((m) => m.id === ref.model);
  if (matches.length === 1) return { provider: matches[0].provider, model: matches[0].id };
  if (matches.length > 1) {
    throw new Error(`"${typed}" is offered by several providers on ${harness} (${matches.map((m) => modelName(m.provider, m.id)).join(', ')}). Pass the full provider/model name.`);
  }
  // A known provider narrows the hint to its own models; otherwise names containing the id come first.
  const needle = ref.model.toLowerCase();
  const near = ref.provider ? names.filter((n) => n.startsWith(`${ref.provider}/`)) : needle ? names.filter((n) => n.toLowerCase().includes(needle)) : [];
  const pool = near.length ? near : names;
  const shown = pool.slice(0, MODEL_HINTS);
  const rest = pool.length - shown.length;
  const label = near.length ? (ref.provider ? `${ref.provider} offers` : 'Did you mean') : 'Available';
  throw new Error(`"${typed}" is not a model the ${harness} harness offers. ${label}: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`);
}

/* ------------------------------------------------------------------ */
/* The allowlist                                                      */
/* ------------------------------------------------------------------ */

export const AGENT_CAPABILITIES: AgentCapability[] = [
  /* ---- read ---- */
  {
    name: 'list_sessions',
    channel: 'sessions:list',
    description: 'List the sessions in Vocs Code with their project folder, harness and status. Use this to resolve a project the user named ("the Vocs-Code project") to a session id, which most other tools need.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tier: () => 'read',
    summarize: () => 'List sessions',
    request: () => undefined,
    project: (result) =>
      (Array.isArray(result) ? (result as SessionMeta[]) : []).map((s) => ({
        id: s.id,
        title: s.title,
        harness: s.config.harness,
        projectRoot: s.config.projectRoot,
        cwd: s.cwd,
        branch: s.worktreeBranch,
        status: s.status,
        archived: !!s.archived
      }))
  },
  {
    name: 'get_app_settings',
    channel: 'settings:get',
    description: 'Read the parts of the Vocs Code configuration that matter for setup: the global MCP servers, the default harness, and the known project folders.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tier: () => 'read',
    summarize: () => 'Read settings',
    request: () => undefined,
    // Deliberately narrow: `settings:get` also carries the provider table, which must never
    // reach a model prompt even though it holds flags rather than key material.
    project: (result) => {
      const s = (result ?? {}) as Partial<AppSettings>;
      return {
        defaultHarness: s.defaultHarness,
        folders: s.folders ?? [],
        mcpServers: s.mcpServers ?? [],
        utilityModel: s.utilityModel
      };
    }
  },
  {
    name: 'list_harnesses',
    channel: 'harness:availability',
    description: 'Which coding harnesses (claude, codex, pi, native, …) are installed and usable on this machine.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tier: () => 'read',
    summarize: () => 'Check harness availability',
    request: () => undefined
  },
  {
    name: 'list_branches',
    channel: 'git:branchesOverview',
    description: 'Local git branches for a session\'s repository, each with its last commit time, ahead/behind counts, whether it is merged into the base branch, and whether a worktree holds it. Use the lastCommitAt timestamps to answer questions about branch age.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'A session in the repository, from list_sessions.' } },
      required: ['session_id'],
      additionalProperties: false
    },
    tier: () => 'read',
    summarize: () => 'List git branches',
    request: (a) => ({ sessionId: str(a.session_id) })
  },
  {
    name: 'git_status',
    channel: 'git:summary',
    description: 'Working-tree status for a session: current branch, changed files, ahead/behind.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false
    },
    tier: () => 'read',
    summarize: () => 'Read git status',
    request: (a) => ({ sessionId: str(a.session_id) })
  },
  {
    name: 'list_mcp_stores',
    channel: 'mcp:stores',
    description: 'MCP servers already configured in each harness\'s own global store (Claude, Codex, Cursor, …), which can be imported into Vocs Code.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tier: () => 'read',
    summarize: () => 'List harness MCP stores',
    request: () => undefined
  },
  {
    name: 'get_project_mcp',
    channel: 'mcp:project',
    description: 'The MCP servers that apply to one session: the repository\'s .mcp.json, the global list, the per-repo switches, and what the session will actually receive.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false
    },
    tier: () => 'read',
    summarize: () => 'Read the project MCP configuration',
    request: (a) => ({ sessionId: str(a.session_id) })
  },
  {
    name: 'probe_mcp_server',
    channel: 'mcp:inspect',
    description:
      'Connect to an MCP server definition, list its tools and disconnect — the "Test connection" check. Always probe before proposing a server. For http/sse this is a plain network call; a 401 tells you which credential the server wants. For stdio it runs the given command, so it needs the user\'s approval first.',
    parameters: {
      type: 'object',
      properties: { server: MCP_SERVER_SCHEMA, session_id: { type: 'string', description: 'Optional: run a stdio probe in this session\'s working directory.' } },
      required: ['server'],
      additionalProperties: false
    },
    // An http probe is a fetch; a stdio probe executes a command line the model chose, which
    // typically downloads and runs a package. Same class of action the approval system gates.
    tier: (a) => (serverOf(a).transport === 'stdio' ? 'write' : 'read'),
    summarize: (a) => {
      const s = serverOf(a);
      return s.transport === 'stdio' ? `Run "${describeServer(s)}" to test the ${str(s.id, 'new')} MCP server` : `Test the connection to ${describeServer(s)}`;
    },
    request: (a) => ({ def: serverOf(a), sessionId: str(a.session_id) || undefined })
  },

  /* ---- write ---- */
  {
    name: 'create_session',
    channel: 'sessions:create',
    description:
      'Start a new Vocs Code session in a project folder, optionally with its first prompt already sent. The folder must be one the app already knows (see get_app_settings.folders or list_sessions). Without model the session starts on the harness\'s configured default model; with model it must be one that harness offers, and a wrong id fails with the names it does offer.',
    parameters: {
      type: 'object',
      properties: {
        project_root: { type: 'string', description: 'Absolute path of the project folder.' },
        prompt: { type: 'string', description: 'First message to send once the session starts.' },
        title: { type: 'string' },
        harness: { type: 'string', description: `Harness id (${HARNESS_IDS.join(', ')}); defaults to the one remembered for that folder.` },
        model: { type: 'string', description: 'Model to start on as "provider/model" (e.g. "anthropic/claude-opus-5"), from the models the chosen harness offers. Omit for the harness default.' },
        use_worktree: { type: 'boolean', description: 'Run in an isolated git worktree.' }
      },
      required: ['project_root'],
      additionalProperties: false
    },
    tier: () => 'write',
    summarize: (a) =>
      `Create a session in ${str(a.project_root, '?')}${a.model ? ` on ${str(a.model)}` : ''}${a.prompt ? ` and send: "${str(a.prompt).slice(0, 80)}"` : ''}`,
    request: async (a, ctx) => {
      const projectRoot = str(a.project_root);
      // A session started for a folder follows that folder's remembered choices, the same ones the
      // New Session dialog opens on; an explicit harness argument still wins over the folder's.
      const defaults = resolveNewSessionDefaults(ctx.settings, projectRoot);
      const harness = sessionHarness(a, ctx.settings, defaults.harness);
      const typed = str(a.model);
      return {
        config: {
          harness,
          projectRoot,
          permissionMode: defaults.permissionMode,
          model: typed ? await resolveSessionModel(typed, harness, ctx) : rememberedModel(ctx.settings, projectRoot, harness),
          effort: defaults.effort || undefined,
          useWorktree: typeof a.use_worktree === 'boolean' ? a.use_worktree : defaults.useWorktree
        },
        title: str(a.title) || undefined,
        initialPrompt: str(a.prompt) || undefined
      };
    },
    project: (result) => {
      const s = result as SessionMeta | null;
      return s ? { id: s.id, title: s.title, cwd: s.cwd, status: s.status } : null;
    }
  },
  {
    name: 'rename_session',
    channel: 'sessions:rename',
    description: 'Change a session\'s title.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string' }, title: { type: 'string' } },
      required: ['session_id', 'title'],
      additionalProperties: false
    },
    tier: () => 'write',
    summarize: (a) => `Rename a session to "${str(a.title)}"`,
    request: (a) => ({ id: str(a.session_id), title: str(a.title) }),
    project: () => ({ ok: true })
  },
  {
    name: 'add_global_mcp_server',
    channel: 'mcp:import',
    description:
      'Add (or replace, by id) an MCP server in the global list, which every harness that supports MCP will receive. Never put a real token in env or headers: write ${TOKEN_NAME} and tell the user to paste the value into the key field, which stores it in the OS keychain.',
    parameters: {
      type: 'object',
      properties: { server: MCP_SERVER_SCHEMA },
      required: ['server'],
      additionalProperties: false
    },
    tier: () => 'write',
    summarize: (a) => {
      const s = serverOf(a);
      return `Add the global MCP server "${str(s.id, '?')}" (${str(s.transport, '?')}: ${describeServer(s)})`;
    },
    request: (a) => ({ servers: [serverOf(a)], to: 'global' })
  },
  {
    name: 'save_project_mcp_servers',
    channel: 'mcp:project:save',
    description: 'Rewrite the mcpServers table of a session repository\'s .mcp.json. This file is usually committed, so it affects everyone working on the repo. Pass the complete list, not just the addition — read get_project_mcp first.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string' }, servers: { type: 'array', items: MCP_SERVER_SCHEMA } },
      required: ['session_id', 'servers'],
      additionalProperties: false
    },
    tier: () => 'write',
    summarize: (a) => {
      const list = Array.isArray(a.servers) ? (a.servers as Partial<McpServerDef>[]) : [];
      return `Write ${list.length} server${list.length === 1 ? '' : 's'} to the repository's .mcp.json (${list.map((s) => str(s.id, '?')).join(', ') || 'none'})`;
    },
    request: (a) => ({ sessionId: str(a.session_id), servers: Array.isArray(a.servers) ? a.servers : [] })
  },

  /* ---- destructive ---- */
  {
    name: 'delete_branch',
    channel: 'git:deleteBranch',
    description: 'Delete one local git branch. Check list_branches first: deleting an unmerged branch loses work, and a branch held by a worktree cannot be deleted. Propose one call per branch.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        branch: { type: 'string' },
        force: { type: 'boolean', description: 'Delete even when the branch is not merged. Loses commits.' }
      },
      required: ['session_id', 'branch'],
      additionalProperties: false
    },
    tier: () => 'destructive',
    summarize: (a) => `Delete branch ${str(a.branch, '?')}${a.force ? ' (force — unmerged commits are lost)' : ''}`,
    request: (a) => ({ sessionId: str(a.session_id), branch: str(a.branch), force: a.force === true })
  }
];

export const CAPABILITIES_BY_NAME = new Map(AGENT_CAPABILITIES.map((c) => [c.name, c]));

/** Channels the context consults on a capability's behalf (see CapabilityContext), not tools themselves. */
const CONTEXT_CHANNELS: IpcChannel[] = ['harness:models'];

/** Channels Vesta may reach. Used by tests to prove the surface stays deliberate. */
export function agentChannels(): IpcChannel[] {
  return Array.from(new Set([...AGENT_CAPABILITIES.map((c) => c.channel), ...CONTEXT_CHANNELS]));
}
