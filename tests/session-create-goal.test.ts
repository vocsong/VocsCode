/**
 * Creating a session with a goal. When the harness owns `/goal` the objective becomes the harness's
 * own goal command and the app sets no goal state — two goals running at once would fight
 * (see src/shared/goal-driver.ts). Every other harness keeps the app's kickoff prompt.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { HarnessId, SessionMeta, UserInput } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';

type AnyRecord = Record<string, any>;

const mocks = vi.hoisted(() => ({
  /** Every input the manager handed an adapter, in order. */
  sent: [] as { harness: HarnessId; input: UserInput }[],
  contexts: new Map<string, HarnessContext>(),
  disposed: [] as string[]
}));

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: HarnessId, ctx: HarnessContext) => {
    mocks.contexts.set(ctx.sessionId, ctx);
    const adapter: HarnessAdapter = {
      id,
      get busy() {
        return false;
      },
      start: async () => undefined,
      send: async (input: UserInput) => {
        mocks.sent.push({ harness: id, input });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => { mocks.disposed.push(ctx.sessionId); },
      _ctx: ctx
    } as unknown as HarnessAdapter;
    return adapter;
  }
}));

let tmpRoot = '';
let counter = 0;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-create-goal-'));
});
afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

/** A Claude config dir with the `goal` skill installed, so the pre-start disk probe finds it. */
async function configDirWithGoalSkill(): Promise<string> {
  const configDir = path.join(tmpRoot, `claude${++counter}`);
  const dir = path.join(configDir, 'skills', 'goal');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: goal\ndescription: Goals\n---\n', 'utf8');
  return configDir;
}

beforeEach(() => {
  mocks.sent.length = 0;
  mocks.contexts.clear();
  mocks.disposed.length = 0;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

async function makeManager(overrides: Partial<ReturnType<typeof defaultSettings>> = {}, existingDir?: string): Promise<SessionManager> {
  const dir = existingDir ?? path.join(tmpRoot, `store${++counter}`);
  const store = new SessionStore(dir);
  await store.load();
  // No providers keeps the one-shot title call offline; it never runs in these tests anyway.
  const settings = { ...defaultSettings(), providers: [], ...overrides };
  const deps: SessionManagerDeps = {
    store,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as never,
    runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn()
  };
  return new SessionManager(deps);
}

const create = (manager: SessionManager, harness: HarnessId, extra: AnyRecord = {}) =>
  manager.create({ config: { harness, projectRoot: path.join(tmpRoot, 'proj'), permissionMode: 'ask' }, goal: 'ship the release', ...extra } as never);

describe('session create with a goal', () => {
  it('gives the objective to a Claude session whose harness has its own /goal, and sets no app goal', async () => {
    process.env.CLAUDE_CONFIG_DIR = await configDirWithGoalSkill();
    const manager = await makeManager();
    const meta = await create(manager, 'claude');

    expect(meta.nativeGoal).toBe('goal');
    expect(meta.goal).toBeUndefined();
    await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
    // The command has to open the message; the objective rides along as its argument.
    expect(mocks.sent[0]).toMatchObject({ harness: 'claude', input: { text: '/goal ship the release' } });
    // The session is named after the objective, since there is no first prompt to name it from.
    expect(meta.title).toBe('ship the release');
    // No kickoff prompt: the app's engine never runs in this session, so no GOAL_COMPLETE token either.
    expect(mocks.sent.every((s) => !s.input.text.includes('GOAL_COMPLETE'))).toBe(true);
  });

  it('sends the first prompt after the delegated goal command, not instead of it', async () => {
    process.env.CLAUDE_CONFIG_DIR = await configDirWithGoalSkill();
    const manager = await makeManager();
    const meta = await create(manager, 'claude', { initialPrompt: 'start from the failing test' });

    await vi.waitFor(() => expect(mocks.sent).toHaveLength(2));
    expect(mocks.sent.map((s) => s.input.text)).toEqual(['/goal ship the release', 'start from the failing test']);
    expect(meta.goal).toBeUndefined();
  });

  it('keeps the app goal and its kickoff prompt on a harness without its own /goal', async () => {
    const manager = await makeManager();
    const meta = await create(manager, 'native');

    expect(meta.nativeGoal).toBeUndefined();
    expect(meta.goal).toMatchObject({ objective: 'ship the release', status: 'active' });
    await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
    expect(mocks.sent[0].input.text).toContain('GOAL_COMPLETE');
    expect(mocks.sent[0].input.text).toContain('ship the release');
  });

  it('keeps the app goal on Claude when the harness preference is off', async () => {
    process.env.CLAUDE_CONFIG_DIR = await configDirWithGoalSkill();
    const manager = await makeManager({ goalDefaults: { autoContinue: true, maxIterations: 25, preferHarness: false } });
    const meta = await create(manager, 'claude');

    expect(meta.nativeGoal).toBeUndefined();
    expect(meta.goal).toMatchObject({ objective: 'ship the release' });
    await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
    expect(mocks.sent[0].input.text).toContain('GOAL_COMPLETE');
  });

  it('keeps the app goal on Claude when the CLI is not configured to load ~/.claude', async () => {
    process.env.CLAUDE_CONFIG_DIR = await configDirWithGoalSkill();
    const manager = await makeManager({ claude: { runtime: 'auto', useProviderKey: false, settingSources: ['project'] } });
    const meta: SessionMeta = await create(manager, 'claude');

    expect(meta.nativeGoal).toBeUndefined();
    expect(meta.goal).toMatchObject({ objective: 'ship the release' });
  });

  it.each(['completed', 'interrupted', 'failed'] as const)('delivers a goal set during a %s turn exactly once, even without auto-continuation', async (outcome) => {
    vi.useFakeTimers();
    try {
      const manager = await makeManager();
      const meta = await create(manager, 'native', { goal: undefined });
      await manager.send(meta.id, { text: 'Work on the old task' });
      const ctx = mocks.contexts.get(meta.id)!;
      ctx.emit({ type: 'status', status: 'running' });
      await manager.goal(meta.id, 'set', { objective: 'Fix the new task', autoContinue: false });
      expect(mocks.sent.map((s) => s.input.text)).toEqual(['Work on the old task']);

      // The old reply must not finish the newly set goal, even if it ends with the token.
      ctx.emit({ type: 'item.upsert', item: { id: 'old-answer', kind: 'assistant', ts: Date.now(), text: 'Old task done. GOAL_COMPLETE' } });
      ctx.emit({ type: 'item.upsert', item: { id: 'old-turn', kind: 'turn', ts: Date.now(), status: outcome } });
      expect(meta.goal?.status).toBe('active');
      expect(meta.goal?.iterations).toBe(0);
      ctx.emit({ type: 'status', status: 'idle' });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(mocks.sent).toHaveLength(2);
      expect(mocks.sent[1].input.text).toContain('Fix the new task');
      expect(mocks.sent[1].input.text).toContain('GOAL_COMPLETE');
      expect((await manager.transcript(meta.id)).filter((item) => item.kind === 'user' && item.text.includes('Fix the new task'))).toHaveLength(1);
      expect(meta.goal).toMatchObject({ status: 'active', iterations: 0, autoContinue: false });
      // The kickoff can finish without an answer; the old turn's GOAL_COMPLETE cannot be reused.
      ctx.emit({ type: 'item.upsert', item: { id: 'kickoff-turn', kind: 'turn', ts: Date.now(), status: 'completed' } });
      ctx.emit({ type: 'status', status: 'idle' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(meta.goal).toMatchObject({ status: 'active', iterations: 0 });
      expect(mocks.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a pending goal after stop and restart only when explicitly resumed', async () => {
    vi.useFakeTimers();
    try {
      const dir = path.join(tmpRoot, `restart${++counter}`);
      const manager = await makeManager({}, dir);
      const meta = await create(manager, 'native', { goal: undefined });
      await manager.send(meta.id, { text: 'Old task' });
      const ctx = mocks.contexts.get(meta.id)!;
      ctx.emit({ type: 'status', status: 'running' });
      await manager.goal(meta.id, 'set', { objective: 'Continue after restart', autoContinue: false });
      await manager.stop(meta.id);
      expect(mocks.disposed).toEqual([meta.id]);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mocks.sent).toHaveLength(1);

      const restored = await makeManager({}, dir);
      expect(restored.get(meta.id)?.goal).toMatchObject({ objective: 'Continue after restart', status: 'active' });
      await restored.goal(meta.id, 'resume', {});
      expect(mocks.sent).toHaveLength(2);
      expect(mocks.sent[1].input.text).toContain('Resuming the goal: Continue after restart');
      expect((await restored.transcript(meta.id)).filter((item) => item.kind === 'user' && item.text.includes('Continue after restart'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a pending goal when it is reset during the old turn and does not deliver one after pause', async () => {
    vi.useFakeTimers();
    try {
      const manager = await makeManager();
      const meta = await create(manager, 'native', { goal: undefined });
      await manager.send(meta.id, { text: 'Old task' });
      const ctx = mocks.contexts.get(meta.id)!;
      ctx.emit({ type: 'status', status: 'running' });
      await manager.goal(meta.id, 'set', { objective: 'First objective' });
      await manager.goal(meta.id, 'set', { objective: 'Second objective' });
      ctx.emit({ type: 'status', status: 'idle' });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(mocks.sent).toHaveLength(2);
      expect(mocks.sent[1].input.text).toContain('Second objective');
      expect(mocks.sent[1].input.text).not.toContain('First objective');

      ctx.emit({ type: 'status', status: 'running' });
      await manager.goal(meta.id, 'set', { objective: 'Paused objective' });
      await manager.goal(meta.id, 'pause', {});
      ctx.emit({ type: 'status', status: 'idle' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(mocks.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
