/**
 * Offline tests for subagent type discovery. The rules that matter: a project file beats a global
 * file beats a built-in, Claude Code's directory is honored, and a bad file can never take the whole
 * discovery down (a subagent spawn must not fail because one file is malformed).
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENTS,
  buildSystemPrompt,
  DEFAULT_BACKGROUND_LIMIT,
  DEFAULT_SESSION_LIMIT,
  discoverAgents,
  findAgent,
  parseAgentFile,
  parseFrontmatter,
  readSubagentLimits,
  resolveAgentDir,
  toolNamesFor
} from '../resources/pi/subagent-agents';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

describe('frontmatter parsing', () => {
  it('reads quoted values containing colons and skips comments', () => {
    const { fields, body } = parseFrontmatter(["---", "# managed", "name: Explore", "description: 'Find code: fast'", "---", "Body line"].join('\n'));
    expect(fields.name).toBe('Explore');
    expect(fields.description).toBe('Find code: fast');
    expect(body).toBe('Body line');
  });

  it('joins folded and literal blocks', () => {
    const folded = parseFrontmatter(['---', 'description: >', '  first part', '  second part', '---', ''].join('\n'));
    expect(folded.fields.description).toBe('first part second part');
    const literal = parseFrontmatter(['---', 'description: |', '  line one', '  line two', '---', ''].join('\n'));
    expect(literal.fields.description).toBe('line one\nline two');
  });

  it('treats a file without frontmatter as all body', () => {
    const parsed = parseFrontmatter('Just a prompt');
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toBe('Just a prompt');
  });
});

describe('agent files', () => {
  it('parses tools, model, prompt mode, mcp and body', () => {
    const agent = parseAgentFile(
      [
        '---',
        'name: reviewer',
        'description: Reviews diffs',
        'tools: read, grep, bash, teleport',
        'model: openai/gpt-5.1-codex',
        'prompt_mode: replace',
        'mcp: false',
        '---',
        'You review diffs.',
      ].join('\n'),
      '/repo/.pi/agents/reviewer.md'
    );
    expect(agent).toMatchObject({
      name: 'reviewer',
      description: 'Reviews diffs',
      tools: ['read', 'grep', 'bash', 'teleport'],
      promptMode: 'replace',
      model: { provider: 'openai', model: 'gpt-5.1-codex' },
      mcp: false,
      source: '/repo/.pi/agents/reviewer.md',
    });
    expect(agent?.prompt).toBe('You review diffs.');
  });

  it('defaults to inherit-the-model, append mode and every tool', () => {
    const agent = parseAgentFile(['---', 'name: helper', '---', 'Help out.'].join('\n'));
    expect(agent).toMatchObject({ name: 'helper', promptMode: 'append', mcp: true });
    expect(agent?.model).toBeUndefined();
    expect(agent?.tools).toContain('edit');
    if (process.platform !== 'win32') expect(agent?.tools).not.toContain('powershell');
  });

  it('rejects a file with no name', () => {
    expect(parseAgentFile('---\ndescription: nothing\n---\nbody')).toBeNull();
  });

  it('filters tools to what pi actually has on this platform', () => {
    const agent = parseAgentFile('---\nname: x\ntools: read, teleport, powershell\n---\nbody');
    const tools = toolNamesFor(agent!);
    expect(tools).toContain('read');
    expect(tools).not.toContain('teleport');
    if (process.platform !== 'win32') expect(tools).not.toContain('powershell');
  });

  it('falls back to a read-only set when a file names no usable tool', () => {
    const agent = parseAgentFile('---\nname: x\ntools: teleport, hover\n---\nbody');
    expect(toolNamesFor(agent!)).toEqual(['read', 'grep', 'find', 'ls']);
  });
});

describe('discovery precedence', () => {
  it('prefers project over global over built-in, and .pi over .claude', async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, 'repo');
    const home = path.join(dir, 'home');
    const agentDir = path.join(home, '.pi', 'agent');
    await writeFile(path.join(cwd, '.pi', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT_PI');
    await writeFile(path.join(cwd, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT_CLAUDE');
    await writeFile(path.join(agentDir, 'agents', 'Explore.md'), '---\nname: Explore\n---\nGLOBAL_PI');
    await writeFile(path.join(home, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nGLOBAL_CLAUDE');
    await writeFile(path.join(cwd, '.pi', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nREVIEW');
    const agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.prompt).toBe('PROJECT_PI');
    expect(findAgent(agents, 'reviewer')?.prompt).toBe('REVIEW');
    expect(findAgent(agents, 'general-purpose')?.source).toBe('template');
    expect(findAgent(agents, 'general-purpose')?.origin).toBe('template');
    expect(findAgent(agents, 'EXPLORE')?.prompt).toBe('PROJECT_PI');
  });

  it('falls back to each lower-precedence directory in turn', async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, 'repo');
    const home = path.join(dir, 'home');
    const agentDir = path.join(home, '.pi', 'agent');
    await writeFile(path.join(cwd, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT_CLAUDE');
    await writeFile(path.join(home, '.claude', 'agents', 'Explore.md'), '---\nname: Explore\n---\nGLOBAL_CLAUDE');
    let agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.prompt).toBe('PROJECT_CLAUDE');
    await fs.rm(path.join(cwd, '.claude'), { recursive: true, force: true });
    agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.prompt).toBe('GLOBAL_CLAUDE');
    await fs.rm(path.join(home, '.claude'), { recursive: true, force: true });
    agents = await discoverAgents({ cwd, agentDir, home });
    expect(findAgent(agents, 'Explore')?.source).toBe('template');
  });

  it('ships the three Claude Code agents and survives an unreadable file', async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, 'repo');
    const home = path.join(dir, 'home');
    await writeFile(path.join(cwd, '.pi', 'agents', 'broken.md'), 'not frontmatter at all');
    await fs.mkdir(path.join(cwd, '.pi', 'agents', 'dir.md'), { recursive: true }); // readdir entry that is not a file
    const agents = await discoverAgents({ cwd, agentDir: path.join(home, '.pi', 'agent'), home });
    expect(agents.map((a) => a.name).sort()).toEqual(['Explore', 'Plan', 'general-purpose']);
    expect(BUILTIN_AGENTS).toHaveLength(3);
  });

  it('keeps Explore read-only and Plan write-free', async () => {
    const dir = await tempDir();
    const agents = await discoverAgents({ cwd: path.join(dir, 'repo'), agentDir: path.join(dir, 'agent'), home: dir });
    const explore = findAgent(agents, 'Explore')!;
    expect(explore.tools).not.toContain('edit');
    expect(explore.tools).not.toContain('write');
    expect(explore.mcp).toBe(false);
    const plan = findAgent(agents, 'Plan')!;
    expect(plan.tools).not.toContain('edit');
  });

  it('honors PI_CODING_AGENT_DIR for the global agent directory', () => {
    const home = path.join(os.tmpdir(), 'vocs-home');
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: '~/custom' }, home)).toBe(path.join(home, 'custom'));
    expect(resolveAgentDir({}, home)).toBe(path.join(home, '.pi', 'agent'));
  });
});

describe('system prompt assembly', () => {
  it('replaces the parent prompt for replace-mode agents', () => {
    const agent = { ...BUILTIN_AGENTS[1]!, promptMode: 'replace' as const, prompt: 'ROLE' };
    expect(buildSystemPrompt(agent, 'PARENT')).toBe('ROLE');
  });

  it('extends the parent prompt for append-mode agents', () => {
    const agent = { ...BUILTIN_AGENTS[0]!, promptMode: 'append' as const, prompt: 'ROLE' };
    expect(buildSystemPrompt(agent, 'PARENT')).toBe('PARENT\n\n# Your role\nROLE');
    expect(buildSystemPrompt(agent, '  ')).toBe('ROLE');
  });
});

describe('project-level definitions', () => {
  it('lets the project root win over the branch, and keeps branch-only types', async () => {
    const dir = await tempDir();
    const projectRoot = path.join(dir, 'repo');
    const cwd = path.join(dir, 'worktree');
    const home = path.join(dir, 'home');
    await writeFile(path.join(projectRoot, '.pi', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT');
    await writeFile(path.join(cwd, '.pi', 'agents', 'Explore.md'), '---\nname: Explore\n---\nBRANCH');
    await writeFile(path.join(cwd, '.pi', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\n---\nREVIEW');
    const agents = await discoverAgents({ cwd, projectRoot, agentDir: path.join(home, '.pi', 'agent'), home });
    // The managed set is authoritative; a branch copy never silently overrides what the manager edits.
    expect(findAgent(agents, 'Explore')).toMatchObject({ prompt: 'PROJECT', origin: 'project' });
    // A type only the branch defines is still available, and says so.
    expect(findAgent(agents, 'reviewer')).toMatchObject({ prompt: 'REVIEW', origin: 'branch', description: 'Reviews diffs' });
  });

  it('treats cwd as the project when no project root is given', async () => {
    const dir = await tempDir();
    const cwd = path.join(dir, 'repo');
    await writeFile(path.join(cwd, '.pi', 'agents', 'Explore.md'), '---\nname: Explore\n---\nONLY');
    const agents = await discoverAgents({ cwd, agentDir: path.join(dir, 'agent'), home: dir });
    expect(findAgent(agents, 'Explore')).toMatchObject({ prompt: 'ONLY', origin: 'project' });
  });

  it('reads templates from disk and lets any definition override one', async () => {
    const dir = await tempDir();
    const projectRoot = path.join(dir, 'repo');
    const templateDir = path.join(dir, 'templates');
    await writeFile(path.join(templateDir, 'shipped.md'), '---\nname: shipped\ndescription: From the app\ntools: read\n---\nSHIPPED');
    await writeFile(path.join(templateDir, 'Explore.md'), '---\nname: Explore\ndescription: Template Explore\n---\nTEMPLATE_EXPLORE');
    let agents = await discoverAgents({ cwd: projectRoot, projectRoot, agentDir: path.join(dir, 'agent'), templateDir, home: dir });
    expect(findAgent(agents, 'shipped')).toMatchObject({ prompt: 'SHIPPED', origin: 'template', source: path.join(templateDir, 'shipped.md') });
    expect(findAgent(agents, 'Explore')).toMatchObject({ prompt: 'TEMPLATE_EXPLORE', origin: 'template' });
    await writeFile(path.join(projectRoot, '.pi', 'agents', 'Explore.md'), '---\nname: Explore\n---\nPROJECT');
    agents = await discoverAgents({ cwd: projectRoot, projectRoot, agentDir: path.join(dir, 'agent'), templateDir, home: dir });
    expect(findAgent(agents, 'Explore')).toMatchObject({ prompt: 'PROJECT', origin: 'project' });
  });

  it('falls back to the compiled-in definitions when no template folder exists', async () => {
    const dir = await tempDir();
    const agents = await discoverAgents({ cwd: path.join(dir, 'repo'), agentDir: path.join(dir, 'agent'), templateDir: path.join(dir, 'missing'), home: dir });
    expect(agents.map((a) => a.name).sort()).toEqual(['Explore', 'Plan', 'general-purpose']);
  });

  it('keeps the shipped template files and the compiled-in fallback in step', async () => {
    const { loadTemplates } = await import('../resources/pi/subagent-agents');
    const shippedDir = path.join(__dirname, '..', 'resources', 'pi', 'agents');
    const shipped = await loadTemplates(shippedDir);
    expect(shipped.map((a) => a.name).sort()).toEqual(['Explore', 'Plan', 'general-purpose']);
    for (const template of shipped) {
      const fallback = BUILTIN_AGENTS.find((a) => a.name === template.name)!;
      // Same text, same knobs: the file is the source of truth and the module is only a safety net.
      expect(template.prompt).toBe(fallback.prompt);
      expect(template.description).toBe(fallback.description);
      // Compare what a child can actually use: a template may name `powershell`, and the effective
      // list drops it everywhere Windows does not have it (the compiled-in fallback already did).
      expect(toolNamesFor(template)).toEqual(toolNamesFor(fallback));
      expect(template.promptMode).toBe(fallback.promptMode);
      expect(template.mcp).toBe(fallback.mcp);
      expect(template.model).toBeUndefined();
    }
  });
});

describe('concurrency limits', () => {
  it('falls back to the shipped caps when there is no settings file', async () => {
    const dir = await tempDir();
    await expect(readSubagentLimits(dir)).resolves.toEqual({ background: DEFAULT_BACKGROUND_LIMIT, session: DEFAULT_SESSION_LIMIT, foreground: 0 });
  });

  it('takes maxConcurrent as both the background pool and the per-session cap', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'subagents.json'), JSON.stringify({ reportUsage: true, maxConcurrent: 20 }));
    await expect(readSubagentLimits(dir)).resolves.toEqual({ background: 20, session: 20, foreground: 0 });
  });

  it('takes maxConcurrentForeground as the foreground cap, 0 meaning no separate cap', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'subagents.json'), JSON.stringify({ maxConcurrentForeground: 2 }));
    await expect(readSubagentLimits(dir)).resolves.toMatchObject({ foreground: 2 });
  });

  it('ignores a malformed file or an out-of-range value rather than failing a spawn', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'subagents.json'), '{ not json');
    await expect(readSubagentLimits(dir)).resolves.toEqual({ background: DEFAULT_BACKGROUND_LIMIT, session: DEFAULT_SESSION_LIMIT, foreground: 0 });
    await writeFile(path.join(dir, 'subagents.json'), JSON.stringify({ maxConcurrent: 0 }));
    await expect(readSubagentLimits(dir)).resolves.toEqual({ background: DEFAULT_BACKGROUND_LIMIT, session: DEFAULT_SESSION_LIMIT, foreground: 0 });
  });
});
