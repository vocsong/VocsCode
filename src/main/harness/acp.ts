import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import type { AcpAgentPreset, ApprovalOption, EffortLevel, FileChange, McpServerDef, ModelInfo, ModelRef, PermissionMode, TranscriptItem, UsageTotals, UserInput } from '../../shared/types';
import { HARNESS_BY_ID, isEffortLevel } from '../../shared/harness-meta';
import { errorMessage, shortId, truncate, withTimeout } from '../util/async';
import { which } from '../runtime';
import { toAcp } from '../mcp/effective';
import { isDangerousCommand, type HarnessAdapter, type HarnessContext } from './types';
import { isOutsideWorkspace } from './permissions';
import { shutdownChild, spawnTool } from './spawn';
import { makeFileChange } from '../util/file-changes';
import { TurnUsageTracker } from '../util/turn-usage';
import { ANTIGRAVITY_ACP_ARGS, ANTIGRAVITY_SIGN_IN_MESSAGE, antigravityAccountEnv, connectAcp, isAntigravityAuthRequired } from './antigravity';
import { acpModelCatalog, decodeAcpModelValue, findEffortOption, findModelOption, flattenSelect, type ConfigOptionLike } from './acp-config';

const ACP_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY'
};

// The ACP prompt result is the only proof of completion. Recover a quiet Antigravity
// stream as failed, not completed, and allow an explicit interrupt even without prose.
export const ANTIGRAVITY_PROMPT_QUIET_MS = 180_000;
export const ANTIGRAVITY_CANCEL_GRACE_MS = 5_000;

type ActivePrompt = {
  startedAt: number;
  quietTimer?: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
  recovering?: boolean;
};

export class AcpAdapter implements HarnessAdapter {
  private child: ChildProcess | null = null;
  private childShutdown: Promise<void> | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private prompt: ActivePrompt | null = null;
  private pendingPermissions = 0;
  private queue: UserInput[] = [];
  private currentAssistant: Extract<TranscriptItem, { kind: 'assistant' }> | null = null;
  private toolItems = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  private configOptions: ConfigOptionLike[] = [];
  private caps: Record<string, unknown> = {};
  private readonly usage: TurnUsageTracker;
  private sessionAllowedKinds = new Set<string>();
  private preset: AcpAgentPreset | null = null;
  private sessionModes?: acp.SessionModeState | null;
  private applyingMode = false;
  /** Clean ModelRef -> the agent's raw option value (tuple-advertising agents key choices by it). */
  private modelValues = new Map<string, string>();

  constructor(private readonly ctx: HarnessContext, readonly id: 'acp' | 'antigravity' = 'acp') {
    this.usage = new TurnUsageTracker(ctx.session().usage);
  }

  get busy(): boolean {
    return this.prompt !== null;
  }

  private resolvePreset(): AcpAgentPreset {
    const s = this.ctx.settings();
    const id = this.ctx.session().config.acpAgent ?? 'dsh';
    const preset = s.acpAgents.find((a) => a.id === id) ?? s.acpAgents[0];
    if (!preset) throw new Error('No ACP agent preset configured.');
    return preset;
  }

  private async killChild(): Promise<void> {
    if (this.childShutdown) return this.childShutdown;
    const child = this.child;
    this.conn = null;
    this.child = null;
    this.pendingPermissions = 0;
    if (!child) return;
    this.childShutdown = shutdownChild(child, 2000);
    try {
      await this.childShutdown;
    } finally {
      this.childShutdown = null;
    }
  }

  private async resolveLaunch() {
    if (this.id === 'antigravity') {
      const binary = this.ctx.runtime.resolve('agy');
      if (!binary) throw new Error('Install Antigravity CLI (agy) from Settings → Providers & keys → Harness logins.');
      const preset = {
        id: this.id, name: HARNESS_BY_ID[this.id].name, description: '',
        command: binary.path, args: [...ANTIGRAVITY_ACP_ARGS]
      };
      return { preset, command: preset.command, args: preset.args, env: antigravityAccountEnv() };
    }
    const preset = this.resolvePreset();
    const env: NodeJS.ProcessEnv = { ...process.env, ...(preset.env ?? {}) };
    for (const [pid, envKey] of Object.entries(ACP_ENV_KEYS)) {
      if (!env[envKey]) {
        const key = await this.ctx.getApiKey(pid);
        if (key) env[envKey] = key;
      }
    }
    let command = preset.command;
    let args = preset.args;
    const explicit = (this.ctx.settings().binaries as Record<string, string | undefined>)[command];
    if (explicit) command = explicit;
    else {
      const resolved = which(command, [this.ctx.runtime.runtimePaths.appRuntimeDir]);
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

  async start(): Promise<void> {
    const meta = this.ctx.session();
    const { preset, command, args, env } = await this.resolveLaunch();
    this.preset = preset;
    // Preset args are user-visible configuration, not secrets (keys travel in env).
    this.ctx.log('info', `spawning ACP agent ${preset.id}: ${command} ${args.join(' ')} in ${meta.cwd}`);
    const child = spawnTool(command, args, { cwd: meta.cwd, env });
    this.child = child;
    if (this.id === 'antigravity') child.stderr?.resume();
    else child.stderr?.on('data', (d: Buffer) => this.ctx.log('debug', `[acp:${preset.id}] ${d.toString().trimEnd()}`));
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.conn = null;
      this.pendingPermissions = 0;
      const detail = `${preset.name} exited (${code})`;
      if (this.prompt) this.finishPrompt(this.prompt, 'failed', detail, false);
      this.discardQueue();
      this.ctx.emit({ type: 'status', status: 'stopped', detail });
    });
    child.on('error', (e) => {
      if (this.child === child) this.ctx.emit({ type: 'error', message: `${preset.name} failed to start: ${errorMessage(e)}`, fatal: true });
    });

    try {
      this.conn = connectAcp(child, () => this.clientHandlers(child));

      const init = await withTimeout(
        this.conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: { name: 'vocs-code', title: 'Vocs Code', version: '0.1.0' }
        } as unknown as acp.InitializeRequest),
        120_000,
        `${preset.name} initialize`
      );
      this.caps = (init.agentCapabilities ?? {}) as Record<string, unknown>;

      const sessionCaps = (this.caps.sessionCapabilities ?? {}) as { resume?: unknown; list?: unknown };
      // HTTP and SSE entries are dropped unless the agent said it understands them.
      const mcpCaps = (this.caps.mcpCapabilities ?? {}) as { http?: boolean; sse?: boolean };
      // ACP requires an absolute `command` and the agent rejects the whole handshake when one is
      // relative — Windows' `cmd /c` shim wrapper is exactly that case. Resolve what we can and
      // drop the rest: losing one server beats losing the session.
      const mcpDefs: McpServerDef[] = [];
      const skippedMcp: string[] = [];
      for (const { def } of await this.ctx.mcpServers().catch((e) => {
        this.ctx.log('warn', `mcp: ${errorMessage(e)}`);
        return [];
      })) {
        if (def.transport !== 'stdio' || !def.command) {
          mcpDefs.push(def);
          continue;
        }
        const command = path.isAbsolute(def.command) ? def.command : which(def.command, [this.ctx.runtime.runtimePaths.appRuntimeDir]);
        if (!command) {
          skippedMcp.push(def.id);
          this.ctx.log('warn', `mcp ${def.id}: cannot resolve "${def.command}" to an absolute path; skipping`);
          continue;
        }
        mcpDefs.push(command === def.command ? def : { ...def, command });
      }
      if (skippedMcp.length) {
        const what = skippedMcp.length > 1 ? 'servers' : 'server';
        this.info(`Skipped MCP ${what} with a command that is not an absolute path: ${skippedMcp.join(', ')}`, 'warn');
      }
      const mcpServers = toAcp(mcpDefs, mcpCaps) as unknown as acp.NewSessionRequest['mcpServers'];
      let res: { sessionId: string; configOptions?: unknown[] | null; modes?: acp.SessionModeState | null } | null = null;
      if (meta.harnessRef.acpSessionId && sessionCaps.resume) {
        try {
          const r = await withTimeout(this.conn.resumeSession({ sessionId: meta.harnessRef.acpSessionId, cwd: meta.cwd, mcpServers } as acp.ResumeSessionRequest), 120_000, 'session/resume');
          res = { sessionId: meta.harnessRef.acpSessionId, configOptions: r.configOptions ?? null, modes: r.modes };
        } catch (e) {
          if (this.id === 'antigravity' && isAntigravityAuthRequired(e)) throw e;
          this.info(`Could not resume ACP session (${errorMessage(e)}); starting a new one.`, 'warn');
        }
      }
      if (!res) {
        const r = await withTimeout(this.conn.newSession({ cwd: meta.cwd, mcpServers }), 180_000, 'session/new');
        res = { sessionId: r.sessionId, configOptions: r.configOptions ?? null, modes: r.modes };
      }
      this.sessionId = res.sessionId;
      this.sessionModes = res.modes;
      this.configOptions = (res.configOptions ?? []) as ConfigOptionLike[];
      await this.setPermissionMode(this.ctx.permissionMode());
      this.ctx.updateRef({ acpSessionId: this.sessionId });
      this.publishModels();

      // Apply the configured model / effort if the agent exposes them.
      if (meta.config.model?.model) await this.setModel(meta.config.model).catch((e) => this.ctx.log('warn', `setModel: ${errorMessage(e)}`));
      const effort = this.ctx.effort();
      if (effort) await this.setEffort(effort).catch((e) => this.ctx.log('debug', `setEffort(${effort}) not applied: ${errorMessage(e)}`));
    } catch (e) {
      // Handshake failed: tear the agent down so it cannot linger holding injected API keys.
      await this.killChild();
      if (this.id === 'antigravity' && isAntigravityAuthRequired(e)) throw new Error(ANTIGRAVITY_SIGN_IN_MESSAGE);
      throw e;
    }
    this.ctx.emit({ type: 'status', status: 'idle' });
  }

  private modelOption(): ConfigOptionLike | undefined {
    return findModelOption(this.configOptions);
  }

  private effortOption(): ConfigOptionLike | undefined {
    return findEffortOption(this.configOptions);
  }

  private publishModels(): void {
    const opt = this.modelOption();
    if (!opt) return;
    const eff = this.effortOption();
    this.modelValues.clear();
    const models: ModelInfo[] = acpModelCatalog(this.configOptions, this.preset?.id ?? 'acp').map(({ model, value }) => {
      this.modelValues.set(`${model.provider}\u0000${model.id}`, value);
      return model;
    });
    this.ctx.emit({ type: 'models', models });
    const currentValue = typeof opt.currentValue === 'string' ? opt.currentValue : undefined;
    const currentDecoded = currentValue ? decodeAcpModelValue(currentValue) : null;
    const current = models.find((m) => (currentDecoded ? m.provider === currentDecoded.provider && m.id === currentDecoded.model : m.id === currentValue));
    if (current) this.ctx.updateMeta({ activeModel: { provider: current.provider, model: current.id } });
    if (eff && isEffortLevel(eff.currentValue)) this.ctx.updateMeta({ activeEffort: eff.currentValue });
  }

  private clientHandlers(child: ChildProcess): acp.Client {
    const cwd = () => this.ctx.session().cwd;
    return {
      requestPermission: async (params: acp.RequestPermissionRequest) => {
        if (this.child !== child || this.prompt?.recovering) return { outcome: { outcome: 'cancelled' } };
        this.pendingPermissions++;
        this.armQuietTimer();
        try {
          return await this.onRequestPermission(params);
        } finally {
          if (this.child === child) {
            this.pendingPermissions--;
            this.armQuietTimer();
          }
        }
      },
      sessionUpdate: async (params: acp.SessionNotification) => {
        if (this.child !== child || this.prompt?.recovering) return;
        this.onSessionUpdate(params);
        this.armQuietTimer();
      },
      // ACP reads intentionally retain the adapter-wide read policy: an absolute path is allowed
      // even when it is outside the session workspace. Writes and commands still go through the
      // permission gate; callers should only use ACP with an agent they trust.
      readTextFile: async (params: acp.ReadTextFileRequest) => {
        const p = params as { path: string; line?: number | null; limit?: number | null };
        const abs = path.isAbsolute(p.path) ? p.path : path.join(cwd(), p.path);
        let content = await fs.readFile(abs, 'utf8');
        if (p.line || p.limit) {
          const lines = content.split('\n');
          const start = Math.max(0, (p.line ?? 1) - 1);
          content = lines.slice(start, p.limit ? start + p.limit : undefined).join('\n');
        }
        return { content };
      },
      writeTextFile: async (params: acp.WriteTextFileRequest) => {
        const p = params as { path: string; content: string };
        const abs = path.isAbsolute(p.path) ? p.path : path.join(cwd(), p.path);
        const mode = this.ctx.permissionMode();
        if (mode === 'plan') throw new Error('Plan mode: writes are disabled');
        const outside = isOutsideWorkspace(cwd(), abs, path);
        if (mode === 'ask' || (outside && mode !== 'full-auto')) {
          let before = '';
          try {
            before = await fs.readFile(abs, 'utf8');
          } catch {
            /* new file */
          }
          const rel = path.relative(cwd(), abs) || p.path;
          const d = await this.ctx.requestApproval({
            kind: 'file_change',
            title: `Write ${rel}?`,
            changes: [makeFileChange(cwd(), rel, before || null, p.content, { addWhenEmpty: true })],
            options: [
              { id: 'allow', label: 'Allow', kind: 'allow' },
              { id: 'deny', label: 'Deny', kind: 'deny' }
            ]
          });
          if (d.optionId !== 'allow') throw new Error('User declined the write');
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, p.content, 'utf8');
        return {};
      }
    } as unknown as acp.Client;
  }

  private async onRequestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const tc = params.toolCall as unknown as { toolCallId: string; title?: string | null; kind?: string | null; rawInput?: unknown; content?: unknown[] | null; locations?: { path: string }[] | null };
    const options = params.options as { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
    const pick = (kinds: string[]): string | undefined => {
      for (const k of kinds) {
        const o = options.find((x) => x.kind === k);
        if (o) return o.optionId;
      }
      return undefined;
    };
    const mode = this.ctx.permissionMode();
    const kind = tc.kind ?? 'other';
    const isEdit = kind === 'edit' || kind === 'delete' || kind === 'move';
    const isRead = kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think';
    const raw = (tc.rawInput ?? {}) as Record<string, unknown>;
    const command = typeof raw.command === 'string' ? raw.command : Array.isArray(raw.command) ? raw.command.join(' ') : undefined;
    const dangerous = !!command && isDangerousCommand(command);
    const cwd = this.ctx.session().cwd;
    const outsideWorkspace = (tc.locations ?? []).some((l) => isOutsideWorkspace(cwd, l.path, path));

    const selected = (optionId: string): acp.RequestPermissionResponse => ({ outcome: { outcome: 'selected', optionId } });
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    const allow = () => {
      const id = pick(this.id === 'antigravity' ? ['allow_once'] : ['allow_once', 'allow_always']);
      return id ? selected(id) : cancelled;
    };
    const reject = () => {
      const id = pick(['reject_once', 'reject_always']);
      return id ? selected(id) : cancelled; // no reject option → cancel rather than accidentally allow
    };
    if (isRead) return allow();
    if (mode === 'plan') return reject();
    if (mode === 'full-auto') {
      // Antigravity persists "always" choices into its own settings; keep every grant one-time.
      const id = pick(this.id === 'antigravity' ? ['allow_once'] : ['allow_always', 'allow_once']);
      return id ? selected(id) : cancelled;
    }
    if (!dangerous && !outsideWorkspace) {
      if (mode === 'auto') return allow();
      if (mode === 'accept-edits' && isEdit) return allow();
      if (this.sessionAllowedKinds.has(kind)) return allow();
    }

    const offered = this.id === 'antigravity' ? options.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once') : options;
    if (!offered.length) return cancelled;
    const ourOptions: ApprovalOption[] = offered.map((o) => ({
      id: o.optionId,
      label: o.name,
      kind: o.kind === 'allow_once' ? 'allow' : o.kind === 'allow_always' ? 'allow_always' : o.kind === 'reject_once' ? 'deny' : 'deny_always'
    }));
    const changes = this.changesFromContent(tc.content ?? undefined);
    const decision = await this.ctx.requestApproval({
      kind: command ? 'command' : isEdit ? 'file_change' : 'tool',
      title: tc.title ?? `Allow ${kind}?`,
      description: outsideWorkspace ? 'Touches paths outside the project directory.' : undefined,
      toolName: kind,
      command,
      cwd,
      input: tc.rawInput,
      changes: changes?.length ? changes : tc.locations?.length ? tc.locations.map((l) => ({ path: l.path, kind: 'update' as const })) : undefined,
      toolItemId: tc.toolCallId,
      options: ourOptions
    });
    const chosen = offered.find((o) => o.optionId === decision.optionId);
    if (chosen?.kind === 'allow_always') this.sessionAllowedKinds.add(kind);
    if (!chosen) return { outcome: { outcome: 'cancelled' } };
    return selected(chosen.optionId);
  }

  private changesFromContent(content: unknown[] | undefined): FileChange[] | undefined {
    if (!content) return undefined;
    const out: FileChange[] = [];
    for (const c of content as { type: string; path?: string; oldText?: string | null; newText?: string }[]) {
      if (c.type === 'diff' && c.path) {
        out.push(makeFileChange(this.ctx.session().cwd, c.path, c.oldText || null, c.newText ?? '', { addWhenEmpty: true }));
      }
    }
    return out.length ? out : undefined;
  }

  private onSessionUpdate(params: acp.SessionNotification): void {
    const u = params.update as unknown as Record<string, unknown> & { sessionUpdate: string };
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const block = u.content as { type: string; text?: string };
        if (block.type === 'text' && block.text) {
          const a = this.ensureAssistant();
          a.text += block.text;
          this.ctx.emit({ type: 'item.delta', id: a.id, textDelta: block.text });
        }
        return;
      }
      case 'agent_thought_chunk': {
        const block = u.content as { type: string; text?: string };
        if (block.type === 'text' && block.text) {
          const a = this.ensureAssistant();
          a.thinking = (a.thinking ?? '') + block.text;
          this.ctx.emit({ type: 'item.delta', id: a.id, thinkingDelta: block.text });
        }
        return;
      }
      case 'user_message_chunk':
        return;
      case 'tool_call':
      case 'tool_call_update': {
        const t = u as unknown as { toolCallId: string; title?: string | null; kind?: string | null; status?: string | null; content?: unknown[] | null; locations?: { path: string }[] | null; rawInput?: unknown; rawOutput?: unknown };
        let item = this.toolItems.get(t.toolCallId);
        if (!item) {
          this.closeAssistant();
          item = { id: t.toolCallId, kind: 'tool', ts: Date.now(), name: t.kind ?? 'tool', title: t.title ?? undefined, hint: hintFor(t.kind), status: 'running', input: t.rawInput, summary: t.title ?? undefined };
          this.toolItems.set(t.toolCallId, item);
        }
        if (t.title) item.title = t.title;
        if (t.kind) {
          item.name = t.kind;
          item.hint = hintFor(t.kind);
        }
        if (t.rawInput !== undefined) {
          item.input = t.rawInput;
          const raw = t.rawInput as Record<string, unknown>;
          if (typeof raw?.command === 'string') item.summary = raw.command;
        }
        if (t.status) item.status = t.status === 'completed' ? 'done' : t.status === 'failed' ? 'error' : 'running';
        const changes = this.changesFromContent(t.content ?? undefined);
        if (changes) item.changes = changes;
        const textOut = (t.content ?? [])
          .map((c) => {
            const cc = c as { type: string; content?: { type: string; text?: string } };
            return cc.type === 'content' && cc.content?.type === 'text' ? cc.content.text ?? '' : '';
          })
          .filter(Boolean)
          .join('\n');
        if (textOut) item.output = truncate(textOut, 40_000);
        else if (t.rawOutput !== undefined && item.status !== 'running' && !item.output) item.output = truncate(typeof t.rawOutput === 'string' ? t.rawOutput : JSON.stringify(t.rawOutput, null, 2), 40_000);
        if (!item.changes && t.locations?.length && (item.hint === 'edit')) item.changes = t.locations.map((l) => ({ path: l.path, kind: 'update' as const }));
        this.ctx.emit({ type: 'item.upsert', item: { ...item } });
        return;
      }
      case 'plan': {
        const p = u as unknown as { entries: { content: string; status: 'pending' | 'in_progress' | 'completed'; priority?: string }[] };
        this.ctx.emit({ type: 'item.upsert', item: { id: 'plan', kind: 'plan', ts: Date.now(), entries: p.entries } });
        return;
      }
      case 'usage_update': {
        const p = u as unknown as { used: number; size: number; cost?: { amount?: number; total?: number; value?: number } | null };
        const cost = p.cost?.amount ?? p.cost?.total ?? p.cost?.value;
        this.usage.setCumulative({ contextTokens: p.used, contextWindow: p.size, costUsd: typeof cost === 'number' ? cost : undefined });
        this.ctx.emit({ type: 'usage', totals: this.usage.snapshot() });
        return;
      }
      case 'config_option_update': {
        const p = u as unknown as { configOptions: ConfigOptionLike[] };
        this.configOptions = p.configOptions;
        this.publishModels();
        return;
      }
      case 'session_info_update': {
        const p = u as unknown as { title?: string | null };
        if (p.title && /^New session|^Untitled/i.test(this.ctx.session().title)) this.ctx.updateMeta({ title: p.title });
        return;
      }
      case 'current_mode_update':
      case 'available_commands_update':
      case 'plan_update':
      case 'plan_removed':
        return;
      case 'compaction_update':
        this.info('The agent compacted its context.');
        return;
      default:
        return;
    }
  }

  private ensureAssistant(): Extract<TranscriptItem, { kind: 'assistant' }> {
    if (!this.currentAssistant) {
      this.currentAssistant = { id: shortId('a_'), kind: 'assistant', ts: Date.now(), text: '', thinking: '', streaming: true };
      this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
    }
    return this.currentAssistant;
  }

  private closeAssistant(): void {
    if (!this.currentAssistant) return;
    this.currentAssistant.streaming = false;
    if (this.currentAssistant.text || this.currentAssistant.thinking) this.ctx.emit({ type: 'item.upsert', item: { ...this.currentAssistant } });
    this.currentAssistant = null;
  }

  private info(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('i_'), kind: 'info', ts: Date.now(), level, text } });
  }

  async send(input: UserInput): Promise<void> {
    if (this.prompt?.recovering || this.childShutdown) throw new Error('The ACP agent is stopping. Retry once it stops.');
    if (!this.conn) await this.start();
    if (!this.conn || !this.sessionId) throw new Error('ACP session is not ready');
    if (this.applyingMode) throw new Error('Wait for the Antigravity permission update to finish.');
    if (this.prompt) {
      this.queue.push(input);
      this.ctx.updateMeta({ queued: this.queue.length });
      return;
    }
    const blocks: unknown[] = [];
    if (input.text) blocks.push({ type: 'text', text: input.text });
    const promptCaps = (this.caps.promptCapabilities ?? {}) as { image?: boolean };
    for (const img of input.images ?? []) {
      if (promptCaps.image) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      else this.info('This ACP agent does not accept images; the attachment was dropped.', 'warn');
    }
    this.toolItems.clear();
    const turn: ActivePrompt = { startedAt: Date.now() };
    this.prompt = turn;
    this.usage.beginTurn();
    this.ctx.emit({ type: 'status', status: 'running' });
    void this.conn.prompt({ sessionId: this.sessionId, prompt: blocks } as acp.PromptRequest).then(
      (res) => {
        if (this.prompt !== turn || turn.recovering) return;
        const stop = res.stopReason;
        this.finishPrompt(turn, stop === 'cancelled' ? 'interrupted' : stop === 'refusal' ? 'failed' : 'completed',
          stop === 'refusal' ? 'The agent refused the request.' : stop === 'max_tokens' || stop === 'max_turn_requests' ? `Stopped: ${stop}` : undefined);
        this.drainQueue();
      },
      (e) => {
        if (this.prompt !== turn || turn.recovering) return;
        const error = this.id === 'antigravity' && isAntigravityAuthRequired(e) ? ANTIGRAVITY_SIGN_IN_MESSAGE : errorMessage(e);
        this.finishPrompt(turn, 'failed', error, false);
        this.drainQueue();
      }
    );
  }

  private finishPrompt(turn: ActivePrompt, status: Extract<TranscriptItem, { kind: 'turn' }>['status'], error?: string, count = true): void {
    clearTimeout(turn.quietTimer);
    clearTimeout(turn.cancelTimer);
    this.closeAssistant();
    if (!count) {
      for (const item of this.toolItems.values()) {
        if (item.status === 'running') this.ctx.emit({ type: 'item.upsert', item: { ...item, status: 'error' } });
      }
    }
    const completed = this.usage.finishTurn(count);
    if (count) this.ctx.emit({ type: 'usage', totals: completed.totals });
    this.ctx.emit({ type: 'item.upsert', item: { id: shortId('turn_'), kind: 'turn', ts: Date.now(), status, durationMs: Date.now() - turn.startedAt, error } });
    this.prompt = null;
  }

  private drainQueue(): void {
    if (!this.conn) return;
    this.ctx.emit({ type: 'status', status: 'idle' });
    const next = this.queue.shift();
    this.ctx.updateMeta({ queued: this.queue.length });
    if (next) void this.send(next);
  }

  private discardQueue(): void {
    if (!this.queue.length) return;
    this.queue = [];
    this.ctx.updateMeta({ queued: 0 });
    this.info('Queued messages were not sent. Resend them after checking the workspace.', 'warn');
  }

  private armQuietTimer(): void {
    const turn = this.prompt;
    if (this.id !== 'antigravity' || !turn || turn.recovering || turn.cancelTimer) return;
    clearTimeout(turn.quietTimer);
    if (!this.currentAssistant?.text.trim() || this.pendingPermissions || [...this.toolItems.values()].some((item) => item.status === 'running')) return;
    turn.quietTimer = setTimeout(() => {
      void this.recoverPrompt(turn, 'failed', 'Antigravity stopped sending updates without confirming the turn ended. The reply was kept; check the workspace before retrying.');
    }, ANTIGRAVITY_PROMPT_QUIET_MS).unref();
  }

  private async recoverPrompt(turn: ActivePrompt, status: 'failed' | 'interrupted', detail: string): Promise<void> {
    if (this.prompt !== turn || turn.recovering) return;
    turn.recovering = true;
    clearTimeout(turn.quietTimer);
    clearTimeout(turn.cancelTimer);
    // A prompt cannot be retried safely on a connection that may still be doing work.
    await this.killChild();
    if (this.prompt !== turn) return;
    this.finishPrompt(turn, status, detail, false);
    this.discardQueue();
    this.ctx.emit({ type: 'status', status: 'stopped', detail });
  }

  async interrupt(): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    const turn = this.prompt;
    if (this.id === 'antigravity' && turn && !turn.cancelTimer) {
      clearTimeout(turn.quietTimer);
      turn.cancelTimer = setTimeout(() => {
        void this.recoverPrompt(turn, 'interrupted', 'Antigravity did not acknowledge the interrupt. Its CLI was stopped; check the workspace before retrying.');
      }, ANTIGRAVITY_CANCEL_GRACE_MS).unref();
    }
    const cancel = this.conn.cancel({ sessionId: this.sessionId }).catch((e) => {
      this.ctx.log('warn', `cancel failed: ${errorMessage(e)}`);
    });
    // A stuck write must not hold the caller open; recovery is tied to the prompt result.
    if (this.id !== 'antigravity') await cancel;
  }

  async setModel(model: ModelRef): Promise<void> {
    const opt = this.modelOption();
    if (!this.conn || !this.sessionId || !opt) throw new Error('This agent does not expose a model option.');
    // Send the agent's raw option value: tuple-advertising agents (dsh) key their choices by it.
    const raw =
      this.modelValues.get(`${model.provider}\u0000${model.model}`) ??
      [...this.modelValues.entries()].find(([k]) => k.endsWith(`\u0000${model.model}`))?.[1] ??
      model.model;
    const res = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: opt.id, value: raw } as acp.SetSessionConfigOptionRequest);
    this.configOptions = (res.configOptions ?? this.configOptions) as ConfigOptionLike[];
    this.ctx.updateMeta({ activeModel: model });
    this.publishModels();
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    const opt = this.effortOption();
    if (!this.conn || !this.sessionId || !opt) return;
    const values = flattenSelect(opt).map((o) => o.value);
    if (!values.includes(effort)) return;
    const res = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: opt.id, value: effort } as acp.SetSessionConfigOptionRequest);
    this.configOptions = (res.configOptions ?? this.configOptions) as ConfigOptionLike[];
    this.ctx.updateMeta({ activeEffort: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.id !== 'antigravity') return; // Other ACP agents use client-side policy.
    if (!HARNESS_BY_ID[this.id].capabilities.permissionModes.includes(mode)) throw new Error(`Antigravity does not support the ${mode} permission mode.`);
    if (!this.conn || !this.sessionId) return;
    if (this.busy || this.applyingMode) throw new Error('Wait for the current Antigravity activity before changing permissions.');
    // Every mode but Plan runs the CLI in `default` under its strict tool policy, so each tool call
    // reaches onRequestPermission and Accept edits / Auto / Full access are enforced client-side.
    const modeId = mode === 'plan' ? 'plan' : 'default';
    if (!this.sessionModes?.availableModes.some((value) => value.id === modeId)) {
      throw new Error('Antigravity CLI did not offer the requested permission mode. Update the CLI and retry.');
    }
    this.applyingMode = true;
    try {
      await withTimeout(this.conn.setSessionMode({ sessionId: this.sessionId, modeId }), 10_000, 'Antigravity permission mode');
    } catch (error) {
      // The server may have applied the mode even though the acknowledgement was lost.
      // Reconnect and apply the saved mode before accepting another prompt.
      await this.killChild();
      throw error;
    } finally {
      this.applyingMode = false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const opt = this.modelOption();
    if (!opt) return [];
    return flattenSelect(opt).map((o) => {
      const decoded = decodeAcpModelValue(o.value);
      return {
        id: decoded?.model ?? o.value,
        provider: decoded?.provider ?? this.preset?.id ?? 'acp',
        displayName: o.name || decoded?.model || o.value,
        description: o.description ?? undefined
      };
    });
  }

  async dispose(): Promise<void> {
    const conn = this.conn;
    const turn = this.prompt;
    if (turn) {
      turn.recovering = true;
      clearTimeout(turn.quietTimer);
      clearTimeout(turn.cancelTimer);
    }
    this.conn = null;
    this.queue = [];
    if (conn && !turn && this.sessionId) {
      const sessionCaps = (this.caps.sessionCapabilities ?? {}) as { close?: unknown };
      if (sessionCaps.close) await withTimeout(conn.closeSession({ sessionId: this.sessionId } as acp.CloseSessionRequest), 5000, 'session/close').catch(() => undefined);
    }
    await this.killChild();
    if (this.prompt) this.finishPrompt(this.prompt, 'interrupted', undefined, false);
  }
}

function hintFor(kind: string | null | undefined): Extract<TranscriptItem, { kind: 'tool' }>['hint'] {
  switch (kind) {
    case 'read':
      return 'read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'execute':
      return 'execute';
    case 'search':
      return 'search';
    case 'fetch':
      return 'fetch';
    case 'think':
      return 'think';
    default:
      return 'other';
  }
}
