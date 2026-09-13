/**
 * Offline tests for the pi-subagents override installer. The regression this guards is the one
 * in the report: a subagent billed to OpenRouter's Claude Haiku because pi-subagents' built-in
 * Explore agent pins `anthropic/claude-haiku-4-5`. Vocs Code installs a drop-in Explore in pi's
 * global agent dir that omits the pin so the child inherits the session model, without
 * overwriting a user's file — and removes the per-project copy older versions wrote.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PI_EXPLORE_AGENT_FILE,
  PI_MANAGED_MARKER,
  exploreOverrideMarkdown,
  installAgentOverride,
  installPiAgentOverrides,
  installPiSubagentsReportUsage,
  piAgentDir
} from '../src/main/pi-agents';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pi-agents-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('explore override content', () => {
  it('keeps Explore read-only but drops the model pin so it inherits the session model', () => {
    const md = exploreOverrideMarkdown();
    expect(md).toContain(PI_MANAGED_MARKER);
    expect(md).toContain('name: Explore');
    expect(md).toContain('tools: read, bash, grep, find, ls');
    expect(md).toContain('READ-ONLY MODE');
    // The whole point: no `model:` frontmatter, so pi-subagents resolves the parent session model.
    expect(md).not.toMatch(/^model:/m);
  });
});

describe('installAgentOverride', () => {
  it('writes an absent file and reports it written', async () => {
    const dir = await tmpDir();
    const res = await installAgentOverride(dir, PI_EXPLORE_AGENT_FILE, exploreOverrideMarkdown());
    expect(res.written).toBe(true);
    expect(res.skipped).toBeNull();
    expect(await fs.readFile(res.path, 'utf8')).toContain('name: Explore');
  });

  it('never overwrites an existing file', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, PI_EXPLORE_AGENT_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, '---\nname: Explore\nmodel: anthropic/claude-opus-4-6\n---\n', 'utf8');
    const res = await installAgentOverride(dir, PI_EXPLORE_AGENT_FILE, exploreOverrideMarkdown());
    expect(res.written).toBe(false);
    expect(res.skipped).toBe('exists');
    expect(await fs.readFile(file, 'utf8')).toContain('claude-opus-4-6');
  });
});

describe('installPiAgentOverrides', () => {
  it('installs into the global agent dir only, honoring PI_CODING_AGENT_DIR', async () => {
    const home = await tmpDir();
    const agentDir = path.join(home, 'relocated-agent');
    const cwd = await tmpDir();
    const log = vi.fn();
    const res = await installPiAgentOverrides({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, home, log });

    expect(res?.path).toBe(path.join(agentDir, 'agents', PI_EXPLORE_AGENT_FILE));
    expect(res?.written).toBe(true);
    expect(await fs.readFile(res!.path, 'utf8')).not.toMatch(/^model:/m);
    // No project copy: a worktree session must not gain an untracked `.pi/` folder.
    await expect(fs.access(path.join(cwd, '.pi'))).rejects.toThrow();
    // The same pass turns on pi-subagents usage reporting in the global settings.
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'subagents.json'), 'utf8'))).toEqual({ reportUsage: true });
  });

  it('removes the project copy older versions installed and keeps the rest of .pi intact', async () => {
    const home = await tmpDir();
    const cwd = await tmpDir();
    const legacy = path.join(cwd, '.pi', 'agents', PI_EXPLORE_AGENT_FILE);
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, exploreOverrideMarkdown(), 'utf8');
    await fs.writeFile(path.join(cwd, '.pi', 'settings.json'), '{}', 'utf8');
    const log = vi.fn();

    await installPiAgentOverrides({ cwd, env: { PI_CODING_AGENT_DIR: path.join(home, 'agent') }, home, log });

    await expect(fs.access(legacy)).rejects.toThrow();
    await expect(fs.access(path.join(cwd, '.pi', 'agents'))).rejects.toThrow();
    expect(await fs.readFile(path.join(cwd, '.pi', 'settings.json'), 'utf8')).toBe('{}');
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('removed legacy project pi subagent override'));
  });

  it('leaves a project-authored Explore in place so the project keeps its own model', async () => {
    const home = await tmpDir();
    const cwd = await tmpDir();
    const projectFile = path.join(cwd, '.pi', 'agents', PI_EXPLORE_AGENT_FILE);
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, '---\nname: Explore\nmodel: openrouter/deepseek/deepseek-v4.1-flash\n---\n', 'utf8');

    const res = await installPiAgentOverrides({ cwd, env: { PI_CODING_AGENT_DIR: path.join(home, 'agent') }, home });

    expect(res?.written).toBe(true);
    expect(await fs.readFile(projectFile, 'utf8')).toContain('deepseek-v4.1-flash');
  });

  it('keeps the project copy when the global override could not be installed', async () => {
    const home = await tmpDir();
    const cwd = await tmpDir();
    const agentDir = path.join(home, 'agent');
    // A file where the global agents dir belongs makes the install fail.
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'agents'), 'not a directory', 'utf8');
    const legacy = path.join(cwd, '.pi', 'agents', PI_EXPLORE_AGENT_FILE);
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, exploreOverrideMarkdown(), 'utf8');
    const log = vi.fn();

    const res = await installPiAgentOverrides({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, home, log });

    expect(res).toBeNull();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('could not install pi subagent override'));
    expect(await fs.readFile(legacy, 'utf8')).toContain(PI_MANAGED_MARKER);
    // A failed install must not stop usage reporting.
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'subagents.json'), 'utf8'))).toEqual({ reportUsage: true });
  });
});

describe('installPiSubagentsReportUsage', () => {
  it('adds reportUsage and preserves existing settings', async () => {
    const dir = await tmpDir();
    // An absent key is filled in; the rest of the file is kept.
    await fs.writeFile(path.join(dir, 'subagents.json'), JSON.stringify({ widgetMode: 'off' }), 'utf8');
    expect(await installPiSubagentsReportUsage(dir)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'subagents.json'), 'utf8'))).toEqual({ widgetMode: 'off', reportUsage: true });
  });

  it('respects an explicit choice and never clobbers it', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'subagents.json'), JSON.stringify({ reportUsage: false }), 'utf8');
    expect(await installPiSubagentsReportUsage(dir)).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'subagents.json'), 'utf8')).reportUsage).toBe(false);
  });

  it('leaves a malformed file for pi-subagents to report', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'subagents.json'), '{ not json', 'utf8');
    expect(await installPiSubagentsReportUsage(dir)).toBe(false);
    expect(await fs.readFile(path.join(dir, 'subagents.json'), 'utf8')).toBe('{ not json');
  });
});

describe('piAgentDir', () => {
  it('defaults to <home>/.pi/agent and expands a leading tilde in the override', () => {
    expect(piAgentDir({}, '/home/u')).toBe(path.join('/home/u', '.pi', 'agent'));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: '~/custom' }, '/home/u')).toBe(path.join('/home/u', 'custom'));
  });
});