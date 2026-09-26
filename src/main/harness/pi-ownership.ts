/** Durable managed-Pi ownership, not a sandbox or a PID-based recovery heuristic. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ManagedPiOwner {
  sessionId: string;
  missionId: string;
  generation: number;
}

export interface ManagedPiOwnershipIntent {
  path: string;
  hash: string;
  receiptPath: string;
  record: ManagedPiOwner & { schemaVersion: 1; kind: 'mission-pi'; nonce: string; createdAt: number };
}

export interface ManagedPiOwnershipInspection {
  state: 'absent' | 'unknown' | 'quiescent';
  quiescent: boolean;
  intents: number;
  detail?: string;
}

const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const directory = (sessionDir: string) => path.join(sessionDir, 'pi', 'process-ownership');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

async function readRecord(file: string): Promise<{ text: string; data: Record<string, unknown> }> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid ownership record');
  const text = await fs.readFile(file, 'utf8');
  const data: unknown = JSON.parse(text);
  if (!object(data)) throw new Error('Invalid ownership record');
  return { text, data };
}

/** Persist before any supervisor can be spawned. No prompts, argv, environment or credentials. */
export async function createManagedPiOwnershipIntent(sessionDir: string, owner: ManagedPiOwner): Promise<ManagedPiOwnershipIntent> {
  if (!path.isAbsolute(sessionDir) || !id(owner.sessionId) || !id(owner.missionId) || !integer(owner.generation)) throw new Error('Invalid managed Pi ownership identity');
  const dir = directory(sessionDir);
  await fs.mkdir(dir, { recursive: true });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid managed Pi ownership directory');
  const bindingFile = path.join(sessionDir, 'pi', 'runtime-launch.json');
  const binding = await readRecord(bindingFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  if (binding && (binding.data.sessionId !== owner.sessionId || binding.data.missionId !== owner.missionId || binding.data.generation !== owner.generation
    || !NONCE.test(String(binding.data.nonce)) || Object.keys(binding.data).sort().join(',') !== 'generation,missionId,nonce,sessionId')) throw new Error('Managed Pi dispatch launch identity changed');
  const record = { schemaVersion: 1 as const, kind: 'mission-pi' as const, nonce: binding ? String(binding.data.nonce) : randomUUID(), ...owner, createdAt: Date.now() };
  const text = JSON.stringify(record) + '\n';
  const file = path.join(dir, `${record.nonce}.intent.json`);
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  // Consume only after the immutable intent exists. A crash in either gap remains unknown,
  // never permission for a second launch to inherit an old nonce/receipt.
  if (binding) await fs.unlink(bindingFile);
  return { path: file, hash: hash(text), receiptPath: path.join(dir, `${record.nonce}.receipt.json`), record };
}

/** The service persisted this nonce in its dispatch journal before asking the adapter to start.
 * Call only after the previous runtime has positively stopped. A missing binding keeps the
 * standalone adapter API compatible; production dispatch always supplies one. */
export async function bindManagedPiLaunch(sessionDir: string, owner: ManagedPiOwner, nonce: string): Promise<void> {
  if (!path.isAbsolute(sessionDir) || !id(owner.sessionId) || !id(owner.missionId) || !integer(owner.generation) || !NONCE.test(nonce)) throw new Error('Invalid managed Pi launch binding');
  const dir = path.join(sessionDir, 'pi');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'runtime-launch.json'), temporary = `${file}.tmp-${nonce}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ ...owner, nonce }) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
}

/** Only for a synchronous launch failure/cancellation BEFORE launch returned a process handle. */
export async function recordUnlaunchedManagedPiIntent(intent: ManagedPiOwnershipIntent): Promise<void> {
  const receipt = { ...intent.record, intentHash: intent.hash, source: 'host_not_started', outcome: 'not_started', quiescent: true, childTreeZero: true, completedAt: Date.now() };
  const handle = await fs.open(intent.receiptPath, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(receipt) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

/**
 * Read-only crash recovery. Every retained launch must have an exact positive receipt. Require
 * generation/notBefore when reconciling a persisted runtimeStartRequestedAt, so an earlier clean
 * capability probe cannot certify a later launch whose write-ahead intent was never persisted.
 * `absent` is NOT proof. The caller must exclude new launches while inspecting; receipts are
 * evidence, not an admission lock. No process enumeration, signals, credentials or workspace writes.
 */
export async function inspectManagedPiOwnership(
  sessionDir: string,
  expected: Pick<ManagedPiOwner, 'sessionId' | 'missionId'> & { generation?: number; notBefore?: number; nonce?: string },
): Promise<ManagedPiOwnershipInspection> {
  let intents = 0;
  const unknown = (detail: string): ManagedPiOwnershipInspection => ({ state: 'unknown', quiescent: false, intents, detail });
  try {
    if (!path.isAbsolute(sessionDir) || !id(expected.sessionId) || !id(expected.missionId)
      || (expected.generation !== undefined && !integer(expected.generation)) || (expected.notBefore !== undefined && !integer(expected.notBefore))
      || (expected.nonce !== undefined && !NONCE.test(expected.nonce))) return unknown('Invalid managed Pi recovery identity.');
    const dir = directory(sessionDir);
    const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!stat) return { state: 'absent', quiescent: false, intents, detail: 'No durable managed Pi ownership intent exists.' };
    if (!stat.isDirectory() || stat.isSymbolicLink()) return unknown('Invalid managed Pi ownership directory.');
    const files = await fs.readdir(dir);
    const names = files.filter((name) => name.endsWith('.intent.json'));
    intents = names.length;
    if (!intents) return files.length ? unknown('Ownership records have no matching intent.') : { state: 'absent', quiescent: false, intents, detail: 'No durable managed Pi ownership intent exists.' };
    if (files.some((name) => !names.some((intent) => name === intent || name === intent.replace('.intent.json', '.receipt.json') || name === intent.replace('.intent.json', '.receipt.json.claimed') || name.startsWith(intent.replace('.intent.json', '.receipt.json.tmp-'))))) return unknown('Unrecognized or orphaned managed Pi ownership record.');
    let expectedLaunch = false;
    for (const name of names) {
      const nonce = name.slice(0, -'.intent.json'.length);
      const intent = await readRecord(path.join(dir, name));
      const record = intent.data;
      if (!NONCE.test(nonce) || record.nonce !== nonce || record.schemaVersion !== 1 || record.kind !== 'mission-pi'
        || record.sessionId !== expected.sessionId || record.missionId !== expected.missionId || !integer(record.generation) || !integer(record.createdAt)
        || Object.keys(record).sort().join(',') !== 'createdAt,generation,kind,missionId,nonce,schemaVersion,sessionId') return unknown('Managed Pi ownership intent identity is invalid.');
      const { data: receipt } = await readRecord(path.join(dir, `${nonce}.receipt.json`));
      if (receipt.schemaVersion !== 1 || receipt.kind !== 'mission-pi' || receipt.nonce !== nonce || receipt.sessionId !== record.sessionId
        || receipt.missionId !== record.missionId || receipt.generation !== record.generation || receipt.intentHash !== hash(intent.text)
        || receipt.quiescent !== true || receipt.childTreeZero !== true || !integer(receipt.completedAt)
        || !((receipt.source === 'supervisor' && (receipt.outcome === 'job_empty' || receipt.outcome === 'not_started'))
          || (receipt.source === 'host_not_started' && receipt.outcome === 'not_started'))) return unknown('Managed Pi teardown receipt does not match its exact launch intent.');
      if ((expected.generation === undefined || record.generation === expected.generation) && (expected.notBefore === undefined || record.createdAt >= expected.notBefore)
        && (expected.nonce === undefined || nonce === expected.nonce)) expectedLaunch = true;
    }
    if (!expectedLaunch) return unknown('No positive managed Pi receipt covers the requested runtime launch.');
    return { state: 'quiescent', quiescent: true, intents };
  } catch {
    return unknown('Managed Pi ownership intent/receipt is missing, unreadable or incomplete.');
  }
}
