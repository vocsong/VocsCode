/**
 * Live smoke tests: drive each harness adapter against the real backend installed on this
 * machine. Skipped unless HARNESS_SMOKE=1. Individual harnesses can be selected with
 * HARNESS_SMOKE_ONLY=codex,pi,... Each test sends one prompt asking for the literal token
 * PONG and asserts the adapter produced an assistant item containing it plus a turn item.
 * HARNESS_SMOKE_ONLY=mcp drives one harness (HARNESS_SMOKE_MCP_HARNESS, default claude) with an
 * injected MCP server and asserts it actually called a tool from it.
 * HARNESS_SMOKE_ANTIGRAVITY_BIN can point to an absolute path to the official Antigravity CLI.
 * HARNESS_SMOKE=1 HARNESS_SMOKE_SHARED=1 npm run test:smoke -- -t 'Shared skill'
 * runs only Codex app-server, Claude, Pi and Antigravity through the owner registry. It uses
 * inherited auth or HARNESS_SMOKE_SHARED_HOME, an already-configured, dedicated test home
 * (not a personal profile; disable Pi's retry setting there). HARNESS_SMOKE_MODEL can select a
 * model for one harness, with HARNESS_SMOKE_PI_PROVIDER to override Pi's default provider.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { IpcChannel, IpcRequest, IpcResponse } from '../src/shared/ipc';
import { MCP_BUILTIN_IDS, type ApprovalDecision, type HarnessId, type HarnessRef, type SessionEvent, type SessionMeta, type TranscriptItem } from '../src/shared/types';
import type { HandlerDeps } from '../src/main/handlers';
import type { ResolvedServer } from '../src/main/mcp/effective';
import { createAdapter } from '../src/main/harness/registry';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import { RuntimeResolver } from '../src/main/runtime';
import { defaultSettings, SettingsStore } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred, errorMessage, withTimeout } from '../src/main/util/async';

const enabled = process.env.HARNESS_SMOKE === '1';
const sharedEnabled = process.env.HARNESS_SMOKE_SHARED === '1';
const only = (process.env.HARNESS_SMOKE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const selected = (id: string) => only.length === 0 || only.includes(id);
const want = (id: string) => enabled && !sharedEnabled && selected(id);
// Resume round-trips cost a second turn per harness, so they stay behind their own flag.
const wantResume = (id: string) => want(id) && process.env.HARNESS_SMOKE_RESUME === '1';
const smokeModelProviders: Partial<Record<HarnessId, string>> = {
  antigravity: 'antigravity',
  claude: 'anthropic',
  pi: 'openai-codex',
};

const appRoot = path.resolve(__dirname, '..');
const tmpRoot = path.join(os.tmpdir(), `vocs-code-smoke-${Date.now()}`);
const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const c of cleanups) await c().catch(() => undefined);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function makeCtx(harness: HarnessId, extra: Partial<SessionMeta['config']> = {}, mcp: ResolvedServer[] = []) {
  const cwd = path.join(tmpRoot, harness);
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'README.md'), '# smoke\n');
  const settings = defaultSettings();
  const antigravityBin = process.env.HARNESS_SMOKE_ANTIGRAVITY_BIN;
  if (harness === 'antigravity' && antigravityBin) {
    if (!path.isAbsolute(antigravityBin)) throw new Error('HARNESS_SMOKE_ANTIGRAVITY_BIN must be an absolute path.');
    settings.binaries.agy = antigravityBin;
  }
  const runtime = new RuntimeResolver({ appRuntimeDir: path.join(tmpRoot, 'runtime'), resourcesDir: path.join(appRoot, 'resources'), appRoot }, () => settings);
  const meta: SessionMeta = {
    id: `smoke_${harness}`,
    title: 'smoke',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: {
      harness, projectRoot: cwd, permissionMode: 'auto', ...extra,
      ...(process.env.HARNESS_SMOKE_FAST_MODE === '1' ? { fastMode: true } : {}),
      ...(process.env.HARNESS_SMOKE_MODEL ? { model: {
        provider: extra.model?.provider ?? smokeModelProviders[harness] ?? 'openai',
        model: process.env.HARNESS_SMOKE_MODEL,
      } } : {}),
    },
    cwd,
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage()
  };
  const events: SessionEvent[] = [];
  const items = new Map<string, TranscriptItem>();
  let resolveIdle: (() => void) | null = null;
  let turns = 0;
  const ctx: HarnessContext = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => settings,
    runtime,
    sessionDir: path.join(tmpRoot, 'sessions', harness),
    permissionMode: () => meta.config.permissionMode,
    effort: () => meta.config.effort ?? undefined,
    getApiKey: async () => undefined,
    mcpServers: async () => mcp,
    ownedMcpIds: () => harness === 'codex' || harness === 'codex-exec' ? [...MCP_BUILTIN_IDS] : [],
    emit: (event) => {
      events.push(event);
      if (event.type === 'item.upsert') items.set(event.item.id, event.item);
      if (event.type === 'item.delta') {
        const it = items.get(event.id);
        if (it?.kind === 'assistant' && event.textDelta) it.text += event.textDelta;
      }
      if (event.type === 'item.upsert' && event.item.kind === 'turn') turns++;
      if (event.type === 'status' && event.status === 'idle' && turns > 0) resolveIdle?.();
      if (event.type === 'status' && (event.status === 'error' || event.status === 'stopped')) resolveIdle?.();
    },
    requestApproval: async (draft: ApprovalDraft): Promise<ApprovalDecision> => {
      events.push({ type: 'log', level: 'info', message: `auto-approving ${draft.kind}: ${draft.command ?? draft.title}` });
      return { optionId: draft.options[0]?.id ?? 'allow' };
    },
    updateRef: (patch) => Object.assign(meta.harnessRef, patch),
    updateMeta: (patch) => Object.assign(meta, patch),
    log: (level, message) => {
      if (process.env.HARNESS_SMOKE_VERBOSE) console.log(`[${harness}] ${level}: ${message}`);
    },
    readJson: async () => null,
    writeJson: async () => undefined
  };
  await fs.mkdir(ctx.sessionDir, { recursive: true });
  const waitTurn = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no turn within ${ms}ms; events: ${summarize(events)}`)), ms);
      resolveIdle = () => {
        clearTimeout(t);
        resolve();
      };
    }).then(() => {
      if (meta.config.fastMode) {
        // A successful standard-speed fallback is not a passing Fast request. Requested means
        // the runtime cannot expose actual service; never promote it to confirmed "on" here.
        expect(['requested', 'on'], meta.fastModeStatus?.detail).toContain(meta.fastModeStatus?.state);
      }
    });
  return { ctx, meta, events, items, waitTurn };
}

function summarize(events: SessionEvent[]): string {
  return events
    .slice(-25)
    .map((e) => (e.type === 'item.upsert' ? `${e.type}:${e.item.kind}${e.item.kind === 'info' ? `(${e.item.text.slice(0, 120)})` : ''}` : e.type === 'error' ? `error(${e.message})` : e.type === 'status' ? `status:${e.status}` : e.type))
    .join(' | ');
}

function assistantText(items: Map<string, TranscriptItem>): string {
  const text = [...items.values()]
    .filter((i) => i.kind === 'assistant')
    .map((i) => (i.kind === 'assistant' ? i.text : ''))
    .join('\n');
  if (text.trim()) return text;
  // Surface the harness-reported failure so an account/network problem reads as such.
  const failures = [...items.values()]
    .map((i) => (i.kind === 'turn' && i.error ? `turn ${i.status}: ${i.error}` : i.kind === 'info' && i.level === 'error' ? `error: ${i.text}` : ''))
    .filter(Boolean);
  return failures.length ? `<<no assistant text; ${failures.join(' | ')}>>` : '';
}

const PROMPT = 'Reply with exactly the single word PONG and nothing else. Do not use any tools.';
const CONTINUE_PROMPT = 'Reply with exactly the single word PONG again and nothing else. Do not use any tools.';

function assertSuccessfulTurn(items: Map<string, TranscriptItem>, events: SessionEvent[], reply: string): void {
  expect(assistantText(items).trim()).toBe(reply);
  const turns = [...items.values()].filter((i) => i.kind === 'turn');
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ status: 'completed' });
  expect(events.filter((e) => e.type === 'error')).toEqual([]);
  const statuses = events.filter((e) => e.type === 'status');
  expect(statuses.at(-1)).toMatchObject({ status: 'idle' });
  expect(statuses.some((e) => e.status === 'error' || e.status === 'stopped')).toBe(false);
}

const sharedHarnessRefs = {
  codex: 'codexThreadId',
  claude: 'claudeSessionId',
  pi: 'piSessionFile',
  antigravity: 'acpSessionId'
} as const satisfies Partial<Record<HarnessId, keyof HarnessRef>>;
type SharedSmokeHarness = keyof typeof sharedHarnessRefs;

async function isolateSharedProfile(dir: string, harness: SharedSmokeHarness): Promise<void> {
  const configured = process.env.HARNESS_SMOKE_SHARED_HOME;
  if (configured && !path.isAbsolute(configured)) throw new Error('HARNESS_SMOKE_SHARED_HOME must be an absolute path to a dedicated test home.');
  const home = configured ? await fs.realpath(configured) : path.join(dir, 'home');
  if (configured && path.relative(await fs.realpath(os.homedir()), home) === '') {
    throw new Error('HARNESS_SMOKE_SHARED_HOME cannot be the current user home.');
  }
  const env = {
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'), CODEX_SQLITE_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent')
  };
  await fs.mkdir(home, { recursive: true });
  // Codex refuses even to initialize if an explicit CODEX_HOME doesn't exist yet.
  if (harness === 'codex') await fs.mkdir(env.CODEX_HOME, { recursive: true });
  if (harness === 'pi' && !configured) {
    await fs.mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
    // Pi can otherwise submit the same inference again after a transport error.
    await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

function toolOrApproval(event: SessionEvent): boolean {
  return event.type === 'approval.request' || event.type === 'approval.resolved' ||
    (event.type === 'item.upsert' && (event.item.kind === 'approval' || event.item.kind === 'tool'));
}

function sharedSmokeDetail(error: unknown, items: TranscriptItem[], events: SessionEvent[]): string {
  // Don't print raw provider payloads, SDK stderr, or model output. Shared Skills intentionally
  // redacts turn errors; only classify details that the runtime made visible through the app.
  const messages = [errorMessage(error), ...items.flatMap((item) => {
    if (item.kind === 'info' || item.kind === 'assistant') return [item.text];
    return item.kind === 'turn' && item.error ? [item.error] : [];
  }), ...events.flatMap((event) => event.type === 'error' ? [event.message] : event.type === 'status' && event.detail ? [event.detail] : [])];
  const hint = [
    [/\b401\b|\bunauthori[sz]ed\b/i, 'provider rejected authentication (401/unauthorized)'],
    [/sign in|log[ -]?in|not authenticated|auth(?:entication)? required|no api key|no model|invalid api key/i, 'no usable account/model in the smoke profile'],
    [/incompatible pi runtime/i, 'Pi could not initialize the required Vocs Code extensions'],
    [/timed out/i, 'owner invoke or terminal event timed out'],
    [/unexpected tool or approval/i, 'unexpected tool or approval (none granted)'],
    [/did not retry/i, 'dispatch was not confirmed; no retry'],
    [/reported an error during the Shared skill turn/i, 'runtime reported a turn error (provider detail redacted by the app)']
  ] as const;
  const states = events.flatMap((e) => e.type === 'status' ? [e.status] : e.type === 'item.upsert' && e.item.kind === 'turn' ? [`turn:${e.item.status}`] : []).slice(-12);
  return `${hint.find(([pattern]) => messages.some((message) => pattern.test(message)))?.[1] ?? 'runtime did not produce one successful nonce turn'}; observed: ${states.join(' → ') || 'no status/turn events'}`;
}

async function runSharedSkillSmoke(harness: SharedSmokeHarness): Promise<void> {
  const { createHandlerRegistry } = await import('../src/main/handlers');
  const { SessionManager } = await import('../src/main/session-manager');
  const { SessionStore } = await import('../src/main/store');
  const { SharedSkillsStore } = await import('../src/main/shared-skills');
  const { AnalyticsStore } = await import('../src/main/analytics');
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'vocs-shared-smoke-'));
  const teardown: (() => Promise<void>)[] = [];
  try {
    const cwd = path.join(dir, 'workspace');
    const userData = path.join(dir, 'app');
    await fs.mkdir(cwd);
    const settings = new SettingsStore(userData);
    await settings.load();
    const runtime = new RuntimeResolver({ appRuntimeDir: path.join(dir, 'runtime'), resourcesDir: path.join(appRoot, 'resources'), appRoot }, () => settings.get());
    const tool = harness === 'antigravity' ? 'agy' : harness;
    const agy = tool === 'agy' ? process.env.HARNESS_SMOKE_ANTIGRAVITY_BIN : undefined;
    if (agy && !path.isAbsolute(agy)) throw new Error('HARNESS_SMOKE_ANTIGRAVITY_BIN must be an absolute path.');
    if (agy) await settings.update({ binaries: { agy } });
    // Resolve before redirecting the profile (e.g. agy can be installed under LOCALAPPDATA).
    const binary = runtime.resolve(tool);
    if (!binary) throw new Error(`${harness}: no installed runtime (${tool}) found for the Shared skill smoke.`);
    await settings.update({
      binaries: { [tool]: binary.path }, mcpDisabledBuiltins: [...MCP_BUILTIN_IDS], notifications: false,
      claude: { ...settings.get().claude, settingSources: [] },
      pi: { extraArgs: ['--no-tools', '--no-extensions', '--no-skills', '--no-context-files', '--offline'] }
    });
    await isolateSharedProfile(dir, harness);

    const log = () => undefined;
    const store = new SessionStore(userData, log);
    await store.load();
    const analytics = new AnalyticsStore(userData, { log });
    const sessions = new SessionManager({
      store, settings, runtime, analytics, log, getSecret: async () => undefined,
      pushEvent: log, pushSessions: log, notify: log, disposeWaitMs: 10_000
    });
    teardown.push(async () => { await sessions.stopAll(); await sessions.flushPendingPersists(); await analytics.flush(); });
    // Only the unused Electron-facing ports are stubs. This registry resolves a real catalog,
    // starts a real SessionManager adapter and never calls a fixture runtime or an auth handler.
    const registry = createHandlerRegistry({
      settings, runtime, sessions, analytics, log, push: log,
      sharedSkills: new SharedSkillsStore(path.join(userData, 'shared-skills.json'), path.join(dir, 'skills')),
      secrets: {} as HandlerDeps['secrets'], terminals: {} as HandlerDeps['terminals'], search: {} as HandlerDeps['search'],
      desktop: { userDataPath: () => userData } as HandlerDeps['desktop']
    });
    teardown.push(() => registry.shutdown());
    const owner = <K extends IpcChannel>(channel: K, request: IpcRequest<K>) => registry.invoke(channel, request, 'desktop') as Promise<IpcResponse<K>>;
    const name = 'live-nonce';
    const description = 'Reply with a synthetic test token';
    const nonce = `VOCS_${randomBytes(8).toString('hex')}`;
    const body = `Do not use any tools, run commands, read files, or ask for approval. Reply with exactly ${nonce} and nothing else.`;
    const text = `/skill ${name} Reply with the literal token from these instructions.`;
    const created = await owner('sharedSkills:create', { name, description });
    const saved = await owner('sharedSkills:save', { name, revision: created.revision, content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n` });
    expect(await owner('sharedSkills:review', { name, revision: saved.revision, enabled: true })).toMatchObject({ name, revision: saved.revision, reviewed: true });
    const model = process.env.HARNESS_SMOKE_MODEL;
    const { id } = await owner('sessions:create', {
      title: 'Shared skill smoke',
      config: {
        harness, projectRoot: cwd, permissionMode: 'plan',
        ...(model ? { model: { provider: (harness === 'pi' && process.env.HARNESS_SMOKE_PI_PROVIDER) || smokeModelProviders[harness] || 'openai', model } } : {})
      }
    });

    console.info(`[Shared skill live] ${harness}: ${binary.source} runtime (${path.basename(binary.path)})`);
    const events: SessionEvent[] = [];
    const turnStatuses: string[] = [];
    const terminal = deferred<void>();
    const unsubscribe = sessions.subscribe(({ sessionId, event }) => {
      if (sessionId !== id) return;
      events.push(event);
      if (toolOrApproval(event)) terminal.reject(new Error('Unexpected tool or approval.'));
      if (event.type === 'item.upsert' && event.item.kind === 'turn') turnStatuses.push(event.item.status);
      if (event.type === 'error') terminal.reject(new Error(event.message));
      if (event.type === 'status') {
        if (event.status === 'error' || event.status === 'stopped') terminal.reject(new Error(`Runtime ${event.status}.`));
        if (event.status === 'idle' && turnStatuses.length) terminal.resolve();
      }
    });
    try {
      // Intentionally one dispatch, never retried; ACK and startup idle aren't turn completion.
      const [ack] = await withTimeout(Promise.all([owner('sharedSkills:invoke', { id, text }), terminal.promise]), 120_000, 'Shared skill invocation')
        .catch(async (error: unknown) => { throw new Error(`${harness}: ${sharedSmokeDetail(error, await sessions.transcript(id), events)}`); });
      expect(ack).toEqual({ sent: true });
      const items = await store.readTranscript(id);
      const detail = sharedSmokeDetail('', items, events);
      const turns = items.filter((item) => item.kind === 'turn');
      expect(turns.map((turn) => turn.status), detail).toEqual(['completed']);
      expect(turnStatuses, detail).toEqual(['completed']);
      expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({ status: 'idle' });
      const meta = sessions.get(id);
      expect(meta).toMatchObject({ status: 'idle', queued: 0, config: { harness, permissionMode: 'plan' } });
      expect(meta?.harnessRef[sharedHarnessRefs[harness]]).toMatch(/\S/);
      expect(events.some((event) => event.type === 'error' || (event.type === 'status' && ['awaiting', 'error', 'stopped'].includes(event.status))), detail).toBe(false);
      expect(events.some(toolOrApproval)).toBe(false);
      expect(items.some((item) => item.kind === 'approval' || item.kind === 'tool')).toBe(false);
      expect(items.some((item) => item.kind === 'info' && item.level === 'error'), detail).toBe(false);
      const users = items.filter((item) => item.kind === 'user');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ text, sharedSkill: { name, revision: saved.revision } });
      expect(JSON.stringify(users[0]).includes(nonce)).toBe(false);
      const answers = items.flatMap((item) => item.kind === 'assistant' && item.text ? [item.text] : []);
      expect(answers.length === 1 && answers[0] === nonce, detail).toBe(true);
    } finally {
      unsubscribe();
    }
  } finally {
    try {
      const results = await Promise.allSettled(teardown.map((dispose) => dispose()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

describe.sequential('Shared skill live smoke', () => {
  for (const harness of Object.keys(sharedHarnessRefs) as SharedSmokeHarness[]) {
    it.runIf(enabled && sharedEnabled && selected(harness))(`${harness} completes one owner-invoked turn`, { retry: 0 }, () => runSharedSkillSmoke(harness));
  }
});

/**
 * Live resume round-trip: run one prompt, tear the adapter down, then rebuild from the same
 * session meta (which still carries the harness ref) and run a continuation prompt.
 */
async function resumeRoundTrip(harness: HarnessId, refKey: keyof HarnessRef, extra: Partial<SessionMeta['config']> = {}): Promise<void> {
  const { ctx, meta, events, items, waitTurn } = await makeCtx(harness, extra);
  const first = createAdapter(harness, ctx);
  cleanups.push(() => first.dispose());
  await first.start();
  await first.send({ text: PROMPT });
  await waitTurn(170_000);
  assertSuccessfulTurn(items, events, 'PONG');
  expect(meta.harnessRef[refKey]).toBeTruthy();
  const originalRef = meta.harnessRef[refKey];
  await first.dispose();

  const second = createAdapter(harness, ctx);
  cleanups.push(() => second.dispose());
  await second.start();
  // A rejected resume falls back to a fresh session with a warning; that must not happen here.
  const resumeWarnings = events.filter(
    (e) => e.type === 'item.upsert' && e.item.kind === 'info' && e.item.level === 'warn' && /resum/i.test(e.item.text)
  );
  expect(resumeWarnings).toEqual([]);
  items.clear();
  events.length = 0;
  await second.send({ text: CONTINUE_PROMPT });
  await waitTurn(170_000);
  assertSuccessfulTurn(items, events, 'PONG');
  expect(meta.harnessRef[refKey]).toBe(originalRef);
}

describe('live harness smoke', () => {
  it.runIf(want('codex'))('codex app-server answers a prompt', async () => {
    const { ctx, items, events, waitTurn, meta } = await makeCtx('codex');
    const adapter = createAdapter('codex', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    expect(meta.harnessRef.codexThreadId).toBeTruthy();
    const models = await adapter.listModels!();
    expect(models.length).toBeGreaterThan(0);
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
  });

  it.runIf(want('codex'))('codex app-server Auto runs an ordinary project command without asking', async () => {
    const { ctx, events, waitTurn, meta } = await makeCtx('codex');
    expect(meta.config.permissionMode).toBe('auto');
    const adapter = createAdapter('codex', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: 'Run exactly this shell command in the current directory and nothing else: node -e "require(\'fs\').writeFileSync(\'auto-marker.txt\', \'ok\')". Then reply DONE.' });
    await waitTurn(170_000);
    // Codex asks for every command not on its known-safe list (`untrusted`); the app's Auto gate
    // must answer that without showing the user an approval.
    expect(await fs.readFile(path.join(meta.cwd, 'auto-marker.txt'), 'utf8')).toBe('ok');
    expect(events.filter((e) => e.type === 'log' && e.message.startsWith('auto-approving'))).toEqual([]);
  });

  it.runIf(want('codex-exec'))('codex exec SDK answers a prompt', async () => {
    const { ctx, items, events, waitTurn } = await makeCtx('codex-exec');
    const adapter = createAdapter('codex-exec', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
  });

  it.runIf(want('cursor'))('cursor SDK answers a prompt', async () => {
    if (!process.env.CURSOR_API_KEY) throw new Error('Cursor smoke requested but CURSOR_API_KEY is not available.');
    const { ctx, items, events, waitTurn, meta } = await makeCtx('cursor');
    const adapter = createAdapter('cursor', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    const models = await adapter.listModels!();
    expect(models.length).toBeGreaterThan(0);
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
    expect(meta.harnessRef.cursorAgentId).toBeTruthy();
  });

  it.runIf(want('pi'))('pi rpc answers a prompt and lists models', async () => {
    const { ctx, events, items, waitTurn, meta } = await makeCtx('pi');
    const adapter = createAdapter('pi', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    const models = await adapter.listModels!();
    expect(models.length).toBeGreaterThan(0);
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
    expect(meta.harnessRef.piSessionFile).toBeTruthy();
    // The completed turn must also be counted against the session's usage totals.
    const usage = events.filter((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage.at(-1)?.totals.turns).toBe(1);
  });

  it.runIf(want('pi') && process.env.HARNESS_SMOKE_QUESTIONS === '1')('pi asks a structured question and receives selection plus context', async () => {
    const { ctx, events, items, waitTurn } = await makeCtx('pi');
    const drafts: ApprovalDraft[] = [];
    ctx.requestApproval = async (draft) => {
      drafts.push(draft);
      if (draft.kind !== 'question' || draft.toolName !== 'ask_user' || draft.questions?.length !== 1) throw new Error('Expected one structured question, not a tool permission.');
      return { optionId: 'allow', answers: { [draft.questions[0].id]: 'staging' }, note: 'Wait for Friday.' };
    };
    const adapter = createAdapter('pi', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: 'Before proceeding, ask me one question using the app structured-question tool, not plain prose: which deployment environment, staging or production? Provide a short description for each option. After my answer, reply exactly STAGING_FRIDAY if I chose staging with context to wait for Friday. Do not deploy anything or call any other tools.' });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'STAGING_FRIDAY');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].questions?.[0].options?.map((option) => option.label.toLowerCase())).toEqual(['staging', 'production']);
    expect(drafts[0].questions?.[0].options?.every((option) => Boolean(option.description))).toBe(true);
    const tools = [...items.values()].filter((item) => item.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'ask_user', status: 'done' });
    expect(tools[0].kind === 'tool' && tools[0].output).toContain('Wait for Friday.');
  });

  it.runIf(want('claude'))('claude agent sdk answers a prompt', async () => {
    const { ctx, items, events, waitTurn, meta } = await makeCtx('claude');
    const adapter = createAdapter('claude', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    const models = await adapter.listModels!();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.contextWindow)).toBe(true);
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
    expect(meta.harnessRef.claudeSessionId).toBeTruthy();
  });

  it.runIf(want('claude'))('claude Auto runs an ordinary command without asking and Plan blocks a write', async () => {
    const auto = await makeCtx('claude');
    const runner = createAdapter('claude', auto.ctx);
    cleanups.push(() => runner.dispose());
    await runner.start();
    await runner.send({ text: 'Use the Bash tool to run exactly: node -e "require(\'fs\').writeFileSync(\'auto-marker.txt\', \'ok\')". Then reply DONE.' });
    await auto.waitTurn(170_000);
    // The PreToolUse tier check answers Auto itself; no approval reaches the user.
    expect(await fs.readFile(path.join(auto.meta.cwd, 'auto-marker.txt'), 'utf8')).toBe('ok');
    expect(auto.events.filter((e) => e.type === 'log' && e.message.startsWith('auto-approving'))).toEqual([]);
    await runner.dispose();

    const plan = await makeCtx('claude', { permissionMode: 'plan' });
    const planner = createAdapter('claude', plan.ctx);
    cleanups.push(() => planner.dispose());
    await planner.start();
    await planner.send({ text: 'Use the Write tool to create plan-marker.txt containing ok. If you cannot, reply BLOCKED.' });
    await plan.waitTurn(170_000);
    await expect(fs.stat(path.join(plan.meta.cwd, 'plan-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(plan.events.filter((e) => e.type === 'log' && e.message.startsWith('auto-approving'))).toEqual([]);
  });

  // Proves the injection path end to end rather than only at the dialect converter: the harness
  // must connect to a server this app handed it and call one of its tools. Runs against the
  // offline fixture server in tests/fixtures, so only the model call costs anything.
  // Verified for claude, codex and acp. codex-exec fails here on purpose: it loads the server,
  // but that adapter runs with approvalPolicy 'never' and Codex declines MCP tool calls in that
  // mode ("MCP tool call requires approval, but approval policy is never").
  it.runIf(want('mcp'))('a harness loads an MCP server this app injected', async () => {
    const harness = (process.env.HARNESS_SMOKE_MCP_HARNESS ?? 'claude') as HarnessId;
    const def = {
      id: 'smokefixture',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [path.resolve(__dirname, 'fixtures/mcp-echo-server.mjs')]
    };
    const extra = harness === 'acp' ? { acpAgent: process.env.HARNESS_SMOKE_ACP_AGENT ?? 'dsh' } : {};
    const { ctx, items, waitTurn } = await makeCtx(harness, extra, [{ def, missing: [], secretEnvKeys: [], secretHeaderKeys: [] }]);
    const adapter = createAdapter(harness, ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: 'Call the echo tool from the smokefixture MCP server with the text ping, then reply with its exact output and nothing else.' });
    await waitTurn(170_000);
    // Harnesses name MCP tool calls differently (Claude uses mcp__<server>__<tool>, ACP reports
    // its own kind), so the proof is the stamp the fixture adds: it is nowhere in the prompt, so
    // only a real round trip to the server can put it in the answer.
    expect([...items.values()].some((i) => i.kind === 'tool')).toBe(true);
    expect(assistantText(items)).toContain('VOCSMCP9137');
  });

  it.runIf(want('acp'))('deepseek harness over ACP answers a prompt', async () => {
    const { ctx, items, events, waitTurn, meta } = await makeCtx('acp', { acpAgent: process.env.HARNESS_SMOKE_ACP_AGENT ?? 'dsh' });
    const adapter = createAdapter('acp', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    expect(meta.harnessRef.acpSessionId).toBeTruthy();
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
  });

  it.runIf(want('antigravity'))('Antigravity lists Gemini models and answers a prompt', async () => {
    const { ctx, items, events, waitTurn, meta } = await makeCtx('antigravity', { permissionMode: 'ask' });
    const adapter = createAdapter('antigravity', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    expect(meta.harnessRef.acpSessionId).toBeTruthy();
    const models = await adapter.listModels!();
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'antigravity', id: expect.stringMatching(/\S/), displayName: expect.stringMatching(/\bGemini\b/i) }),
    ]));
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
  });

  it.runIf(want('antigravity') && process.env.HARNESS_SMOKE_QUESTIONS === '1')('Antigravity asks a structured question via ACP elicitation and receives the selected choice', async () => {
    const { ctx, events, items, waitTurn } = await makeCtx('antigravity', { permissionMode: 'ask' });
    const drafts: ApprovalDraft[] = [];
    ctx.requestApproval = async (draft) => {
      drafts.push(draft);
      if (draft.kind !== 'question' || !draft.questions?.length) throw new Error('Expected a structured question card, not a tool permission.');
      const q = draft.questions[0]!;
      const pick = q.options?.find((option) => /blue/i.test(option.label))?.label ?? q.options?.[0]?.label ?? 'Blue';
      return { optionId: 'allow', answers: { [q.id]: pick }, note: 'Keep it concise.' };
    };
    const adapter = createAdapter('antigravity', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: 'Before answering, use ask_question to ask me one single-select question: "Pick a color" with options "Red" and "Blue". After I answer, reply with exactly COLOR_BLUE if I chose Blue. Do not call any other tools.' });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'COLOR_BLUE');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.questions?.[0]?.options?.map((option) => option.label)).toEqual(expect.arrayContaining(['Red', 'Blue']));
  });

  it.runIf(want('native'))('native loop answers a prompt through an OpenAI-compatible provider', async () => {
    const provider = process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
    if (!provider) throw new Error('Native smoke requested but no DEEPSEEK_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY is available.');
    const model = provider === 'deepseek' ? 'deepseek-v4-flash' : provider === 'openai' ? 'gpt-5.4-mini' : 'claude-sonnet-5';
    const { ctx, items, waitTurn, events } = await makeCtx('native', { model: { provider, model } });
    const adapter = createAdapter('native', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    assertSuccessfulTurn(items, events, 'PONG');
  });

  it.runIf(want('native-tools'))('native loop uses tools with approvals', async () => {
    const provider = process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.OPENAI_API_KEY ? 'openai' : null;
    if (!provider) throw new Error('Native tool smoke requested but no DEEPSEEK_API_KEY or OPENAI_API_KEY is available.');
    const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-5.4-mini';
    const { ctx, items, waitTurn, meta, events } = await makeCtx('native', { model: { provider, model }, permissionMode: 'ask' });
    const adapter = createAdapter('native', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: 'Call write_file exactly once to create hello.txt containing exactly hello from vocs code (no trailing newline). Then call read_file exactly once to read hello.txt. Do not call any other tools or narrate. Reply with exactly DONE.' });
    await waitTurn(170_000);
    const content = await fs.readFile(path.join(meta.cwd, 'hello.txt'), 'utf8');
    expect(content).toBe('hello from vocs code');
    assertSuccessfulTurn(items, events, 'DONE');
    const tools = [...items.values()].filter((i) => i.kind === 'tool');
    expect(tools.map((i) => [i.name, i.status])).toEqual([['write_file', 'done'], ['read_file', 'done']]);
  });

  // Resume round-trips after a dispose (HARNESS_SMOKE_RESUME=1): a second adapter is built from
  // the same session meta, so its start() must resume the persisted harness ref rather than
  // silently starting fresh. A fresh start would still answer PONG, so the tests also assert the
  // ref is unchanged after the continuation turn.
  it.runIf(wantResume('codex'))('codex app-server resumes after dispose', async () => {
    await resumeRoundTrip('codex', 'codexThreadId');
  });

  it.runIf(wantResume('codex-exec'))('codex exec resumes after dispose', async () => {
    await resumeRoundTrip('codex-exec', 'codexThreadId');
  });

  it.runIf(wantResume('cursor'))('cursor resumes after dispose', async () => {
    if (!process.env.CURSOR_API_KEY) throw new Error('Cursor resume smoke requested but CURSOR_API_KEY is not available.');
    await resumeRoundTrip('cursor', 'cursorAgentId');
  });

  it.runIf(wantResume('pi'))('pi resumes after dispose', async () => {
    await resumeRoundTrip('pi', 'piSessionFile');
  });

  it.runIf(wantResume('claude'))('claude resumes after dispose', async () => {
    await resumeRoundTrip('claude', 'claudeSessionId');
  });

  it.runIf(wantResume('acp'))('acp resumes after dispose', async () => {
    await resumeRoundTrip('acp', 'acpSessionId', { acpAgent: process.env.HARNESS_SMOKE_ACP_AGENT ?? 'dsh' });
  });

  it.runIf(wantResume('antigravity'))('Antigravity resumes after dispose', async () => {
    await resumeRoundTrip('antigravity', 'acpSessionId', { permissionMode: 'ask' });
  });

  it.runIf(wantResume('native'))('native resumes after dispose', async () => {
    const provider = process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
    if (!provider) throw new Error('Native resume smoke requested but no provider API key is available.');
    const model = provider === 'deepseek' ? 'deepseek-v4-flash' : provider === 'openai' ? 'gpt-5.4-mini' : 'claude-sonnet-5';
    await resumeRoundTrip('native', 'nativeHistory', { model: { provider, model } });
  });
});
