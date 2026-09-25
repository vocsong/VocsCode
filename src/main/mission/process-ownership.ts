/** Durable bounded process ownership for host checks and terminals. Not a sandbox or PID scan. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ProcessOwner =
  | { kind: 'mission-check'; missionId: string; operationId: string }
  | { kind: 'terminal'; sessionId: string; terminalId: string; cwd: string };
export type ProcessOwnershipRecord = ProcessOwner & { schemaVersion: 1; nonce: string; createdAt: number };
export interface ProcessOwnershipIntent { path: string; hash: string; receiptPath: string; record: ProcessOwnershipRecord }
export const ownershipNonce = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function valid(record: ProcessOwnershipRecord): boolean {
  const keys = Object.keys(record).sort().join(',');
  return record.schemaVersion === 1 && ownershipNonce(record.nonce) && integer(record.createdAt)
    && (record.kind === 'mission-check' && id(record.missionId) && id(record.operationId) && keys === 'createdAt,kind,missionId,nonce,operationId,schemaVersion'
      || record.kind === 'terminal' && id(record.sessionId) && id(record.terminalId) && typeof record.cwd === 'string' && path.isAbsolute(record.cwd)
        && keys === 'createdAt,cwd,kind,nonce,schemaVersion,sessionId,terminalId');
}

function writeExclusive(file: string, text: string): void {
  const handle = openSync(file, 'wx', 0o600);
  try { writeFileSync(handle, text, 'utf8'); fsyncSync(handle); } finally { closeSync(handle); }
}

/** Synchronous so a PTY's public create API need not change. Always before the first spawn. */
export function createProcessOwnershipIntent(dir: string, owner: ProcessOwner): ProcessOwnershipIntent {
  const record: ProcessOwnershipRecord = { ...owner, schemaVersion: 1, nonce: randomUUID(), createdAt: Date.now() };
  if (!path.isAbsolute(dir) || !valid(record)) throw new Error('Invalid process ownership identity');
  mkdirSync(dir, { recursive: true });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid process ownership directory');
  const text = JSON.stringify(record) + '\n';
  const file = path.join(dir, `${record.nonce}.intent.json`);
  writeExclusive(file, text);
  return { path: file, hash: hash(text), receiptPath: path.join(dir, `${record.nonce}.receipt.json`), record };
}

/** Only the caller that knows spawn has not returned a process handle may publish this. */
export function recordUnlaunchedProcessIntent(intent: ProcessOwnershipIntent): void {
  writeExclusive(intent.receiptPath, JSON.stringify({ ...intent.record, intentHash: intent.hash, source: 'host_not_started', outcome: 'not_started', quiescent: true, childTreeZero: true, completedAt: Date.now() }) + '\n');
}

async function read(file: string): Promise<{ text: string; data: Record<string, unknown> }> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid process ownership file');
  const text = await fs.readFile(file, 'utf8');
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid process ownership record');
  return { text, data: data as Record<string, unknown> };
}

/** Inventory is retained, never quarantined/deleted. An orphan or a corrupt record blocks recovery. */
export async function processOwnershipIntents(dir: string): Promise<ProcessOwnershipIntent[]> {
  const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid process ownership directory');
  const files = await fs.readdir(dir), names = files.filter((name) => name.endsWith('.intent.json'));
  if (files.some((name) => !names.some((intent) => name === intent || name === intent.replace('.intent.json', '.receipt.json')
    || name === intent.replace('.intent.json', '.receipt.json.claimed') || name === intent.replace('.intent.json', '.receipt.json.guardian') || name.startsWith(intent.replace('.intent.json', '.receipt.json.tmp-'))))) throw new Error('Orphaned process ownership record');
  return Promise.all(names.map(async (name) => {
    const file = path.join(dir, name), { text, data } = await read(file), record = data as ProcessOwnershipRecord;
    if (!valid(record) || name !== `${record.nonce}.intent.json`) throw new Error('Invalid process ownership intent');
    return { path: file, hash: hash(text), receiptPath: path.join(dir, `${record.nonce}.receipt.json`), record };
  }));
}

/** Exact positive receipt, including kind-specific identity and the immutable intent hash. */
export async function processOwnershipQuiescent(intent: ProcessOwnershipIntent): Promise<boolean> {
  try {
    const current = await read(intent.path), { data: receipt } = await read(intent.receiptPath);
    if (hash(current.text) !== intent.hash || !valid(current.data as ProcessOwnershipRecord)) return false;
    const identity = intent.record.kind === 'mission-check' ? ['missionId', 'operationId'] : ['sessionId', 'terminalId', 'cwd'];
    return ['schemaVersion', 'kind', 'nonce', ...identity].every((key) => receipt[key] === (intent.record as unknown as Record<string, unknown>)[key])
      && receipt.intentHash === intent.hash && receipt.quiescent === true && receipt.childTreeZero === true && integer(receipt.completedAt)
      && receipt.completedAt >= intent.record.createdAt
      && (receipt.source === 'supervisor' && (receipt.outcome === 'job_empty' || receipt.outcome === 'not_started') || receipt.source === 'host_not_started' && receipt.outcome === 'not_started');
  } catch { return false; }
}

export const checkOwnershipDirectory = (root: string, missionId: string): string => {
  if (!id(missionId)) throw new Error('Invalid Mission ownership identity');
  return path.join(root, missionId, 'checks');
};
