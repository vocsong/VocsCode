/**
 * Offline tests for Claude Code's agent definitions: the frontmatter format, the one field this app
 * edits, and the one file it will write — a new definition.
 *
 * The last part is the point. A definition named after a built-in (`Explore`, `Plan`) does not
 * adjust that built-in, it replaces it — verified against the bundled CLI, where a frontmatter-only
 * `Explore.md` left the agent describing itself as "a general-purpose Claude Code agent". So the app
 * creates a built-in's name only when the caller explicitly overrides it, refuses a name an existing
 * file claims either way, and once a file exists it edits the `model:` line and nothing else.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeAgentFile, withClaudeAgentModel } from '../src/shared/claude-agent-files';
import { CLAUDE_AGENT_DIR, claudeAgentDir, createClaudeAgent, hasClaudeAgentPins, isPinnedModel, listClaudeAgents, setClaudeAgentModel } from '../src/main/claude-agents';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-claude-agents-'));
  tempDirs.push(dir);
  return dir;
}

async function writeAgent(root: string, file: string, text: string): Promise<string> {
  const dir = claudeAgentDir(root);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, file);
  await fs.writeFile(target, text, 'utf8');
  return target;
}

describe('Claude agent frontmatter', () => {
  it('reads the fields it knows and keeps the body as the prompt', () => {
    const parsed = parseClaudeAgentFile(['---', 'name: Explore', 'description: Searches the repo', 'model: sonnet', 'tools: Read, Grep', '---', '', 'You search.'].join('\n'))!;
    expect(parsed.fields).toEqual({ name: 'Explore', description: 'Searches the repo', model: 'sonnet' });
    expect(parsed.prompt).toBe('You search.');
  });

  it('ignores keys it does not own, and is not a definition without a name or frontmatter', () => {
    expect(parseClaudeAgentFile('---\nname: x\ndescription: d\ncolor: blue\n---\nbody')!.fields).toEqual({ name: 'x', description: 'd' });
    expect(parseClaudeAgentFile('---\ndescription: d\n---\nbody')).toBeNull();
    expect(parseClaudeAgentFile('just a prompt')).toBeNull();
  });

  it('writes a model that parses back, quoting whatever the format would otherwise misread', () => {
    const bare = withClaudeAgentModel(['---', 'name: Explore', 'description: Searches: the repo', '---', '', 'You search.'].join('\n'), 'deepseek-v4.1-flash')!;
    expect(parseClaudeAgentFile(bare)!.fields).toEqual({ name: 'Explore', description: 'Searches: the repo', model: 'deepseek-v4.1-flash' });

    // A model id carrying YAML punctuation survives the round trip rather than being read as syntax.
    const quoted = withClaudeAgentModel(bare, 'model: with a colon')!;
    expect(parseClaudeAgentFile(quoted)!.fields.model).toBe('model: with a colon');
    expect(parseClaudeAgentFile(quoted)!.fields.description).toBe('Searches: the repo');
  });
});

describe('editing one definition’s model', () => {
  const file = ['---', '# a comment the author wrote', 'name: reviewer', 'description: Reviews a diff', 'tools: Read, Grep', 'model: old-model', '---', '', 'You review diffs.', ''].join('\n');

  it('replaces only the model line, leaving every other byte alone', () => {
    const next = withClaudeAgentModel(file, 'new-model')!;
    expect(next).toBe(file.replace('model: old-model', 'model: new-model'));
  });

  it('adds the line when the definition pins nothing, and removes it when the pin is cleared', () => {
    const unpinned = withClaudeAgentModel(file, undefined)!;
    expect(unpinned).not.toContain('model:');
    expect(unpinned).toBe(file.replace('model: old-model\n', ''));
    expect(withClaudeAgentModel(unpinned, 'new-model')!.split('\n')).toContain('model: new-model');
    // Clearing a pin that was never set is not an edit, so the file stays byte-identical.
    expect(withClaudeAgentModel(unpinned, undefined)).toBe(unpinned);
  });

  it('keeps a CRLF file CRLF', () => {
    const crlf = file.replace(/\n/g, '\r\n');
    const next = withClaudeAgentModel(crlf, 'new-model')!;
    expect(next).toBe(crlf.replace('model: old-model', 'model: new-model'));
    expect(next).not.toMatch(/[^\r]\n/);
  });

  it('refuses a file with no frontmatter to edit', () => {
    expect(withClaudeAgentModel('no frontmatter here', 'm')).toBeNull();
  });
});

describe('the project’s Claude definitions', () => {
  it('lists what the project has, by the name in the file rather than its file name', async () => {
    const root = await tempDir();
    await writeAgent(root, 'search-helper.md', '---\nname: Explore\ndescription: Custom search\nmodel: deepseek-v4.1-flash\n---\n\nYou search.\n');
    await writeAgent(root, 'notes.txt', 'ignored');
    await writeAgent(root, 'broken.md', 'no frontmatter');

    const files = await listClaudeAgents(root);
    expect(files.map((f) => f.name)).toEqual(['Explore']);
    expect(files[0]).toMatchObject({ description: 'Custom search', model: 'deepseek-v4.1-flash' });
    expect(files[0]!.path).toBe(path.join(root, CLAUDE_AGENT_DIR, 'search-helper.md'));
  });

  it('reports no definitions for a project without the directory', async () => {
    const root = await tempDir();
    expect(await listClaudeAgents(root)).toEqual([]);
    expect(await hasClaudeAgentPins(root)).toBe(false);
  });

  it('counts a pin as a model the file actually names, and `inherit` as none', async () => {
    const root = await tempDir();
    expect(isPinnedModel(undefined)).toBe(false);
    expect(isPinnedModel('inherit')).toBe(false);
    expect(isPinnedModel('sonnet')).toBe(true);

    await writeAgent(root, 'Plan.md', '---\nname: Plan\ndescription: Plans\nmodel: inherit\n---\n');
    expect(await hasClaudeAgentPins(root)).toBe(false);

    await writeAgent(root, 'Explore.md', '---\nname: Explore\ndescription: Searches\nmodel: deepseek-v4.1-flash\n---\n');
    expect(await hasClaudeAgentPins(root)).toBe(true);
  });

  it('edits an existing definition in place, body and all', async () => {
    const root = await tempDir();
    const target = await writeAgent(root, 'reviewer.md', '---\nname: reviewer\ndescription: Reviews a diff\n---\n\nYou review diffs.\n');

    expect(await setClaudeAgentModel(root, 'reviewer', 'deepseek-v4.1-flash')).toEqual({ ok: true });
    const written = await fs.readFile(target, 'utf8');
    expect(written).toBe('---\nname: reviewer\ndescription: Reviews a diff\nmodel: deepseek-v4.1-flash\n---\n\nYou review diffs.\n');
    expect((await listClaudeAgents(root))[0]!.model).toBe('deepseek-v4.1-flash');

    // Clearing it puts the definition back to inheriting, not to a stale pin.
    expect(await setClaudeAgentModel(root, 'reviewer', undefined)).toEqual({ ok: true });
    expect(await fs.readFile(target, 'utf8')).toBe('---\nname: reviewer\ndescription: Reviews a diff\n---\n\nYou review diffs.\n');
    expect(await hasClaudeAgentPins(root)).toBe(false);
  });

  it('never creates a definition, so a built-in cannot be replaced by accident', async () => {
    const root = await tempDir();
    const result = await setClaudeAgentModel(root, 'Explore', 'deepseek-v4.1-flash');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Explore');
    await expect(fs.readdir(claudeAgentDir(root))).rejects.toThrow();
  });

  it('rejects a name that could escape the definitions folder', async () => {
    const root = await tempDir();
    expect((await setClaudeAgentModel(root, '../evil', 'm')).ok).toBe(false);
  });
});

describe('creating a new definition', () => {
  it('writes the name, description and instructions, and pins no model', async () => {
    const root = await tempDir();
    const result = await createClaudeAgent(root, { name: 'reviewer', description: 'Reviews: a diff', prompt: 'You review diffs.\n' });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(root, CLAUDE_AGENT_DIR, 'reviewer.md'));

    const written = await fs.readFile(result.path!, 'utf8');
    expect(written).toBe("---\nname: reviewer\ndescription: 'Reviews: a diff'\n---\n\nYou review diffs.\n");
    // It parses back as the definition it claims to be, and inherits the session model.
    expect(parseClaudeAgentFile(written)!.fields).toEqual({ name: 'reviewer', description: 'Reviews: a diff' });
    expect(await listClaudeAgents(root)).toMatchObject([{ name: 'reviewer', description: 'Reviews: a diff', path: result.path }]);
    expect(await hasClaudeAgentPins(root)).toBe(false);
  });

  it('creates the directory when the project has none', async () => {
    const root = await tempDir();
    await expect(fs.readdir(claudeAgentDir(root))).rejects.toThrow();
    expect((await createClaudeAgent(root, { name: 'tester', description: 'Runs the suite', prompt: 'Test it.' })).ok).toBe(true);
    expect(await fs.readdir(claudeAgentDir(root))).toEqual(['tester.md']);
  });

  it('refuses a built-in name, so a definition cannot silently replace one', async () => {
    const root = await tempDir();
    for (const name of ['Explore', 'Plan', 'general-purpose']) {
      const result = await createClaudeAgent(root, { name, description: 'Replaces the built-in', prompt: 'body' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(name);
    }
    // The same rule covers a type a live engine reports that is not in the known list.
    const engineOwn = await createClaudeAgent(root, { name: 'code-reviewer', description: 'd', prompt: 'p' }, ['code-reviewer']);
    expect(engineOwn.ok).toBe(false);
    expect(engineOwn.error).toContain('code-reviewer');
    await expect(fs.readdir(claudeAgentDir(root))).rejects.toThrow();
  });

  it('writes the definition that replaces a built-in when the caller overrides it, pinning the model it was given', async () => {
    const root = await tempDir();
    const result = await createClaudeAgent(
      root,
      { name: 'Explore', description: 'Searches the repo', prompt: 'You search.', model: 'deepseek-v4.1-flash' },
      [],
      { override: true }
    );
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(root, CLAUDE_AGENT_DIR, 'Explore.md'));
    expect(await fs.readFile(result.path!, 'utf8')).toBe('---\nname: Explore\ndescription: Searches the repo\nmodel: deepseek-v4.1-flash\n---\n\nYou search.\n');
    // The pin is the point of the override: the built-in no longer inherits Claude Code's own default.
    expect(await hasClaudeAgentPins(root)).toBe(true);
    // Overriding one built-in does not open the door for the ordinary path.
    expect((await createClaudeAgent(root, { name: 'Plan', description: 'd', prompt: 'p' })).ok).toBe(false);
  });

  it('an override still refuses a name a project definition already owns, or a file on disk', async () => {
    const root = await tempDir();
    await writeAgent(root, 'search-helper.md', '---\nname: Explore\ndescription: Custom search\n---\n\nYou search.\n');
    const claimed = await createClaudeAgent(root, { name: 'Explore', description: 'Overrides', prompt: 'p' }, [], { override: true });
    expect(claimed.ok).toBe(false);
    expect(claimed.error).toContain('already defines Explore');
    // A file the exact name holds is the author's too, definition or not.
    await writeAgent(root, 'Plan.md', 'notes with no frontmatter');
    const file = await createClaudeAgent(root, { name: 'Plan', description: 'Overrides', prompt: 'p' }, [], { override: true });
    expect(file.ok).toBe(false);
    expect(file.error).toContain('Plan.md already exists');
    expect(await fs.readdir(claudeAgentDir(root))).toEqual(['Plan.md', 'search-helper.md']);
  });

  it('refuses a name the project already defines, under any file name', async () => {
    const root = await tempDir();
    // The row is keyed by the name in the file, so this file already owns `reviewer`.
    await writeAgent(root, 'search-helper.md', '---\nname: reviewer\ndescription: Reviews a diff\n---\n\nYou review diffs.\n');
    const result = await createClaudeAgent(root, { name: 'reviewer', description: 'Another', prompt: 'Other.' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already defines reviewer');
    // A different casing is the same type to Claude Code, so it is the same collision.
    const cased = await createClaudeAgent(root, { name: 'Reviewer', description: 'Another', prompt: 'Other.' });
    expect(cased.ok).toBe(false);
    expect(cased.error).toContain('already defines reviewer');
    expect(await fs.readFile(path.join(root, CLAUDE_AGENT_DIR, 'search-helper.md'), 'utf8')).toContain('Reviews a diff');
    expect(await fs.readdir(claudeAgentDir(root))).toEqual(['search-helper.md']);
  });

  it('refuses to write over a file of the same name that is not a definition at all', async () => {
    const root = await tempDir();
    await writeAgent(root, 'reviewer.md', 'notes the author keeps here, no frontmatter');
    const result = await createClaudeAgent(root, { name: 'reviewer', description: 'Reviews a diff', prompt: 'You review diffs.' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('reviewer.md already exists');
    expect(await fs.readFile(path.join(root, CLAUDE_AGENT_DIR, 'reviewer.md'), 'utf8')).toBe('notes the author keeps here, no frontmatter');
  });

  it('refuses a missing description and a name that could escape the folder', async () => {
    const root = await tempDir();
    expect((await createClaudeAgent(root, { name: 'reviewer', description: '  ', prompt: 'p' })).ok).toBe(false);
    expect((await createClaudeAgent(root, { name: '../evil', description: 'd', prompt: 'p' })).ok).toBe(false);
    await expect(fs.readdir(claudeAgentDir(root))).rejects.toThrow();
  });
});
