import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isIncluded, parseWorktreeInclude } from '../src/main/worktree-include';

let root = '';
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-include-patterns-'));
  const result = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Ask Git about paths without creating files (including escaped spaces and backslashes). */
async function expectGitMatches(patterns: string, names: string[]): Promise<void> {
  await fs.writeFile(path.join(root, '.gitignore'), patterns + '\n');
  const result = spawnSync('git', ['-c', 'core.excludesFile=', '-c', 'core.ignoreCase=false', 'check-ignore', '--no-index', '--stdin', '-z'], {
    cwd: root,
    env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    input: names.join('\0') + '\0',
    encoding: 'utf8'
  });
  expect([0, 1], result.stderr).toContain(result.status);
  const ignored = new Set(result.stdout.split('\0').filter(Boolean));
  const rules = parseWorktreeInclude(patterns);
  for (const name of names) expect(isIncluded(rules, name, false), `${JSON.stringify(patterns)}: ${JSON.stringify(name)}`).toBe(ignored.has(name));
}

describe('.worktreeinclude pattern compatibility with Git', () => {
  it('keeps valid rules working alongside reversed ranges', async () => {
    const text = '.env\n[z-a].env\n*.local';
    const rules = parseWorktreeInclude(text);
    expect(isIncluded(rules, '.env', false)).toBe(true);
    expect(isIncluded(rules, 'app/config.local', false)).toBe(true);
    await expectGitMatches(text, ['.env', 'app/config.local', 'a.env', 'z.env', 'm.env', 'other']);
    await expectGitMatches('[!z-a].env', ['a.env', 'z.env', 'm.env']);
  });

  it.each(['alnum', 'alpha', 'blank', 'cntrl', 'digit', 'graph', 'lower', 'print', 'punct', 'space', 'upper', 'xdigit'])(
    'supports the POSIX %s character class, including negation and mixed sets',
    async (name) => {
      const candidates = ['0', '1', '9', 'a', 'f', 'g', 'z', 'A', 'F', 'G', 'Z', '-', '!', ']', ' ', '\t', '\u0001', '\u007f'].map((c) => `${c}.env`);
      await expectGitMatches(`[[:${name}:]].env`, candidates);
      await expectGitMatches(`[![:${name}:]].env`, candidates);
      await expectGitMatches(`[x[:${name}:]_].env`, [...candidates, 'x.env', '_.env']);
    }
  );

  it('matches digit classes at the root and below it', () => {
    const rules = parseWorktreeInclude('[[:digit:]].env');
    expect(isIncluded(rules, '1.env', false)).toBe(true);
    expect(isIncluded(rules, 'config/1.env', false)).toBe(true);
    expect(isIncluded(rules, 'a.env', false)).toBe(false);
  });

  it.each(['[a-z].env', '[a\\-z].env', '[\\]].env', '[]a].env', '[^a].env', '[[:unknown:]].env', '[abc.env'])(
    'preserves bracket and escape semantics for %s',
    async (pattern) => {
      await expectGitMatches(pattern + '\n.env', ['.env', 'a.env', 'm.env', 'z.env', '-.env', '].env', '[abc.env', '1.env']);
    }
  );

  it.each([0, 1, 2, 3, 4, 5, 6])('trims trailing spaces with %i preceding backslashes', async (slashes) => {
    const pattern = 'local' + '\\'.repeat(slashes) + '   ';
    const literal = 'local' + '\\'.repeat(Math.floor(slashes / 2));
    const rules = parseWorktreeInclude(pattern);
    expect(isIncluded(rules, literal + (slashes % 2 ? ' ' : ''), false)).toBe(true);
    expect(isIncluded(rules, literal + (slashes % 2 ? '' : ' '), false)).toBe(false);
    // On Windows, Git treats a backslash in an input path as a separator, not a filename character.
    if (process.platform !== 'win32' || slashes < 2) {
      await expectGitMatches(pattern, [literal, literal + ' ', literal + '  ', literal + '   ']);
    }
  });

  it('retains escaped spaces before trimming unescaped spaces', async () => {
    await expectGitMatches('local\\ \\   \n.env', ['local', 'local ', 'local  ', 'local   ', '.env']);
  });
});
