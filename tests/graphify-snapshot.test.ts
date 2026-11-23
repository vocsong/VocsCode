/** Exercises the production snapshot adapter against disposable Git repositories, with no network. */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphHead, graphHeadStamp, snapshotCommittedCode } from '../src/main/intelligence/graph-snapshot';

const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const MiB = 1024 * 1024;
let temp: string, repo: string, stage: string;

function git(cwd: string, args: string[], input?: string | Buffer): string {
  const result = spawnSync('git', [
    '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${path.join(temp, 'no-hooks')}`, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    ...args
  ], {
    cwd, input, windowsHide: true, timeout: 10_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GCM_|SSH_ASKPASS)/i.test(key))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'no-global-config'), GIT_TERMINAL_PROMPT: '0'
    }
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr?.toString() ?? 'Fixture Git failed.');
  return result.stdout.toString().trim();
}

async function put(root: string, file: string, body: string | Buffer): Promise<void> {
  const dest = path.join(root, file);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body);
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function blob(body: string | Buffer): string {
  return git(repo, ['hash-object', '-w', '--stdin'], body);
}

function treeCommit(entries: string[]): string {
  const tree = git(repo, ['mktree', '-z'], `${entries.join('\0')}\0`);
  return git(repo, ['commit-tree', tree, '-m', 'Tree fixture']);
}

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'vocs-graph-test-'));
  repo = path.join(temp, 'repo & source');
  stage = path.join(temp, 'private stage');
  await fs.mkdir(repo);
  await fs.mkdir(stage);
  git(repo, ['init', '-b', 'fixture-main']);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
});

describe('Graphify committed snapshots', () => {
  it('stages only exact committed regular source bytes and preserves the dirty checkout, index and links', async () => {
    const source = Buffer.from('export const café = 1;\r\n');
    await put(repo, 'src/saved.ts', source);
    await put(repo, 'src/deleted.ts', 'export const stillCommitted = true;\n');
    await put(repo, 'src/space name.js', 'export const withSpaces = true;\n');
    await put(repo, '.gitattributes', 'src/saved.ts filter=graphFixture\n');
    await put(repo, '.vocs-code/session.ts', 'private memory\n');
    await put(repo, 'dist/generated.js', 'generated\n');
    await put(repo, 'graphify-out/cached.ts', 'old graph\n');
    await put(repo, 'src/vendor.min.js', 'minified\n');
    await put(repo, 'readme.md', 'not code\n');
    await put(repo, 'garbled.ts', Buffer.from([0xff, 0x00, 0xfe]));
    await put(repo, 'lfs.ts', 'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 12345\n');
    git(repo, ['add', '-A']);
    git(repo, ['update-index', '--chmod=+x', 'src/space name.js']);
    const outside = path.join(temp, 'outside');
    await put(outside, 'secret.ts', 'outside checkout\n');
    git(outside, ['init']);
    const subCommit = commit(outside, 'submodule');
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${subCommit},src/submodule`]);
    const link = blob('../outside/secret.ts');
    git(repo, ['update-index', '--add', '--cacheinfo', `120000,${link},linked.ts`]);
    git(repo, ['commit', '-m', 'base']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    await put(repo, 'src/saved.ts', 'working tree edition\n');
    await fs.unlink(path.join(repo, 'src/deleted.ts'));
    await put(repo, 'src/index-only.ts', 'staged but not committed\n');
    git(repo, ['add', 'src/index-only.ts']);
    await put(repo, 'src/untracked.ts', 'untracked edition\n');
    await put(repo, '.graphifyignore', '**\n');
    await fs.symlink(outside, path.join(repo, 'src', 'submodule'), LINK);
    // A smudging/checkout implementation would encounter this required driver and fail.
    git(repo, ['config', 'filter.graphFixture.smudge', 'false']);
    git(repo, ['config', 'filter.graphFixture.required', 'true']);
    const index = await fs.readFile(path.join(repo, '.git', 'index'));
    const indexStatus = git(repo, ['diff', '--cached', '--name-only']);

    expect(await graphHead(repo)).toBe(head);
    await snapshotCommittedCode(repo, head, stage);
    expect(await fs.readdir(stage)).toEqual(['src']);
    expect(await fs.readdir(path.join(stage, 'src'))).toEqual(['deleted.ts', 'saved.ts', 'space name.js']);
    expect(await fs.readFile(path.join(stage, 'src', 'saved.ts'))).toEqual(source);
    expect(await fs.readFile(path.join(stage, 'src', 'deleted.ts'), 'utf8')).toBe('export const stillCommitted = true;\n');
    expect(await fs.readFile(path.join(repo, 'src', 'saved.ts'), 'utf8')).toBe('working tree edition\n');
    expect(await fs.readFile(path.join(repo, 'src', 'index-only.ts'), 'utf8')).toBe('staged but not committed\n');
    expect(await fs.readFile(path.join(repo, 'src', 'untracked.ts'), 'utf8')).toBe('untracked edition\n');
    if (process.platform !== 'win32') expect((await fs.stat(path.join(stage, 'src', 'space name.js'))).mode & 0o111).toBe(0);
    expect((await fs.lstat(path.join(repo, 'src', 'submodule'))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(repo, 'src', 'submodule'))).toBe(outside);
    expect(await fs.readFile(path.join(repo, '.git', 'index'))).toEqual(index);
    expect(git(repo, ['diff', '--cached', '--name-only'])).toBe(indexStatus);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('pins the linked worktree HEAD, including packed refs and objects, not the main checkout', async () => {
    await put(repo, 'old.ts', 'old commit\n');
    const old = commit(repo, 'linked version');
    const linked = path.join(temp, 'linked checkout');
    git(repo, ['worktree', 'add', '-b', 'fixture-linked', linked, old]);
    await put(repo, 'main.ts', 'new main\n');
    const main = commit(repo, 'main advanced');
    git(repo, ['gc', '--prune=now']);
    expect(await graphHead(repo)).toBe(main);
    expect(await graphHead(linked)).toBe(old);
    expect(await graphHeadStamp(linked)).toBe(old);
    await snapshotCommittedCode(linked, old, stage);
    expect(await fs.readdir(stage)).toEqual(['old.ts']);
    const older = await fs.mkdtemp(path.join(temp, 'other-stage-'));
    await snapshotCommittedCode(repo, old, older);
    expect(await fs.readdir(older)).toEqual(['old.ts']);
    git(linked, ['checkout', '--detach', old]);
    expect(await graphHead(linked)).toBe(old);

    const forged = path.join(temp, 'copy of gitfile');
    await fs.mkdir(forged);
    await fs.copyFile(path.join(linked, '.git'), path.join(forged, '.git'));
    expect(await graphHead(forged)).toBeNull();
    expect(await graphHeadStamp(forged)).toBeNull();
  });

  it('reads a freshness stamp without Git or a writable temp root', async () => {
    await put(repo, 'nested/code.ts', 'code\n');
    const head = commit(repo, 'base');
    const missing = 'f'.repeat(40);
    const ref = path.join(repo, '.git', 'refs', 'heads', 'fixture-main');
    await fs.writeFile(ref, `${missing}\n`);
    expect(await graphHead(repo)).toBeNull(); // object verification, unlike the stamp
    expect(await graphHeadStamp(repo)).toBe(missing);
    await fs.writeFile(ref, `${head}\n`);
    for (const key of ['PATH', 'TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(key, path.join(temp, 'unavailable'));
    expect(await graphHeadStamp(repo)).toBe(head);
    expect(await graphHeadStamp(path.join(repo, 'nested'))).toBeNull();
    expect(await graphHead(repo)).toBeNull();
  });

  it('recognizes exact SHA-256 commit and blob IDs', async () => {
    const sha256 = path.join(temp, 'sha256 checkout');
    await fs.mkdir(sha256);
    git(sha256, ['init', '--object-format=sha256']);
    await put(sha256, 'source.ts', 'sha256 code\n');
    const head = commit(sha256, 'sha256');
    expect(head).toHaveLength(64);
    expect(await graphHead(sha256)).toBe(head);
    await snapshotCommittedCode(sha256, head, stage);
    expect(await fs.readFile(path.join(stage, 'source.ts'), 'utf8')).toBe('sha256 code\n');
  });

  it('denies fallback to a parent, a linked root, an arbitrary gitfile, and a bare repository', async () => {
    expect(await graphHead(repo)).toBeNull(); // unborn
    await put(repo, 'nested/code.ts', 'code\n');
    const head = commit(repo, 'parent commit');
    const alias = path.join(temp, 'alias');
    await fs.symlink(repo, alias, LINK);
    const separate = path.join(temp, 'gitfile root');
    await put(separate, '.git', `gitdir: ${path.join(repo, '.git')}\n`);
    const bare = path.join(temp, 'bare.git');
    git(temp, ['clone', '--bare', repo, bare]);
    const linkedAdmin = path.join(temp, 'linked admin');
    await fs.mkdir(linkedAdmin);
    await fs.symlink(path.join(repo, '.git'), path.join(linkedAdmin, '.git'), LINK);
    for (const cwd of [path.join(repo, 'nested'), alias, path.join(alias, 'nested'), separate, bare, linkedAdmin]) {
      expect(await graphHead(cwd)).toBeNull();
      await expect(snapshotCommittedCode(cwd, head, stage)).rejects.toThrow();
      expect(await fs.readdir(stage)).toEqual([]);
    }
  });

  it('ignores inherited Git state, project config includes, and replacement refs', async () => {
    await put(repo, 'replace.ts', 'first\n');
    const original = commit(repo, 'base');
    await put(repo, 'replace.ts', 'second\n');
    const second = commit(repo, 'new HEAD');
    git(repo, ['replace', second, original]);
    await put(temp, 'invalid.config', '[ definitely not valid Git config\n');
    git(repo, ['config', 'include.path', path.join(temp, 'invalid.config')]);
    const inherited = {
      GIT_DIR: path.join(temp, 'fake'), GIT_WORK_TREE: temp, GIT_COMMON_DIR: temp,
      GIT_CONFIG_GLOBAL: path.join(temp, 'invalid.config'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
      GIT_OBJECT_DIRECTORY: path.join(temp, 'fake'), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(temp, 'fake'),
      GIT_INDEX_FILE: path.join(temp, 'fake-index'), GIT_CONFIG_SYSTEM: path.join(temp, 'invalid.config')
    };
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
    expect(await graphHead(repo)).toBe(second);
    await snapshotCommittedCode(repo, second, stage);
    expect(await fs.readFile(path.join(stage, 'replace.ts'), 'utf8')).toBe('second\n');
  });

  it('refuses local alternates and project-provided Git executables', async () => {
    await put(repo, 'source.ts', 'local code\n');
    const head = commit(repo, 'commit');
    await put(repo, '.git/objects/info/alternates', `${path.join(temp, 'other-objects')}\n`);
    expect(await graphHead(repo)).toBeNull();
    await expect(snapshotCommittedCode(repo, head, stage)).rejects.toThrow();
    const objects = path.join(repo, '.git', 'objects');
    await fs.unlink(path.join(objects, 'info', 'alternates'));
    const shard = path.join(objects, head.slice(0, 2));
    const relocated = path.join(temp, 'relocated objects');
    await fs.rename(shard, relocated);
    await fs.symlink(relocated, shard, LINK);
    expect(await graphHead(repo)).toBeNull();
    await expect(snapshotCommittedCode(repo, head, stage)).rejects.toThrow();
    await fs.unlink(shard);
    await fs.rename(relocated, shard);
    const filename = process.platform === 'win32' ? 'git.exe' : 'git';
    await put(repo, `bin/${filename}`, 'not executable by the adapter\n');
    await fs.chmod(path.join(repo, 'bin', filename), 0o700);
    vi.stubEnv('PATH', [path.join(repo, 'bin'), 'bin', process.env.PATH].join(path.delimiter));
    expect(await graphHead(repo)).toBe(head);
    await snapshotCommittedCode(repo, head, stage);
    expect(await fs.readdir(stage)).toEqual(['source.ts']);
  });

  it.each(['CON.ts', 'LPT¹.ts', 'foo~1.ts', 'file:stream.ts', 'parent./file.ts', '../file.ts', 'Case.ts'])('rejects unsafe or colliding paths (%s) in committed trees', async (name) => {
    const code = blob('source\n');
    const record = (file: string) => `100644 blob ${code}\t${file}`;
    const [parent, leaf] = name.split('/');
    const subtree = leaf ? git(repo, ['mktree', '-z'], `${record(leaf)}\0`) : undefined;
    const head = treeCommit(subtree ? [`040000 tree ${subtree}\t${parent}`] : name === 'Case.ts' ? [record(name), record('case.ts')] : [record(name)]);
    await expect(snapshotCommittedCode(repo, head, stage)).rejects.toThrow(/unsafe|colliding/);
    expect(await fs.readdir(stage)).toEqual([]);
  });

  it('allows empty snapshots and skips over-size single files', async () => {
    await put(repo, 'large.ts', Buffer.alloc(MiB + 1, 97));
    await put(repo, 'documentation.md', 'not code\n');
    const head = commit(repo, 'no eligible source');
    await snapshotCommittedCode(repo, head, stage);
    expect(await fs.readdir(stage)).toEqual([]);
  });

  it('rejects aggregate byte and file-count overflow before writing anything', async () => {
    const large = blob(Buffer.alloc(MiB, 97));
    const small = blob('one\n');
    const make = (oid: string, count: number) => Array.from({ length: count }, (_, i) => `100644 blob ${oid}\tf${i}.ts`);
    for (const head of [treeCommit(make(large, 33)), treeCommit(make(small, 4097))]) {
      await expect(snapshotCommittedCode(repo, head, stage)).rejects.toThrow(/file or byte limit/);
      expect(await fs.readdir(stage)).toEqual([]);
    }
  });

  it('cancels an in-flight Git batch without materializing source or leaking temp metadata', async () => {
    await put(repo, 'source.ts', 'code\n');
    const head = commit(repo, 'base');
    const scratch = path.join(temp, 'scratch');
    await fs.mkdir(scratch);
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(key, scratch);
    const inFlight = new AbortController();
    const spawnEvents = channel('child_process');
    let batch: ChildProcess | undefined;
    const observe = (message: unknown): void => {
      const child = (message as { process: ChildProcess }).process;
      child.once('spawn', () => {
        if (!child.spawnargs.includes('--batch')) return;
        batch = child;
        inFlight.abort();
      });
    };
    spawnEvents.subscribe(observe);
    try {
      await expect(snapshotCommittedCode(repo, head, stage, inFlight.signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      spawnEvents.unsubscribe(observe);
    }
    expect(batch).toBeDefined();
    expect(batch!.signalCode !== null || batch!.exitCode !== null).toBe(true);
    expect(await fs.readdir(stage)).toEqual([]);
    expect(await fs.readdir(scratch)).toEqual([]);
  });

  it('rejects pre-aborts, mutable revision specs, non-commit IDs and unsafe staging', async () => {
    await put(repo, 'source.ts', 'code\n');
    const head = commit(repo, 'base');
    const original = blob('not a commit\n');
    const abort = AbortSignal.abort();
    await expect(graphHead(repo, abort)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(graphHeadStamp(repo, abort)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(snapshotCommittedCode(repo, head, stage, abort)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await fs.readdir(stage)).toEqual([]);
    for (const revision of ['HEAD', head.slice(0, 12), original, '--all']) {
      await expect(snapshotCommittedCode(repo, revision, stage)).rejects.toThrow(/commit ID/);
    }
    const inside = path.join(repo, 'empty');
    await fs.mkdir(inside);
    await expect(snapshotCommittedCode(repo, head, inside)).rejects.toThrow(/outside the checkout/);
    const alias = path.join(temp, 'stage alias');
    await fs.symlink(stage, alias, LINK);
    await expect(snapshotCommittedCode(repo, head, alias)).rejects.toThrow();
    await put(stage, 'do-not-overwrite.ts', 'existing output\n');
    await expect(snapshotCommittedCode(repo, head, stage)).rejects.toThrow(/empty/);
    expect(await fs.readFile(path.join(stage, 'do-not-overwrite.ts'), 'utf8')).toBe('existing output\n');
  });
});
