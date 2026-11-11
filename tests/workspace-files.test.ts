/** Tests for workspace-scoped listing and bounded file reads. */
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceFiles, MAX_IMAGE_BYTES, readWorkspaceFile, readWorkspaceImage, resolveWorkspaceFile } from '../src/main/workspace-files';
import { createHandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import type { SessionMeta } from '../src/shared/types';
import { missionFixture } from './support/mission-fixture';

const tempDirs: string[] = [];

function workspace(): { container: string; root: string; sibling: string } {
  const container = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-workspace-files-'));
  tempDirs.push(container);
  return {
    container,
    root: path.join(container, 'proj'),
    sibling: path.join(container, 'proj2'),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('listWorkspaceFiles', () => {
  it('lists the root and nested directories with sizes and directory-first name sorting', async () => {
    const { root } = workspace();
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, 'alpha-dir'));
    await fs.writeFile(path.join(root, 'zeta.txt'), 'zeta');
    await fs.writeFile(path.join(root, 'beta.txt'), 'be');
    await fs.writeFile(path.join(root, 'nested', 'inner.txt'), 'inside');

    await expect(listWorkspaceFiles(root)).resolves.toEqual([
      { name: 'alpha-dir', path: 'alpha-dir', isDir: true, size: undefined },
      { name: 'nested', path: 'nested', isDir: true, size: undefined },
      { name: 'beta.txt', path: 'beta.txt', isDir: false, size: 2 },
      { name: 'zeta.txt', path: 'zeta.txt', isDir: false, size: 4 },
    ]);
    await expect(listWorkspaceFiles(root, path.join('nested'))).resolves.toEqual([
      { name: 'inner.txt', path: path.join('nested', 'inner.txt'), isDir: false, size: 6 },
    ]);
    await expect(listWorkspaceFiles(root, root)).resolves.toHaveLength(4);
  });

  it('rejects traversal, absolute outside paths, and sibling-prefix paths', async () => {
    const { root, sibling } = workspace();
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'outside.txt'), 'outside');

    await expect(listWorkspaceFiles(root, '..')).resolves.toEqual([]);
    await expect(listWorkspaceFiles(root, path.join('..', 'proj2'))).resolves.toEqual([]);
    await expect(listWorkspaceFiles(root, sibling)).resolves.toEqual([]);
  });

  it('rejects directory links that resolve outside the workspace', async () => {
    const { root, sibling } = workspace();
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'outside.txt'), 'outside');
    await fs.symlink(sibling, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(listWorkspaceFiles(root, 'outside-link')).resolves.toEqual([]);
    await expect(readWorkspaceFile(root, path.join('outside-link', 'outside.txt'))).resolves.toEqual({ content: '', truncated: false });
  });
});

describe('readWorkspaceFile', () => {
  it('rejects absolute and traversing reads outside the workspace', async () => {
    const { root, sibling } = workspace();
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling);
    const outside = path.join(sibling, 'outside.txt');
    await fs.writeFile(outside, 'outside');

    await expect(readWorkspaceFile(root, outside)).resolves.toEqual({ content: '', truncated: false });
    await expect(readWorkspaceFile(root, path.join('..', 'proj2', 'outside.txt'))).resolves.toEqual({ content: '', truncated: false });
  });

  it('returns only the bounded UTF-8 prefix and reports truncation', async () => {
    const { root } = workspace();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'sample.txt'), 'abcdefgh');

    await expect(readWorkspaceFile(root, 'sample.txt', 3)).resolves.toEqual({ content: 'abc', truncated: true });
    await expect(readWorkspaceFile(root, 'sample.txt', 20)).resolves.toEqual({ content: 'abcdefgh', truncated: false });
  });

  it('names a missing file and the folder it was looked for in, not the realpath error', async () => {
    const { root } = workspace();
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    const where = path.resolve(root);

    // A reply named a bundle that lives in another repository, so the session folder has no such file.
    await expect(readWorkspaceFile(root, 'SideGuard-Q-2026-10.zip')).rejects.toThrow(new Error(`SideGuard-Q-2026-10.zip was not found in ${where}`));
    await expect(readWorkspaceFile(root, path.join('docs', 'gone.md'))).rejects.toThrow(new Error(`docs/gone.md was not found in ${where}`));
    await expect(readWorkspaceImage(root, 'gone.png')).rejects.toThrow(new Error(`gone.png was not found in ${where}`));
    await expect(listWorkspaceFiles(root, 'nope')).rejects.toThrow(new Error(`nope was not found in ${where}`));
  });

  it('says the session folder itself is gone rather than blaming the file', async () => {
    const { root } = workspace();

    await expect(readWorkspaceFile(root, 'a.txt')).rejects.toThrow(new Error(`${path.resolve(root)} no longer exists`));
  });

  it('flags binary content instead of decoding it as text', async () => {
    const { root } = workspace();
    await fs.mkdir(root, { recursive: true });
    // A zip's local file header: the NULs a UTF-8 decode would turn into noise.
    await fs.writeFile(path.join(root, 'bundle.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]));
    await fs.writeFile(path.join(root, 'notes.txt'), 'plain text');

    await expect(readWorkspaceFile(root, 'bundle.zip')).resolves.toEqual({ content: '', truncated: false, binary: true });
    await expect(readWorkspaceFile(root, 'notes.txt')).resolves.toEqual({ content: 'plain text', truncated: false });
  });

  it('honors a zero-byte maximum', async () => {
    const { root } = workspace();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'sample.txt'), 'content');

    await expect(readWorkspaceFile(root, 'sample.txt', 0)).resolves.toEqual({ content: '', truncated: true });
  });

  it('defaults to 400,000 bytes and clamps the maximum to 2,000,000 bytes', async () => {
    const { root } = workspace();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'default.txt'), 'a'.repeat(400_001));
    await fs.writeFile(path.join(root, 'clamped.txt'), 'b'.repeat(2_000_001));

    const defaultRead = await readWorkspaceFile(root, 'default.txt');
    expect(defaultRead.content).toHaveLength(400_000);
    expect(defaultRead.truncated).toBe(true);

    const clampedRead = await readWorkspaceFile(root, 'clamped.txt', 3_000_000);
    expect(clampedRead.content).toHaveLength(2_000_000);
    expect(clampedRead.truncated).toBe(true);
  });
});

describe('readWorkspaceImage', () => {
  // A 1x1 transparent PNG: real image bytes that a UTF-8 decode would mangle.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  it('returns the exact bytes as base64 with the MIME type of the extension', async () => {
    const { root } = workspace();
    await fs.mkdir(path.join(root, 'runs'), { recursive: true });
    await fs.writeFile(path.join(root, 'runs', 'chart.PNG'), PNG);

    const image = await readWorkspaceImage(root, path.join('runs', 'chart.PNG'));
    expect(image).toEqual({ mimeType: 'image/png', data: PNG.toString('base64'), size: PNG.length, tooLarge: false });
    expect(Buffer.from(image!.data, 'base64').equals(PNG)).toBe(true);
  });

  it('refuses non-image paths and images outside the workspace', async () => {
    const { root, sibling } = workspace();
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(root, 'notes.txt'), 'text');
    await fs.writeFile(path.join(sibling, 'outside.png'), PNG);

    await expect(readWorkspaceImage(root, 'notes.txt')).resolves.toBeNull();
    await expect(readWorkspaceImage(root, path.join('..', 'proj2', 'outside.png'))).resolves.toBeNull();
    await expect(readWorkspaceImage(root, path.join(sibling, 'outside.png'))).resolves.toBeNull();
  });

  it('reports an image over the cap without sending its bytes', async () => {
    const { root } = workspace();
    await fs.mkdir(root, { recursive: true });
    const big = path.join(root, 'huge.png');
    await fs.writeFile(big, PNG);
    await fs.truncate(big, MAX_IMAGE_BYTES + 1);

    await expect(readWorkspaceImage(root, 'huge.png')).resolves.toEqual({ mimeType: 'image/png', data: '', size: MAX_IMAGE_BYTES + 1, tooLarge: true });
  });
});


describe('resolveWorkspaceFile', () => {
  async function put(root: string, name: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), name);
  }

  it('prefers the exact regular file, including files in skipped directories', async () => {
    const { root } = workspace();
    await put(root, 'notes.md');
    await put(root, 'docs/notes.md');
    await put(root, 'node_modules/pkg/notes.md');
    const scan = vi.spyOn(fs, 'opendir');
    await expect(resolveWorkspaceFile(root, 'notes.md')).resolves.toEqual({ status: 'resolved', path: 'notes.md' });
    await expect(resolveWorkspaceFile(root, 'node_modules/pkg/notes.md')).resolves.toEqual({ status: 'resolved', path: 'node_modules/pkg/notes.md' });
    expect(scan).not.toHaveBeenCalled();
  });

  it('matches component suffixes and bare basenames, never discarding supplied directories', async () => {
    const { root } = workspace();
    await put(root, 'src/api/tools.ts');
    await put(root, 'src/notapi/tools.ts');
    await expect(resolveWorkspaceFile(root, 'api/tools.ts')).resolves.toEqual({ status: 'resolved', path: 'src/api/tools.ts' });
    await expect(resolveWorkspaceFile(root, 'missing/tools.ts')).resolves.toEqual({ status: 'missing' });
    await expect(resolveWorkspaceFile(root, 'tools.ts')).resolves.toEqual({ status: 'ambiguous', paths: ['src/api/tools.ts', 'src/notapi/tools.ts'] });
    await expect(resolveWorkspaceFile(root, 'Tools.ts')).resolves.toEqual(process.platform === 'win32'
      ? { status: 'ambiguous', paths: ['src/api/tools.ts', 'src/notapi/tools.ts'] }
      : { status: 'missing' });
    await expect(resolveWorkspaceFile(root, 'API/TOOLS.ts')).resolves.toEqual(process.platform === 'win32'
      ? { status: 'resolved', path: 'src/api/tools.ts' }
      : { status: 'missing' });
    await put(root, 'nested/unique.md');
    await expect(resolveWorkspaceFile(root, 'unique.md')).resolves.toEqual({ status: 'resolved', path: 'nested/unique.md' });
  });

  it('skips generated/dependency trees and never resolves directories', async () => {
    const { root } = workspace();
    for (const dir of ['.git', '.vocs-code', 'node_modules', 'dist', 'out', 'build', '.next', '.venv', 'venv', 'target']) await put(root, `${dir}/hidden.ts`);
    await fs.mkdir(path.join(root, 'nested', 'directory.ts'), { recursive: true });
    await expect(resolveWorkspaceFile(root, 'hidden.ts')).resolves.toEqual({ status: 'missing' });
    await expect(resolveWorkspaceFile(root, 'directory.ts')).resolves.toEqual({ status: 'missing' });
    await put(root, 'other/nested/file.md');
    await fs.mkdir(path.join(root, 'nested', 'file.md'));
    await expect(resolveWorkspaceFile(root, 'nested/file.md')).resolves.toEqual({ status: 'missing' });
  });

  it('rejects malformed and unsafe paths before accessing the filesystem', async () => {
    const realpath = vi.spyOn(fs, 'realpath');
    const stat = vi.spyOn(fs, 'lstat');
    for (const target of [null, undefined, {}, [], 42, '', ' ', '/etc/passwd', '../file', 'a/../file', 'a/..', 'C:/file', 'C:file', String.raw`\\host\share`, 'a\u0000b', 'a\nb', 'a\u007fb', 'https://host/file', 'a:b', 'a?b']) {
      await expect(resolveWorkspaceFile('/unused', target as string)).rejects.toThrow();
    }
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('searches only the current worktree, not its project or sibling worktrees', async () => {
    const { root } = workspace();
    const cwd = path.join(root, '.vocs-code', 'worktrees', 'current');
    await put(root, 'src/project-only.ts');
    await put(path.join(root, '.vocs-code', 'worktrees', 'other'), 'src/sibling-only.ts');
    await put(cwd, 'src/current.ts');
    await expect(resolveWorkspaceFile(cwd, 'project-only.ts')).resolves.toEqual({ status: 'missing' });
    await expect(resolveWorkspaceFile(cwd, 'sibling-only.ts')).resolves.toEqual({ status: 'missing' });
    await expect(resolveWorkspaceFile(cwd, 'current.ts')).resolves.toEqual({ status: 'resolved', path: 'src/current.ts' });
  });

  it('allows safe exact symlinks but never follows links during fallback or falls back after escape', async () => {
    const { root, sibling } = workspace();
    await put(root, 'actual/inside.md');
    await put(root, 'actual/outside.md');
    await put(root, 'actual/missing.md');
    await put(sibling, 'outside.md');
    await fs.symlink(path.join(root, 'actual', 'inside.md'), path.join(root, 'alias.md'), 'file');
    await fs.symlink(sibling, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(sibling, 'outside.md'), path.join(root, 'outside.md'), 'file');
    await fs.symlink(path.join(root, 'actual'), path.join(root, 'safe-dir'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.mkdir(path.join(root, 'links'));
    await fs.symlink(path.join(root, 'actual', 'inside.md'), path.join(root, 'links', 'fallback.md'), 'file');
    await fs.symlink(path.join(root, 'gone.md'), path.join(root, 'dangling.md'), 'file');
    await put(root, 'actual/dangling.md');
    await expect(resolveWorkspaceFile(root, 'alias.md')).resolves.toEqual({ status: 'resolved', path: 'alias.md' });
    await expect(resolveWorkspaceFile(root, 'safe-dir/inside.md')).resolves.toEqual({ status: 'resolved', path: 'safe-dir/inside.md' });
    await expect(resolveWorkspaceFile(root, 'inside.md')).resolves.toEqual({ status: 'resolved', path: 'actual/inside.md' });
    await expect(resolveWorkspaceFile(root, 'outside.md')).rejects.toThrow(/outside workspace/i);
    await expect(resolveWorkspaceFile(root, 'escape/missing.md')).rejects.toThrow(/outside workspace/i);
    await expect(resolveWorkspaceFile(root, 'safe-dir/missing-other.md')).resolves.toEqual({ status: 'missing' });
    await expect(resolveWorkspaceFile(root, 'absent/alias.md')).resolves.toEqual({ status: 'missing' });
    await expect(resolveWorkspaceFile(root, 'fallback.md')).resolves.toEqual({ status: 'missing' });
    await expect(resolveWorkspaceFile(root, 'dangling.md')).resolves.toEqual({ status: 'missing' });
  });

  it('preserves missing-root and non-ENOENT exact errors without scanning', async () => {
    const { root } = workspace();
    await expect(resolveWorkspaceFile(root, 'file.md')).rejects.toThrow(`${path.resolve(root)} no longer exists`);
    await put(root, 'blocker');
    const scan = vi.spyOn(fs, 'opendir');
    await expect(resolveWorkspaceFile(root, 'blocker/file.md')).rejects.toMatchObject({ code: 'ENOTDIR' });
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'lstat').mockRejectedValue(denied);
    await expect(resolveWorkspaceFile(root, 'file.md')).rejects.toBe(denied);
    expect(scan).not.toHaveBeenCalled();
  });

  it('reports incomplete on any unreadable subtree instead of declaring a unique match', async () => {
    const { root } = workspace();
    await put(root, 'readable/unique.md');
    await fs.mkdir(path.join(root, 'unreadable'));
    const original = fs.opendir.bind(fs);
    vi.spyOn(fs, 'opendir').mockImplementation((async (dir: string) => {
      if (String(dir).endsWith('unreadable')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(dir);
    }) as typeof fs.opendir);
    await expect(resolveWorkspaceFile(root, 'unique.md')).resolves.toEqual({ status: 'incomplete' });
  });

  it('bounds visited entries and matches without expensive filesystem fixtures', async () => {
    const { root } = workspace();
    await fs.mkdir(root, { recursive: true });
    let visited = 0;
    let matches = false;
    vi.spyOn(fs, 'opendir').mockImplementation((async () => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 50_001; i++) {
          visited++;
          yield { name: matches || i === 0 ? 'hit.md' : `${i}.md`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
        }
      }
    })) as unknown as typeof fs.opendir);
    await expect(resolveWorkspaceFile(root, 'hit.md')).resolves.toEqual({ status: 'incomplete' });
    expect(visited).toBe(50_001);
    matches = true;
    visited = 0;
    await expect(resolveWorkspaceFile(root, 'hit.md')).resolves.toEqual({ status: 'incomplete' });
    expect(visited).toBe(100);
  });

  it('validates the registered IPC payload before scoped filesystem access and uses session cwd', async () => {
    const { root, sibling } = workspace();
    await put(root, 'nested/current.md');
    await put(sibling, 'project-only.md');
    const get = vi.fn(() => ({ id: 'session', cwd: root, config: { projectRoot: sibling } } as SessionMeta));
    const registry = createHandlerRegistry({ sessions: { get }, desktop: {}, runtime: {}, log: vi.fn(), push: vi.fn() } as unknown as HandlerDeps);
    const realpath = vi.spyOn(fs, 'realpath');
    for (const input of [null, [], {}, { sessionId: 'session', path: 4 }, { sessionId: 'session', path: '../file' }, { sessionId: '../bad', path: 'file' }, { sessionId: 'session', path: 'file', missionWorkspaceId: 4 }, { sessionId: 'session', path: 'file', missionWorkspaceId: '../bad' }, { sessionId: 'session', path: 'file', cwd: sibling }]) {
      await expect(registry.invoke('fs:resolve', input)).rejects.toThrow();
    }
    expect(realpath).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    await expect(registry.invoke('fs:resolve', { sessionId: 'session', path: 'current.md' })).resolves.toEqual({ status: 'resolved', path: 'nested/current.md' });
    await expect(registry.invoke('fs:resolve', { sessionId: 'session', path: 'project-only.md' })).resolves.toEqual({ status: 'missing' });
    await expect(registry.invoke('fs:resolve', { sessionId: 'session', path: 'current.md', missionWorkspaceId: 'unowned' })).rejects.toThrow(/owning Mission lead/);
    await registry.shutdown();
  });

  it('resolves Mission leads against integration by default and honors an explicit owned workspace', async () => {
    const { root, sibling } = workspace();
    await put(root, 'lead/selected.md');
    await put(sibling, 'integration/selected.md');
    const leadPath = await fs.realpath(root);
    const integrationPath = await fs.realpath(sibling);
    const session = { id: 'lead', cwd: leadPath, config: { projectRoot: leadPath }, mission: { missionId: 'mission', role: 'lead' } } as SessionMeta;
    const record = missionFixture({
      id: 'mission', leadSessionId: 'lead', workspaces: [
        { id: 'lead-workspace', role: 'lead', path: leadPath, branch: 'mission/lead', ownerSessionId: 'lead', base: { baseCommitSha: 'base', contentHash: 'tree' } },
        { id: 'integration-workspace', role: 'integration', path: integrationPath, branch: 'mission/integration', base: { baseCommitSha: 'base', contentHash: 'tree' } }
      ]
    });
    const registry = createHandlerRegistry({ sessions: { get: () => session }, missions: { get: () => record }, desktop: {}, runtime: {}, log: vi.fn(), push: vi.fn() } as unknown as HandlerDeps);
    await expect(registry.invoke('fs:resolve', { sessionId: 'lead', path: 'selected.md' })).resolves.toEqual({ status: 'resolved', path: 'integration/selected.md' });
    await expect(registry.invoke('fs:resolve', { sessionId: 'lead', path: 'selected.md', missionWorkspaceId: 'lead-workspace' })).resolves.toEqual({ status: 'resolved', path: 'lead/selected.md' });
    await expect(registry.invoke('fs:resolve', { sessionId: 'lead', path: 'selected.md', missionWorkspaceId: 'unknown' })).rejects.toThrow(/unavailable or cleaned/);
    await registry.shutdown();
  });
});
