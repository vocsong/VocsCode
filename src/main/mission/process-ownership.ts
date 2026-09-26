/** Durable bounded process ownership for host checks and terminals. Not a sandbox or PID scan. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
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
const claimPath = (intent: ProcessOwnershipIntent) => `${intent.receiptPath}.claimed`;
const claimRequiredPath = (intent: ProcessOwnershipIntent) => intent.path.replace(/\.intent\.json$/, '.claim-required.json');
const claimRequiredText = (intent: ProcessOwnershipIntent) => JSON.stringify({ schemaVersion: 1, nonce: intent.record.nonce, intentHash: intent.hash, launch: 'exclusive-claim' }) + '\n';
/** A supervisor's claim is its identity JSON, which never has a source; this cannot collide. */
const hostClaimText = (intent: ProcessOwnershipIntent) => JSON.stringify({ schemaVersion: 1, kind: intent.record.kind, nonce: intent.record.nonce, intentHash: intent.hash, source: 'host_not_started' }) + '\n';

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

/** Synchronous so a PTY's public create API need not change. Always before the first spawn.
 * `claimRequired` durably declares that no process may start under this nonce without first taking
 * `<receipt>.claimed` with an exclusive create, as the Windows Job supervisor does before it creates
 * its target. Only such an intent can later be proven unstarted (retireUnclaimedProcessIntent). */
export function createProcessOwnershipIntent(dir: string, owner: ProcessOwner, options: { claimRequired?: boolean } = {}): ProcessOwnershipIntent {
  const record: ProcessOwnershipRecord = { ...owner, schemaVersion: 1, nonce: randomUUID(), createdAt: Date.now() };
  if (!path.isAbsolute(dir) || !valid(record)) throw new Error('Invalid process ownership identity');
  mkdirSync(dir, { recursive: true });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid process ownership directory');
  const text = JSON.stringify(record) + '\n';
  const file = path.join(dir, `${record.nonce}.intent.json`);
  writeExclusive(file, text);
  const intent = { path: file, hash: hash(text), receiptPath: path.join(dir, `${record.nonce}.receipt.json`), record };
  if (options.claimRequired) {
    // Nobody has seen this nonce yet. If its declaration cannot be written, close it as unstarted
    // rather than leave an intent that restart recovery could never retire.
    try { writeExclusive(claimRequiredPath(intent), claimRequiredText(intent)); }
    catch (error) { try { recordUnlaunchedProcessIntent(intent); } catch { /* recovery stays blocked */ } throw error; }
  }
  return intent;
}

/** Only the caller that knows spawn has not returned a process handle may publish this. */
export function recordUnlaunchedProcessIntent(intent: ProcessOwnershipIntent): void {
  writeExclusive(intent.receiptPath, JSON.stringify({ ...intent.record, intentHash: intent.hash, source: 'host_not_started', outcome: 'not_started', quiescent: true, childTreeZero: true, completedAt: Date.now() }) + '\n');
}

/** Close an intent no launcher has claimed. A launcher takes `<receipt>.claimed` with an exclusive
 * create before it starts anything, so winning that same create proves nothing started under this
 * nonce, and makes any later launcher fail before it can start. A not-started receipt follows.
 * Safe to repeat after a crash between the two writes. False if anything else holds the claim or
 * a receipt already exists: that intent needs its own exact receipt instead. */
export function retireUnclaimedProcessIntent(intent: ProcessOwnershipIntent): boolean {
  const claim = claimPath(intent), text = hostClaimText(intent);
  try { writeExclusive(claim, text); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const stat = lstatSync(claim);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 || readFileSync(claim, 'utf8') !== text) return false;
    } catch { return false; }
  }
  try { recordUnlaunchedProcessIntent(intent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  return true;
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
    || name === intent.replace('.intent.json', '.receipt.json.claimed') || name === intent.replace('.intent.json', '.receipt.json.guardian')
    || name === intent.replace('.intent.json', '.claim-required.json') || name.startsWith(intent.replace('.intent.json', '.receipt.json.tmp-'))))) throw new Error('Orphaned process ownership record');
  return Promise.all(names.map(async (name) => {
    const file = path.join(dir, name), { text, data } = await read(file), record = data as ProcessOwnershipRecord;
    if (!valid(record) || name !== `${record.nonce}.intent.json`) throw new Error('Invalid process ownership intent');
    return { path: file, hash: hash(text), receiptPath: path.join(dir, `${record.nonce}.receipt.json`), record };
  }));
}

/** Exact positive receipt only, including kind-specific identity and the immutable intent hash. */
export async function processOwnershipReceipted(intent: ProcessOwnershipIntent): Promise<boolean> {
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

/** An exact positive receipt. Restart inspection also retires a claim-required intent that no
 * launcher ever claimed (a host death during approval or the heavy-check wait, or a supervisor
 * that died before registering ownership), by winning the claim itself. A claimed intent, or one
 * without that durable declaration, still needs its launcher's receipt. */
export async function processOwnershipQuiescent(intent: ProcessOwnershipIntent): Promise<boolean> {
  if (await processOwnershipReceipted(intent)) return true;
  try {
    const [current, declaration] = await Promise.all([read(intent.path), read(claimRequiredPath(intent))]);
    if (hash(current.text) !== intent.hash || declaration.text !== claimRequiredText(intent)) return false;
    return retireUnclaimedProcessIntent(intent) && await processOwnershipReceipted(intent);
  } catch { return false; }
}

export const checkOwnershipDirectory = (root: string, missionId: string): string => {
  if (!id(missionId)) throw new Error('Invalid Mission ownership identity');
  return path.join(root, missionId, 'checks');
};
