/**
 * Offline, opt-in (Node 22+ with SQLite/FTS5 and local Git; no application profile):
 *   VOCS_CODE_KNOWLEDGE_BENCH=1 VOCS_CODE_KNOWLEDGE_HISTORY_OUT=/tmp/vocs-history.json npx --no-install vitest run tests/knowledge-benchmark-history.integration.test.ts
 * PowerShell: set $env:VOCS_CODE_KNOWLEDGE_BENCH='1' and $env:VOCS_CODE_KNOWLEDGE_HISTORY_OUT
 * to a fresh report path (e.g. Join-Path $env:TEMP 'vocs-history.json'), then run the same Vitest command.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { gitIdentityFacts } from '../src/main/git';
import { callIntelligenceTool, type GatewaySession } from '../src/main/intelligence/gateway';
import { LOCAL_LEARNING_ORIGIN, MemoryStore } from '../src/main/intelligence/memory-store';
import { PassiveLearning } from '../src/main/intelligence/passive-learning';
import { ProjectRegistry } from '../src/main/intelligence/registry';
import { IntelligenceService, type IntelligenceServiceDeps, type MemoryRecallResult } from '../src/main/intelligence/service';
import { KnowledgeService } from '../src/main/knowledge/service';
import { SearchIndex } from '../src/main/search';
import { SessionStore } from '../src/main/store';
import { resolveIntelligenceSettings } from '../src/shared/intelligence';
import type { AppSettings, SessionMeta, TranscriptItem } from '../src/shared/types';

// Cite a public source snapshot; the benchmark never opens or fetches these links.
const SOURCE_SNAPSHOT = '8358d990faba096e4e02c922792618527307f3ca';
const NOW = Date.parse('2026-01-05T00:00:00Z');
const BACKGROUND_SESSIONS = 48;
const TURNS_PER_BACKGROUND_SESSION = 48;
const BOOT_PAIRS = 8;
const WARMUP_BOOT_PAIRS = 1;
const RECALL_ROUNDS = 12;
const WARMUP_RECALL_ROUNDS = 2;
const LIMIT = 6;
const log = () => undefined;

type Mode = 'local' | 'off';
type Probe = { query: string; phrase: string; answer: string; kind: 'note' | 'history' | 'redundant' | 'foreign' | 'missing'; source?: string };
// Handwritten descriptions of public code, not actual past Vocs Code conversations. Four probes
// stress snippet clipping; controls include a relevant passive note which adds no new answer.
const PROBES: readonly Probe[] = [
  { query: 'coverage restart', phrase: 'persisted size and modification time', answer: 'Compare the file against its persisted size and modification time.', kind: 'note', source: 'src/main/search.ts' },
  { query: 'takeaway excerpt', phrase: 'skip fenced code blocks', answer: 'The prose filter must skip fenced code blocks.', kind: 'note', source: 'src/main/intelligence/passive-learning.ts' },
  { query: 'registered worktree', phrase: 'common Git directory', answer: 'The verified workspace can share identity via its common Git directory.', kind: 'note', source: 'src/main/git.ts' },
  { query: 'scope predicate', phrase: 'session allowlist is applied in SQL', answer: 'The session allowlist is applied in SQL before returning rows.', kind: 'note', source: 'src/main/search.ts' },
  { query: 'append queue', phrase: 'last write wins per item id', answer: 'The last write wins per item id.', kind: 'history', source: 'src/main/search.ts' },
  { query: 'rewrite invalidation', phrase: 'discard the stored stamp', answer: 'Explicit rewrites discard the stored stamp.', kind: 'history', source: 'src/main/search.ts' },
  { query: 'reflection privacy', phrase: 'never copy tool output', answer: 'The local notes never copy tool output.', kind: 'redundant', source: 'src/main/intelligence/passive-learning.ts' },
  { query: 'archipelago marzipan', phrase: 'copper lantern protocol', answer: 'The synthetic outcome was the copper lantern protocol.', kind: 'foreign' },
  { query: 'xylophone zeppelin', phrase: 'silver compass protocol', answer: '', kind: 'missing' }
];

const probeId = (i: number) => `probe-${i}`;
const targetNote = (p: Probe) => p.kind === 'note' || p.kind === 'redundant';
const observedBackfill = (index: SearchIndex) => vi.spyOn(index as unknown as { backfill(): Promise<void> }, 'backfill');
const elapsed = (start: number) => performance.now() - start;

function distribution(samples: number[]) {
  expect(samples.length).toBeGreaterThan(0);
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: samples.length, p50: sorted[Math.ceil(samples.length * 0.5) - 1], p95: sorted[Math.ceil(samples.length * 0.95) - 1] };
}

function meta(id: string, projectRoot: string): SessionMeta {
  return {
    id, title: `Synthetic Vocs Code session ${id}`, createdAt: NOW, updatedAt: NOW,
    config: { harness: 'native', permissionMode: 'ask', projectRoot }, cwd: projectRoot,
    status: 'idle', harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  };
}

async function seed(store: SessionStore, projectRoot: string, foreignRoot: string) {
  const themes = ['renderer overlay focus', 'terminal scrollback', 'model catalog retries', 'release notes rendering'];
  for (let s = 0; s < BACKGROUND_SESSIONS; s++) {
    const id = `background-${s}`;
    const items: TranscriptItem[] = [];
    for (let t = 0; t < TURNS_PER_BACKGROUND_SESSION; t++) {
      const ts = NOW + (s * TURNS_PER_BACKGROUND_SESSION + t) * 10;
      const theme = themes[(s + t) % themes.length];
      items.push(
        { id: `user-${t}`, kind: 'user', ts, text: `Review ${theme} for fixture ${s} iteration ${t}. Compare the expected UI state against the synthetic replay.` },
        { id: `tool-${t}`, kind: 'tool', ts: ts + 1, name: 'Read', status: 'done', summary: `Inspect ${theme}`, output: `Fixture ${s} iteration ${t}: no external calls. ${'Synthetic state replay returned a stable view. '.repeat(6)}` },
        { id: `answer-${t}`, kind: 'assistant', ts: ts + 2, text: `The replay of ${theme} reproduced the expected sequence. The local fixture validated the transition without starting a connected harness. Next, review the same UI state after a refresh.` },
        { id: `turn-${t}`, kind: 'turn', ts: ts + 3, status: 'completed' }
      );
    }
    await store.importSession(meta(id, projectRoot), items, 'Synthetic fixture.');
  }
  for (const [i, probe] of PROBES.entries()) {
    if (probe.kind === 'missing') continue;
    const id = probeId(i);
    const ts = NOW + 100_000 + i * 10;
    // Keep the answer in the same short prose line, but beyond the 18-word FTS excerpt window.
    const leadIn = probe.kind === 'note' ? 'In the offline walkthrough the routine used the same inputs on two successive runs, comparing what changed with the expected local behavior. ' : '';
    const text = `${probe.kind === 'history' ? '' : 'Lesson: '}${probe.query}: ${leadIn}${probe.answer}`;
    await store.upsert(meta(id, probe.kind === 'foreign' ? foreignRoot : projectRoot));
    // Observe actual committed user, assistant and turn upserts; imports are not passive capture.
    await store.appendTranscript(id, { id: 'user', kind: 'user', ts, text: 'Please summarize the key implementation detail from this offline walkthrough.', userInput: { sessionId: id, id: 'input', ts, tokens: 12 } });
    await store.appendTranscript(id, { id: 'answer', kind: 'assistant', ts: ts + 1, text });
    await store.appendTranscript(id, { id: 'turn', kind: 'turn', ts: ts + 2, status: 'completed' });
  }
}

async function boot(dir: string, sessions: number) {
  const store = new SessionStore(dir, log);
  const index = new SearchIndex(dir, { store, log });
  // Observe the real nonblocking production task, rather than polling for a single search hit or
  // folding close()/checkpoint time into the measurement. See tests/search.test.ts.
  const task = observedBackfill(index);
  const reads = vi.spyOn(store, 'readTranscript');
  try {
    const start = performance.now();
    const loaded = await store.load();
    const opened = performance.now();
    await index.init();
    const returned = performance.now();
    await task.mock.results[0]?.value;
    const ready = performance.now();
    expect(index.available, 'SearchIndex must open a real SQLite/FTS5 database').toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
    expect(loaded).toHaveLength(sessions);
    const metrics = { storeLoadMs: opened - start, indexInitMs: returned - opened, indexBackfillWaitMs: ready - returned, storeToIndexReadyMs: ready - start, transcriptReads: reads.mock.calls.length };
    // Validate actual indexed rows, before and after reuse (including the real but foreign hit).
    const sessionIds = loaded.map((s) => s.id);
    if (metrics.transcriptReads) expect(reads.mock.calls.map(([id]) => id).sort()).toEqual([...sessionIds].sort());
    for (const [i, probe] of PROBES.entries()) {
      const hits = index.recall({ q: probe.query, sessionIds, strict: true });
      expect(hits).toMatchObject({ available: true, partial: false });
      expect(hits.results.map((hit) => hit.sessionId)).toEqual(probe.kind === 'missing' ? [] : [probeId(i)]);
    }
    return metrics;
  } finally {
    index.close();
  }
}

type BootSample = Awaited<ReturnType<typeof boot>>;

function bootSummary(samples: BootSample[]) {
  const field = (key: keyof BootSample) => samples.map((sample) => sample[key]);
  return {
    samples: samples.length,
    storeLoadMs: distribution(field('storeLoadMs')),
    indexInitMs: distribution(field('indexInitMs')),
    indexBackfillWaitMs: distribution(field('indexBackfillWaitMs')),
    storeToIndexReadyMs: distribution(field('storeToIndexReadyMs')),
    transcriptReads: { total: field('transcriptReads').reduce((a, b) => a + b, 0), ...distribution(field('transcriptReads')) }
  };
}

async function measureBoots(coldDir: string, warmDir: string, sessions: number) {
  // Prime the warm arm once, on its own unchanged profile. The cold arm's disposable DB starts
  // absent each time. Cold means no derived index, not cold process or purged OS page cache.
  expect((await boot(warmDir, sessions)).transcriptReads).toBe(sessions);
  const cold: BootSample[] = [];
  const warm: BootSample[] = [];
  for (let pair = -WARMUP_BOOT_PAIRS; pair < BOOT_PAIRS; pair++) {
    for (const arm of pair % 2 === 0 ? ['cold', 'warm'] as const : ['warm', 'cold'] as const) {
      if (arm === 'cold') {
        for (const suffix of ['', '-wal', '-shm']) await fs.rm(path.join(coldDir, `search.db${suffix}`), { force: true });
      }
      const sample = await boot(arm === 'cold' ? coldDir : warmDir, sessions);
      expect(sample.transcriptReads).toBe(arm === 'cold' ? sessions : 0);
      if (pair >= 0) (arm === 'cold' ? cold : warm).push(sample);
    }
  }
  return { cold: bootSummary(cold), unchangedWarm: bootSummary(warm) };
}

type ReturnedRecall = Pick<MemoryRecallResult, 'history' | 'note'> & {
  count: number;
  records: Array<Pick<MemoryRecallResult['records'][number], 'kind' | 'type' | 'scope' | 'state' | 'text' | 'servable' | 'sources' | 'verification'> & { historical: boolean }>;
};
const unmark = (s: string) => s.replace(/[\u0001\u0002]/g, '');

type RecallSample = { ms: number; bytes: number; records: number; history: number; historyLookups: number; transcriptReads: number; recordHit: boolean; historyHit: boolean; probe: Probe };
type RecallHistory = NonNullable<IntelligenceServiceDeps['history']>;

async function measureRecall(
  intelligence: IntelligenceService, knowledge: KnowledgeService, session: GatewaySession, setMode: (mode: Mode) => void,
  history: ReturnType<typeof vi.fn<RecallHistory>>, reads: () => number
) {
  const samples: Record<Mode, RecallSample[]> = { local: [], off: [] };
  for (let round = -WARMUP_RECALL_ROUNDS; round < RECALL_ROUNDS; round++) {
    for (let offset = 0; offset < PROBES.length; offset++) {
      const i = (offset + round + PROBES.length) % PROBES.length;
      const probe = PROBES[i];
      let pairedHistory: ReturnedRecall['history'] | undefined;
      // Rotate the queries and counterbalance which mode goes first for each individual probe.
      for (const mode of (i + round) % 2 === 0 ? ['local', 'off'] as const : ['off', 'local'] as const) {
        setMode(mode);
        const previousLookups = history.mock.calls.length;
        const previousReads = reads();
        const start = performance.now();
        const response = await callIntelligenceTool({ intelligence, knowledge }, session, 'memory_recall', { query: probe.query, limit: LIMIT, include_unverified: true });
        const ms = elapsed(start);
        const historyLookups = history.mock.calls.length - previousLookups;
        const transcriptReads = reads() - previousReads;
        expect(historyLookups).toBe(1);
        expect(transcriptReads).toBe(0);
        // memory_recall does not serialize the index availability flag.
        expect(history.mock.results[previousLookups]?.value).toMatchObject({ available: true, partial: false });
        expect(response.isError).not.toBe(true);
        expect(response.content).toHaveLength(1);
        const { text } = response.content[0];
        const payload = JSON.parse(text) as ReturnedRecall;
        const inScope = targetNote(probe) || probe.kind === 'history';
        expect(payload.history.map((hit) => [hit.sessionId, hit.kind])).toEqual(inScope ? [[probeId(i), 'assistant']] : []);
        if (pairedHistory) expect(payload.history).toEqual(pairedHistory);
        pairedHistory = payload.history;
        expect(payload.count).toBe(payload.records.length);
        const shouldRecallNote = mode === 'local' && targetNote(probe);
        expect(payload.records).toHaveLength(shouldRecallNote ? 1 : 0);
        if (shouldRecallNote) {
          expect(payload.records[0]).toMatchObject({ type: 'episodic', scope: 'project', kind: 'lesson', state: 'candidate', servable: false, historical: true, sources: [{ type: 'transcript', ref: `${probeId(i)}#answer` }] });
          expect(payload.records[0].verification).toBeUndefined();
        }
        const recordText = payload.records.map((record) => record.text);
        const historyText = payload.history.map((hit) => unmark(hit.snippet));
        const recordHit = recordText.some((s) => s.includes(probe.phrase));
        const historyHit = historyText.some((s) => s.includes(probe.phrase));
        expect(recordHit).toBe(shouldRecallNote);
        expect(historyHit).toBe(probe.kind === 'history' || probe.kind === 'redundant');
        for (const other of PROBES) {
          if (other !== probe) expect([...recordText, ...historyText].some((s) => s.includes(other.phrase))).toBe(false);
        }
        if (round >= 0) samples[mode].push({ ms, bytes: Buffer.byteLength(text, 'utf8'), records: payload.count, history: payload.history.length, historyLookups, transcriptReads, recordHit, historyHit, probe });
      }
    }
  }
  const summary = (arm: RecallSample[]) => {
    const hits = arm.filter((s) => s.recordHit || s.historyHit);
    const byKind = (kind: Probe['kind']) => ({ requests: arm.filter((s) => s.probe.kind === kind).length, hits: hits.filter((s) => s.probe.kind === kind).length });
    const total = (key: 'bytes' | 'records' | 'history' | 'historyLookups' | 'transcriptReads') => arm.reduce((sum, s) => sum + s[key], 0);
    return {
      requests: arm.length,
      latencyMs: distribution(arm.map((s) => s.ms)),
      returnedContextUtf8Bytes: { total: total('bytes'), ...distribution(arm.map((s) => s.bytes)) },
      returnedRecords: total('records'),
      returnedHistorySnippets: total('history'),
      historyLookups: total('historyLookups'),
      transcriptReads: total('transcriptReads'),
      distinctProbesWithKnownAnswer: new Set(hits.map((s) => s.probe)).size,
      knownAnswerHits: hits.length,
      knownAnswerInRecords: arm.filter((s) => s.recordHit).length,
      knownAnswerInHistory: arm.filter((s) => s.historyHit).length,
      byProbeKind: { note: byKind('note'), history: byKind('history'), redundant: byKind('redundant'), foreign: byKind('foreign'), missing: byKind('missing') }
    };
  };
  return { local: summary(samples.local), off: summary(samples.off) };
}

it.skipIf(process.env.VOCS_CODE_KNOWLEDGE_BENCH !== '1')('benchmarks production history boot and passive recall offline', async () => {
  const report = process.env.VOCS_CODE_KNOWLEDGE_HISTORY_OUT;
  if (!report?.trim()) throw new Error('Set VOCS_CODE_KNOWLEDGE_HISTORY_OUT to a fresh report path when enabling the benchmark.');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-knowledge-history-'));
  try {
    const root = await fs.realpath(temp);
    const projectRoot = path.join(root, 'workspace');
    const foreignRoot = path.join(root, 'foreign-workspace');
    // Isolate both fixture creation and production Git identity discovery from ambient repo/config
    // overrides. Disposable Git identity only: no checkout, remote, commits, hooks or source scans.
    for (const key of Object.keys(process.env)) if (/^GIT_/i.test(key)) vi.stubEnv(key, undefined);
    const emptyGitConfig = path.join(root, 'gitconfig');
    await fs.writeFile(emptyGitConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyGitConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    for (const cwd of [projectRoot, foreignRoot]) {
      await fs.mkdir(cwd);
      execFileSync('git', ['init', '--quiet', '--template='], { cwd });
    }
    const warmDir = path.join(root, 'warm');
    const coldDir = path.join(root, 'cold');
    const data = path.join(warmDir, 'intelligence');
    await fs.mkdir(data, { recursive: true });
    await fs.mkdir(coldDir);
    const store = new SessionStore(warmDir, log);
    const index = new SearchIndex(warmDir, { store, log });
    const memory = new MemoryStore(data, { log, now: () => NOW });
    const config = resolveIntelligenceSettings({ reflection: 'local' });
    config.graphify.enabled = false;
    const settings = () => ({ intelligence: config, knowledge: { prime: false, autoDistill: false } }) as AppSettings;
    const complete = vi.fn(async () => { throw new Error('Unexpected model call in offline benchmark'); });
    const completer = { complete, label: () => 'offline/no-model' };
    const knowledge = new KnowledgeService({ log, settings, synth: { completer } });
    const registry = new ProjectRegistry(data, { log, facts: gitIdentityFacts, now: () => NOW });
    const reads = vi.spyOn(store, 'readTranscript');
    const history = vi.fn<RecallHistory>((query, sessionIds, limit, opts) => index.recall({ q: query, sessionIds, limit, strict: opts?.strict }));
    const intelligence = new IntelligenceService({
      log, settings, registry, memory, knowledge, completer, history, now: () => NOW,
      sessions: () => store.list().map((s) => ({ id: s.id, title: s.title, projectRoot: s.config.projectRoot, archived: s.archived }))
    });
    const failed = vi.fn();
    const passive = new PassiveLearning({
      enabled: () => memory.available && config.reflection === 'local', session: (id) => store.get(id), failed,
      capture: async (ctx, observation, current) => { await intelligence.captureLocalTurn(ctx, observation, current); }
    });
    store.hooks = { prepareAppend: (id, item) => passive.prepare(id, item) };
    try {
      memory.init();
      expect(memory.available, `MemoryStore SQLite unavailable: ${memory.reason}`).toBe(true);
      const session: GatewaySession = { sessionId: 'background-0', projectRoot, cwd: projectRoot, actions: ['read'] };
      const project = await intelligence.project(session);
      expect((await intelligence.project({ projectRoot: foreignRoot })).id).not.toBe(project.id);
      await seed(store, projectRoot, foreignRoot);
      await passive.close();
      expect(failed).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      const ledgers = PROBES.map((_probe, i) => memory.forSession(probeId(i)));
      for (const [i, records] of ledgers.entries()) {
        const probe = PROBES[i];
        expect(records).toHaveLength(targetNote(probe) || probe.kind === 'foreign' ? 1 : 0);
        for (const record of records) expect(record).toMatchObject({ origin: LOCAL_LEARNING_ORIGIN, state: 'candidate', text: expect.stringContaining(probe.phrase) });
      }
      const sessions = store.list().length;
      expect(sessions).toBe(BACKGROUND_SESSIONS + PROBES.filter((p) => p.kind !== 'missing').length);
      const transcriptItems = BACKGROUND_SESSIONS * TURNS_PER_BACKGROUND_SESSION * 4 + (sessions - BACKGROUND_SESSIONS) * 3;
      const transcriptBytes = (await Promise.all(store.list().map(async (s) => (await fs.stat(path.join(store.sessionDir(s.id), 'transcript.jsonl'))).size))).reduce((sum, size) => sum + size, 0);
      await Promise.all(['sessions.json', 'sessions'].map((file) => fs.cp(path.join(warmDir, file), path.join(coldDir, file), { recursive: true })));
      const startup = await measureBoots(coldDir, warmDir, sessions);

      // Both arms query the same already-indexed history and same persisted notes. Only Local may
      // surface them. This deliberately measures retrieval policy, not the cost of note generation.
      const task = observedBackfill(index);
      await store.load();
      await index.init();
      expect(index.available).toBe(true);
      expect(task).toHaveBeenCalledTimes(1);
      await task.mock.results[0].value;
      const recall = await measureRecall(intelligence, knowledge, session, (mode) => { config.reflection = mode; }, history, () => reads.mock.calls.length);
      expect(reads).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();

      const results = {
        schemaVersion: 1,
        workload: {
          source: 'Handwritten public VocsCode-themed transcripts; disposable empty Git workspaces for identity, not a VocsCode checkout or repository scan.',
          publicSourceReferences: [...new Set(PROBES.flatMap((p) => p.source ? [`https://github.com/vocsong/VocsCode/blob/${SOURCE_SNAPSHOT}/${p.source}`] : []))],
          limits: 'Purpose-built lexical probes include snippet clipping, history-sufficient, redundant-note, wrong-project and absent controls. Repeats measure latency, not independent accuracy trials. Boot is transcript-index readiness, not full app startup or a cold OS cache. Recall is memory_recall dispatch and serialized text only (UTF-8 bytes, not tokens); no alternate queries, MCP/HTTP, Electron or model inference. Local/Off toggles retrieval over identical persisted data, not capture cost.',
          percentileMethod: 'nearest rank',
          backgroundSessions: BACKGROUND_SESSIONS, turnsPerBackgroundSession: TURNS_PER_BACKGROUND_SESSION,
          sessions, transcriptItems, transcriptBytes, uniqueProbes: PROBES.length,
          eligibleTargetNotes: PROBES.filter(targetNote).length, persistedNotes: ledgers.flat().length,
          bootPairs: BOOT_PAIRS, warmupBootPairs: WARMUP_BOOT_PAIRS,
          recallRounds: RECALL_ROUNDS, warmupRecallRounds: WARMUP_RECALL_ROUNDS, recallLimit: LIMIT
        },
        startup,
        recall: { ...recall, transcriptReads: reads.mock.calls.length, modelCalls: complete.mock.calls.length }
      };
      // Never silently overwrite something at the caller's output path; emit aggregates only.
      await fs.writeFile(report, `${JSON.stringify(results, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } finally {
      try {
        await passive.close();
      } finally {
        try {
          index.close();
        } finally {
          memory.close();
        }
      }
    }
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});
