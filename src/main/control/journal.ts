import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ControlError, controlGrantInputSchema, controlIdSchema, type ControlGrant, type ControlOperation, type ControlProject } from '../../shared/control';
import { writeJson } from '../util/fs';

const projectSchema = z.strictObject({ id: controlIdSchema, root: z.string(), canonicalRoot: z.string(), name: z.string(), identity: z.string() });
const grantSchema = controlGrantInputSchema.extend({ id: z.string().uuid(), revokedAt: z.number().optional() });
const operationSchema = z.strictObject({
  id: z.string().uuid(), controllerId: z.string().uuid(), accountId: controlGrantInputSchema.shape.accountId,
  instanceId: z.string().uuid(), projectId: controlIdSchema, sessionId: controlIdSchema.optional(),
  method: z.enum(['sessions.create', 'sessions.send']), admissionWindowId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(200), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['accepted', 'dispatched', 'succeeded', 'failed', 'interrupted', 'unknown']),
  inputId: z.string().optional(), runtimeId: z.string().optional(), turnId: z.string().optional(), outputIds: z.array(z.string()).optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
const stateSchema = z.strictObject({
  version: z.literal(1), instanceId: z.string().uuid(), logId: z.string().uuid(), enabled: z.boolean(),
  projects: z.array(projectSchema).max(1000), grants: z.array(grantSchema).max(256),
  windows: z.array(z.strictObject({ id: z.string().uuid(), controllerId: z.string().uuid(), accountId: controlGrantInputSchema.shape.accountId, expiresAt: z.number() })).max(1024),
  operations: z.array(operationSchema).max(5000),
  events: z.array(z.strictObject({ id: z.string().uuid(), operationId: z.string().uuid(), state: operationSchema.shape.state, at: z.number(), epoch: z.string().uuid() })).max(10000),
});
export interface ControlJournalState {
  version: 1;
  instanceId: string;
  logId: string;
  enabled: boolean;
  projects: Array<ControlProject & { identity: string }>;
  grants: ControlGrant[];
  windows: Array<{ id: string; controllerId: string; accountId: string; expiresAt: number }>;
  operations: ControlOperation[];
  events: Array<{ id: string; operationId: string; state: ControlOperation['state']; at: number; epoch: string }>;
}
const terminal = new Set<ControlOperation['state']>(['succeeded', 'failed', 'interrupted', 'unknown']);
export const CONTROL_RETRY_GRACE_MS = 24 * 60 * 60 * 1000;

/** One atomic local journal: admission, receipts and lifecycle event commit together. No prompt text. */
export class ControlJournal {
  private value: ControlJournalState | undefined;
  private queue = Promise.resolve();
  readonly epoch = randomUUID();
  readonly file: string;
  constructor(userData: string, private readonly persist = writeJson, private readonly now = Date.now) { this.file = path.join(userData, 'control.json'); }

  /** Only expired windows plus retry grace may lose terminal receipts. Unknown/expired window IDs
   * are never admitted again, so pruning cannot turn a late retry into another execution. */
  private prune(state: ControlJournalState): void {
    const activeWindows = new Set(state.operations.filter((op) => !terminal.has(op.state)).map((op) => op.admissionWindowId));
    const expired = new Set(state.windows.filter((w) => w.expiresAt + CONTROL_RETRY_GRACE_MS <= this.now() && !activeWindows.has(w.id)).map((w) => w.id));
    state.windows = state.windows.filter((w) => !expired.has(w.id));
    state.operations = state.operations.filter((op) => !expired.has(op.admissionWindowId));
    const retained = new Set(state.operations.map((op) => op.id));
    state.events = state.events.filter((event) => retained.has(event.operationId)).slice(-10000);
  }

  async load(): Promise<void> {
    let initial: ControlJournalState;
    try {
      initial = stateSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ControlError('storage_unavailable');
      initial = { version: 1, instanceId: randomUUID(), logId: randomUUID(), enabled: false, projects: [], grants: [], windows: [], operations: [], events: [] };
    }
    // Restart is not permission to execute a saved intent. Preserve uncertainty without re-dispatch.
    for (const operation of initial.operations) if (!terminal.has(operation.state)) {
      operation.state = 'unknown';
      operation.updatedAt = this.now();
      initial.events.push({ id: randomUUID(), operationId: operation.id, state: 'unknown', at: operation.updatedAt, epoch: this.epoch });
    }
    this.prune(initial);
    try {
      stateSchema.parse(initial);
      await this.persist(this.file, initial);
      this.value = initial;
    } catch { throw new ControlError('storage_unavailable'); }
  }

  snapshot(): ControlJournalState {
    if (!this.value) throw new ControlError('storage_unavailable');
    return structuredClone(this.value);
  }

  transaction<T>(change: (state: ControlJournalState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const next = this.snapshot();
      this.prune(next);
      const result = change(next);
      const previous = new Map(this.value!.operations.map((op) => [op.id, op]));
      for (const operation of next.operations) {
        const old = previous.get(operation.id);
        if (old && terminal.has(old.state) && JSON.stringify(old) !== JSON.stringify(operation)) throw new ControlError('conflict');
        if (!old || old.state !== operation.state) next.events.push({ id: randomUUID(), operationId: operation.id, state: operation.state, at: operation.updatedAt, epoch: this.epoch });
      }
      // Lifecycle diagnostics are a bounded local ring, not an externally resumable event feed.
      next.events = next.events.slice(-10000);
      try {
        stateSchema.parse(next);
        await this.persist(this.file, next);
      } catch { throw new ControlError('storage_unavailable'); }
      this.value = next;
      return structuredClone(result);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
