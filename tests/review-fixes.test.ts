import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { gateAction, isOutsideWorkspace } from '../src/main/harness/permissions';
import { globToRegExp } from '../src/main/harness/native/tools';
import { parseUnifiedDiff } from '../src/shared/diff-parse';

describe('permission gate hardening', () => {
  it('never auto-approves a dangerous command below full access, even with a session grant', () => {
    expect(gateAction('ask', { mutating: true, isEdit: false, command: 'rm -rf /tmp/x', sessionAllowed: true })).toBe('ask');
    expect(gateAction('auto', { mutating: true, isEdit: false, command: 'git push --force', sessionAllowed: true })).toBe('ask');
    expect(gateAction('accept-edits', { mutating: true, isEdit: false, command: 'sudo apt install x', sessionAllowed: true })).toBe('ask');
    expect(gateAction('full-auto', { mutating: true, isEdit: false, command: 'rm -rf /', sessionAllowed: false })).toBe('allow');
    expect(gateAction('ask', { mutating: true, isEdit: false, command: 'npm test', sessionAllowed: true })).toBe('allow');
  });
  it('asks for edits outside the workspace unless full access', () => {
    expect(gateAction('accept-edits', { mutating: true, isEdit: true, outsideWorkspace: true })).toBe('ask');
    expect(gateAction('auto', { mutating: true, isEdit: true, outsideWorkspace: true })).toBe('ask');
    expect(gateAction('accept-edits', { mutating: true, isEdit: true, outsideWorkspace: false })).toBe('allow');
    expect(gateAction('full-auto', { mutating: true, isEdit: true, outsideWorkspace: true })).toBe('allow');
  });
  it('detects paths outside the workspace on Windows and POSIX', () => {
    const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj';
    expect(isOutsideWorkspace(cwd, 'src/a.ts', path)).toBe(false);
    expect(isOutsideWorkspace(cwd, '../other/a.ts', path)).toBe(true);
    expect(isOutsideWorkspace(cwd, process.platform === 'win32' ? 'C:\\Windows\\x.txt' : '/etc/passwd', path)).toBe(true);
    expect(isOutsideWorkspace(cwd, undefined, path)).toBe(false);
  });
});

describe('glob trailing **', () => {
  it('matches everything below a directory', () => {
    const re = globToRegExp('src/**');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/x/y/z.tsx')).toBe(true);
    expect(re.test('lib/a.ts')).toBe(false);
  });
});

describe('diff parser hunk counting', () => {
  it('keeps removed lines that start with --- inside the hunk', () => {
    const diff = ['diff --git a/doc.yaml b/doc.yaml', '--- a/doc.yaml', '+++ b/doc.yaml', '@@ -1,3 +1,2 @@', ' title: x', '--- separator', '+++ new marker', ' end'].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const types = files[0].hunks[0].lines.map((l) => l.type);
    expect(types).toEqual(['ctx', 'del', 'add', 'ctx']);
    expect(files[0].hunks[0].lines[1].text).toBe('-- separator');
  });
  it('still splits consecutive files', () => {
    const diff = ['--- a.txt', '+++ a.txt', '@@ -1 +1 @@', '-x', '+y', '--- b.txt', '+++ b.txt', '@@ -1 +1 @@', '-p', '+q'].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.newPath)).toEqual(['a.txt', 'b.txt']);
  });
});
