/** The analytics snapshot uploaded for the code.vocs.io dashboard: privacy projection, parts, and combining computers. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { buildAnalyticsSnapshot, assembleSnapshot, projectFolderName, redactPaths, SnapshotAssemblyError, type AnalyticsSnapshot, type AnalyticsSnapshotSource, type SnapshotPartRef } from '../src/shared/analytics/snapshot';
import { ANALYTICS_PART_MAX_BYTES, encodeSnapshot, gunzipText, SnapshotPartTooLargeError } from '../src/shared/analytics/snapshot-codec';
import { combineSnapshots, summarizeSnapshot } from '../src/shared/analytics/combine';
import { emptyReliabilityReport, type ReliabilityRow } from '../src/shared/analytics/reliability';
import { emptyCodeOutputReport } from '../src/shared/analytics/code-output';
import { emptyCounters, emptyDimensions, emptySlice } from '../src/shared/usage-rollup';
import type { SessionMeta, TranscriptItem, UsageDay, UsageSessionRecord, UsageTotals } from '../src/shared/types';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
const usage = (p: Partial<UsageTotals>): UsageTotals => ({ ...ZERO, ...p });
const T0 = Date.UTC(2026, 10, 20, 12);
const META = { appVersion: '0.10.1', platform: 'win32' };

function meta(id: string, projectRoot: string, totals: UsageTotals): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    createdAt: T0,
    updatedAt: T0,
    config: { harness: 'claude', permissionMode: 'ask', projectRoot },
    cwd: projectRoot,
    status: 'idle',
    harnessRef: {},
    activeModel: { provider: 'anthropic', model: 'opus' },
    usage: totals
  };
}

function edit(id: string, file: string): Extract<TranscriptItem, { kind: 'tool' }> {
  return { id, kind: 'tool', ts: T0, name: 'Edit', status: 'done', durationMs: 100, changes: [{ path: file, kind: 'update' }] } as Extract<TranscriptItem, { kind: 'tool' }>;
}

describe('the desktop snapshot leaves paths and receipts behind', () => {
  it('uploads folder names, keeps titles, and drops file paths, roots and replay receipts', async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-snapshot-'));
    dirs.push(dir);
    const store = new AnalyticsStore(dir, { log: () => undefined });
    const win = meta('s-win', 'G:\\Work\\funCentral', usage({}));
    const mac = meta('s-mac', '/Users/vocs/code/Vocs-Code/', usage({}));
    await store.load([win, mac]);
    store.recordUsage(win, usage({ inputTokens: 100, outputTokens: 40, costUsd: 1.25, turns: 2 }), T0);
    store.recordUsage(mac, usage({ inputTokens: 50, outputTokens: 10, costUsd: 0.5, turns: 1 }), T0);
    store.recordToolCall('s-win', edit('t1', 'G:\\Work\\funCentral\\src\\private-plan.ts'), T0);

    const snapshot = store.snapshot(META, T0);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('G:\\\\Work');
    expect(json).not.toContain('/Users/vocs');
    expect(json).not.toContain('private-plan');
    expect(json).not.toContain('recordedTools');
    expect(json).not.toContain('recordedUserInputs');
    expect(Object.keys(snapshot)).not.toContain('files');
    expect(Object.keys(snapshot)).not.toContain('recorded');

    expect(snapshot.sessions.map((s) => [s.id, s.title, s.projectRoot]).sort()).toEqual([
      ['s-mac', 'Session s-mac', 'Vocs-Code'],
      ['s-win', 'Session s-win', 'funCentral']
    ]);
    const day = snapshot.days['2026-11-20'];
    expect(Object.keys(day.by!.project).sort()).toEqual(['Vocs-Code', 'funCentral']);
    expect(day.by!.project.funCentral.label).toBe('funCentral');
    expect(day.by!.file).toEqual({});
    expect(Object.keys(snapshot.reports).sort()).toEqual(['0', '30', '7', '90']);

    // The web summary of the snapshot matches the desktop's own, project names aside.
    const desktop = store.summary(0, T0);
    const web = summarizeSnapshot(snapshot, 0, T0);
    expect(web.totals).toEqual(desktop.totals);
    expect(web.toolTotals).toEqual(desktop.toolTotals);
    expect(web.byProject.map((b) => [b.label, b.usage.costUsd])).toEqual(desktop.byProject.map((b) => [projectFolderName(b.label), b.usage.costUsd]));
    expect(web.files).toEqual([]);
  });

  it('cuts paths out of reliability project rows, executables and signatures, and drops example ids', () => {
    const row = (key: string): ReliabilityRow => ({ ...emptyReliabilityReport(T0, 7).overall, key, label: key });
    const reliability = emptyReliabilityReport(T0, 7);
    reliability.byProject = [row('C:\\Users\\vocs\\secret-repo')];
    reliability.byExecutable = [row('C:\\Program Files\\nodejs\\node.exe')];
    reliability.byModel = [row('anthropic/opus')];
    reliability.signatures = [
      { signature: 'shell | command_not_found | /opt/private/bin/tool', category: 'command_not_found', source: 'ambiguous', outcome: 'failure', count: 1, sessions: 1, harnesses: ['claude'], models: ['anthropic/opus'], firstSeen: T0, lastSeen: T0, incidents: 0, recovered: 0, examples: ['exec_1'], confidence: {} }
    ] as typeof reliability.signatures;
    const source: AnalyticsSnapshotSource = { days: {}, sessions: [], tools: {}, modelTools: {}, harnessTools: {}, harnessModelTools: {}, reports: { '7': { reliability, codeOutput: emptyCodeOutputReport(T0, 7) } } };
    const out = buildAnalyticsSnapshot(source, { ...META, generatedAt: T0 }).reports['7'].reliability;
    expect(out.byProject[0].label).toBe('secret-repo');
    expect(out.byExecutable[0].key).toBe('node.exe');
    expect(out.byModel[0].label).toBe('anthropic/opus');
    expect(out.signatures[0].signature).toBe('shell | command_not_found | tool');
    expect(out.signatures[0].examples).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/secret-repo\\|Users|Program Files|\/opt\//);
    // The source report is untouched.
    expect(reliability.signatures[0].examples).toEqual(['exec_1']);
  });

  it('names folders in either separator style', () => {
    expect(projectFolderName('G:\\Vocs-Code\\')).toBe('Vocs-Code');
    expect(projectFolderName('/home/me/app')).toBe('app');
    expect(projectFolderName('plain')).toBe('plain');
    expect(redactPaths('a | b | ./x/y.sh')).toBe('a | b | y.sh');
  });
});

// ---------------------------------------------------------------------------------------------

function day(date: string, project: string, sessionId: string, cost: number, turns = 1): [string, UsageDay] {
  const by = emptyDimensions();
  by.harness.claude = { ...emptySlice('claude'), costUsd: cost, turns, sessions: [sessionId] };
  by.project[project] = { ...emptySlice(project), costUsd: cost, turns, sessions: [sessionId] };
  return [date, { ...emptyCounters(), costUsd: cost, turns, by }];
}

function session(id: string, project: string, cost: number, createdAt = T0): UsageSessionRecord {
  return { id, title: `Title ${id}`, harness: 'claude', provider: 'anthropic', model: 'opus', projectRoot: project, createdAt, updatedAt: createdAt, usage: usage({ costUsd: cost, turns: 1 }), toolCalls: 0 };
}

function snapshotOf(days: [string, UsageDay][], sessions: UsageSessionRecord[], reliabilityRows = 0): AnalyticsSnapshot {
  const reliability = emptyReliabilityReport(T0, 30);
  reliability.overall.counts.executed = reliabilityRows;
  return buildAnalyticsSnapshot(
    { days: Object.fromEntries(days), sessions, tools: { Edit: { calls: 2, errors: 0, declined: 0, durationMs: 10 } }, modelTools: {}, harnessTools: {}, harnessModelTools: {}, reports: { '30': { reliability, codeOutput: emptyCodeOutputReport(T0, 30) } } },
    { ...META, generatedAt: T0 }
  );
}

describe('snapshot parts', () => {
  const snap = snapshotOf([day('2026-10-31', 'A', 's1', 1), day('2026-11-01', 'A', 's1', 2), day('2026-11-02', 'B', 's2', 3)], [session('s1', 'A', 3, Date.UTC(2026, 9, 31)), session('s2', 'B', 3)]);

  it('splits by month, round-trips through gzip, and reassembles the same snapshot', async () => {
    const { manifest, changed } = await encodeSnapshot(snap);
    expect(manifest.parts.map((p) => p.id)).toEqual(['days.2026-10', 'days.2026-11', 'sessions.2026-10', 'sessions.2026-11', 'tools', 'reports']);
    expect(changed.map((p) => p.id)).toEqual(manifest.parts.map((p) => p.id));
    const texts = new Map(await Promise.all(changed.map(async (p) => [p.id, await gunzipText(p.body)] as const)));
    expect(assembleSnapshot(manifest, texts)).toEqual(snap);
  });

  it('re-encodes only the parts whose content changed', async () => {
    const first = await encodeSnapshot(snap);
    const uploaded = new Map<string, SnapshotPartRef>(first.manifest.parts.map((p) => [p.id, p]));
    expect((await encodeSnapshot(snap, uploaded)).changed).toEqual([]);

    const next = structuredClone(snap);
    next.days['2026-11-02'].costUsd = 4;
    const second = await encodeSnapshot(next, uploaded);
    expect(second.changed.map((p) => p.id)).toEqual(['days.2026-11']);
    expect(second.manifest.parts.map((p) => p.id)).toEqual(first.manifest.parts.map((p) => p.id));
  });

  it('refuses a manifest whose part is missing', async () => {
    const { manifest, changed } = await encodeSnapshot(snap);
    const texts = new Map(await Promise.all(changed.slice(1).map(async (p) => [p.id, await gunzipText(p.body)] as const)));
    expect(() => assembleSnapshot(manifest, texts)).toThrow(SnapshotAssemblyError);
  });

  it('fails loudly instead of truncating a part over the relay cap', async () => {
    // Incompressible text, so the gzip output stays over the cap.
    const bytes = new Uint8Array(ANALYTICS_PART_MAX_BYTES * 1.2);
    for (let i = 0; i < bytes.length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536));
    const noise = Buffer.from(bytes).toString('base64');
    const big = snapshotOf([], [{ ...session('s1', 'A', 1), title: noise }]);
    await expect(encodeSnapshot(big)).rejects.toBeInstanceOf(SnapshotPartTooLargeError);
  });
});

describe('combining computers', () => {
  // The PC's session records run ahead of its day buckets; the Mac's day buckets run ahead of its records.
  const pc = snapshotOf([day('2026-11-19', 'funCentral', 's1', 2), day('2026-11-20', 'Vocs-Code', 's2', 1)], [session('s1', 'funCentral', 5), session('s2', 'Vocs-Code', 1)], 10);
  const mac = snapshotOf([day('2026-11-20', 'Vocs-Code', 's1', 4), day('2026-11-21', 'Vocs-Code', 's1', 3)], [session('s1', 'Vocs-Code', 1)], 20);
  const combined = combineSnapshots(
    [
      { hostId: 'pc', name: 'Vocs PC', snapshot: pc },
      { hostId: 'mac', name: 'Vocs Macmini', snapshot: mac }
    ],
    0,
    T0
  );

  it('takes totals per computer, then adds them', () => {
    // PC: max(sessions 6, days 3) = 6. Mac: max(sessions 1, days 7) = 7.
    expect(combined.computers.map((c) => c.summary.totals.costUsd)).toEqual([6, 7]);
    expect(combined.summary.totals.costUsd).toBe(13);
    expect(combined.summary.toolTotals.calls).toBe(combined.computers.reduce((a, c) => a + c.summary.toolTotals.calls, 0));
  });

  it('merges projects by folder name and keeps same-id sessions from different computers apart', () => {
    const vocs = combined.summary.byProject.find((b) => b.key === 'Vocs-Code')!;
    expect(vocs.sessions).toBe(2);
    expect(combined.summary.sessionCount).toBe(3);
    expect(combined.summary.sessions.map((s) => s.id).sort()).toEqual(['mac:s1', 'pc:s1', 'pc:s2']);
    const shared = combined.summary.days.find((d) => d.date === '2026-11-20')!;
    expect(shared.usage.costUsd).toBe(5);
    expect(shared.usage.by!.project['Vocs-Code'].sessions.sort()).toEqual(['mac:s1', 'pc:s2']);
    expect(combined.summary.activeDays).toBe(3);
  });

  it('keeps reliability per computer', () => {
    const at30 = combineSnapshots([{ hostId: 'pc', name: 'Vocs PC', snapshot: pc }, { hostId: 'mac', name: 'Vocs Macmini', snapshot: mac }], 30, T0);
    expect(at30.computers.map((c) => c.summary.reliability.overall.counts.executed)).toEqual([10, 20]);
    expect('reliability' in at30.summary).toBe(false);
  });

  it('summarizes no computers as an empty view', () => {
    const empty = combineSnapshots([], 30, T0);
    expect(empty.summary.totals.costUsd).toBe(0);
    expect(empty.summary.sessionCount).toBe(0);
    expect(empty.computers).toEqual([]);
  });
});
