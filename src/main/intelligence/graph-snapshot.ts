/**
 * Graphify's Git boundary. Only the exact, physical checkout and its local object store are
 * eligible. Git runs in a private bare metadata view: no repository discovery, index, attributes,
 * project configuration/includes, hooks, replacements, alternates or on-demand fetches.
 * Supports files-based SHA-1/SHA-256 repositories and standard linked worktrees with reciprocal
 * absolute pointers, not arbitrary gitfiles, reftable, Windows UNC paths, or shared alternates.
 * Like Git itself, this assumes no hostile local process concurrently rewrites Git administration
 * files. The destination must be app-private (not writable by the project).
 */
import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const MiB = 1024 * 1024;
// All subprocess output is bounded; no partial snapshot on tree, aggregate or file-count overflow.
const MAX_TREE_BYTES = 8 * MiB;
const MAX_ENTRIES = 100_000;
const MAX_FILES = 4096;
const MAX_FILE_BYTES = MiB;
const MAX_CODE_BYTES = 32 * MiB;
const HEAD_MS = 10_000;
const SNAPSHOT_MS = 45_000;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CODE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|pyi?|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|scala|lua|dart|zig|exs?|erl|hrl|sh|sol|vue|svelte)$/i;
const OUTPUT_DIRS = new Set(['node_modules', 'vendor', 'dist', 'out', 'build', 'target', 'coverage', 'graphify-out', '__pycache__']);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LFS_MARKER = Buffer.from('version https://git-lfs.github.com/spec/v1');
const INVALID_REPO = 'Graphify requires an exact, local Git worktree with supported metadata.';

// Test names against Windows rules even when staging on POSIX: device files (including extensions
// and the superscript digits Win32 recognizes), streams, short aliases and trailing dots/spaces.
function safePart(part: string): boolean {
  return !!part && !/[<>:"/\\|?*\x00-\x1f\x7f]|[ .]$|~\d/i.test(part)
    && !/^(?:con(?:in\$|out\$)?|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i.test(part);
}

function absolute(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\0') || (WIN && !/^[a-z]:[\\/]/i.test(value))) throw new Error(INVALID_REPO);
  const input = WIN ? value.replaceAll('/', '\\') : value;
  const root = path.parse(input).root;
  const parts = input.slice(root.length).split(path.sep).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || (WIN && !safePart(part)))) throw new Error(INVALID_REPO);
  return path.join(root, ...parts);
}

function within(root: string, value: string): boolean {
  const rel = path.relative(root, value);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
const samePath = (a: string, b: string): boolean => path.relative(a, b) === '';

async function physicalDir(value: string, signal: AbortSignal): Promise<string> {
  const full = absolute(value);
  let prefix = path.parse(full).root;
  for (const part of full.slice(prefix.length).split(path.sep).filter(Boolean)) {
    signal.throwIfAborted();
    prefix = path.join(prefix, part);
    // Check each component before looking below it; lstat refuses junctions and symlinks.
    if (!(await fs.lstat(prefix)).isDirectory()) throw new Error(INVALID_REPO);
  }
  const real = await fs.realpath(full);
  if (!samePath(real, full)) throw new Error(INVALID_REPO);
  return real;
}

function lstat(file: string) {
  return fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

async function readSmall(file: string, cap: number, signal: AbortSignal): Promise<Buffer | undefined> {
  signal.throwIfAborted();
  const stat = await lstat(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > cap) throw new Error(INVALID_REPO);
  const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await fd.stat()).isFile()) throw new Error(INVALID_REPO);
    const result = Buffer.allocUnsafe(cap + 1);
    let end = 0;
    while (end <= cap) {
      signal.throwIfAborted();
      const { bytesRead } = await fd.read(result, end, result.length - end, end);
      if (!bytesRead) return result.subarray(0, end);
      end += bytesRead;
    }
    throw new Error(INVALID_REPO);
  } finally {
    await fd.close();
  }
}

async function line(file: string, signal: AbortSignal): Promise<string | undefined> {
  const data = await readSmall(file, 4096, signal);
  return data ? UTF8.decode(data).replace(/\r?\n$/, '') : undefined;
}

interface Checkout { root: string; gitDir: string; common: string; head: string }

function branchRef(head: string): string | undefined {
  if (!head.startsWith('ref: refs/heads/')) return undefined;
  const ref = head.slice(5);
  if (ref.split('/').some((part) => !safePart(part) || part.startsWith('.') || part.endsWith('.lock') || /\.\.|@\{|[ ~^\[\]]/.test(part))) return undefined;
  return ref;
}

async function checkout(cwd: string, signal: AbortSignal): Promise<Checkout> {
  const root = await physicalDir(cwd, signal);
  const marker = path.join(root, '.git');
  let gitDir = marker, common = marker;
  if (!(await lstat(marker))?.isDirectory()) {
    // A linked worktree stores HEAD separately. Require Git's standard layout and a reciprocal
    // pointer back to this exact marker before using the common .git directory outside the root.
    const pointer = await line(marker, signal);
    if (!pointer?.startsWith('gitdir: ')) throw new Error(INVALID_REPO);
    gitDir = absolute(pointer.slice(8));
    const worktrees = path.dirname(gitDir);
    common = path.dirname(worktrees);
    if (path.basename(worktrees) !== 'worktrees' || path.basename(common) !== '.git') throw new Error(INVALID_REPO);
    gitDir = await physicalDir(gitDir, signal);
    common = path.dirname(path.dirname(gitDir));
    if (await line(path.join(gitDir, 'commondir'), signal) !== '../..'
      || !samePath(absolute(await line(path.join(gitDir, 'gitdir'), signal) ?? ''), marker)) throw new Error(INVALID_REPO);
  }
  if (await lstat(path.join(common, 'commondir')) || !(await lstat(path.join(common, 'refs')))?.isDirectory()) throw new Error(INVALID_REPO);
  const head = await line(path.join(gitDir, 'HEAD'), signal);
  if (!head || (!OID.test(head) && !branchRef(head))) throw new Error(INVALID_REPO);
  return { root, gitDir, common, head };
}

async function readHead(repo: Checkout, signal: AbortSignal): Promise<string | null> {
  if (OID.test(repo.head)) return repo.head;
  const ref = branchRef(repo.head)!;
  const parts = ref.split('/');
  let dir = repo.common;
  let loose = true;
  for (const name of parts.slice(0, -1)) {
    signal.throwIfAborted();
    dir = path.join(dir, name);
    const stat = await lstat(dir);
    if (!stat) { loose = false; break; }
    if (!stat.isDirectory()) throw new Error(INVALID_REPO);
  }
  if (loose) {
    const oid = await line(path.join(dir, parts.at(-1)!), signal);
    if (oid !== undefined) return OID.test(oid) ? oid : null;
  }
  const packed = await readSmall(path.join(repo.common, 'packed-refs'), 4 * MiB, signal);
  for (const row of packed?.toString('utf8').split('\n') ?? []) {
    if (row.endsWith(` ${ref}`)) {
      const oid = row.slice(0, row.indexOf(' '));
      if (OID.test(oid)) return oid;
    }
  }
  return null;
}

function withinCheckout(repo: Checkout, file: string): boolean {
  return within(repo.root, file) || within(path.dirname(repo.common), file);
}

async function gitExecutable(repo: Checkout, signal: AbortSignal): Promise<string> {
  async function runnable(file: string): Promise<string | undefined> {
    signal.throwIfAborted();
    if (withinCheckout(repo, file)) return undefined;
    try {
      const real = absolute(await fs.realpath(file));
      if (withinCheckout(repo, real) || (WIN && path.extname(real).toLowerCase() !== '.exe')) return undefined;
      if (!(await fs.stat(real)).isFile()) return undefined;
      await fs.access(real, constants.X_OK);
      return real;
    } catch { return undefined; }
  }
  // PATH is the app user's authority, not the checkout's. No relative entries or cmd/bat shims.
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).slice(0, 256)) {
    let file: string;
    try { file = path.join(absolute(dir), WIN ? 'git.exe' : 'git'); } catch { continue; }
    const git = await runnable(file);
    if (!git) continue;
    const bin = path.dirname(git);
    if (WIN && /^(?:cmd|bin)$/i.test(path.basename(bin))) {
      // Git for Windows' cmd/git.exe launches a child. Prefer its native executable so a
      // cancelled/overflowed invocation kills Git itself instead of only its launcher.
      for (const arch of ['mingw64', 'mingw32', 'clangarm64']) {
        const nativeBin = path.join(path.dirname(bin), arch, 'bin');
        const native = await runnable(path.join(nativeBin, 'git.exe'));
        if (native && samePath(path.dirname(native), nativeBin)) return native;
      }
    }
    return git;
  }
  throw new Error('Graphify could not find Git on the application PATH.');
}

async function localObjectStore(common: string, signal: AbortSignal): Promise<string> {
  const objects = path.join(common, 'objects');
  if (!(await fs.lstat(objects)).isDirectory()) throw new Error(INVALID_REPO);
  const info = await lstat(path.join(objects, 'info'));
  if (info && (!info.isDirectory() || await lstat(path.join(objects, 'info', 'alternates')))) throw new Error(INVALID_REPO);
  // Git may read loose objects (including delta bases) and pack/index sidecars without asking us.
  // Refuse indirections in those lookup areas before handing the store to Git. Disable optional
  // readers for the commit-graph and multi-pack index in the private config.
  let count = 0;
  const check = (): void => {
    signal.throwIfAborted();
    if (++count > MAX_ENTRIES) throw new Error('Graphify Git object store has too many entries.');
  };
  for await (const dir of await fs.opendir(objects)) {
    check();
    if (!/^(?:[a-f0-9]{2}|pack)$/i.test(dir.name)) continue;
    if (!dir.isDirectory()) throw new Error(INVALID_REPO);
    for await (const file of await fs.opendir(path.join(objects, dir.name))) {
      check();
      if (!file.isFile() && !(dir.name === 'pack' && file.name === 'multi-pack-index.d' && file.isDirectory())) throw new Error(INVALID_REPO);
    }
  }
  return objects;
}

type RunGit = (args: string[], maxBytes: number, input?: string | Buffer, allowMissingConfigKeys?: boolean) => Promise<Buffer>;
async function withGit<T>(repo: Checkout, revision: string, signal: AbortSignal, use: (git: RunGit) => Promise<T>): Promise<T> {
  const git = await gitExecutable(repo, signal);
  const tempRoot = absolute(await fs.realpath(os.tmpdir()));
  if (withinCheckout(repo, tempRoot)) throw new Error(INVALID_REPO);
  signal.throwIfAborted();
  const work = await fs.mkdtemp(path.join(tempRoot, 'vocs-graph-git-'));
  try {
    const objects = await localObjectStore(repo.common, signal);
    const env: NodeJS.ProcessEnv = {
      ...(WIN ? { SystemRoot: process.env.SystemRoot } : {}),
      PATH: path.dirname(git), HOME: work, USERPROFILE: work, XDG_CONFIG_HOME: work, LC_ALL: 'C',
      GIT_DIR: work, GIT_OBJECT_DIRECTORY: objects, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'no-config'),
      GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0', GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0'
    };
    const run: RunGit = (args, cap, input, allowMissingConfigKeys = false) => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(git, ['--no-pager', ...args], {
        cwd: work, env, signal, killSignal: 'SIGKILL', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
      });
      let failure: Error | undefined;
      let length = 0;
      const chunks: Buffer[] = [];
      const closePipes = (): void => { child.stdin.destroy(); child.stdout.destroy(); };
      child.stdout.on('data', (chunk: Buffer) => {
        if (length + chunk.length > cap) {
          failure = new Error('Graphify Git response exceeds its byte limit.');
          closePipes();
          child.kill('SIGKILL');
          return;
        }
        length += chunk.length;
        chunks.push(chunk);
      });
      child.on('error', () => {
        failure ??= new Error('Graphify could not run Git.');
        closePipes();
      });
      child.on('close', (code) => {
        if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code === 0 || (allowMissingConfigKeys && code === 1 && length === 0)) resolve(Buffer.concat(chunks, length));
        else reject(new Error('Graphify could not read the requested commit from the local Git object store.'));
      });
      child.stdin.on('error', () => { /* Git can exit without consuming stdin. */ });
      child.stdin.end(input);
    });

    // Parse only identity/format keys from bounded config data, with includes explicitly disabled.
    // The config is never installed in the Git view; no directives can select readers or paths.
    for (const base of [path.join(repo.common, 'config'), path.join(repo.gitDir, 'config.worktree')]) {
      const data = await readSmall(base, 64 * 1024, signal);
      if (!data) continue;
      const keys = await run(['config', '--file', '-', '--no-includes', '--null', '--get-regexp',
        '^(core\\.(bare|worktree|repositoryformatversion)|extensions\\.(objectformat|refstorage))$'], 64 * 1024, data, true);
      for (const key of keys.toString().toLowerCase().split('\0').filter(Boolean)) {
        if (/^core\.bare\n(?:false|no|0|off)$/.test(key) || /^core\.repositoryformatversion\n[01]$/.test(key)
          || key === 'extensions.refstorage\nfiles' || key === `extensions.objectformat\n${revision.length === 64 ? 'sha256' : 'sha1'}`) continue;
        throw new Error(INVALID_REPO);
      }
    }
    const format = revision.length === 64 ? '1\n[extensions]\n\tobjectFormat = sha256' : '0';
    await fs.mkdir(path.join(work, 'refs'));
    await fs.writeFile(path.join(work, 'HEAD'), 'ref: refs/heads/graph-snapshot\n');
    await fs.writeFile(path.join(work, 'config'), `[core]\n\tbare = true\n\tcommitGraph = false\n\tmultiPackIndex = false\n\trepositoryFormatVersion = ${format}\n[protocol]\n\tallow = never\n`);
    if ((await run(['cat-file', '-t', revision], 64)).toString('ascii') !== 'commit\n') throw new Error('Graphify requires a full Git commit ID.');
    return await use(run);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

interface CheckoutStamp { revision: string; commonDir: string }

async function probeHead(cwd: string, verify: boolean, signal?: AbortSignal): Promise<CheckoutStamp | null> {
  const budget = deadline(HEAD_MS, signal);
  try {
    budget.throwIfAborted();
    const repo = await checkout(cwd, budget);
    const head = await readHead(repo, budget);
    const commit = verify && head ? await withGit(repo, head, budget, async () => head) : head;
    budget.throwIfAborted();
    return commit ? { revision: commit, commonDir: repo.common } : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/** A verified commit ID, or null for an unavailable, unborn or unsupported checkout. */
export async function graphHead(cwd: string, signal?: AbortSignal): Promise<string | null> {
  return (await probeHead(cwd, true, signal))?.revision ?? null;
}

/** Physical checkout identity and freshness hint, without an object-store walk, subprocess or writes. */
export function graphCheckoutStamp(cwd: string, signal?: AbortSignal): Promise<CheckoutStamp | null> {
  return probeHead(cwd, false, signal);
}

export async function graphHeadStamp(cwd: string, signal?: AbortSignal): Promise<string | null> {
  return (await graphCheckoutStamp(cwd, signal))?.revision ?? null;
}

interface Entry { parts: string[]; oid: string; size: number }
function selectCode(tree: Buffer, width: number): Entry[] {
  let count = 0, bytes = 0;
  const entries: Entry[] = [];
  const names = new Map<string, string>();
  for (let start = 0; start < tree.length;) {
    const end = tree.indexOf(0, start);
    const tab = tree.indexOf(9, start);
    if (end < 0 || tab < start || tab >= end) throw new Error('Invalid Graphify Git tree response.');
    if (++count > MAX_ENTRIES) throw new Error('Graphify Git tree has too many entries.');
    const metadata = tree.toString('ascii', start, tab);
    const raw = tree.subarray(tab + 1, end);
    start = end + 1;
    if (!/^(?:100644|100755) blob /.test(metadata)) continue;
    if (!isUtf8(raw)) continue; // Git also allows filenames that are not representable as UTF-8.
    const name = UTF8.decode(raw);
    if (!CODE.test(name)) continue;
    const parts = name.split('/');
    if (parts.some((part) => part === '.' || part === '..')) throw new Error('Graphify Git tree has an unsafe code path.');
    if (parts.some((part) => part.startsWith('.')) || parts.slice(0, -1).some((part) => OUTPUT_DIRS.has(part.toLowerCase()))
      || /\.(?:min|bundle)\.[cm]?js$/i.test(name)) continue;
    if (!parts.every(safePart)) throw new Error('Graphify Git tree has an unsafe code path.');
    if (raw.length > 512 || parts.length > 24 || parts.some((part) => Buffer.byteLength(part) > 255)) continue;
    const [, , oid, sizeText] = metadata.split(/ +/);
    if (!oid || !OID.test(oid) || oid.length !== width || !/^\d+$/.test(sizeText ?? '')) {
      throw new Error('Graphify could not read a code blob from the local Git object store.');
    }
    const size = Number(sizeText);
    if (!size || size > MAX_FILE_BYTES) continue;
    if (entries.length >= MAX_FILES || bytes + size > MAX_CODE_BYTES) throw new Error('Graphify committed code exceeds its file or byte limit.');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix += `/${parts[i]}`;
      const key = prefix.normalize('NFC').toUpperCase();
      const value = i === parts.length - 1 ? `${prefix}\0` : prefix;
      if (names.has(key) && (names.get(key) !== value || i === parts.length - 1)) throw new Error('Graphify Git tree has colliding code paths.');
      names.set(key, value);
    }
    entries.push({ parts, oid, size });
    bytes += size;
  }
  return entries;
}

/**
 * Stage UTF-8 regular source blobs below one private, empty directory outside the checkout.
 * Skips hidden paths (including .vocs-code), build/dependency outputs, minified JS, binary and LFS
 * pointer files, and files above 1 MiB. Sizes, names (512 bytes / 24 components), count and wall
 * time are deliberately bounded. No eligible files is a successful empty snapshot. On rejection
 * (including cancellation), the caller must discard the staging directory, not index it.
 */
export async function snapshotCommittedCode(cwd: string, revision: string, destination: string, signal?: AbortSignal): Promise<void> {
  const budget = deadline(SNAPSHOT_MS, signal);
  budget.throwIfAborted();
  if (!OID.test(revision)) throw new Error('Graphify requires a full Git commit ID.');
  const repo = await checkout(cwd, budget);
  const target = await physicalDir(destination, budget);
  if (withinCheckout(repo, target)) throw new Error('Graphify staging must be outside the checkout.');
  const staging = await fs.opendir(target);
  try {
    if (await staging.read()) throw new Error('Graphify staging must be empty.');
  } finally {
    await staging.close();
  }
  await withGit(repo, revision, budget, async (git) => {
    const entries = selectCode(await git(['ls-tree', '-r', '-z', '-l', '--full-tree', revision], MAX_TREE_BYTES), revision.length);
    if (!entries.length) return;
    const blobs = await git(['cat-file', '--batch'], MAX_CODE_BYTES + MAX_FILES * 96,
      entries.map(({ oid }) => `${oid}\n`).join(''));
    const dirs = new Set<string>();
    let offset = 0;
    for (const { parts, oid, size } of entries) {
      budget.throwIfAborted();
      const header = Buffer.from(`${oid} blob ${size}\n`);
      if (!blobs.subarray(offset, offset + header.length).equals(header)) throw new Error('Invalid Graphify Git blob response.');
      offset += header.length;
      const body = blobs.subarray(offset, offset + size);
      offset += size;
      if (blobs[offset++] !== 10) throw new Error('Incomplete Graphify Git blob response.');
      if (body.includes(0) || !isUtf8(body) || body.subarray(0, LFS_MARKER.length).equals(LFS_MARKER)) continue;
      let dir = target;
      for (const part of parts.slice(0, -1)) {
        dir = path.join(dir, part);
        if (!dirs.has(dir)) {
          await fs.mkdir(dir, { mode: 0o700 });
          dirs.add(dir);
        }
      }
      await fs.writeFile(path.join(dir, parts.at(-1)!), body, { flag: 'wx', mode: 0o600, signal: budget });
    }
    if (offset !== blobs.length) throw new Error('Invalid Graphify Git blob response.');
  });
  budget.throwIfAborted();
}
