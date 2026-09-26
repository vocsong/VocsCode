// Forking into a different harness cannot resume the source's provider session, so the copied
// transcript is handed to the new harness as a one-shot preamble on its first message.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import { createForkWorktree } from '../src/main/git';
import { renderForkContext } from '../src/main/fork-context';
import { emptyUsage } from '../src/main/models/static-models';
import { sessionUsageStats } from '../src/renderer/src/session-usage';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SessionStore } from '../src/main/store';
import type { SessionMeta, TranscriptItem, UserInput } from '../src/shared/types';

const sent = vi.hoisted((): UserInput[] => []);

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: () => ({
    id: 'native',
    busy: false,
    start: async () => undefined,
    send: async (input: UserInput) => void sent.push(input),
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    dispose: async () => undefined
  })
}));

// These fixtures have no repository behind their project root, so the default is "share the
// source's directory"; the relocated case overrides it per test. The real one is covered against a
// real repo in session-worktree-isolation.test.ts.
vi.mock('../src/main/git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createForkWorktree: vi.fn(async () => null)
}));

const source = (harness: SessionMeta['config']['harness']): SessionMeta => ({
  id: 's_src',
  title: 'source session',
  createdAt: 1,
  updatedAt: 2,
  cwd: 'G:/proj/wt',
  worktreeBranch: 'agent/source-session',
  config: { harness, projectRoot: 'G:/proj', permissionMode: 'auto' },
  harnessRef: {},
  status: 'idle',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
});

function makeManager(src: SessionMeta, items: TranscriptItem[]) {
  const sessions: SessionMeta[] = [src];
  const transcripts = new Map<string, TranscriptItem[]>([[src.id, items]]);
  const blobs = new Map<string, string>();
  const store = {
    list: () => sessions,
    get: (id: string) => sessions.find((s) => s.id === id),
    upsert: vi.fn(async (m: SessionMeta) => {
      const i = sessions.findIndex((s) => s.id === m.id);
      if (i >= 0) sessions[i] = m;
      else sessions.push(m);
    }),
    readTranscript: async (id: string) => transcripts.get(id) ?? [],
    rewriteTranscript: vi.fn(async (id: string, next: TranscriptItem[]) => void transcripts.set(id, next)),
    appendTranscript: vi.fn(async (id: string, item: TranscriptItem) => void transcripts.set(id, [...(transcripts.get(id) ?? []), item])),
    readBlob: async (_id: string, name: string) => blobs.get(name) ?? null,
    writeBlob: vi.fn(async (_id: string, name: string, content: string) => {
      blobs.set(name, content);
      return path.join('G:/tmp', name);
    }),
    sessionDir: (id: string) => path.join('G:/tmp', id)
  } as unknown as SessionStore;
  const settings = defaultSettings();
  settings.defaultModelByHarness.pi = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
  const manager = new SessionManager({
    store,
    settings: { get: () => settings } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn()
  });
  return { manager, store, sessions };
}

const conversation: TranscriptItem[] = [
  { id: 'u_1', kind: 'user', ts: 1, text: 'fix the login bug' },
  { id: 'a_1', kind: 'assistant', ts: 2, text: 'I found the cause in session.ts' },
  { id: 't_1', kind: 'tool', ts: 3, name: 'bash', summary: 'npm test', status: 'error', output: '2 tests failed' },
  { id: 'i_1', kind: 'info', ts: 4, level: 'info', text: 'noise' }
];

describe('renderForkContext', () => {
  it('renders the conversation, keeps failures, and drops informational noise', () => {
    const text = renderForkContext(conversation, 'claude', 'pi');
    expect(text).toContain('Handoff from Claude Agent SDK to Pi');
    expect(text).toContain('**User:**\nfix the login bug');
    expect(text).toContain('I found the cause in session.ts');
    expect(text).toContain('**Tool bash — npm test** [error]\n2 tests failed');
    expect(text).not.toContain('noise');
    expect(text).toContain('--- End of previous conversation ---');
  });

  it('keeps the most recent items when the conversation exceeds the budget', () => {
    const items: TranscriptItem[] = Array.from({ length: 40 }, (_, i) => ({ id: `u_${i}`, kind: 'user' as const, ts: i, text: `message ${i} ${'x'.repeat(1_400)}` }));
    const text = renderForkContext(items, 'claude', 'pi');
    expect(text).toContain('earlier item(s) omitted for length.');
    expect(text).toContain('message 39');
    expect(text).not.toContain('message 0 ');
  });
});

describe('cross-harness fork context', () => {
  it('hands the prior conversation to the new harness on its first message only', async () => {
    sent.length = 0;
    const { manager } = makeManager(source('claude'), conversation);
    const fork = await manager.fork('s_src', 'pi');
    expect(fork!.pendingForkContext).toBe(true);

    await manager.send(fork!.id, { text: 'now add a regression test' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Handoff from Claude Agent SDK to Pi');
    expect(sent[0].text).toContain('fix the login bug');
    expect(sent[0].text.endsWith('now add a regression test')).toBe(true);
    // The transcript still shows only what the user typed.
    expect(manager.get(fork!.id)!.pendingForkContext).toBeUndefined();

    await manager.send(fork!.id, { text: 'and run it' });
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toBe('and run it');
  });

  it('does not seed a same-harness fork that stayed in the source directory', async () => {
    sent.length = 0;
    const { manager } = makeManager(source('claude'), conversation);
    const fork = await manager.fork('s_src');
    expect(fork!.pendingForkContext).toBeUndefined();
    await manager.send(fork!.id, { text: 'continue' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('continue');
  });

  it('hands the conversation to a same-harness fork that moved to its own worktree', async () => {
    sent.length = 0;
    const src = { ...source('claude'), harnessRef: { claudeSessionId: 'claude_abc' } };
    vi.mocked(createForkWorktree).mockResolvedValueOnce({ path: 'G:/proj/.vocs-code/worktrees/source-fork', branch: 'vocscode/source-fork' });
    const { manager } = makeManager(src, conversation);

    const fork = await manager.fork('s_src');
    // A provider session id is bound to the directory it ran in, so the moved fork starts fresh
    // from the transcript instead of resuming claude_abc in a directory that never held it.
    expect(fork!.cwd).toBe('G:/proj/.vocs-code/worktrees/source-fork');
    expect(fork!.worktreeBranch).toBe('vocscode/source-fork');
    expect(fork!.harnessRef).toEqual({});
    expect(fork!.pendingForkContext).toBe(true);

    await manager.send(fork!.id, { text: 'now add a regression test' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Handoff from a previous session');
    expect(sent[0].text).toContain('fix the login bug');
    expect(sent[0].text.endsWith('now add a regression test')).toBe(true);
    expect(manager.get(fork!.id)!.pendingForkContext).toBeUndefined();

    await manager.send(fork!.id, { text: 'and run it' });
    expect(sent[1].text).toBe('and run it');
  });
});

/** A source session that really spent money: $23.86 over two completed turns. */
const SPENT = { inputTokens: 1_100_000, outputTokens: 1_500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 23.86, turns: 2 };
const spentTranscript: TranscriptItem[] = [
  { id: 'u_1', kind: 'user', ts: 10, text: 'fix the login bug' },
  { id: 'turn_1', kind: 'turn', ts: 20, status: 'completed', durationMs: 1_000, costUsd: 20, usage: { inputTokens: 1_000_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  { id: 'turn_2', kind: 'turn', ts: 30, status: 'completed', durationMs: 2_000, costUsd: 3.86, usage: { inputTokens: 100_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } }
];

// A fork carries the conversation, not the ledger. Inheriting the source's totals charges the same
// dollars to two sessions, and the dashboard then adds them up twice — which is where the largest
// remaining error on it came from.
describe('fork spend', () => {
  async function forked(harness?: SessionMeta['config']['harness']) {
    const { manager, store } = makeManager({ ...source('claude'), updatedAt: 30, usage: { ...SPENT } }, spentTranscript.map((i) => ({ ...i })));
    const fork = (await manager.fork('s_src', harness))!;
    const items = await store.readTranscript(fork.id);
    return { fork, items, carried: items.filter((i): i is Extract<TranscriptItem, { kind: 'turn' }> => i.kind === 'turn') };
  }

  const shapes: [string, SessionMeta['config']['harness'] | undefined][] = [
    ['a same-harness fork', undefined],
    ['a fork into another harness', 'pi']
  ];

  for (const [shape, harness] of shapes) {
    it(`hands ${shape} the conversation without the spend`, async () => {
      const { fork, items, carried } = await forked(harness);

      // The ledger starts at zero: the source's totals describe work this session did not do.
      expect(fork.usage).toEqual(emptyUsage());
      expect(fork.forkedFrom).toBe('s_src');

      // The rows are all there — same ids, same tokens: the fork can see the conversation. Worth
      // nothing, and marked so a reader can tell them from a turn that genuinely cost nothing.
      expect(carried.map((t) => [t.id, t.costUsd, t.carried])).toEqual([
        ['turn_1', 0, true],
        ['turn_2', 0, true]
      ]);
      expect(carried.map((t) => t.usage?.inputTokens)).toEqual([1_000_000, 100_000]);

      // What the Usage panel reports for it: nothing spent here, and the inherited turns named.
      const stats = sessionUsageStats(fork, items);
      expect(stats.turns.total).toBe(0);
      expect(stats.turns.costUsd).toBe(0);
      expect(stats.carried.turns).toBe(2);
    });
  }

  it('counts a turn the fork ran itself, on top of carried rows worth nothing', async () => {
    const { fork, items } = await forked();
    items.push({ id: 'turn_3', kind: 'turn', ts: fork.createdAt + 1, status: 'completed', durationMs: 500, costUsd: 0.42, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const stats = sessionUsageStats(fork, items);
    expect(stats.turns.costUsd).toBeCloseTo(0.42, 9);
    expect(stats.turns.total).toBe(1);
    expect(stats.carried.turns).toBe(2);
  });
});
