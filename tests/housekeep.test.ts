import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { housekeepActivityAt, housekeepIsRecent } from '../src/shared/housekeep';
import { configuredHousekeepReviewer, housekeepEvidence, HousekeepService } from '../src/main/housekeep';
import type { HousekeepWorktree } from '../src/main/housekeep-worktrees';
import { emptyUsage } from '../src/main/models/static-models';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import { deferred } from '../src/main/util/async';

const DAY = 86_400_000;
const NOW = Date.now();
const OLD = NOW - 10 * DAY;
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function meta(id: string, changes: Partial<SessionMeta> = {}): SessionMeta {
  const projectRoot = path.join(os.tmpdir(), 'project');
  return {
    id, title: id, createdAt: OLD, updatedAt: OLD + 20, cwd: projectRoot,
    status: 'idle', config: { projectRoot, permissionMode: 'ask', harness: 'native' },
    harnessRef: {}, usage: emptyUsage(), ...changes
  };
}

function completeTurn(): TranscriptItem[] {
  return [
    { id: 'u', kind: 'user', ts: OLD + 1, text: 'Deliver the report' },
    { id: 'tool', kind: 'tool', ts: OLD + 2, name: 'read', status: 'done', output: 'not sent to the model' },
    { id: 'reply', kind: 'assistant', ts: OLD + 3, text: 'The report was delivered.', thinking: 'also not sent' },
    { id: 'done', kind: 'turn', ts: OLD + 4, status: 'completed' }
  ];
}

async function setup(rows: SessionMeta[], turns: Record<string, TranscriptItem[]> = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-housekeep-'));
  cleanup.push(userData);
  const store = new SessionStore(userData, vi.fn());
  await store.load();
  for (const row of rows) {
    await store.upsert(row);
    await store.rewriteTranscript(row.id, turns[row.id] ?? completeTurn());
  }
  const settings = defaultSettings();
  const log = vi.fn();
  const manager = new SessionManager({
    settings: { get: () => settings } as SessionManagerDeps['settings'],
    store, analytics: {} as SessionManagerDeps['analytics'], runtime: {} as SessionManagerDeps['runtime'],
    getSecret: async () => undefined, log, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn()
  });
  const inspect = vi.fn(async (_: { cwd: string }): Promise<HousekeepWorktree> => ({ kind: 'none' }));
  const remove = vi.fn(async (_tree, before: () => void | Promise<void>) => { await before(); });
  const review = vi.fn(async (_prompt: string): Promise<string | null> => null);
  const reviewer = vi.fn(() => ({ identity: 'explicit-fixture', label: 'fixture/model', complete: review }));
  const external = new Set<string>();
  const owners = new Set<string>();
  const saveInFlight = { value: false };
  const service = new HousekeepService({
    sessions: manager, settings: () => settings, now: () => NOW,
    savingRecentDays: () => saveInFlight.value, trashDirectory: async () => { throw new Error('Fixture cannot trash a real directory.'); },
    hasTerminalOrView: id => external.has(id), runningOwners: async () => owners, inspect, remove, reviewer
  });
  return { service, manager, store, userData, inspect, remove, reviewer, review, external, owners, settings, saveInFlight };
}

describe('Housekeep review and apply', () => {
  it('protects the exact cutoff and uses latest creation, update, input, or view', () => {
    expect(housekeepIsRecent(NOW - 7 * DAY, NOW, 7)).toBe(true);
    expect(housekeepIsRecent(NOW - 7 * DAY - 1, NOW, 7)).toBe(false);
    expect(housekeepIsRecent(NOW, NOW, 0)).toBe(false);
    expect(housekeepIsRecent(NOW + 1, NOW, 0)).toBe(true);
    expect(housekeepActivityAt(meta('s_viewed', { lastUserMessageAt: NOW - 9, lastViewedAt: NOW - 2 }))).toBe(NOW - 2);
  });

  it('does not send excerpts at preview or treat a merged label, unverified answer, live writer or protected session as complete', async () => {
    const { service, review, external, inspect } = await setup([
      meta('s_old'), meta('s_open'), meta('s_recent', { lastViewedAt: NOW - DAY }), meta('s_pinned', { pinned: true }),
      meta('s_merged', { status: 'merged' }), meta('s_queued', { queued: 1 }), meta('s_runtime', { workspaceWriterClaims: ['unknown'] }),
      meta('s_draft'), meta('s_archive', { archived: true }), meta('s_dirty', { worktreeBranch: 'vocscode/dirty', cwd: path.join(os.tmpdir(), 'dirty') })
    ], { s_merged: completeTurn().slice(0, 3) });
    external.add('s_open');
    inspect.mockImplementation(async input => input.cwd.endsWith('dirty') ? { kind: 'blocked', reason: 'Local files.' } : { kind: 'none' });
    const preview = await service.preview(['s_draft']);
    expect(preview.recentDays).toBe(7);
    expect(review).not.toHaveBeenCalled();
    expect(preview.rows.map(row => row.sessionId)).not.toContain('s_archive');
    expect(preview.rows.filter(row => row.verdict === 'review').map(row => row.sessionId)).toEqual(['s_old']);
    expect(preview.rows.find(row => row.sessionId === 's_dirty')?.reason).toBe('Local files.');
    expect(preview.rows.find(row => row.sessionId === 's_merged')?.reason).toContain('no verified completed turn');
  });

  it('uses only bounded conversation evidence, rejects a changed reviewer, and treats model results as recommendations', async () => {
    const { service, reviewer, review, manager } = await setup([meta('s_old'), meta('s_new', { updatedAt: NOW })]);
    const preview = await service.preview([]);
    expect(preview.reviewModel).toBe('fixture/model');
    reviewer.mockReturnValueOnce({ label: 'other/model', identity: 'changed', complete: review });
    await expect(service.assess(preview.id)).rejects.toThrow('utility model changed');
    expect(review).not.toHaveBeenCalled();
    review.mockResolvedValue(JSON.stringify({ reviews: [{ index: 0, verdict: 'complete', reason: 'The requested report was delivered.' }] }));
    const assessed = await service.assess(preview.id);
    expect(review).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ untrustedConversationExcerpts: [{ index: 0, request: 'Deliver the report', response: 'The report was delivered.' }] }));
    expect(assessed.rows.find(row => row.sessionId === 's_old')?.verdict).toBe('complete');
    expect(manager.get('s_old')?.archived).not.toBe(true);
    await expect(service.apply(preview.id, ['s_new'], [])).rejects.toThrow('eligible sessions');
    expect((await service.apply(preview.id, ['s_old'], [])).map(r => r.state)).toEqual(['archived']);
    await expect(service.apply(preview.id, ['s_old'], [])).rejects.toThrow('expired');
  });

  it('keeps uncertain and malformed verdicts out of automatic approval', async () => {
    const { service, review } = await setup([meta('s_old')]);
    const preview = await service.preview([]);
    review.mockResolvedValue(JSON.stringify({ reviews: [{ index: 0, verdict: 'complete', reason: 'Done' }, { index: 0, verdict: 'keep', reason: 'Pending' }] }));
    const assessed = await service.assess(preview.id);
    expect(assessed.rows[0]).toMatchObject({ verdict: 'review', reason: 'No verified model recommendation. Review this session yourself.' });
  });

  it('rechecks the configured age, new drafts, and transcript before applying a stale preview', async () => {
    const { service, manager, settings, store, remove } = await setup([meta('s_age'), meta('s_draft'), meta('s_changed')]);
    const preview = await service.preview([]);
    settings.housekeepRecentDays = 11;
    expect(await service.apply(preview.id, ['s_age'], [])).toEqual([{ sessionId: 's_age', title: 's_age', state: 'skipped', detail: 'Recent transcript activity.' }]);
    settings.housekeepRecentDays = 0;
    const again = await service.preview([]);
    await store.appendTranscript('s_changed', { id: 'last', kind: 'user', ts: NOW, text: 'Actually, finish this too.' });
    const outcomes = await service.apply(again.id, ['s_draft', 's_changed'], ['s_draft']);
    expect(outcomes.map(r => [r.sessionId, r.state]).sort()).toEqual([['s_changed', 'skipped'], ['s_draft', 'skipped']]);
    expect(manager.list().some(r => r.archived)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('uses a one-time age override through preview, assessment and apply without changing the saved window', async () => {
    const { service, store, review, manager, settings } = await setup([
      meta('s_between', { lastViewedAt: NOW - 5 * DAY }), meta('s_between_transcript'),
      meta('s_cutoff', { lastViewedAt: NOW - 3 * DAY })
    ]);
    await store.appendTranscript('s_between_transcript', { kind: 'info', id: 'view', ts: NOW - 4 * DAY, level: 'info', text: 'Checked the report.' });
    const ordinary = await service.preview([]);
    expect(ordinary.rows.every(row => row.verdict === 'protected')).toBe(true);

    const overridden = await service.preview([], 3);
    expect(overridden.recentDays).toBe(3);
    expect(overridden.rows.filter(row => row.verdict === 'review').map(row => row.sessionId).sort()).toEqual(['s_between', 's_between_transcript']);
    expect(overridden.rows.find(row => row.sessionId === 's_cutoff')?.verdict).toBe('protected');
    expect(settings.housekeepRecentDays).toBe(7);

    settings.housekeepRecentDays = 14;
    review.mockResolvedValue(JSON.stringify({ reviews: [{ index: 0, verdict: 'complete', reason: 'Delivered.' }, { index: 1, verdict: 'complete', reason: 'Delivered.' }] }));
    const assessed = await service.assess(overridden.id);
    expect(assessed.rows.filter(row => row.verdict === 'complete')).toHaveLength(2);
    expect(manager.list().some(row => row.archived)).toBe(false);
    await expect(service.apply(overridden.id, ['s_cutoff'], [])).rejects.toThrow('eligible sessions');
    await expect(service.apply(overridden.id, ['s_between_transcript'], [])).resolves.toMatchObject([{ state: 'archived' }]);
    expect(settings.housekeepRecentDays).toBe(14);
    const fresh = await service.preview([]);
    expect(fresh.recentDays).toBe(14);
    expect(fresh.rows.find(row => row.sessionId === 's_between')?.verdict).toBe('protected');
  });

  it('interprets a zero-day override as disabling only age protection', async () => {
    const { service } = await setup([
      meta('s_recent', { updatedAt: NOW }), meta('s_pinned', { pinned: true }), meta('s_future', { updatedAt: NOW + 1 })
    ]);
    const preview = await service.preview([], 0);
    expect(preview.recentDays).toBe(0);
    expect(preview.rows.filter(row => row.verdict === 'review').map(row => row.sessionId)).toEqual(['s_recent']);
  });

  it('disallows a canonical checkout alias added after preview, even through a junction', async () => {
    const { service, store, userData, inspect, manager } = await setup([meta('s_owner')]);
    const owner = manager.get('s_owner')!;
    const root = path.join(userData, 'repo');
    const cwd = path.join(root, 'checkout');
    await fs.mkdir(path.join(cwd, 'nested'), { recursive: true });
    const alias = path.join(userData, 'alias');
    await fs.symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    Object.assign(owner, { cwd, worktreeBranch: 'vocscode/checkout' });
    owner.config.projectRoot = root;
    inspect.mockResolvedValue({ kind: 'clean', root, cwd, branch: owner.worktreeBranch!, head: 'head' });
    const preview = await service.preview([]);
    expect(preview.rows[0].verdict).toBe('review');
    await store.upsert(meta('s_alias', { cwd: path.join(alias, 'nested') }));
    await expect(service.apply(preview.id, ['s_owner'], [])).resolves.toEqual([
      { sessionId: 's_owner', title: 's_owner', state: 'skipped', detail: 'Another session refers to this worktree.' }
    ]);
    const fresh = await service.preview([]);
    expect(fresh.rows.find(row => row.sessionId === owner.id)).toMatchObject({ verdict: 'protected', reason: 'Another session refers to this worktree.' });
    expect(manager.get(owner.id)?.archived).not.toBe(true);
  });

  it('protects recent transcript activity even when the saved metadata lags it, and a pending age change blocks apply', async () => {
    const { service, store, saveInFlight, settings } = await setup([meta('s_old'), meta('s_recent_disk')]);
    await store.appendTranscript('s_recent_disk', { kind: 'info', id: 'resume', ts: NOW - DAY, level: 'info', text: 'Recent activity' });
    const preview = await service.preview([]);
    expect(preview.rows.find(row => row.sessionId === 's_recent_disk')).toMatchObject({ verdict: 'protected', reason: 'Recent transcript activity.' });
    saveInFlight.value = true;
    await expect(service.apply(preview.id, ['s_old'], [])).rejects.toThrow('setting to finish saving');
    settings.housekeepRecentDays = 11;
    saveInFlight.value = false;
    await expect(service.apply(preview.id, ['s_old'], [])).resolves.toMatchObject([{ state: 'skipped' }]);
  });

  it('keeps a damaged transcript or a session with a remaining detached process', async () => {
    const { service, owners, store, manager } = await setup([meta('s_damaged'), meta('s_detached'), meta('s_late_process')]);
    await fs.appendFile(path.join(store.sessionDir('s_damaged'), 'transcript.jsonl'), '{"kind":"user"');
    owners.add('s_detached');
    const preview = await service.preview([]);
    expect(preview.rows.filter(row => row.verdict === 'protected').map(row => row.sessionId).sort()).toEqual(['s_damaged', 's_detached']);
    owners.add('s_late_process');
    await expect(service.apply(preview.id, ['s_late_process'], [])).resolves.toEqual([
      { sessionId: 's_late_process', title: 's_late_process', state: 'skipped', detail: 'A process may still be using this session.' }
    ]);
    expect(manager.get('s_late_process')?.archived).toBeFalsy();
  });

  it('archives a batch with isolated outcomes, preserves transcripts across restart, and recovers from an index write failure', async () => {
    const { service, manager, store, userData } = await setup([meta('s_fails', { updatedAt: OLD + 21 }), meta('s_done')]);
    const preview = await service.preview([]);
    vi.spyOn(store, 'upsert').mockRejectedValueOnce(new Error('disk locked'));
    expect(await service.apply(preview.id, ['s_fails', 's_done'], [])).toEqual([
      { sessionId: 's_fails', title: 's_fails', state: 'skipped', detail: 'The session archive could not be saved.' },
      { sessionId: 's_done', title: 's_done', state: 'archived' }
    ]);
    expect(manager.get('s_fails')?.archived).toBeFalsy();
    const restarted = new SessionStore(userData, vi.fn());
    await restarted.load();
    expect(restarted.get('s_done')?.archived).toBe(true);
    expect(restarted.get('s_fails')?.archived).toBeFalsy();
    expect(await restarted.readTranscript('s_done')).toEqual(completeTurn());
  });

  it('rejects ordinary sends while a housekeep reservation is checking the worktree', async () => {
    const { manager } = await setup([meta('s_idle')]);
    const pending = deferred<boolean>();
    const archive = manager.archiveForHousekeep('s_idle', () => pending.promise);
    await expect(manager.send('s_idle', { text: 'still working' })).rejects.toThrow('being archived');
    pending.resolve(false);
    await archive;
    expect(manager.get('s_idle')?.archived).toBe(true);
  });

  it('never chooses another provider when the utility model is not explicitly set or not usable', () => {
    const settings = defaultSettings();
    settings.providers.push({ id: 'local', kind: 'ollama', name: 'Local', enabled: true, hasApiKey: false, models: [], baseUrl: 'http://127.0.0.1:1234/v1' });
    const deps = { log: vi.fn(), getSecret: vi.fn(async () => undefined) };
    expect(configuredHousekeepReviewer(settings, deps)).toBeNull();
    settings.utilityModel = { provider: 'missing', model: 'fixture' };
    expect(configuredHousekeepReviewer(settings, deps)).toBeNull();
    settings.utilityModel = { provider: 'local', model: 'fixture' };
    expect(configuredHousekeepReviewer(settings, deps)?.label).toBe('local/fixture');
    expect(deps.getSecret).not.toHaveBeenCalled();
  });

  it('rejects a commentary-only or attachment-dependent final answer', () => {
    const items = completeTurn();
    const reply = items[2];
    if (reply.kind !== 'assistant') throw new Error('fixture');
    reply.phase = 'commentary';
    expect(housekeepEvidence(items)).toBe('No final response was recorded for the latest request.');
    const request = items[0];
    if (request.kind !== 'user') throw new Error('fixture');
    request.imagesOmitted = 1;
    expect(housekeepEvidence(items)).toBe('The latest request is missing or needs attachment context.');
  });
});
