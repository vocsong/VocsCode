/** Recognition and workspace resolution for file mentions in transcripts. */
import { describe, expect, it } from 'vitest';
import { parseFileRef, workspaceRelativePath } from '../src/renderer/src/file-refs';

describe('parseFileRef', () => {
  it('accepts relative, absolute and Windows paths', () => {
    expect(parseFileRef('src/renderer/src/store.ts')).toEqual({ path: 'src/renderer/src/store.ts' });
    expect(parseFileRef('./src/renderer/src/store.ts')).toEqual({ path: 'src/renderer/src/store.ts' });
    expect(parseFileRef('G:\\Vocs-Code\\src\\main\\handlers.ts')).toEqual({ path: 'G:/Vocs-Code/src/main/handlers.ts' });
    expect(parseFileRef('C:/proj/src/app.tsx')).toEqual({ path: 'C:/proj/src/app.tsx' });
    expect(parseFileRef('/workspace/src/foo.ts')).toEqual({ path: '/workspace/src/foo.ts' });
  });

  it('accepts bare project filenames, dotfiles and known extension-less files', () => {
    expect(parseFileRef('package.json')).toEqual({ path: 'package.json' });
    expect(parseFileRef('README.md')).toEqual({ path: 'README.md' });
    expect(parseFileRef('Dockerfile')).toEqual({ path: 'Dockerfile' });
    expect(parseFileRef('.gitignore')).toEqual({ path: '.gitignore' });
    expect(parseFileRef('archive.tar.gz')).toEqual({ path: 'archive.tar.gz' });
  });

  it('keeps a line suffix separate from the path', () => {
    expect(parseFileRef('src/main/handlers.ts:136')).toEqual({ path: 'src/main/handlers.ts', line: 136 });
    expect(parseFileRef('src/main/handlers.ts:136:7')).toEqual({ path: 'src/main/handlers.ts', line: 136 });
    expect(parseFileRef('src/main/handlers.ts#L136')).toEqual({ path: 'src/main/handlers.ts', line: 136 });
    expect(parseFileRef('G:\\proj\\src\\foo.ts:12')).toEqual({ path: 'G:/proj/src/foo.ts', line: 12 });
  });

  it('marks a trailing slash as a directory reference', () => {
    expect(parseFileRef('src/main/harness/')).toEqual({ path: 'src/main/harness/' });
  });

  it('rejects prose, URLs, product names and import specifiers', () => {
    for (const text of [
      'npm run build',
      'https://example.com/src/foo.ts',
      'example.com',
      'node.js',
      'Next.js',
      '@shared/types',
      '@scope/pkg/index.ts',
      '1.2.3',
      'v1.0.3',
      'src/main/harness',
      '*.tsx',
      'foo(bar).ts',
      'src/foo.ts:',
      '~/proj/foo.ts',
      '--watch'
    ]) {
      expect(parseFileRef(text), text).toBeNull();
    }
  });
});

describe('workspaceRelativePath', () => {
  it('passes relative mentions through, normalised', () => {
    expect(workspaceRelativePath('G:/proj', 'src/foo.ts')).toBe('src/foo.ts');
    expect(workspaceRelativePath('G:/proj', './src/foo.ts')).toBe('src/foo.ts');
  });

  it('strips the session cwd from absolute mentions, matching Windows case-insensitively', () => {
    expect(workspaceRelativePath('G:/proj', 'G:\\proj\\src\\foo.ts')).toBe('src/foo.ts');
    expect(workspaceRelativePath('g:/proj', 'G:/PROJ/src/foo.ts')).toBe('src/foo.ts');
    expect(workspaceRelativePath('G:/proj', 'G:/proj')).toBe('');
  });

  it('reads a leading slash on a Windows cwd as workspace-relative', () => {
    expect(workspaceRelativePath('G:/proj/a', '/src/foo.ts')).toBe('src/foo.ts');
    expect(workspaceRelativePath('G:/', '/src/foo.ts')).toBe('src/foo.ts');
  });

  it('resolves POSIX absolute mentions, including a cwd of the filesystem root', () => {
    expect(workspaceRelativePath('/workspace', '/workspace/src/foo.ts')).toBe('src/foo.ts');
    expect(workspaceRelativePath('/', '/src/foo.ts')).toBe('src/foo.ts');
  });

  it('refuses mentions outside the workspace', () => {
    expect(workspaceRelativePath('G:/proj', 'G:/other/foo.ts')).toBeNull();
    expect(workspaceRelativePath('G:/proj', '../foo.ts')).toBeNull();
    expect(workspaceRelativePath('/workspace', '/other/foo.ts')).toBeNull();
  });
});
