/** Mission journal durability/recovery contracts exercised against real files, never a fake store. */
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionStore, type MissionJournalEvent, type MissionTransaction } from '../src/main/mission/store';

interface State {
  schemaVersion: number;
  id: string;
  revision: number;
  lastEventSequence: number;
  title: string;
  tasks: string[];
}

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-'));
  dirs.push(dir);
  return dir;
}

function state(id = 'mission-a'): State {
  return { schemaVersion: 1, id, revision: 0, lastEventSequence: 0, title: 'Build it', tasks: [] };
}

function transaction(expectedRevision = 0, idempotencyKey = `request-${expectedRevision}`): MissionTransaction {
  return { expectedRevision, idempotencyKey, actor: 'user:one', kind: expectedRevision ? 'task.add' : 'mission.create' };
}

function store(dir: string, snapshotEvery = 25): MissionStore<State> {
  return new MissionStore<State>(dir, {
    snapshotEvery,
    validate(value) {
      const record = value as State;
      if (typeof record.title !== 'string' || !Array.isArray(record.tasks) || record.tasks.some((task) => typeof task !== 'string')) throw new Error('Invalid Mission');
    }
  });
}

function file(dir: string, id = 'mission-a', name = 'journal.jsonl'): string {
  return path.join(dir, 'missions', id, name);
}

async function events(dir: string, id = 'mission-a'): Promise<MissionJournalEvent<State>[]> {
  return (await fs.readFile(file(dir, id), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('MissionStore committed state', () => {
  it('journals validated, cloned state and replays after the last atomic snapshot', async () => {
    const dir = await temp();
    const first = store(dir, 2);
    const input = state();
    const created = await first.create(input, transaction());
    expect(created).toEqual({ ...input, revision: 1, lastEventSequence: 1 });
    input.tasks.push('not committed');
    created.tasks.push('not committed either');
    expect(first.get(input.id)?.tasks).toEqual([]);
    await first.transact(input.id, transaction(1), (draft) => { draft.tasks.push('one'); });
    await first.transact(input.id, transaction(2), (draft) => { draft.tasks.push('two'); });
    const snapshot = JSON.parse(await fs.readFile(file(dir, input.id, 'snapshot.json'), 'utf8'));
    expect(snapshot.lastEventSequence).toBe(2);
    expect(snapshot.state.tasks).toEqual(['one']);
    const rows = await events(dir);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(3);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(rows[2]).toMatchObject({ schemaVersion: 1, actor: 'user:one', expectedRevision: 2, currentRevision: 3, kind: 'task.add', idempotencyKey: 'request-2', payload: { tasks: ['one', 'two'] } });
    expect(rows[2].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[2].requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isFinite(Date.parse(rows[2].timestamp))).toBe(true);
    const restarted = store(dir);
    expect(await restarted.load()).toEqual([{ ...state(), revision: 3, lastEventSequence: 3, tasks: ['one', 'two'] }]);
    const listed = restarted.list();
    listed[0].tasks.length = 0;
    const loaded = await restarted.load(input.id);
    loaded!.tasks.length = 0;
    expect(restarted.get(input.id)?.tasks).toEqual(['one', 'two']);
  });

  it('does not expose a draft before journal fsync, or retain a mutator-owned object afterward', async () => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    const entered = deferred();
    const release = deferred();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === file(dir)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { entered.resolve(); await release.promise; await sync(); });
      }
      return handle;
    });
    let retained!: State;
    const pending = first.transact('mission-a', transaction(1), (draft) => { retained = draft; draft.tasks.push('durable'); });
    await entered.promise;
    expect(first.get('mission-a')?.tasks).toEqual([]);
    release.resolve();
    const committed = await pending;
    retained.tasks.push('late mutation');
    committed.tasks.push('response mutation');
    expect(first.get('mission-a')?.tasks).toEqual(['durable']);
    expect((await store(dir).load())[0].tasks).toEqual(['durable']);
  });

  it('serializes concurrent CAS and create calls, while independent Missions keep progressing', async () => {
    const dir = await temp();
    const first = store(dir);
    const creations = await Promise.all(Array.from({ length: 8 }, () => first.create(state(), transaction())));
    expect(creations.every((created) => created.revision === 1)).toBe(true);
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => first.transact('mission-a', transaction(1, `cas-${index}`), (draft) => { draft.tasks.push(String(index)); })));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failures = outcomes.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(11);
    for (const failure of failures) expect(failure.reason).toMatchObject({ code: 'REVISION_CONFLICT', message: '[MISSION_REVISION_CONFLICT] Expected revision 1; current revision is 2', details: { expectedRevision: 1, currentRevision: 2 } });
    expect(await events(dir)).toHaveLength(2);
    await first.create(state('mission-b'), transaction());
    const entered = deferred();
    const release = deferred();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === file(dir)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { entered.resolve(); await release.promise; await sync(); });
      }
      return handle;
    });
    const pending = first.transact('mission-a', transaction(2), (draft) => { draft.tasks.push('after CAS'); });
    await entered.promise;
    try {
      await expect(first.transact('mission-b', transaction(1), (draft) => { draft.tasks.push('independent'); })).resolves.toMatchObject({ revision: 2, tasks: ['independent'] });
      expect(first.get('mission-a')?.revision).toBe(2);
    } finally { release.resolve(); }
    await pending;
    const all = [...await events(dir), ...await events(dir, 'mission-b')];
    expect(new Set(all.map((row) => row.eventId)).size).toBe(5);
  });

  it('deduplicates canonical wire requests across restart without rerunning generated-ID callbacks', async () => {
    const dir = await temp();
    const first = store(dir);
    const createRequest = { ...transaction(), request: { objective: 'Build it' } };
    await first.create(state(), createRequest);
    const request = { ...transaction(1), request: { task: { title: 'first', tags: ['one', 'two'] }, enabled: true } };
    const generated = await first.transact('mission-a', request, (draft) => { draft.tasks.push(`generated-${Date.now()}`); });
    await first.transact('mission-a', transaction(2), (draft) => { draft.tasks.push('later'); });
    const restarted = store(dir);
    await restarted.load();
    const noReplay = vi.fn(() => { throw new Error('must not run a duplicate callback'); });
    const reordered = { ...request, request: { enabled: true, task: { tags: ['one', 'two'], title: 'first' } } };
    await expect(restarted.transact('mission-a', reordered, noReplay)).resolves.toEqual(generated);
    expect(noReplay).not.toHaveBeenCalled();
    await expect(restarted.create({ ...state(), title: 'a new generated value' }, createRequest)).resolves.toMatchObject({ title: 'Build it', revision: 1 });
    for (const conflicting of [
      { ...request, request: { task: { title: 'different' }, enabled: true } },
      { ...request, actor: 'worker:other' },
      { ...request, kind: 'different.operation' },
      { ...request, expectedRevision: 3 },
      { ...request, request: undefined }
    ]) await expect(restarted.transact('mission-a', conflicting, noReplay)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(noReplay).not.toHaveBeenCalled();
    expect(restarted.get('mission-a')?.revision).toBe(3);
    expect(await events(dir)).toHaveLength(3);
  });

  it('uses the original base for payload-only retries and rejects changed payloads', async () => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    const add = (draft: State) => { draft.tasks.push('one'); };
    const original = await first.transact('mission-a', transaction(1), add);
    await first.transact('mission-a', transaction(2), (draft) => { draft.tasks.push('two'); });
    const restarted = store(dir);
    await restarted.load();
    await expect(restarted.transact('mission-a', transaction(1), add)).resolves.toEqual(original);
    await expect(restarted.transact('mission-a', transaction(1), (draft) => { draft.tasks.push('different'); })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(restarted.create({ ...state(), title: 'different' }, transaction())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const replacement = { ...restarted.get('mission-a')!, title: 'replacement' };
    const pending = restarted.transact('mission-a', transaction(3), replacement);
    replacement.tasks.push('changed after submission');
    await expect(pending).resolves.toMatchObject({ title: 'replacement', revision: 4, tasks: ['one', 'two'] });
    expect(await events(dir)).toHaveLength(4);
  });

  it('validates both new state and immutable identity before admission without poisoning later writes', async () => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    await expect(first.transact('mission-a', transaction(1), (draft) => { draft.id = 'mission-b'; })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(first.transact('mission-a', transaction(1), { ...state(), tasks: [42 as unknown as string] })).rejects.toThrow('Invalid Mission');
    await expect(first.transact('mission-a', transaction(1), { ...state(), schemaVersion: 2 })).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
    expect(first.isBlocked('mission-a')).toBe(false);
    expect(await events(dir)).toHaveLength(1);
    await expect(first.transact('mission-a', transaction(1), (draft) => { draft.title = 'valid'; })).resolves.toMatchObject({ revision: 2, title: 'valid' });
    const guard = new MissionStore<State>(await temp(), { validate: () => false });
    await expect(guard.create(state(), transaction())).rejects.toMatchObject({ code: 'INVALID' });
    expect(guard.list()).toEqual([]);
  });
});

function failJournalOnce(dir: string, stage: 'write' | 'partial' | 'sync'): void {
  const open = fs.open.bind(fs);
  let injected = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!injected && String(args[0]) === file(dir)) {
      injected = true;
      if (stage === 'sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected fsync failure'));
      else {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (data) => {
          if (stage === 'partial') await write(String(data).slice(0, Math.floor(String(data).length / 2)), 'utf8');
          throw new Error('injected append failure');
        });
      }
    }
    return handle;
  });
}

describe('MissionStore failed writes and explicit recovery', () => {
  it.each(['write', 'partial'] as const)('blocks after a %s failure, rejects queued admissions and never publishes the failed draft', async (stage) => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    const originalBytes = await fs.readFile(file(dir));
    failJournalOnce(dir, stage);
    const rejectedCallback = vi.fn();
    const outcomes = await Promise.allSettled([
      first.transact('mission-a', transaction(1), (draft) => { draft.tasks.push('must not leak'); }),
      first.transact('mission-a', transaction(1, 'queued'), rejectedCallback)
    ]);
    expect(outcomes.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(rejectedCallback).not.toHaveBeenCalled();
    expect(first.get('mission-a')).toMatchObject({ revision: 1, tasks: [] });
    expect(first.isBlocked('mission-a')).toBe(true);
    await expect(first.transact('mission-a', transaction(1), rejectedCallback)).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(rejectedCallback).not.toHaveBeenCalled();
    await expect(first.load('mission-a')).resolves.toMatchObject({ revision: 1, tasks: [] });
    expect(first.isBlocked('mission-a')).toBe(false);
    expect(await fs.readFile(file(dir))).toEqual(originalBytes);
    if (stage === 'partial') expect(first.issues()).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('incomplete final journal line') })]);
    await first.transact('mission-a', transaction(1), (draft) => { draft.tasks.push('recovered'); });
    expect(await events(dir)).toHaveLength(2);
    expect((await store(dir).load())[0]).toMatchObject({ revision: 2, tasks: ['recovered'] });
  });

  it('reconciles a complete line after fsync failed and idempotently returns it without another append', async () => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    const request = { ...transaction(1), request: { intent: 'dispatch' } };
    failJournalOnce(dir, 'sync');
    await expect(first.transact('mission-a', request, (draft) => { draft.tasks.push('uncertain'); })).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(first.get('mission-a')).toMatchObject({ revision: 1, tasks: [] });
    expect(await events(dir)).toHaveLength(2);
    await expect(first.load('mission-a')).resolves.toMatchObject({ revision: 2, tasks: ['uncertain'] });
    const noReplay = vi.fn(() => { throw new Error('duplicate dispatch'); });
    await expect(first.transact('mission-a', request, noReplay)).resolves.toMatchObject({ revision: 2, tasks: ['uncertain'] });
    expect(noReplay).not.toHaveBeenCalled();
    expect(await events(dir)).toHaveLength(2);
  });

  it('recovers an interrupted initial create without inventing a committed Mission', async () => {
    const dir = await temp();
    const first = store(dir);
    // Preload the absent ID so the injected open is the append, not recovery.
    await first.load('mission-a');
    failJournalOnce(dir, 'partial');
    await expect(first.create(state(), transaction())).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(first.list()).toEqual([]);
    const restarted = store(dir);
    expect(await restarted.load()).toEqual([]);
    expect(await fs.readFile(file(dir), 'utf8')).toBe('');
    await expect(restarted.create(state(), transaction())).resolves.toMatchObject({ revision: 1, lastEventSequence: 1 });
    expect(await events(dir)).toHaveLength(1);
  });

  it('captures wire requests before queued callers can mutate them', async () => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    const wire = { task: 'original' };
    const metadata = { ...transaction(1), request: wire };
    const pending = first.transact('mission-a', metadata, (draft) => { draft.tasks.push('once'); });
    wire.task = 'caller changed it';
    metadata.actor = 'another actor';
    await pending;
    expect((await events(dir))[1]).toMatchObject({ actor: 'user:one', request: { task: 'original' } });
    const restarted = store(dir);
    await restarted.load();
    await expect(restarted.transact('mission-a', { ...transaction(1), request: { task: 'original' } }, () => { throw new Error('duplicate'); })).resolves.toMatchObject({ revision: 2 });
    await expect(restarted.transact('mission-a', metadata, state())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await events(dir)).toHaveLength(2);
  });

  it.each(['rename', 'sync'] as const)('keeps the previous atomic snapshot after %s failure, but recovers the committed event', async (stage) => {
    const dir = await temp();
    const first = store(dir, 1);
    await first.create(state(), transaction());
    const previousSnapshot = await fs.readFile(file(dir, 'mission-a', 'snapshot.json'));
    if (stage === 'rename') vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('injected snapshot failure'), { code: 'EIO' }));
    else {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith('.tmp')) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected snapshot fsync failure'));
        return handle;
      });
    }
    const request = { ...transaction(1), request: { intent: 'integrate' } };
    await expect(first.transact('mission-a', request, (draft) => { draft.tasks.push('journal committed'); })).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(first.get('mission-a')).toMatchObject({ revision: 2, tasks: ['journal committed'] });
    expect(first.isBlocked('mission-a')).toBe(true);
    expect(await fs.readFile(file(dir, 'mission-a', 'snapshot.json'))).toEqual(previousSnapshot);
    expect((await fs.readdir(path.dirname(file(dir)))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await events(dir)).toHaveLength(2);
    vi.restoreAllMocks();
    await first.load('mission-a');
    await expect(first.transact('mission-a', request, () => { throw new Error('must not reintegrate'); })).resolves.toMatchObject({ revision: 2 });
    await first.transact('mission-a', transaction(2), (draft) => { draft.title = 'next'; });
    expect(await events(dir)).toHaveLength(3);
    const snapshot = JSON.parse(await fs.readFile(file(dir, 'mission-a', 'snapshot.json'), 'utf8'));
    expect(snapshot.lastEventSequence).toBe(3);
    expect((await store(dir).load())[0]).toMatchObject({ revision: 3, title: 'next', tasks: ['journal committed'] });
  });
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function checksum(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

async function rewrite(dir: string, change: (rows: MissionJournalEvent<State>[]) => void): Promise<void> {
  const rows = await events(dir);
  change(rows);
  let previous: string | null = null;
  for (const row of rows) {
    row.previousChecksum = previous;
    const { checksum: _checksum, ...body } = row;
    row.checksum = checksum(body);
    previous = row.checksum;
  }
  await fs.writeFile(file(dir), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

describe('MissionStore recovery treats the journal as the source of truth', () => {
  it.each(['directory', 'journal', 'last-event'] as const)('does not forget known commits when a %s disappears during reload', async (removed) => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    await first.transact('mission-a', transaction(1), (draft) => { draft.tasks.push('known committed'); });
    if (removed === 'directory') await fs.rm(path.dirname(file(dir)), { recursive: true });
    else if (removed === 'journal') await fs.unlink(file(dir));
    else await fs.writeFile(file(dir), JSON.stringify((await events(dir))[0]) + '\n');
    await expect(first.load('mission-a')).rejects.toMatchObject({ code: 'CORRUPT' });
    expect(first.isBlocked('mission-a')).toBe(true);
    await expect(first.load('mission-a')).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(first.create(state(), transaction())).rejects.toMatchObject({ code: 'BLOCKED' });
  });

  it('truncates only an incomplete final line, records a warning and resumes with contiguous sequences', async () => {
    const dir = await temp();
    const first = store(dir, 1);
    await first.create(state(), transaction());
    await first.transact('mission-a', transaction(1), (draft) => { draft.title = 'committed'; });
    const flushed = await fs.readFile(file(dir));
    await fs.appendFile(file(dir), '{"schemaVersion":1,"payload":"torn 🐱');
    const restarted = store(dir);
    expect(await restarted.load()).toEqual([{ ...state(), revision: 2, lastEventSequence: 2, title: 'committed' }]);
    expect(restarted.issues()).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('incomplete final journal line') })]);
    expect(await fs.readFile(file(dir))).toEqual(flushed);
    await restarted.transact('mission-a', transaction(2), (draft) => { draft.title = 'after recovery'; });
    expect((await events(dir)).map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  it.each(['malformed', 'checksum', 'sequence', 'revision', 'event-id', 'key', 'mission-id', 'validator', 'future-journal', 'future-state'] as const)('blocks %s corruption only for its Mission and never skips or truncates it', async (damage) => {
    const dir = await temp();
    const first = store(dir, 1);
    await first.create(state(), transaction());
    await first.transact('mission-a', transaction(1), (draft) => { draft.tasks.push('one'); });
    await first.transact('mission-a', transaction(2), (draft) => { draft.tasks.push('two'); });
    await first.create(state('healthy'), transaction());
    if (damage === 'malformed') {
      const rows = (await fs.readFile(file(dir), 'utf8')).split('\n');
      rows[1] = '{broken interior';
      await fs.writeFile(file(dir), rows.join('\n') + 'also an incomplete tail');
    } else if (damage === 'checksum') {
      const rows = await events(dir);
      rows[1].payload.title = 'tampered without a checksum';
      await fs.writeFile(file(dir), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    } else await rewrite(dir, (rows) => {
      if (damage === 'sequence') rows[1].sequence = 3;
      if (damage === 'revision') rows[1].currentRevision = 40;
      if (damage === 'event-id') rows[1].eventId = rows[0].eventId;
      if (damage === 'key') rows[1].idempotencyKey = rows[0].idempotencyKey;
      if (damage === 'mission-id') rows[1].missionId = 'somewhere-else';
      if (damage === 'validator') rows[1].payload.tasks = [false as unknown as string];
      if (damage === 'future-journal') rows[1].schemaVersion = 2;
      if (damage === 'future-state') rows[1].payload.schemaVersion = 2;
    });
    const damaged = await fs.readFile(file(dir));
    const restarted = store(dir);
    expect(await restarted.load()).toEqual([{ ...state('healthy'), revision: 1, lastEventSequence: 1 }]);
    expect(restarted.isBlocked('mission-a')).toBe(true);
    expect(restarted.get('mission-a')).toBeUndefined();
    expect(restarted.issues()).toContainEqual(expect.objectContaining({ missionId: 'mission-a', severity: 'blocked' }));
    await expect(restarted.transact('mission-a', transaction(3), state())).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(await fs.readFile(file(dir))).toEqual(damaged);
    await expect(restarted.transact('healthy', transaction(1), (draft) => { draft.title = 'still available'; })).resolves.toMatchObject({ revision: 2 });
  });

  it.each(['json', 'checksum', 'wrong-cache'] as const)('ignores a %s snapshot cache and rebuilds from the journal', async (damage) => {
    const dir = await temp();
    const first = store(dir, 1);
    await first.create(state(), transaction());
    const snapshotPath = file(dir, 'mission-a', 'snapshot.json');
    if (damage === 'json') await fs.writeFile(snapshotPath, '{broken');
    else {
      const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
      snapshot.state.title = 'not journaled';
      if (damage === 'wrong-cache') {
        const { checksum: _checksum, ...body } = snapshot;
        snapshot.checksum = checksum(body);
      }
      await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
    }
    const restarted = store(dir);
    expect(await restarted.load()).toEqual([{ ...state(), revision: 1, lastEventSequence: 1 }]);
    expect(restarted.issues()).toContainEqual(expect.objectContaining({ severity: 'warning' }));
    expect(restarted.isBlocked('mission-a')).toBe(false);
    await restarted.transact('mission-a', transaction(1), (draft) => { draft.tasks.push('valid'); });
    expect(await events(dir)).toHaveLength(2);
  });

  it.each(['future-snapshot', 'missing-journal', 'truncated-history'] as const)('blocks %s instead of treating a cache as committed history', async (damage) => {
    const dir = await temp();
    const first = store(dir, 1);
    await first.create(state(), transaction());
    await first.transact('mission-a', transaction(1), (draft) => { draft.tasks.push('committed'); });
    if (damage === 'future-snapshot') {
      const target = file(dir, 'mission-a', 'snapshot.json');
      const snapshot = JSON.parse(await fs.readFile(target, 'utf8'));
      snapshot.schemaVersion = 2;
      await fs.writeFile(target, JSON.stringify(snapshot));
    } else if (damage === 'missing-journal') await fs.unlink(file(dir));
    else {
      const rows = await events(dir);
      await fs.writeFile(file(dir), JSON.stringify(rows[0]) + '\n');
    }
    const restarted = store(dir);
    expect(await restarted.load()).toEqual([]);
    expect(restarted.isBlocked('mission-a')).toBe(true);
    await expect(restarted.create(state(), transaction())).rejects.toMatchObject({ code: 'BLOCKED' });
  });
});

async function linkDirectory(target: string, link: string): Promise<void> {
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('MissionStore immutable opaque artifacts and sources', () => {
  it('retains one immutable artifact per exact key across concurrent retries and new store instances', async () => {
    const dir = await temp(), first = store(dir);
    await first.create(state(), transaction());
    const originalJournal = await fs.readFile(file(dir));
    const request = { instruction: 'Use this visual', imageIndex: 0 };
    const refs = await Promise.all(Array.from({ length: 8 }, () => first.retainArtifact('mission-a', 'user-image', 'exact bytes', request)));
    expect(new Set(refs).size).toBe(1);
    const restarted = store(dir); await restarted.load();
    await expect(restarted.retainArtifact('mission-a', 'user-image', Buffer.from('exact bytes'), { imageIndex: 0, instruction: 'Use this visual' })).resolves.toBe(refs[0]);
    expect((await restarted.readArtifact('mission-a', refs[0])).toString()).toBe('exact bytes');
    for (const [bytes, identity] of [['different bytes', request], ['exact bytes', { ...request, instruction: 'Changed request' }]] as const) {
      await expect(restarted.retainArtifact('mission-a', 'user-image', bytes, identity)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    expect(restarted.isBlocked('mission-a')).toBe(false);
    expect(await fs.readdir(file(dir, 'mission-a', 'artifacts'))).toHaveLength(1);
    expect(await fs.readFile(file(dir))).toEqual(originalJournal);
    const other = await restarted.retainArtifact('mission-a', 'another-image', 'exact bytes', request);
    expect(other).not.toBe(refs[0]);
    expect(await fs.readdir(file(dir, 'mission-a', 'artifacts'))).toHaveLength(2);
  });

  it.each(['identity', 'content', 'rename', 'published'] as const)('recovers the same ref after a %s durability failure without rewriting or republishing blobs', async (stage) => {
    const dir = await temp(), first = store(dir);
    await first.create(state(), transaction());
    const before = await fs.readFile(file(dir)), artifacts = file(dir, 'mission-a', 'artifacts');
    const open = fs.open.bind(fs), rename = fs.rename.bind(fs);
    let injected = false, blobCreates = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args), name = path.basename(String(args[0]));
      if (name === 'content' && (Number(args[1]) & constants.O_EXCL)) blobCreates++;
      if (!injected && (stage === 'identity' && name === 'identity.json' || stage === 'content' && name === 'content')) {
        injected = true;
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { await sync(); throw new Error('Injected durable artifact acknowledgment failure'); });
      }
      return handle;
    });
    if (stage === 'rename' || stage === 'published') vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      if (stage === 'published') await rename(...args);
      throw new Error('Injected artifact rename acknowledgment failure');
    });
    await expect(first.retainArtifact('mission-a', 'exact-image', 'durable bytes', { imageIndex: 0 })).rejects.toThrow(/Injected/);
    expect(first.isBlocked('mission-a')).toBe(true);
    const names = await fs.readdir(artifacts); expect(names).toHaveLength(1);
    const retainedDir = path.join(artifacts, names[0]);
    const receipt = JSON.parse(await fs.readFile(path.join(retainedDir, 'identity.json'), 'utf8'));
    const bytesBefore = stage === 'identity' ? undefined : await fs.stat(path.join(retainedDir, 'content'));
    if (stage !== 'published') await expect(first.readArtifact('mission-a', receipt.blobId)).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = store(dir); await restarted.load();
    await expect(restarted.retainArtifact('mission-a', 'exact-image', 'changed bytes', { imageIndex: 0 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await fs.readdir(artifacts)).toEqual(names);
    await expect(restarted.retainArtifact('mission-a', 'exact-image', 'durable bytes', { imageIndex: 0 })).resolves.toBe(receipt.blobId);
    await expect(restarted.retainArtifact('mission-a', 'exact-image', 'durable bytes', { imageIndex: 0 })).resolves.toBe(receipt.blobId);
    const finalNames = await fs.readdir(artifacts); expect(finalNames).toHaveLength(1); expect(finalNames[0]).toMatch(/^retained-/);
    const finalDir = path.join(artifacts, finalNames[0]);
    expect((await fs.readdir(finalDir)).sort()).toEqual(['content', 'identity.json']);
    expect(blobCreates).toBe(1);
    if (bytesBefore) expect(await fs.stat(path.join(finalDir, 'content'))).toMatchObject({ ino: bytesBefore.ino, mtimeMs: bytesBefore.mtimeMs });
    expect((await restarted.readArtifact('mission-a', receipt.blobId)).toString()).toBe('durable bytes');
    expect(await fs.readFile(file(dir))).toEqual(before);
  });

  it.each(['identity.json', 'content'] as const)('never overwrites a partial retained %s on recovery', async (name) => {
    const dir = await temp(), first = store(dir);
    await first.create(state(), transaction());
    const open = fs.open.bind(fs);
    const failure = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])) === name) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (data) => {
          await write(Buffer.from(data as Uint8Array).subarray(0, 3));
          throw new Error('Injected partial artifact write');
        });
      }
      return handle;
    });
    await expect(first.retainArtifact('mission-a', 'partial', 'complete bytes')).rejects.toThrow(/Injected partial/);
    failure.mockRestore();
    const artifacts = file(dir, 'mission-a', 'artifacts'), names = await fs.readdir(artifacts);
    expect(names).toHaveLength(1); expect(names[0]).toMatch(/^\.retaining-/);
    const partial = path.join(artifacts, names[0], name), before = await fs.readFile(partial), stat = await fs.stat(partial);
    const restarted = store(dir); await restarted.load();
    await expect(restarted.retainArtifact('mission-a', 'partial', 'complete bytes')).rejects.toMatchObject({ code: 'CORRUPT' });
    expect(restarted.isBlocked('mission-a')).toBe(true);
    expect(await fs.readdir(artifacts)).toEqual(names); expect(await fs.readFile(partial)).toEqual(before);
    expect(await fs.stat(partial)).toMatchObject({ ino: stat.ino, mtimeMs: stat.mtimeMs });
  });

  it.each(['missing-identity', 'foreign-file', 'changed-content'] as const)('preserves %s in an interrupted retention rather than adopting uncertain bytes', async (damage) => {
    const dir = await temp(), first = store(dir); await first.create(state(), transaction());
    const failure = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Injected publication failure'));
    await expect(first.retainArtifact('mission-a', 'uncertain', 'original bytes')).rejects.toThrow(/Injected/); failure.mockRestore();
    const artifacts = file(dir, 'mission-a', 'artifacts'), names = await fs.readdir(artifacts), staged = path.join(artifacts, names[0]);
    if (damage === 'missing-identity') await fs.unlink(path.join(staged, 'identity.json'));
    else if (damage === 'foreign-file') await fs.writeFile(path.join(staged, 'unknown'), 'uncertain bytes');
    else await fs.writeFile(path.join(staged, 'content'), 'changed bytes');
    const files = (await fs.readdir(staged)).sort(), before = await Promise.all(files.map((name) => fs.readFile(path.join(staged, name))));
    const restarted = store(dir); await restarted.load();
    await expect(restarted.retainArtifact('mission-a', 'uncertain', 'original bytes')).rejects.toMatchObject({ code: 'CORRUPT' });
    expect(await fs.readdir(artifacts)).toEqual(names); expect((await fs.readdir(staged)).sort()).toEqual(files);
    expect(await Promise.all(files.map((name) => fs.readFile(path.join(staged, name))))).toEqual(before);
  });

  it('fails closed on mismatched retained identities, missing blobs and linked leaves without replacing them', async () => {
    const dir = await temp(), first = store(dir);
    await first.create(state(), transaction());
    const ref = await first.retainArtifact('mission-a', 'retained-key', 'exact bytes');
    const artifacts = file(dir, 'mission-a', 'artifacts'), retained = path.join(artifacts, (await fs.readdir(artifacts))[0]);
    const identityFile = path.join(retained, 'identity.json'), original = await fs.readFile(identityFile, 'utf8');
    const { checksum: _checksum, ...receipt } = JSON.parse(original); receipt.idempotencyKey = 'different-key';
    await fs.writeFile(identityFile, JSON.stringify({ ...receipt, checksum: checksum(receipt) }));
    await expect(first.retainArtifact('mission-a', 'retained-key', 'exact bytes')).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(first.readArtifact('mission-a', ref)).rejects.toMatchObject({ code: 'CORRUPT' });
    await fs.writeFile(identityFile, original); await first.load('mission-a');
    const content = path.join(retained, 'content'); await fs.unlink(content);
    await expect(first.retainArtifact('mission-a', 'retained-key', 'exact bytes')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(retained)).toEqual(['identity.json']);
    const outside = path.join(await temp(), 'untouched'); await fs.writeFile(outside, 'outside bytes'); await fs.link(outside, content); await first.load('mission-a');
    await expect(first.retainArtifact('mission-a', 'retained-key', 'exact bytes')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(first.readArtifact('mission-a', ref)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await fs.readFile(outside, 'utf8')).toBe('outside bytes'); expect(await fs.readdir(artifacts)).toHaveLength(1);
  });

  it('copies and bounds keyed artifact input before queued work and scopes opaque refs to their Mission', async () => {
    const dir = await temp(), first = new MissionStore<State>(dir, { validate: () => true, maxBlobBytes: 16 });
    await first.create(state(), transaction()); await first.create(state('other'), transaction());
    const bytes = Buffer.from('immutable'), identity = { name: 'original' };
    const pending = first.retainArtifact('mission-a', '../not-a-path', bytes, identity); bytes.fill(0); identity.name = 'mutated';
    const ref = await pending;
    expect((await first.readArtifact('mission-a', ref)).toString()).toBe('immutable');
    await expect(first.retainArtifact('mission-a', '../not-a-path', 'immutable', { name: 'original' })).resolves.toBe(ref);
    await expect(first.retainArtifact('mission-a', 'too-large', Buffer.alloc(17))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(first.readArtifact('mission-a', ref, 8)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(first.readSource('mission-a', ref)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(first.readArtifact('other', ref)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await first.retainArtifact('other', '../not-a-path', 'immutable', { name: 'original' })).not.toBe(ref);
    expect(first.isBlocked('mission-a')).toBe(false);
  });

  it('stores copied bytes under host IDs, enforces read/write bounds, and survives restart', async () => {
    const dir = await temp();
    const first = new MissionStore<State>(dir, { validate: () => true, maxBlobBytes: 16 });
    await first.create(state(), transaction());
    const input = Buffer.from('candidate');
    const pending = first.writeArtifact('mission-a', input);
    input.fill(0);
    const artifactId = await pending;
    const anotherId = await first.writeArtifact('mission-a', 'candidate');
    expect(artifactId).not.toBe(anotherId);
    const sourceId = await first.writeSource('mission-a', 'source');
    expect(artifactId).not.toContain(path.sep);
    expect((await first.readArtifact('mission-a', artifactId)).toString()).toBe('candidate');
    await expect(first.readArtifact('mission-a', artifactId, 8)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(first.readArtifact('mission-a', artifactId, 17)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(first.writeSource('mission-a', Buffer.alloc(17))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(first.isBlocked('mission-a')).toBe(false);
    await expect(first.readSource('mission-a', artifactId)).rejects.toMatchObject({ code: 'INVALID' });
    await first.create(state('other'), transaction());
    await expect(first.readArtifact('other', artifactId)).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = store(dir);
    await restarted.load();
    expect((await restarted.readSource('mission-a', sourceId)).toString()).toBe('source');
    const response = await restarted.readArtifact('mission-a', artifactId);
    response.fill(0);
    expect((await restarted.readArtifact('mission-a', artifactId)).toString()).toBe('candidate');
    await fs.writeFile(file(dir, 'mission-a', path.join('artifacts', artifactId)), 'tampered!');
    await expect(restarted.readArtifact('mission-a', artifactId)).rejects.toMatchObject({ code: 'CORRUPT' });
  });

  it.each(['../escape', '/absolute', 'C:\\escape', 'x/y', 'x\\y', 'x:stream', '.', '..', 'con', 'nul', 'COM1', 'Mission-A', 'a'.repeat(129)])('rejects unsafe or nonportable ID %s without creating paths', async (id) => {
    const dir = await temp();
    const first = store(dir);
    await expect(first.create(state(id), transaction())).rejects.toMatchObject({ code: 'INVALID' });
    await expect(first.load(id)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(first.readArtifact('mission-a', id)).rejects.toMatchObject({ code: 'INVALID' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it.each(['artifacts', 'source'] as const)('rejects %s directory symlink/junction replacement for reads and writes', async (kind) => {
    const dir = await temp();
    const outside = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    const blobId = kind === 'source' ? await first.writeSource('mission-a', 'bytes') : await first.writeArtifact('mission-a', 'bytes');
    const target = file(dir, 'mission-a', kind);
    await fs.rm(target, { recursive: true });
    await fs.writeFile(path.join(outside, blobId), 'outside');
    await linkDirectory(outside, target);
    const reading = kind === 'source' ? first.readSource('mission-a', blobId) : first.readArtifact('mission-a', blobId);
    await expect(reading).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    const writing = kind === 'source' ? first.writeSource('mission-a', 'escaped') : first.writeArtifact('mission-a', 'escaped');
    await expect(writing).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await fs.readdir(outside)).toEqual([blobId]);
    expect(await fs.readFile(path.join(outside, blobId), 'utf8')).toBe('outside');
    expect(first.isBlocked('mission-a')).toBe(true);
  });

  it('blocks a linked Mission without preventing other Missions from loading, and rejects a linked root', async () => {
    const dir = await temp();
    const outside = await temp();
    const first = store(dir);
    await first.create(state('healthy'), transaction());
    await fs.writeFile(path.join(outside, 'sentinel'), 'untouched');
    await linkDirectory(outside, path.join(dir, 'missions', 'linked'));
    const restarted = store(dir);
    expect((await restarted.load()).map((mission) => mission.id)).toEqual(['healthy']);
    expect(restarted.isBlocked('linked')).toBe(true);
    await expect(restarted.create(state('linked'), transaction())).rejects.toMatchObject({ code: 'BLOCKED' });
    const linkedRoot = await temp();
    await linkDirectory(outside, path.join(linkedRoot, 'missions'));
    await expect(store(linkedRoot).load()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await fs.readdir(outside)).toEqual(['sentinel']);
  });

  it('rejects hardlinked journal and artifact leaves rather than reading or modifying their targets', async () => {
    const dir = await temp();
    const first = store(dir);
    await first.create(state(), transaction());
    const blobId = await first.writeArtifact('mission-a', 'safe');
    const outside = await temp();
    const target = path.join(outside, 'outside-file');
    await fs.writeFile(target, 'outside');
    const blob = file(dir, 'mission-a', path.join('artifacts', blobId));
    await fs.unlink(blob);
    await fs.link(target, blob);
    await expect(first.readArtifact('mission-a', blobId)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await fs.unlink(file(dir));
    await fs.link(target, file(dir));
    await expect(first.transact('mission-a', transaction(1), (draft) => { draft.title = 'unsafe'; })).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(await fs.readFile(target, 'utf8')).toBe('outside');
    expect(first.get('mission-a')?.revision).toBe(1);
  });
});
