/**
 * Real installed Pi 0.85.1, RPC mode, offline scripted provider: the Vocs Code subagents extension is
 * loaded the way the app loads it, spawns a real child agent session in-process, and the run lands as
 * a run file plus a tool result.
 *
 * Opt-in: `VOCS_CODE_PI_INTEGRATION=1`. A selected but missing runtime fails, never skips.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PiOfflineRunner, piIntegrationPaths, type PiEvent, type ScriptedCall } from './pi-offline-runner';
import { parseRunFile } from '../src/shared/subagents';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const call = (id: string, name: string, args: Record<string, unknown>): ScriptedCall => ({ id, name, arguments: args });
const text = (event: PiEvent) => (event.result?.content ?? []).map((part: PiEvent) => part.text ?? '').join('\n');
const MCP_FIXTURE = path.resolve('tests/fixtures/mcp-echo-server.mjs');

describe.skipIf(!enabled)('Vocs Code subagents over the real Pi runtime', () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  const runners: PiOfflineRunner[] = [];

  beforeAll(() => {
    piIntegrationPaths();
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'vocs-pi-subagents-'));
    cwd = path.join(root, 'workspace');
    agentDir = path.join(root, 'agent');
    await fs.mkdir(cwd);
    await fs.mkdir(agentDir);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  });
  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.close()));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const start = (options: Partial<ConstructorParameters<typeof PiOfflineRunner>[0]> = {}) => {
    const runner = new PiOfflineRunner({ cwd, agentDir, ...options });
    runners.push(runner);
    return runner;
  };

  it('registers the subagent tools alongside the third-party ones (coexistence, not replacement)', async () => {
    const runner = start();
    await runner.ready();
    const advertised = runner.events
      .filter((event) => event.type === 'extension_ui_request' && event.message?.startsWith('PI_FIXTURE_TOOLS::'))
      .flatMap((event) => (JSON.parse(event.message.slice('PI_FIXTURE_TOOLS::'.length)) as { tools: { name: string }[] }).tools.map((tool) => tool.name));
    expect(advertised).toContain('subagent');
    expect(advertised).toContain('subagent_result');
    expect(advertised).toContain('subagent_steer');
    expect(runner.events.filter((event) => event.type === 'extension_error')).toEqual([]);
  });

  it('runs a queued foreground child, returns its output and writes a parseable run record', async () => {
    const runner = start();
    await runner.ready();
    const events = await runner.prompt([
      call('s1', 'subagent', { description: 'Find the registry', prompt: 'Where is the harness registry?', type: 'Explore' }),
    ]);
    const ended = events.filter((event) => event.type === 'tool_execution_end');
    expect(ended).toHaveLength(1);
    expect(ended[0].isError).toBe(false);
    // The scripted provider answers any child turn with COMPAT_OK, so the child's answer is the result.
    expect(text(ended[0])).toContain('COMPAT_OK');
    expect(text(ended[0])).toContain('Explore completed');
    expect(ended[0].result?.details).toMatchObject({ agent: 'Explore', status: 'completed', turns: 1 });
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'extension_error')).toEqual([]);

    const dir = path.join(agentDir, 'subagents');
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    const parsed = parseRunFile(await fs.readFile(path.join(dir, files[0]!), 'utf8'))!;
    expect(parsed.meta).toMatchObject({ agent: 'Explore', mode: 'foreground', description: 'Find the registry' });
    expect(parsed.status).toBe('completed');
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]!.model).toBe('scripted');
    expect(parsed.totals.turns).toBe(1);
  });

  it("runs an agent the project defines in its own .pi/agents", async () => {
    // The project's set is what the manager edits: a definition there is usable without touching
    // anything global, and it is resolved from VOCS_CODE_PROJECT_ROOT, not from the session cwd.
    await fs.mkdir(path.join(cwd, '.pi', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.pi', 'agents', 'reviewer.md'),
      ['---', 'name: reviewer', 'description: Reviews diffs against the repo rules', 'tools: read, grep', 'prompt_mode: replace', '---', 'You review diffs.'].join('\n'),
      'utf8'
    );
    const runner = start();
    await runner.ready();
    const events = await runner.prompt([call('s1', 'subagent', { description: 'Review the diff', prompt: 'Review it', type: 'reviewer' })]);
    const ended = events.filter((event) => event.type === 'tool_execution_end');
    expect(ended).toHaveLength(1);
    expect(ended[0].result?.details).toMatchObject({ agent: 'reviewer', status: 'completed' });
    expect(ended[0].isError).toBe(false);
    expect(events.filter((event) => event.type === 'extension_error')).toEqual([]);
    const run = parseRunFile(await fs.readFile(path.join(agentDir, 'subagents', (await fs.readdir(path.join(agentDir, 'subagents')))[0]!), 'utf8'))!;
    expect(run.meta.agent).toBe('reviewer');
    expect(run.status).toBe('completed');
  });

  it('rejects an unknown agent type without running anything', async () => {
    const runner = start();
    await runner.ready();
    const events = await runner.prompt([
      call('s1', 'subagent', { description: 'Nope', prompt: 'x', type: 'ghost' }),
    ]);
    const ended = events.filter((event) => event.type === 'tool_execution_end');
    expect(ended).toHaveLength(1);
    expect(ended[0].isError).toBe(true);
    expect(text(ended[0])).toContain('Unknown subagent type "ghost"');
    await expect(fs.readdir(path.join(agentDir, 'subagents'))).rejects.toThrow();
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
  });

  it('gives a child the session\'s MCP tools, and none when its agent opts out', async () => {
    const mcpConfig = path.join(root, 'mcp.json');
    await fs.writeFile(
      mcpConfig,
      JSON.stringify({ servers: [{ id: 'echo', transport: 'stdio', command: process.execPath, args: [MCP_FIXTURE] }] }),
      'utf8'
    );
    const childPrompt = JSON.stringify({ calls: [call('c1', 'mcp__echo__echo', { text: 'child-call' })] });
    const runner = start({ mcpConfig });
    await runner.ready();
    const events = await runner.prompt([call('s1', 'subagent', { description: 'Use MCP', prompt: childPrompt, type: 'general-purpose' })]);
    expect(events.filter((event) => event.type === 'extension_error')).toEqual([]);
    const dir = path.join(agentDir, 'subagents');
    const file = (await fs.readdir(dir))[0]!;
    const run = parseRunFile(await fs.readFile(path.join(dir, file), 'utf8'))!;
    expect(run.status).toBe('completed');
    // The child reached the real MCP server: the stamp only exists in the server's response.
    const mcpItem = run.items.find((item) => item.kind === 'tool' && item.name === 'mcp__echo__echo');
    expect(mcpItem).toMatchObject({ status: 'done' });
    expect(JSON.stringify(run.items)).toContain('child-call:');

    // An agent that opts out (`mcp: false`) never sees the tool: pi rejects the call.
    await fs.mkdir(path.join(cwd, '.pi', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.pi', 'agents', 'no-mcp.md'),
      ['---', 'name: no-mcp', 'description: No MCP here', 'tools: read, grep', 'mcp: false', 'prompt_mode: replace', '---', 'You have no MCP tools.'].join('\n'),
      'utf8'
    );
    const optedOut = start({ mcpConfig });
    await optedOut.ready();
    await optedOut.prompt([call('s1', 'subagent', { description: 'No MCP', prompt: childPrompt, type: 'no-mcp' })]);
    const dirAfter = path.join(agentDir, 'subagents');
    const files = await fs.readdir(dirAfter);
    const newest = (await Promise.all(files.map(async (name) => ({ name, stat: await fs.stat(path.join(dirAfter, name)) })))).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]!.name;
    const optedRun = parseRunFile(await fs.readFile(path.join(dirAfter, newest), 'utf8'))!;
    expect(optedRun.items.some((item) => item.kind === 'tool' && item.name === 'mcp__echo__echo' && item.status === 'done')).toBe(false);
  });

  it('gates a child command in ask mode: an approved command runs, a denied one never does', async () => {
    const allowed = start({ mode: 'ask', choice: (payload: PiEvent) => (String(payload.summary).includes('allow-me') ? 'Allow once' : 'Deny') });
    await allowed.ready();
    // The child's first model call is scripted by the same fixture the parent uses, so the child asks
    // its gate for a real bash command. The second child turn sees a tool result and answers with text.
    const childPrompt = JSON.stringify({ calls: [call('c1', 'bash', { command: 'echo allow-me' })] });
    let events = await allowed.prompt([call('s1', 'subagent', { description: 'Run a command', prompt: childPrompt, type: 'general-purpose' })]);
    const approvals = events.filter((event) => event.type === 'extension_ui_request' && event.title?.startsWith('VCODE_APPROVAL::')).map((event) => JSON.parse(event.title.slice('VCODE_APPROVAL::'.length)) as Record<string, unknown>);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ tool: 'bash', agent: 'general-purpose' });
    expect(String(approvals[0]!.runId)).toMatch(/^agent_/);
    const readRuns = async () => {
      const dir = path.join(agentDir, 'subagents');
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      return Promise.all(files.map(async (file) => parseRunFile(await fs.readFile(path.join(dir, file), 'utf8'))!));
    };
    const bashItem = (status: string) => (run: Awaited<ReturnType<typeof readRuns>>[number]) => run.items.some((item) => item.kind === 'tool' && item.name === 'bash' && item.status === status);
    // Allow once: the child's command reached the real bash tool.
    expect((await readRuns()).some(bashItem('done'))).toBe(true);
    expect(events.filter((event) => event.type === 'extension_error')).toEqual([]);

    const denied = start({ mode: 'ask', choice: () => 'Deny' });
    await denied.ready();
    events = await denied.prompt([call('s1', 'subagent', { description: 'Run a command', prompt: childPrompt, type: 'general-purpose' })]);
    expect(events.filter((event) => event.type === 'extension_ui_request' && event.title?.startsWith('VCODE_APPROVAL::'))).toHaveLength(1);
    // Deny: the child saw a declined result and the command never reached the tool, so no run shows
    // the bash call as done. The parent's own subagent call is the only tool the parent executed.
    const runs = await readRuns();
    expect(runs.filter(bashItem('done'))).toHaveLength(1); // only the allowed run from this test
    expect(runs.filter(bashItem('error')).length).toBeGreaterThanOrEqual(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
  });
});
