/** Private desktop catalog. No settings, harness discovery, or prompt dispatch here. */
import { isUtf8 } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHARED_SKILL_NAME, type SharedSkillDocument, type SharedSkillInfo, type SharedSkillReceipt } from '../shared/shared-skills';

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_BYTES = 32 * 1024;
const MAX_DESCRIPTION = 1024;
const MAX_ENTRIES = 512;
const MAX_APPROVAL_BYTES = 96 * 1024;
const REVISION = /^[a-f0-9]{64}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const UNSAFE_PATH = 'Shared skills require regular files and directories without links.';
const PATH_CHANGED = 'Shared skills storage changed. Try again.';
const NOT_FOUND = 'Shared skill not found.';
const STALE = 'Shared skill changed on disk. Reload it before saving or reviewing.';
const INVALID_DOC = 'Shared skill needs valid name and description frontmatter and a non-empty body.';
const TOO_LARGE = 'Shared skill exceeds the 32 KiB limit.';
const BAD_APPROVALS = 'Shared skill approvals are unavailable.';
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const SCALAR_CONTROL = /[\r\n\u2028\u2029\uD800-\uDFFF]/u;
const hasText = (value: string) => /[^\s\p{Cc}\p{Cf}]/u.test(value);

class StorageError extends Error {}

function refuse(message: string): never {
  throw new StorageError(message);
}

/** Filesystem and parser errors may carry private paths or input excerpts. */
async function safely<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    return refuse(message);
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && SHARED_SKILL_NAME.test(name) && !(process.platform === 'win32' && WINDOWS_DEVICE.test(name));
}

function validRevision(revision: unknown): revision is string {
  return typeof revision === 'string' && REVISION.test(revision);
}

function checkName(name: unknown): asserts name is string {
  if (!validName(name)) refuse('Invalid shared skill name.');
}

function textBytes(content: string): Buffer {
  if (typeof content !== 'string') refuse(INVALID_DOC);
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) refuse(TOO_LARGE);
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.toString('utf8') !== content) refuse('Shared skill must be valid UTF-8 text.');
  return bytes;
}

function scalar(raw: string): string {
  if (raw.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?$/.exec(raw);
    if (!quoted) refuse(INVALID_DOC);
    try {
      return JSON.parse(quoted[1]) as string;
    } catch {
      return refuse(INVALID_DOC);
    }
  }
  if (raw.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/.exec(raw);
    if (!quoted) refuse(INVALID_DOC);
    return quoted[1].replaceAll("''", "'");
  }
  const comment = raw.search(/[ \t]#/);
  const plain = (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
  // No collection, directive, tag, anchor, alias, or embedded mapping syntax.
  if (/^(?:[!&*|>{}\[\],%@`#]|[?:-](?:[ \t]|$))|:[ \t]|:$/.test(plain)) refuse(INVALID_DOC);
  return plain;
}

interface ParsedSkill extends SharedSkillReceipt {
  description: string;
  content: string;
  body: string;
}

/** v1 uses two unique scalar fields, not general YAML. The remainder is literal Markdown. */
function parseSkill(name: string, bytes: Buffer): ParsedSkill {
  if (!isUtf8(bytes)) refuse('Shared skill must be valid UTF-8 text.');
  const content = bytes.toString('utf8');
  if (TEXT_CONTROL.test(content)) refuse('Shared skill must be plain UTF-8 text.');
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  if (!opening) refuse(INVALID_DOC);
  const rest = content.slice(opening[0].length);
  const closing = /(?:^|\r?\n)---[ \t]*\r?\n/.exec(rest);
  if (!closing) refuse(INVALID_DOC);
  const body = rest.slice(closing.index + closing[0].length);
  const header = rest.slice(0, closing.index);
  if (/\r(?!\n)|[\u2028\u2029]/u.test(header)) refuse(INVALID_DOC);
  const fields = new Map<string, string>();
  const lines = header.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*(?:#.*)?$/.test(lines[i])) continue;
    const field = /^(name|description):[ \t]+(.*)$/.exec(lines[i]);
    if (!field || fields.has(field[1])) refuse(INVALID_DOC);
    const [, key, raw] = field;
    let value: string;
    if (key === 'description' && /^[|>]-?(?:[ \t]+#.*)?$/.test(raw.trimEnd())) {
      // Descriptions are summaries; accept consistently indented literal/folded forms as well.
      const parts: string[] = [];
      let indent = 0;
      while (i + 1 < lines.length && /^(?: |[ \t]*$)/.test(lines[i + 1])) {
        const line = lines[++i];
        if (!line.trim()) continue;
        const spaces = /^ +/.exec(line)![0].length;
        if (indent === 0) indent = spaces;
        if (spaces < indent) refuse(INVALID_DOC);
        parts.push(line.slice(indent).trim());
      }
      value = parts.join(' ');
    } else {
      value = scalar(raw.trimEnd());
    }
    if (TEXT_CONTROL.test(value) || SCALAR_CONTROL.test(value) || !hasText(value)) refuse(INVALID_DOC);
    fields.set(key, value);
  }
  const description = fields.get('description')?.trim();
  if (fields.get('name') !== name || !description || description.length > MAX_DESCRIPTION || !hasText(body)) refuse(INVALID_DOC);
  return { name, description, revision: createHash('sha256').update(bytes).digest('hex'), content, body };
}

interface Directory {
  path: string;
  stat: BigIntStats;
  parent?: Directory;
}

interface FileSnapshot {
  bytes: Buffer;
  stat: BigIntStats;
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a: BigIntStats | undefined, b: BigIntStats | undefined): boolean {
  if (!a || !b) return a === b;
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs &&
    a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
}

async function statIfPresent(target: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
    return undefined;
  }
}

function absolute(target: string): string {
  if (!path.isAbsolute(target) || target.includes('\0') || target.split(/[\\/]/).includes('..') ||
      (process.platform === 'win32' && (/^\\\\[.?]\\/.test(target) || target.slice(path.parse(target).root.length).includes(':')))) refuse(UNSAFE_PATH);
  return path.resolve(target);
}

async function canonical(target: string, exactName?: string): Promise<void> {
  const real = await fs.realpath(target);
  if (path.relative(target, real) !== '' || (exactName !== undefined && path.basename(real) !== exactName)) refuse(UNSAFE_PATH);
}

async function checkDirectory(dir: Directory): Promise<void> {
  if (dir.parent) await checkDirectory(dir.parent);
  const now = await statIfPresent(dir.path);
  if (!now?.isDirectory() || !sameIdentity(dir.stat, now)) refuse(PATH_CHANGED);
}

/** Walk each component (not recursive mkdir/stat), refusing intermediate symlinks and junctions. */
async function openDirectory(target: string, create = false, parent?: Directory): Promise<Directory | undefined> {
  const root = parent?.path ?? path.parse(target).root;
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  if (path.isAbsolute(relative) || parts.includes('..')) refuse(UNSAFE_PATH);
  if (!parent) parts.unshift('');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat = await statIfPresent(current);
    if (!stat && create && parent) {
      await checkDirectory(parent);
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
      }
      stat = await statIfPresent(current);
    }
    if (!stat) return undefined;
    if (!stat.isDirectory()) refuse(UNSAFE_PATH);
    parent = { path: current, stat, parent };
  }
  await canonical(current);
  return parent;
}

async function skillDirectory(root: Directory, name: string): Promise<Directory | undefined> {
  await checkDirectory(root);
  const target = path.join(root.path, name);
  const stat = await statIfPresent(target);
  if (!stat) return undefined;
  if (!stat.isDirectory()) refuse(UNSAFE_PATH);
  await canonical(target, name);
  return { path: target, stat, parent: root };
}

async function fileAt(dir: Directory, leaf: string): Promise<BigIntStats | undefined> {
  await checkDirectory(dir);
  const target = path.join(dir.path, leaf);
  const stat = await statIfPresent(target);
  if (stat) {
    if (!stat.isFile() || stat.nlink !== 1n) refuse(UNSAFE_PATH);
    await canonical(target, leaf);
  }
  return stat;
}

async function readFileAt(dir: Directory, leaf: string, limit: number, oversized: string): Promise<FileSnapshot | undefined> {
  const stat = await fileAt(dir, leaf);
  if (!stat) return undefined;
  if (stat.size > BigInt(limit)) refuse(oversized);
  // Pin the leaf; on Windows the before/handle/after identity checks cover the missing O_NOFOLLOW.
  const handle = await fs.open(path.join(dir.path, leaf), READ_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameVersion(opened, stat) || !sameVersion(stat, await fileAt(dir, leaf))) refuse(PATH_CHANGED);
    const bytes = Buffer.allocUnsafe(Number(stat.size) + 1);
    let end = 0;
    while (end < bytes.length) {
      const { bytesRead } = await handle.read(bytes, end, bytes.length - end, end);
      if (bytesRead === 0) break;
      end += bytesRead;
    }
    if (BigInt(end) !== stat.size || !sameVersion(stat, await handle.stat({ bigint: true })) || !sameVersion(stat, await fileAt(dir, leaf))) refuse(PATH_CHANGED);
    return { bytes: bytes.subarray(0, end), stat };
  } finally {
    await handle.close();
  }
}

async function checkSkillBytes(dir: Directory, before: FileSnapshot): Promise<void> {
  const now = await readFileAt(dir, SKILL_FILE, MAX_SKILL_BYTES, TOO_LARGE);
  if (!now || !sameVersion(before.stat, now.stat) || !before.bytes.equals(now.bytes)) refuse(STALE);
}

async function unlinkOwned(dir: Directory, leaf: string, written: BigIntStats): Promise<void> {
  try {
    const current = await fileAt(dir, leaf);
    if (current && sameIdentity(current, written)) await fs.unlink(path.join(dir.path, leaf));
  } catch {
    // A moved/replaced path is not ours to clean up.
  }
}

async function writeNew(dir: Directory, leaf: string, bytes: Buffer, preserve?: BigIntStats): Promise<BigIntStats> {
  await checkDirectory(dir);
  const handle = await fs.open(path.join(dir.path, leaf), 'wx', 0o600);
  let made: BigIntStats | undefined;
  try {
    try {
      made = await handle.stat({ bigint: true });
      if (!sameVersion(made, await fileAt(dir, leaf))) refuse(PATH_CHANGED);
      await handle.writeFile(bytes);
      if (preserve && process.platform !== 'win32') {
        if (made.uid !== preserve.uid || made.gid !== preserve.gid) await handle.chown(Number(preserve.uid), Number(preserve.gid));
        await handle.chmod(Number(preserve.mode & 0o777n));
      }
      await handle.sync();
      return await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (made) await unlinkOwned(dir, leaf, made);
    throw error;
  }
}

async function replaceFile(
  dir: Directory, leaf: string, bytes: Buffer, prior: BigIntStats | undefined, beforeCommit: () => Promise<void>, preserve?: BigIntStats
): Promise<void> {
  const temp = `.shared-skill-${randomUUID()}.tmp`;
  const staged = await writeNew(dir, temp, bytes, preserve);
  try {
    await beforeCommit();
    if (!sameVersion(staged, await fileAt(dir, temp))) refuse(PATH_CHANGED);
    if (!sameVersion(prior, await fileAt(dir, leaf))) refuse(STALE);
    // Optimistic, not an OS compare-and-swap against an external writer between check and rename.
    await fs.rename(path.join(dir.path, temp), path.join(dir.path, leaf));
  } catch (error) {
    await unlinkOwned(dir, temp, staged);
    throw error;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function approvalMap(bytes: Buffer | undefined): Map<string, string> {
  if (!bytes) return new Map();
  if (!isUtf8(bytes)) refuse(BAD_APPROVALS);
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse(BAD_APPROVALS);
  }
  if (!record(decoded) || decoded.version !== 1 || !record(decoded.approvals) || Object.keys(decoded).length !== 2) refuse(BAD_APPROVALS);
  const pairs = Object.entries(decoded.approvals);
  if (pairs.length > MAX_ENTRIES) refuse(BAD_APPROVALS);
  const approvals = new Map<string, string>();
  for (const [name, revision] of pairs) {
    if (!SHARED_SKILL_NAME.test(name) || !validRevision(revision)) refuse(BAD_APPROVALS);
    approvals.set(name, revision);
  }
  return approvals;
}

function info({ name, revision, description }: ParsedSkill, approvals: ReadonlyMap<string, string>): SharedSkillInfo {
  return { name, description, revision, reviewed: approvals.get(name) === revision };
}

/** The paths are trusted main-process configuration; operation inputs are names, never paths. */
export class SharedSkillsStore {
  private tail: Promise<void> = Promise.resolve();
  private readonly root: string;
  private readonly home?: string;

  constructor(private readonly approvalFile: string, root?: string) {
    const home = os.homedir();
    this.root = root ?? path.join(home, '.agents', 'skills');
    if (root === undefined) this.home = home;
  }

  private async openRoot(create = false): Promise<Directory | undefined> {
    const target = absolute(this.root);
    if (this.home === undefined) return openDirectory(target, create);
    // The default may provision .agents/skills, never the home directory itself.
    const home = await openDirectory(absolute(this.home));
    return home && openDirectory(target, create, home);
  }

  private ordered<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async approvals() {
    return safely(BAD_APPROVALS, async () => {
      const file = absolute(this.approvalFile);
      const relative = path.relative(absolute(this.root), file);
      if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) refuse(BAD_APPROVALS);
      const leaf = path.basename(file);
      const dir = await openDirectory(path.dirname(file));
      const saved = dir && await readFileAt(dir, leaf, MAX_APPROVAL_BYTES, BAD_APPROVALS);
      // Windows uses the trusted profile directory's inherited ACL; POSIX mode must be private.
      const uid = process.getuid?.();
      if (saved && uid !== undefined && (saved.stat.uid !== BigInt(uid) || (saved.stat.mode & 0o077n) !== 0n)) refuse(BAD_APPROVALS);
      return { file, leaf, dir, stat: saved?.stat, entries: approvalMap(saved?.bytes) };
    });
  }

  private async approvalsForInfo(): Promise<ReadonlyMap<string, string>> {
    // A broken approval file should not hide editable documents, but never confers consent.
    return (await this.approvals().catch(() => undefined))?.entries ?? new Map();
  }

  private async skill(root: Directory, name: string) {
    const dir = await skillDirectory(root, name);
    const file = dir && await readFileAt(dir, SKILL_FILE, MAX_SKILL_BYTES, TOO_LARGE);
    if (!dir || !file) refuse(NOT_FOUND);
    return { dir, file, doc: parseSkill(name, file.bytes) };
  }

  private async existing(name: string) {
    checkName(name);
    const root = await this.openRoot();
    if (!root) refuse(NOT_FOUND);
    return this.skill(root, name);
  }

  private async asDocument(doc: ParsedSkill): Promise<SharedSkillDocument> {
    return { ...info(doc, await this.approvalsForInfo()), content: doc.content };
  }

  list(): Promise<SharedSkillInfo[]> {
    return safely('Could not list shared skills.', async () => {
      const root = await this.openRoot();
      if (!root) return [];
      await checkDirectory(root);
      const names: string[] = [];
      let count = 0;
      for await (const entry of await fs.opendir(root.path)) {
        if (++count > MAX_ENTRIES) refuse('Shared skills directory has too many entries.');
        if (entry.isDirectory() && validName(entry.name)) names.push(entry.name);
      }
      const approvals = await this.approvalsForInfo();
      const skills: SharedSkillInfo[] = [];
      for (const name of names.sort()) {
        const found = await this.skill(root, name).catch(() => undefined);
        if (found) skills.push(info(found.doc, approvals));
      }
      await checkDirectory(root);
      return skills;
    });
  }

  read(name: string): Promise<SharedSkillDocument> {
    return safely('Could not read shared skill.', async () => this.asDocument((await this.existing(name)).doc));
  }

  create(request: { name: string; description: string }): Promise<SharedSkillDocument> {
    return this.ordered(() => safely('Could not create shared skill.', async () => {
      const { name, description } = request;
      checkName(name);
      if (typeof description !== 'string' || description.length > MAX_DESCRIPTION) refuse(INVALID_DOC);
      const summary = description.trim().replace(/[ \t\r\n]+/g, ' ');
      const raw = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(summary)}\n---\n\n# ${name}\n\nDescribe what the agent should do when this skill is used.\n`;
      const bytes = textBytes(raw);
      const doc = parseSkill(name, bytes);
      const root = await this.openRoot(true);
      if (!root) refuse(UNSAFE_PATH);
      const folder = path.join(root.path, name);
      await checkDirectory(root);
      try {
        await fs.mkdir(folder, { mode: 0o700 });
      } catch (error) {
        if (code(error) === 'EEXIST') refuse('Shared skill already exists.');
        throw error;
      }
      const dir = await skillDirectory(root, name);
      if (!dir) refuse(PATH_CHANGED);
      try {
        await writeNew(dir, SKILL_FILE, bytes);
      } catch (error) {
        // Never remove somebody else's file or a non-empty folder.
        await checkDirectory(dir).then(() => fs.rmdir(dir.path)).catch(() => undefined);
        throw error;
      }
      return this.asDocument(doc);
    }));
  }

  save(request: { name: string; revision: string; content: string }): Promise<SharedSkillDocument> {
    return this.ordered(() => safely('Could not save shared skill.', async () => {
      const { name, revision, content } = request;
      if (!validRevision(revision)) refuse(STALE);
      const { dir, file, doc } = await this.existing(name);
      if (doc.revision !== revision) refuse(STALE);
      const bytes = textBytes(content);
      const next = parseSkill(name, bytes);
      if (!file.bytes.equals(bytes)) {
        await replaceFile(dir, SKILL_FILE, bytes, file.stat, () => checkSkillBytes(dir, file), file.stat);
      }
      return this.asDocument(next);
    }));
  }

  review(request: { name: string; revision: string; enabled: boolean }): Promise<SharedSkillInfo> {
    return this.ordered(() => safely('Could not save shared skill review.', async () => {
      const { name, revision, enabled } = request;
      if (typeof enabled !== 'boolean') refuse('Invalid shared skill review request.');
      if (!validRevision(revision)) refuse(STALE);
      const { dir, file, doc } = await this.existing(name);
      if (doc.revision !== revision) refuse(STALE);
      const stored = await this.approvals();
      const next = enabled ? revision : undefined;
      if (stored.entries.get(name) !== next) {
        if (next === undefined) stored.entries.delete(name);
        else stored.entries.set(name, next);
        if (stored.entries.size > MAX_ENTRIES) refuse('Too many shared skill approvals.');
        const target = stored.dir ?? await openDirectory(path.dirname(stored.file), true);
        if (!target) refuse(BAD_APPROVALS);
        const approvals = Object.fromEntries([...stored.entries.keys()].sort().map((key) => [key, stored.entries.get(key)]));
        const bytes = Buffer.from(`${JSON.stringify({ version: 1, approvals })}\n`, 'utf8');
        await replaceFile(target, stored.leaf, bytes, stored.stat, () => checkSkillBytes(dir, file));
      } else {
        await checkSkillBytes(dir, file);
      }
      return info(doc, stored.entries);
    }));
  }

  /** Linearized with local mutations; approvals are read from the committed profile, not a cache. */
  resolve(name: string): Promise<{ receipt: SharedSkillReceipt; content: string }> {
    return this.ordered(() => safely('Could not resolve shared skill.', async () => {
      const { dir, file, doc } = await this.existing(name);
      const { entries } = await this.approvals();
      const approved = entries.get(name);
      if (approved === undefined) refuse('Shared skill is not reviewed.');
      if (approved !== doc.revision || !sameVersion(file.stat, await fileAt(dir, SKILL_FILE))) {
        refuse('Shared skill changed on disk. Review it again before use.');
      }
      return { receipt: { name, revision: doc.revision }, content: doc.body };
    }));
  }
}
