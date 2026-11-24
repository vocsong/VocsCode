/** Regression coverage for stat-gated analytics startup backfill and extracted startup migrations. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { reconcileForkInheritance, repriceClaudeFallbackTranscripts } from '../src/main/analytics-migrations';
import { emptyUsage } from '../src/main/models/static-models';
import { SessionStore } from '../src/main/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const roots: string[] = [];
const T0 = Date.UTC(2026, 9, 10, 12);

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-analytics-scan-'));
  roots.push(dir);
  return dir;
}

function makeMeta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    createdAt: T0,
    updatedAt: T0,
    config: { harness: 'native', projectRoot: '/repo', permissionMode: 'ask' },
    cwd: '/repo',
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage(),
    ...overrides
  };
}

function makeUserReceipt(id: string, sessionId: string, tokens: number, ts = T0): Extract<TranscriptItem, { kind: 'user' }> {
  return {
    id,
    kind: 'user',
    ts,
    text: 'hello',
    userInput: { id: `receipt_${id}`, sessionId, ts, tokens }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('stat-gated analytics startup scan', () => {
  it('skips re-reading unchanged transcripts on steady-state restarts while recovering crashed appends', async () => {
    const root = await makeRoot();
    const log = vi.fn();
    const store = new SessionStore(root, log);
    await store.load();
    const meta = makeMeta('s_stat_1');
    await store.upsert(meta);
    await store.appendTranscript(meta.id, makeUserReceipt('u1', meta.id, 10));

    // Boot 1: scans transcript, records receipt + execution backfill, and persists file stat stamp.
    const read1 = vi.fn((id: string) => store.readTranscript(id));
    const boot1 = new AnalyticsStore(root, { log });
    await boot1.load(store.list(), read1, [], { transcriptStamp: (id) => store.transcriptStamp(id) });
    await boot1.whenBackfilled();
    expect(read1).toHaveBeenCalledTimes(2); // Initial tool backfill + execution/receipt replay.
    expect(boot1.summary(0, T0).days.reduce((sum, d) => sum + d.usage.userInputTokens, 0)).toBe(10);

    // Boot 2: unchanged transcript on disk -> 0 transcript reads!
    const store2 = new SessionStore(root, log);
    await store2.load();
    const read2 = vi.fn((id: string) => store2.readTranscript(id));
    const boot2 = new AnalyticsStore(root, { log });
    await boot2.load(store2.list(), read2, [], { transcriptStamp: (id) => store2.transcriptStamp(id) });
    await boot2.whenBackfilled();
    expect(read2).toHaveBeenCalledTimes(0);
    expect(boot2.summary(0, T0).days.reduce((sum, d) => sum + d.usage.userInputTokens, 0)).toBe(10);

    // Simulate a crash: a new receipt lands in transcript.jsonl while sessions.json (updatedAt) and
    // analytics.json are untouched from Boot 2.
    const oldIndex = await fs.readFile(path.join(root, 'sessions.json'), 'utf8');
    await store2.appendTranscript(meta.id, makeUserReceipt('u2', meta.id, 25, T0 + 1_000));
    await fs.writeFile(path.join(root, 'sessions.json'), oldIndex);

    // Boot 3: transcript file size/mtime changed -> re-scans and recovers the missed receipt once.
    const store3 = new SessionStore(root, log);
    await store3.load();
    const read3 = vi.fn((id: string) => store3.readTranscript(id));
    const boot3 = new AnalyticsStore(root, { log });
    await boot3.load(store3.list(), read3, [], { transcriptStamp: (id) => store3.transcriptStamp(id) });
    await boot3.whenBackfilled();
    expect(read3).toHaveBeenCalledTimes(1);
    expect(boot3.summary(0, T0 + 1_000).days.reduce((sum, d) => sum + d.usage.userInputTokens, 0)).toBe(35);

    // Boot 4: unchanged again -> 0 reads, total stays exact.
    const store4 = new SessionStore(root, log);
    await store4.load();
    const read4 = vi.fn((id: string) => store4.readTranscript(id));
    const boot4 = new AnalyticsStore(root, { log });
    await boot4.load(store4.list(), read4, [], { transcriptStamp: (id) => store4.transcriptStamp(id) });
    await boot4.whenBackfilled();
    expect(read4).toHaveBeenCalledTimes(0);
    expect(boot4.summary(0, T0 + 1_000).days.reduce((sum, d) => sum + d.usage.userInputTokens, 0)).toBe(35);
  });

  it('does not commit a scan stamp if the transcript changes while being read', async () => {
    const root = await makeRoot();
    const log = vi.fn();
    const store = new SessionStore(root, log);
    await store.load();
    const meta = makeMeta('s_race');
    await store.upsert(meta);
    await store.appendTranscript(meta.id, makeUserReceipt('u1', meta.id, 10));

    let calls = 0;
    const racingStamp = vi.fn(async () => (calls++ === 0 ? '100:1000:1000' : '150:1001:1001'));
    const boot1 = new AnalyticsStore(root, { log });
    await boot1.load(store.list(), (id) => store.readTranscript(id), [], { transcriptStamp: racingStamp });
    await boot1.whenBackfilled();

    // Because stampBefore !== stampAfter, no stamp was saved; the next boot still scans.
    const read2 = vi.fn((id: string) => store.readTranscript(id));
    const boot2 = new AnalyticsStore(root, { log });
    await boot2.load(store.list(), read2, [], { transcriptStamp: async () => '150:1001:1001' });
    await boot2.whenBackfilled();
    expect(read2).toHaveBeenCalledTimes(1);
  });
});

describe('analytics-migrations startup orchestrators', () => {
  it('repriceClaudeFallbackTranscripts is a no-op when no sessions were repriced', async () => {
    const log = vi.fn();
    const persist = vi.fn(async () => undefined);
    const repriceTurns = vi.fn(async () => 0);
    const rows = await repriceClaudeFallbackTranscripts([], { get: () => undefined, repriceTurns, persist }, [], log);
    expect(rows).toBe(0);
    expect(repriceTurns).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('reconcileForkInheritance settles the sweep only when every transcript is readable', async () => {
    const log = vi.fn();
    const settle = vi.fn(async () => undefined);
    const reconcileForks = vi.fn(() => ({ ids: [], usd: 0 }));
    const meta = makeMeta('s_fork');

    // Unreadable transcript -> sweep stays unsettled so next boot retries.
    await reconcileForkInheritance(
      { reconcileForks, settleForkSweep: settle },
      {
        list: () => [meta],
        readTranscript: async () => {
          throw new Error('ENOENT');
        },
        repriceTurns: async () => 0,
        persist: async () => undefined
      },
      log
    );
    expect(settle).not.toHaveBeenCalled();

    // Readable transcript with no carried rows -> settles cleanly.
    await reconcileForkInheritance(
      { reconcileForks, settleForkSweep: settle },
      {
        list: () => [meta],
        readTranscript: async () => [],
        repriceTurns: async () => 0,
        persist: async () => undefined
      },
      log
    );
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
