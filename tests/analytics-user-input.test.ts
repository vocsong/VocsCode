import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { emptyUsage } from '../src/main/models/static-models';
import { buildScope } from '../src/renderer/src/components/analytics/model';
import { totalTokens } from '../src/shared/usage-rollup';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const roots: string[] = [];
const today = Date.UTC(2026, 8, 20, 12);
const day = 86_400_000;
const log = vi.fn();
const meta = (id = 's_input'): SessionMeta => ({
  id, title: 'Input tracking', createdAt: today - 40 * day, updatedAt: today,
  config: { harness: 'native', projectRoot: '/project', permissionMode: 'ask' },
  cwd: '/project', harnessRef: {}, status: 'idle', activeModel: { provider: 'local', model: 'test' }, usage: emptyUsage()
});
const message = (id: string, tokens: number, ts = today, sessionId = 's_input'): Extract<TranscriptItem, { kind: 'user' }> => ({
  id, kind: 'user', ts, text: 'The transcript can include generated context; only the host receipt is counted.',
  userInput: { id: `input_${id}`, sessionId, ts, tokens }
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-user-input-'));
  roots.push(root);
  const store = new AnalyticsStore(root, { log });
  await store.load([]);
  return { root, store };
}
afterEach(async () => {
  vi.restoreAllMocks();
  log.mockClear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('user-entered token analytics', () => {
  it('counts each submission once, separately from provider usage, across date ranges and reloads', async () => {
    const { root, store } = await setup();
    const session = meta();
    const recent = message('recent', 12);
    store.recordUserMessage(session, message('old', 30, today - 35 * day));
    store.recordUserMessage(session, message('previous', 8, today - 10 * day));
    store.recordUserMessage(session, recent);
    store.recordUserMessage(session, recent);
    // Provider usage includes assembled context and can be emitted repeatedly or reset.
    store.recordUsage(session, { ...emptyUsage(), inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, reasoningTokens: 40, costUsd: 2 }, today);
    store.recordUsage(session, { ...emptyUsage(), inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, reasoningTokens: 40, costUsd: 2 }, today);
    await store.flush();
    const fresh = new AnalyticsStore(root, { log });
    await fresh.load([]);
    fresh.recordUserMessage(session, recent);
    const seven = buildScope(fresh.summary(7, today), 7, today);
    expect(seven.totals.userInputTokens).toBe(12);
    expect(seven.previous?.userInputTokens).toBe(8);
    expect(buildScope(fresh.summary(30, today), 30, today).totals.userInputTokens).toBe(20);
    const all = buildScope(fresh.summary(0, today), 0, today);
    expect(all.totals.userInputTokens).toBe(50);
    expect(totalTokens(all.totals)).toBe(1600);
    expect(all.totals.costUsd).toBe(2);
    expect(all.days.at(-1)?.usage.by?.harness.native.userInputTokens).toBe(12);
    await fresh.flush();
  });

  it('ignores legacy/automated messages, copied fork receipts, and invalid estimates', async () => {
    const { store } = await setup();
    const session = meta();
    store.recordUserMessage(session, { id: 'legacy', kind: 'user', ts: today, text: 'Cannot prove whether this was typed or generated' });
    store.recordUserMessage(meta('fork'), message('inherited', 99));
    for (const tokens of [-1, NaN, Infinity, 1.5]) store.recordUserMessage(session, message(`invalid_${tokens}`, tokens));
    store.recordUserMessage(session, message('empty', 0));
    expect(buildScope(store.summary(0, today), 0, today).totals.userInputTokens).toBe(0);
    await store.flush();
  });

  it('recovers marked transcript receipts after a failed analytics write, without replaying copied or duplicate submissions', async () => {
    const { root, store } = await setup();
    const session = meta();
    const first = message('first', 10);
    store.recordUserMessage(session, first);
    await store.flush();
    const second = message('second', 20);
    store.recordUserMessage(session, second);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, 'analytics.json')) throw new Error('injected analytics write failure');
      return rename(from, to);
    });
    await store.flush();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('injected analytics write failure'));
    vi.restoreAllMocks();
    const transcript = vi.fn(async () => [first, second]);
    const fresh = new AnalyticsStore(root, { log });
    await fresh.load([session, meta('fork')], transcript);
    await fresh.whenBackfilled();
    expect(buildScope(fresh.summary(0, today), 0, today).totals.userInputTokens).toBe(30);
    fresh.recordUserMessage(session, second);
    await fresh.flush();
    const again = new AnalyticsStore(root, { log });
    transcript.mockClear();
    await again.load([session, meta('fork')], transcript);
    await again.whenBackfilled();
    expect(transcript).toHaveBeenCalledTimes(2);
    expect(buildScope(again.summary(0, today), 0, today).totals.userInputTokens).toBe(30);
    // A crash may persist a new receipt without updating session metadata. Replay still recovers it.
    const third = message('third', 5);
    const changed = new AnalyticsStore(root, { log });
    await changed.load([session], async () => [first, second, third]);
    await changed.whenBackfilled();
    expect(buildScope(changed.summary(0, today), 0, today).totals.userInputTokens).toBe(35);
    await changed.flush();
  });

  it('retries an unreadable transcript on the next load instead of marking missing data complete', async () => {
    const { root } = await setup();
    const session = meta();
    const failed = new AnalyticsStore(root, { log });
    await failed.load([session], async () => { throw new Error('unavailable transcript'); });
    await failed.whenBackfilled();
    const recovered = new AnalyticsStore(root, { log });
    await recovered.load([session], async () => [message('recovered', 7)]);
    await recovered.whenBackfilled();
    expect(buildScope(recovered.summary(0, today), 0, today).totals.userInputTokens).toBe(7);
    await recovered.flush();
  });
});
