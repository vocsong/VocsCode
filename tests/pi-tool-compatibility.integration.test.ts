import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { PiOfflineRunner, piIntegrationPaths, type PiEvent, type ScriptedCall } from './pi-offline-runner';

// Explicit opt-in: no provider credit. A selected but missing runtime is a failure, never a skip.
const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const text = (event: PiEvent) => (event.result?.content ?? []).map((part: PiEvent) => part.text ?? '').join('\n');
const ended = (events: PiEvent[]) => events.filter((event) => event.type === 'tool_execution_end');
const executed = (events: PiEvent[]) => events.filter((event) => event.type === 'extension_ui_request' && event.message?.startsWith('PI_FIXTURE_EXECUTED::'));
const approvals = (events: PiEvent[]) => events.filter((event) => event.type === 'extension_ui_request' && event.title?.startsWith('VCODE_APPROVAL::')).map((event) => JSON.parse(event.title.slice('VCODE_APPROVAL::'.length)));
const call = (id: string, name: string, args: Record<string, unknown>): ScriptedCall => ({ id, name, arguments: args });
function settled(events: PiEvent[], count: number, errors = 0): void {
  expect(ended(events)).toHaveLength(count);
  expect(ended(events).filter((event) => event.isError)).toHaveLength(errors);
  expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'agent_settled')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'extension_error')).toHaveLength(0);
  const assistant = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
  expect(assistant?.stopReason).toBe('stop');
  expect(assistant?.content).toEqual([{ type: 'text', text: 'COMPAT_OK' }]);
}

describe.skipIf(!enabled)('real Pi 0.85.1 offline compatibility dispatch', () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  const runners: PiOfflineRunner[] = [];
  beforeAll(() => { piIntegrationPaths(); });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'vocs-pi-compat-'));
    cwd = path.join(root, 'workspace');
    agentDir = path.join(root, 'agent');
    await fs.mkdir(cwd);
    await fs.mkdir(agentDir);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, shellCommandPrefix: 'export PI_COMPAT_PREFIX=preserved' }));
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

  it('loads external resources through CLI Jiti and preserves canonical, alias and legacy edits with BOM/CRLF', async () => {
    const runner = start();
    await runner.ready();
    let events = await runner.prompt([call('w1', 'write', { file_path: 'file.txt', content: '\uFEFFalpha\r\nbeta\r\ngamma\r\n' })]);
    settled(events, 1);
    expect(executed(events)).toHaveLength(1);
    events = await runner.prompt([call('e1', 'edit', { file_path: 'file.txt', old_string: 'beta\n', new_string: '', replace_all: false })]);
    settled(events, 1);
    expect(ended(events)[0].result.details.diff).toBeTypeOf('string');
    expect(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8')).toBe('\uFEFFalpha\r\ngamma\r\n');
    events = await runner.prompt([call('e2', 'edit', { path: 'file.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'gamma', newText: 'GAMMA' }] })]);
    settled(events, 1);
    expect(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8')).toBe('\uFEFFALPHA\r\nGAMMA\r\n');
    for (const [index, args] of [
      { path: 'file.txt', oldText: 'ALPHA', newText: 'one' },
      { path: 'file.txt', edits: JSON.stringify([{ oldText: 'one', newText: 'two' }]) },
      { path: 'file.txt', edits: { oldText: 'two', newText: 'three' } },
    ].entries()) {
      settled(await runner.prompt([call(`legacy${index}`, 'edit', args)]), 1);
    }
    events = await runner.prompt([call('r1', 'read', { file_path: 'file.txt', offset: 2, limit: 1 }), call('r2', 'read', { path: 'file.txt', offset: 1, limit: 1 })]);
    settled(events, 2);
    expect(text(ended(events).find((event) => event.toolCallId === 'r1')!)).toContain('GAMMA');
    expect(text(ended(events).find((event) => event.toolCallId === 'r2')!)).toContain('three');
    expect((await runner.request('get_state')).isStreaming).toBe(false);
    expect((await runner.request('get_session_stats')).cost).toBe(0);
  });

  it('rejects conflicts and replace_all before approval or mutation; retains Pi atomic multi-edit failure', async () => {
    const runner = start({ mode: 'ask' });
    await runner.ready();
    await fs.writeFile(path.join(cwd, 'a.txt'), 'alpha beta');
    const events = await runner.prompt([
      call('c1', 'write', { path: 'a.txt', file_path: 'b.txt', content: 'bad' }),
      call('c2', 'edit', { file_path: 'a.txt', old_string: 'alpha', new_string: 'bad', edits: [] }),
      call('c3', 'edit', { file_path: 'a.txt', old_string: 'alpha', new_string: 'bad', replace_all: true }),
      call('c4', 'edit', { file_path: 'a.txt', old_string: 'alpha' }),
      call('c5', 'bash', { command: 'printf bad > bad.txt', timeout: 1, timeout_ms: 1000 }),
      call('c6', 'edit', { path: 'a.txt', oldText: 'alpha', old_string: 'alpha', new_string: '' }),
    ]);
    settled(events, 6, 6);
    expect(approvals(events)).toHaveLength(0);
    expect(executed(events)).toHaveLength(0);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('alpha beta');
    expect(await fs.readdir(cwd)).toEqual(['a.txt']);
    const allowed = start({ choice: () => 'Allow once' });
    await allowed.ready();
    const failed = await allowed.prompt([call('atomic', 'edit', { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'changed' }, { oldText: 'missing', newText: '' }] })]);
    settled(failed, 1, 1);
    expect(executed(failed)).toHaveLength(1);
    expect(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8')).toBe('alpha beta');
  });

  it('gates normalized dangerous/outside aliases with zero executions, including mode changes to plan', async () => {
    const modeFile = path.join(root, 'mode.txt');
    await fs.writeFile(modeFile, 'auto');
    await fs.writeFile(path.join(cwd, 'victim.txt'), 'KEEP');
    await fs.writeFile(path.join(root, 'outside.txt'), 'KEEP');
    const runner = start({ mode: 'auto', modeFile });
    await runner.ready();
    let events = await runner.prompt([
      call('deny-shell', 'bash', { command: 'rm -rf victim.txt', timeout_ms: 1000 }),
      call('deny-edit', 'edit', { file_path: '../outside.txt', old_string: 'KEEP', new_string: '' }),
      call('deny-write', 'write', { file_path: '../outside.txt', content: 'BAD' }),
    ]);
    settled(events, 3, 3);
    expect(executed(events)).toHaveLength(0);
    expect(approvals(events)).toHaveLength(3);
    expect(approvals(events).find((entry) => entry.toolCallId === 'deny-shell').input).toEqual({ command: 'rm -rf victim.txt', timeout: 1 });
    expect(approvals(events).find((entry) => entry.toolCallId === 'deny-edit').input).toEqual({ path: '../outside.txt', edits: [{ oldText: 'KEEP', newText: '' }] });
    expect(await fs.readFile(path.join(root, 'outside.txt'), 'utf8')).toBe('KEEP');
    expect(await fs.readFile(path.join(cwd, 'victim.txt'), 'utf8')).toBe('KEEP');
    await fs.writeFile(modeFile, 'plan');
    events = await runner.prompt([call('plan-write', 'write', { file_path: 'new.txt', content: 'BAD' }), call('plan-shell', 'bash', { command: 'printf bad > bad.txt' })]);
    settled(events, 2, 2);
    expect(executed(events)).toHaveLength(0);
    expect(approvals(events)).toHaveLength(0);
    expect(events.filter((event) => event.message?.startsWith?.('VCODE_TOOL_BLOCKED::'))).toHaveLength(2);
    expect(await fs.readdir(cwd)).toEqual(['victim.txt']);
  });

  it('preserves bash prefix/session environment, streaming tail output and explicit millisecond timeout', async () => {
    const runner = start();
    await runner.ready();
    let events = await runner.prompt([call('env', 'bash', { command: 'printf "%s|%s" "$PI_COMPAT_PREFIX" "$PI_PROVIDER"', timeout: 2 })]);
    settled(events, 1);
    expect(text(ended(events)[0])).toBe('preserved|vocs-offline');
    events = await runner.prompt([call('tail', 'bash', { command: 'for ((i=1;i<=2400;i++)); do printf "line%04d\\n" "$i"; done', timeout: 5 })]);
    settled(events, 1);
    expect(text(ended(events)[0])).toContain('line2400');
    expect(text(ended(events)[0])).not.toContain('line0001');
    expect(events.filter((event) => event.type === 'tool_execution_update').length).toBeGreaterThan(0);
    const full = ended(events)[0].result.details.fullOutputPath;
    expect(await fs.readFile(full, 'utf8')).toContain('line0001');
    await fs.rm(full, { force: true });
    events = await runner.prompt([call('timeout', 'bash', { command: 'sleep 5; printf bad > timeout-bad.txt', timeout_ms: 80 })]);
    settled(events, 1, 1);
    expect(text(ended(events)[0])).toContain('timed out after 0.08 seconds');
    expect(await fs.readdir(cwd)).not.toContain('timeout-bad.txt');
  });

  it('preserves image autoResize:false, project trust and repeated append-system-prompt flags', async () => {
    const chunk = (name: string, data: Buffer) => {
      const type = Buffer.from(name);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
      return Buffer.concat([size, type, data, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2100, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(1 + 2100 * 4))), chunk('IEND', Buffer.alloc(0))]);
    await fs.writeFile(path.join(cwd, 'wide.png'), image);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ images: { autoResize: false }, shellCommandPrefix: 'export PI_COMPAT_PREFIX=global', compaction: { enabled: false } }));
    await fs.mkdir(path.join(cwd, '.pi'));
    await fs.writeFile(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ shellCommandPrefix: 'export PI_COMPAT_PREFIX=project' }));
    const untrusted = start({ extraArgs: ['--no-session', '--append-system-prompt', 'CUSTOM_USER_APPEND_MARKER', '--append-system-prompt', 'COMPAT_APPEND_MARKER'] });
    await untrusted.ready();
    const events = await untrusted.prompt([call('image', 'read', { file_path: 'wide.png' }), call('trust', 'bash', { command: 'printf "%s" "$PI_COMPAT_PREFIX"' })]);
    settled(events, 2);
    const inline = ended(events).find((event) => event.toolCallId === 'image')!.result.content.find((part: PiEvent) => part.type === 'image');
    expect(inline.mimeType).toBe('image/png');
    expect(inline.data).toBe(image.toString('base64'));
    expect(text(ended(events).find((event) => event.toolCallId === 'trust')!)).toBe('global');
    const prompt = JSON.parse(events.find((event) => event.message?.startsWith?.('PI_FIXTURE_PROMPT::'))!.message.slice('PI_FIXTURE_PROMPT::'.length)).systemPrompt;
    expect(prompt).toContain('CUSTOM_USER_APPEND_MARKER');
    expect(prompt).toContain('COMPAT_APPEND_MARKER');
    expect(prompt).toContain('Use read to examine files instead of cat or sed.');
    expect(prompt).toContain('replace_all:true is unsupported');
    const trusted = start({ extraArgs: ['--no-session', '--approve'] });
    await trusted.ready();
    const trustedEvents = await trusted.prompt([call('trust2', 'bash', { command: 'printf "%s" "$PI_COMPAT_PREFIX"' })]);
    settled(trustedEvents, 1);
    expect(text(ended(trustedEvents)[0])).toBe('project');
  });

  it('cancels actual shell execution without a late write and accepts a new turn afterward', async () => {
    const runner = start();
    await runner.ready();
    const from = runner.events.length;
    await runner.request('prompt', { message: JSON.stringify({ calls: [call('abort', 'bash', { command: 'printf STARTED; sleep 20; printf bad > abort-bad.txt' })] }) });
    await runner.waitFor((event) => event.type === 'tool_execution_update' && JSON.stringify(event.partialResult).includes('STARTED'), from);
    await runner.request('abort');
    await runner.waitFor((event) => event.type === 'agent_settled', from);
    const events = runner.events.slice(from);
    expect(ended(events)).toHaveLength(1);
    expect(ended(events)[0].isError).toBe(true);
    expect(text(ended(events)[0])).toContain('aborted');
    expect(executed(events)).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_settled')).toHaveLength(1);
    expect(await fs.readdir(cwd)).not.toContain('abort-bad.txt');
    expect((await runner.request('get_state')).isStreaming).toBe(false);
    settled(await runner.prompt([call('after', 'write', { file_path: 'after.txt', content: 'OK' })]), 1);
    expect(await fs.readFile(path.join(cwd, 'after.txt'), 'utf8')).toBe('OK');
  });

  it('relaunches the CLI with a persisted session and re-establishes wrappers/grants', async () => {
    const sessionDir = path.join(root, 'sessions');
    const first = start({ mode: 'ask', extraArgs: ['--session-dir', sessionDir], choice: () => 'Allow for session' });
    await first.ready();
    settled(await first.prompt([call('persist', 'write', { file_path: 'persisted.txt', content: 'BEFORE' })]), 1);
    const { sessionFile } = await first.request('get_state');
    expect(sessionFile).toBeTypeOf('string');
    await first.close();
    const second = start({ mode: 'ask', extraArgs: ['--session', sessionFile, '--session-dir', sessionDir] });
    await second.ready();
    const history = await second.request('get_messages');
    expect(history.messages.filter((message: PiEvent) => message.role === 'toolResult' && message.toolCallId === 'persist')).toHaveLength(1);
    const denied = await second.prompt([call('resume-deny', 'write', { file_path: 'persisted.txt', content: 'BAD' })]);
    settled(denied, 1, 1);
    expect(approvals(denied)).toHaveLength(1);
    expect(executed(denied)).toHaveLength(0);
    expect(await fs.readFile(path.join(cwd, 'persisted.txt'), 'utf8')).toBe('BEFORE');
    settled(await second.prompt([call('resume-read', 'read', { file_path: 'persisted.txt' })]), 1);
    expect((await second.request('get_state')).isStreaming).toBe(false);
  });

  it.each([['--exclude-tools', 'bash'], ['--tools', 'read'], ['--no-tools']])('does not activate excluded/disabled tools: %j', async (...extraArgs) => {
    const runner = start({ extraArgs: ['--no-session', ...extraArgs] });
    await runner.ready();
    const metadata = runner.events.find((event) => event.message?.startsWith?.('PI_FIXTURE_TOOLS::'));
    const { active, tools } = JSON.parse(metadata!.message.slice('PI_FIXTURE_TOOLS::'.length));
    if (extraArgs[0] === '--no-tools') expect(active).toEqual([]);
    else if (extraArgs[0] === '--tools') expect(active).toEqual(['read']);
    else { expect(active).not.toContain('bash'); expect(tools.map((tool: PiEvent) => tool.name)).not.toContain('bash'); }
  });

  it('fails readiness if another extension wins a built-in registration', async () => {
    const runner = start({ competing: true });
    await expect(runner.ready()).rejects.toThrow(/Missing tools readiness/);
    expect(runner.events.some((event) => event.message?.includes?.('Another extension replaced read'))).toBe(true);
  });
});
