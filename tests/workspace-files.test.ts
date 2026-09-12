/** Tests for workspace-scoped listing and bounded file reads. */
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceFiles, readWorkspaceFile } from '../src/main/workspace-files';

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
