/** Real journal persistence: usage observations are not a generic stale-CAS escape hatch. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionStore, type MissionTransaction } from '../src/main/mission/store';
import { assertMissionRecord } from '../src/main/mission/state';
import { assertMissionUsageObservation } from '../src/main/mission/budget';
import type { MissionRecord } from '../src/shared/mission';
import { missionFixture } from './support/mission-fixture';

let root: string;
const options = { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation, snapshotEvery: 1 };
const metadata = (idempotencyKey: string): MissionTransaction => ({ idempotencyKey, expectedRevision: 1, actor: 'host', kind: 'budget-usage', observation: true, request: { tokens: 100, costUsd: 1 } });
function usage(record: MissionRecord) { record.operations[0].payload.budgetUsage = { tokens: 100, costUsd: 1 }; }
async function seed(store: MissionStore<MissionRecord>) {
  return store.create(missionFixture({ operations: [{ id: 'dispatch', idempotencyKey: 'dispatch', kind: 'dispatch', actor: 'host', expectedRevision: 1, state: 'in_flight', payload: { sessionId: 'lead', dispatchStartedAt: 1 } }] }), { idempotencyKey: 'create', expectedRevision: 0, actor: 'host', kind: 'create' });
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-budget-journal-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('Non-material Mission usage journal', () => {
  it('recovers an observation after snapshot failure, deduplicates its lost reply, and retains normal control CAS', async () => {
    const store = new MissionStore<MissionRecord>(root, options); await seed(store);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('snapshot.json')) throw new Error('injected snapshot failure');
      return rename(from, to);
    });
    const request = metadata('usage');
    await expect(store.transact('mission', request, usage)).rejects.toThrow();
    expect(store.isBlocked('mission')).toBe(true);
    expect(store.get('mission')).toMatchObject({ revision: 1, lastEventSequence: 2 });
    vi.restoreAllMocks();
    const recovered = new MissionStore<MissionRecord>(root, options); await recovered.load('mission');
    const duplicate = vi.fn(() => { throw new Error('A committed observation must not be applied twice'); });
    const receipt = await recovered.transact('mission', request, duplicate);
    expect(duplicate).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ revision: 1, lastEventSequence: 2 });
    expect(receipt.operations[0].payload.budgetUsage).toEqual({ tokens: 100, costUsd: 1 });
    await recovered.transact('mission', { expectedRevision: 1, idempotencyKey: 'control', actor: 'host', kind: 'title' }, (record) => { record.title = 'Genuine changed state'; });
    expect(recovered.get('mission')).toMatchObject({ revision: 2, lastEventSequence: 3 });
    await expect(recovered.transact('mission', { ...metadata('stale'), observation: undefined }, usage)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(recovered.transact('mission', { ...request, observation: undefined }, usage)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await fs.readFile(path.join(root, 'missions', 'mission', 'journal.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it.each(['actor', 'plan', 'permission', 'operation', 'decrease', 'remove', 'extra-counter'] as const)('rejects %s changes disguised as usage without appending any event', async (mutation) => {
    const store = new MissionStore<MissionRecord>(root, options); await seed(store);
    await store.transact('mission', metadata('initial-usage'), usage);
    const request = metadata('invalid-usage');
    if (mutation === 'actor') request.actor = 'lead';
    await expect(store.transact('mission', request, (record) => {
      if (mutation === 'plan') record.plan.scope = 'Unapproved scope';
      if (mutation === 'permission') record.requestedPermissionMode = 'full-auto';
      if (mutation === 'operation') record.operations[0].state = 'succeeded';
      if (mutation === 'decrease') record.operations[0].payload.budgetUsage = { tokens: 99, costUsd: 1 };
      if (mutation === 'remove') delete record.operations[0].payload.budgetUsage;
      if (mutation === 'extra-counter') record.operations[0].payload.budgetUsage = { tokens: 100, costUsd: 1, approve: true };
    })).rejects.toThrow();
    expect(store.get('mission')).toMatchObject({ revision: 1, lastEventSequence: 2, requestedPermissionMode: 'auto' });
    expect((await fs.readFile(path.join(root, 'missions', 'mission', 'journal.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('requires the non-material validator for admission and revalidates even checksummed snapshots on replay', async () => {
    const unsupported = new MissionStore<MissionRecord>(root, { validate: assertMissionRecord }); await seed(unsupported);
    await expect(unsupported.transact('mission', metadata('unsupported'), usage)).rejects.toThrow(/explicit non-material/);
    // Simulate an older faulty writer: a valid checksum is not proof of observational semantics.
    const faulty = new MissionStore<MissionRecord>(root, { ...options, validateObservation: () => true }); await faulty.load('mission');
    await faulty.transact('mission', metadata('forged-observation'), (record) => { usage(record); record.plan.scope = 'Not just telemetry'; });
    const strict = new MissionStore<MissionRecord>(root, options);
    await expect(strict.load('mission')).rejects.toThrow(/coordination or authority/);
    expect(strict.isBlocked('mission')).toBe(true);
  });
});
