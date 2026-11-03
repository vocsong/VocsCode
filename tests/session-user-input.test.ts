/** User input is measured at submission, not from the much larger prompt the provider receives. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessContext } from '../src/main/harness/types';
import { emptyUsage } from '../src/main/models/static-models';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { HarnessId, TranscriptItem, UserInput } from '../src/shared/types';
import { totalTokens } from '../src/shared/usage-rollup';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));

type UserItem = Extract<TranscriptItem, { kind: 'user' }>;
interface Fixture {
  manager: SessionManager;
  store: SessionStore;
  analytics: AnalyticsStore;
  log: ReturnType<typeof vi.fn>;
}
const T0 = Date.parse('2026-09-10T23:59:59Z');
let now: number;
let root: string;
let fixtures: Fixture[];
let adapters: Map<string, { ctx: HarnessContext; sent: UserInput[]; rewound: string[]; busy: boolean }>;

async function open(options: { waitForBackfill?: boolean; readTranscript?: (id: string) => Promise<TranscriptItem[]> } = {}): Promise<Fixture> {
  const store = new SessionStore(root);
  await store.load();
  const log = vi.fn();
  const analytics = new AnalyticsStore(root, { log });
  await analytics.load(store.list(), options.readTranscript ?? ((id) => store.readTranscript(id)));
  if (options.waitForBackfill !== false) await analytics.whenBackfilled();
  const settings = { ...defaultSettings(), providers: [], autoCompactionThreshold: undefined };
  const manager = new SessionManager({
    store,
    analytics,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as unknown as SettingsStore,
    runtime: {} as never,
    getSecret: async () => undefined,
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log,
    appInstructions: async () => 'App instructions: never include this generated text in user input.',
    knowledgeDigest: async () => 'Project knowledge: this generated context is not a user submission.'
  });
  const fixture = { manager, store, analytics, log };
  fixtures.push(fixture);
  return fixture;
}

async function session(f: Fixture, harness: HarnessId = 'native') {
  return f.manager.create({ title: 'User input accounting', config: { harness, projectRoot: root, permissionMode: 'ask' } });
}

async function users(f: Fixture, id: string): Promise<UserItem[]> {
  return (await f.store.readTranscript(id)).filter((item): item is UserItem => item.kind === 'user');
}

function counted(f: Fixture, range = 0) {
  return f.analytics.summary(range, now).days.reduce((sum, day) => sum + day.usage.userInputTokens, 0);
}

function countedDays(f: Fixture) {
  return f.analytics.summary(0, now).days.filter((day) => day.usage.userInputTokens > 0).map((day) => [day.date, day.usage.userInputTokens]);
}

async function settle(f: Fixture) {
  await f.manager.stopAll();
  await f.manager.flushPendingPersists();
  for (const meta of f.store.list()) await f.store.readTranscript(meta.id);
  await f.analytics.flush();
}

beforeEach(async () => {
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-user-input-'));
  fixtures = [];
  adapters = new Map();
  vi.mocked(createAdapter).mockImplementation((id, ctx) => {
    const script = { ctx, sent: [] as UserInput[], rewound: [] as string[], busy: false };
    adapters.set(ctx.sessionId, script);
    return {
      id,
      get busy() { return script.busy; },
      start: async () => ctx.emit({ type: 'status', status: 'idle' }),
      send: async (input) => { script.sent.push(input); },
      interrupt: async () => { script.busy = false; },
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      rewindToUserMessage: async (itemId) => { script.rewound.push(itemId); return true; },
      dispose: async () => undefined
    };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const f of fixtures) await settle(f);
  await fs.rm(root, { recursive: true, force: true });
});

it('counts only the initial Unicode text, excluding the active goal, instructions, knowledge and attachments', async () => {
  const f = await open();
  const file = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('Attachment contents. '.repeat(100)).toString('base64') };
  const image = { name: 'shot.png', mimeType: 'image/png', data: Buffer.from('not user text').toString('base64') };
  const meta = await f.manager.create({
    title: 'Initial prompt',
    config: { harness: 'codex', projectRoot: root, permissionMode: 'ask' },
    goal: 'A generated goal annotation that is much longer than the submitted prompt',
    initialPrompt: '🙂🙂🙂🙂a', initialFiles: [file], initialImages: [image]
  });
  await vi.waitFor(() => expect(adapters.get(meta.id)?.sent).toHaveLength(1));
  const [item] = await users(f, meta.id);
  // Five Unicode code points (nine UTF-16 code units): ceil(5 / 4), not ceil(9 / 4).
  expect(item.userInput).toEqual({ id: expect.any(String), sessionId: meta.id, ts: T0, tokens: 2 });
  expect(item.userInput!.id).not.toBe('');
  expect(item.files).toHaveLength(1);
  expect(await fs.readFile(item.files![0].path, 'utf8')).toBe('Attachment contents. '.repeat(100));
  const sent = adapters.get(meta.id)!.sent[0];
  expect(sent.text).toContain('Active goal:');
  expect(sent.text).toContain('App instructions:');
  expect(sent.text).toContain('Project knowledge:');
  expect(sent.text).toContain(JSON.stringify(item.files![0].path));
  expect(sent.images).toEqual([image]);
  expect(counted(f)).toBe(2);

  // Billed input includes the whole context; it is a separate ledger, never this estimate.
  const usage = { ...emptyUsage(), inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, reasoningTokens: 5, turns: 1 };
  adapters.get(meta.id)!.ctx.emit({ type: 'usage', totals: usage });
  expect(f.manager.get(meta.id)!.usage).toEqual(usage);
  expect(f.analytics.summary(0, now).totals).toEqual(usage);
  expect(totalTokens(f.analytics.summary(0, now).totals)).toBe(180);
  expect(counted(f)).toBe(2);

  await f.manager.send(meta.id, { text: '', files: [file], images: [image] });
  expect((await users(f, meta.id))[1].userInput?.tokens).toBe(0);
  expect(counted(f)).toBe(2);
});

it('counts queue and steer submissions once even when their transcript upserts replay after midnight', async () => {
  const f = await open();
  const meta = await session(f);
  await f.manager.send(meta.id, { text: 'abcd', mode: 'now' });
  const adapter = adapters.get(meta.id)!;
  adapter.busy = true;
  adapter.ctx.emit({ type: 'status', status: 'running' });
  await f.manager.send(meta.id, { text: 'abcde', mode: 'queue' });
  await f.manager.send(meta.id, { text: '  ab\n🙂🙂🙂🙂  ', mode: 'steer' });
  const submitted = await users(f, meta.id);
  expect(submitted.map((item) => item.userInput?.tokens)).toEqual([1, 2, 3]);
  expect(new Set(submitted.map((item) => item.userInput?.id)).size).toBe(3);
  expect(adapter.sent.map((input) => input.mode)).toEqual(['now', 'queue', 'steer']);
  expect(counted(f)).toBe(6);

  now += 2_000;
  for (const item of submitted) {
    adapter.ctx.emit({ type: 'item.upsert', item: { ...item, queuedAs: undefined } });
    adapter.ctx.emit({ type: 'item.upsert', item: { ...item, queuedAs: undefined } });
  }
  adapter.ctx.emit({ type: 'item.upsert', item: { id: 'reply', kind: 'assistant', ts: now, text: 'Generated output. '.repeat(100) } });
  adapter.ctx.emit({ type: 'item.upsert', item: { id: 'turn', kind: 'turn', ts: now, status: 'completed' } });
  expect(await users(f, meta.id)).toHaveLength(3);
  expect(countedDays(f)).toEqual([['2026-09-10', 6]]);
  await settle(f);
  expect(countedDays(await open())).toEqual([['2026-09-10', 6]]);
});

it('adds an edit-and-resend as a new submission on its own UTC day without changing the transcript item id', async () => {
  const f = await open();
  const meta = await session(f);
  await f.manager.send(meta.id, { text: 'abcd' });
  const [original] = await users(f, meta.id);
  adapters.get(meta.id)!.ctx.emit({ type: 'item.upsert', item: { id: 'old-answer', kind: 'assistant', ts: now, text: 'Discarded answer' } });
  adapters.get(meta.id)!.ctx.emit({ type: 'item.upsert', item: { id: 'old-turn', kind: 'turn', ts: now, status: 'completed' } });
  now += 2_000;

  await f.manager.editAndResend(meta.id, original.id, { text: '🙂🙂🙂🙂a' });

  const [revised] = await users(f, meta.id);
  expect(revised.id).toBe(original.id);
  expect(revised.userInput).toEqual({ id: expect.any(String), sessionId: meta.id, ts: now, tokens: 2 });
  expect(revised.userInput!.id).not.toBe(original.userInput!.id);
  expect((await f.store.readTranscript(meta.id)).map((item) => item.id)).toEqual([original.id]);
  expect(adapters.get(meta.id)!.sent.map((input) => input.text)).toEqual(['abcd', '🙂🙂🙂🙂a']);
  expect(countedDays(f)).toEqual([['2026-09-10', 1], ['2026-09-11', 2]]);
  expect(counted(f, 1)).toBe(2);
  expect(counted(f, 2)).toBe(3);
  // Recording the receipt must not invent an execution turn at the original item's old timestamp.
  expect(f.analytics.executions.allTurns()).toHaveLength(1);
  await settle(f);

  const restarted = await open();
  expect(countedDays(restarted)).toEqual([['2026-09-10', 1], ['2026-09-11', 2]]);
  expect((await users(restarted, meta.id))[0].userInput).toEqual(revised.userInput);
});

it('refuses edit-and-resend when the accounting write fails, without rewinding, sending or removing transcript receipts', async () => {
  const f = await open();
  const meta = await session(f);
  await f.manager.send(meta.id, { text: 'abcd' });
  const [original] = await users(f, meta.id);
  await f.manager.send(meta.id, { text: 'abcdefgh' });
  const adapter = adapters.get(meta.id)!;
  const before = await f.store.readTranscript(meta.id);
  const rename = fs.rename.bind(fs);
  let failed = 0;
  const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(root, 'analytics.json')) {
      failed++;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    await rename(from, to);
  });
  try {
    await expect(f.manager.editAndResend(meta.id, original.id, { text: 'abcdefghijkl' })).rejects.toThrow('disk full');
  } finally {
    failure.mockRestore();
  }
  expect(failed).toBe(1);
  expect(adapter.rewound).toEqual([]);
  expect(adapter.sent.map((input) => input.text)).toEqual(['abcd', 'abcdefgh']);
  expect(await f.store.readTranscript(meta.id)).toEqual(before);
  expect(counted(f)).toBe(3);

  // A retry can persist the old receipts, rewind once, and add only the successful submission.
  await f.manager.editAndResend(meta.id, original.id, { text: 'abcdefghijkl' });
  expect(adapter.rewound).toEqual([original.id]);
  expect(adapter.sent.map((input) => input.text)).toEqual(['abcd', 'abcdefgh', 'abcdefghijkl']);
  expect((await users(f, meta.id)).map((item) => item.id)).toEqual([original.id]);
  expect(counted(f)).toBe(6);
  await settle(f);
  expect(counted(await open())).toBe(6);
});

it.each([undefined, 'codex'] as const)('does not count copied fork receipts again (target %s)', async (harness) => {
  const f = await open();
  const source = await session(f);
  await f.manager.send(source.id, { text: 'abcd' });
  const [original] = await users(f, source.id);
  const fork = (await f.manager.fork(source.id, harness))!;
  const [copied] = await users(f, fork.id);
  expect(copied.userInput).toEqual(original.userInput);
  expect(copied.userInput?.sessionId).toBe(source.id);

  await f.manager.send(fork.id, { text: 'abcdefgh' });
  const adapter = adapters.get(fork.id)!;
  if (harness) {
    expect(adapter.sent[0].text).toContain('Handoff from');
    expect(adapter.sent[0].text.endsWith('abcdefgh')).toBe(true);
  }
  // An imported item's upsert is not a new submission, even in the fork's live event stream.
  adapter.ctx.emit({ type: 'item.upsert', item: copied });
  expect(counted(f)).toBe(3);
  expect((await users(f, fork.id))[1].userInput).toMatchObject({ sessionId: fork.id, tokens: 2 });
  expect(source.usage).toEqual(emptyUsage());
  expect(fork.usage).toEqual(emptyUsage());
  await settle(f);
  const restarted = await open();
  expect(counted(restarted)).toBe(3);
  expect(restarted.analytics.summary(0, now).totals).toEqual(emptyUsage());
});

it('recovers a receipt after an analytics write failure for an already-backfilled session, once across two restarts', async () => {
  const first = await open();
  const meta = await session(first);
  await first.manager.send(meta.id, { text: 'abcd' });
  await settle(first);
  const resumed = await open();
  expect(counted(resumed)).toBe(1);
  const baseline = await fs.readFile(path.join(root, 'analytics.json'), 'utf8');
  const oldIndex = await fs.readFile(path.join(root, 'sessions.json'), 'utf8');
  now += 2_000;
  await resumed.manager.send(meta.id, { text: 'abcdefgh' });
  // Older transcripts and generated prompts have no receipt; recovery must not guess from text.
  await resumed.store.appendTranscript(meta.id, { id: 'legacy', kind: 'user', ts: now, text: 'Unmarked legacy or automated input. '.repeat(100) });
  await resumed.manager.stopAll();
  await resumed.manager.flushPendingPersists();
  await resumed.store.readTranscript(meta.id);
  const rename = fs.rename.bind(fs);
  let failed = 0;
  const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(root, 'analytics.json')) {
      failed++;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    await rename(from, to);
  });
  await resumed.analytics.flush();
  failure.mockRestore();
  expect(failed).toBe(1);
  expect(resumed.log).toHaveBeenCalledWith('warn', expect.stringContaining('analytics write failed:'));
  expect(await fs.readFile(path.join(root, 'analytics.json'), 'utf8')).toBe(baseline);

  // The transcript can land before its debounced metadata write. Keep the previous index so a
  // metadata-only recovery checkpoint would incorrectly skip this already-backfilled session.
  await fs.writeFile(path.join(root, 'sessions.json'), oldIndex);
  // No retry/flush from the old process: only the durable transcript can recover this submission.
  const recovered = await open();
  expect(countedDays(recovered)).toEqual([['2026-09-10', 1], ['2026-09-11', 2]]);
  await recovered.analytics.flush();
  const again = await open();
  expect(countedDays(again)).toEqual([['2026-09-10', 1], ['2026-09-11', 2]]);
  expect(again.analytics.summary(0, now).totals).toEqual(emptyUsage());
});

it('leaves goal kickoff, continuation and resume prompts unmarked but counts a subsequent explicit message', async () => {
  const f = await open();
  const meta = await f.manager.create({ title: 'Automatic goal', config: { harness: 'native', projectRoot: root, permissionMode: 'ask' }, goal: 'Complete the work' });
  await vi.waitFor(() => expect(adapters.get(meta.id)?.sent).toHaveLength(1));
  const adapter = adapters.get(meta.id)!;
  expect(adapter.sent[0].text).toContain('GOAL_COMPLETE');
  adapter.ctx.emit({ type: 'item.upsert', item: { id: 'answer', kind: 'assistant', ts: now, text: 'Still working.' } });
  adapter.ctx.emit({ type: 'item.upsert', item: { id: 'turn', kind: 'turn', ts: now, status: 'completed' } });
  adapter.ctx.emit({ type: 'status', status: 'idle' });
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(2), { timeout: 3_000 });
  expect(adapter.sent[1].text).toContain('Goal check-in 1/');
  await f.manager.goal(meta.id, 'pause', {});
  await f.manager.goal(meta.id, 'resume', {});
  await vi.waitFor(() => expect(adapter.sent).toHaveLength(3));
  expect((await users(f, meta.id)).map((item) => item.userInput)).toEqual([undefined, undefined, undefined]);
  expect(counted(f)).toBe(0);

  await f.manager.send(meta.id, { text: 'abcd' });
  expect(counted(f)).toBe(1);
  await settle(f);
  expect(counted(await open())).toBe(1);
});

it.each(['edit', 'clear', 'delete'] as const)('preserves unflushed receipts before %s while startup replay is still waiting', async (action) => {
  const first = await open();
  const meta = await session(first);
  first.analytics.recordUsage(meta, emptyUsage());
  await first.analytics.flush();
  const baseline = await fs.readFile(path.join(root, 'analytics.json'), 'utf8');
  await first.manager.send(meta.id, { text: 'abcd' });
  await first.manager.send(meta.id, { text: 'abcdefgh' });
  const [original] = await users(first, meta.id);
  await settle(first);
  fixtures.splice(fixtures.indexOf(first), 1); // The previous process no longer retries writes.
  await fs.writeFile(path.join(root, 'analytics.json'), baseline);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const resumed = await open({ waitForBackfill: false, readTranscript: async (id) => {
    await waiting;
    return new SessionStore(root).readTranscript(id);
  } });
  try {
    expect(counted(resumed)).toBe(0);
    if (action === 'edit') await resumed.manager.editAndResend(meta.id, original.id, { text: 'abcdefghijkl' });
    else if (action === 'clear') await resumed.manager.clearTranscript(meta.id);
    else await resumed.manager.delete(meta.id);
  } finally {
    release();
    await resumed.analytics.whenBackfilled();
  }
  expect(counted(resumed)).toBe(action === 'edit' ? 6 : 3);
  await settle(resumed);
  expect(counted(await open())).toBe(action === 'edit' ? 6 : 3);
});

it('excludes a generated native goal command while counting the separate initial prompt', async () => {
  const configDir = path.join(root, 'claude');
  const skills = path.join(configDir, 'skills', 'goal');
  await fs.mkdir(skills, { recursive: true });
  await fs.writeFile(path.join(skills, 'SKILL.md'), '---\nname: goal\ndescription: Goals\n---\n');
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  const f = await open();
  const meta = await f.manager.create({ title: 'Native goal', config: { harness: 'claude', projectRoot: root, permissionMode: 'ask' }, goal: 'Ship the release', initialPrompt: 'abcd' });
  await vi.waitFor(() => expect(adapters.get(meta.id)?.sent).toHaveLength(2));
  expect(adapters.get(meta.id)!.sent.map((input) => input.text)).toEqual(['/goal Ship the release', 'abcd']);
  const items = await users(f, meta.id);
  expect(items[0].userInput?.tokens ?? 0).toBe(0);
  expect(items[1].userInput).toMatchObject({ sessionId: meta.id, tokens: 1 });
  expect(counted(f)).toBe(1);
});
