import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverChatImports } from '../src/main/chat-import';

let fixture: string;
const start = '2026-06-01T12:00:00.000Z';
const finish = '2026-06-01T12:00:02.000Z';
const cwd = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';

beforeEach(async () => { fixture = await mkdtemp(path.join(tmpdir(), 'vocs-chat-import-')); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixture, { recursive: true, force: true });
});

async function jsonl(relative: string, records: unknown[]): Promise<string> {
  const filename = path.join(fixture, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n');
  return filename;
}

function claude(role: 'user' | 'assistant', text: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: role, uuid: role, sessionId: 'claude-session', cwd, timestamp: role === 'user' ? start : finish, message: { role, content: text }, ...extra };
}

function meta(extra: Record<string, unknown> = {}): unknown {
  return { type: 'session_meta', timestamp: start, payload: { id: 'codex-session', cwd, timestamp: start, source: 'cli', ...extra } };
}

function codex(role: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'response_item', timestamp: finish, payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...extra } };
}

describe('Claude Code chat import', () => {
  it('previews and imports only conversation text, preserving timestamps and project metadata', async () => {
    await jsonl('claude/projects/encoded/session.jsonl', [
      { type: 'system', apiKey: 'never-import-settings' },
      claude('user', [{ type: 'text', text: 'Fix the tests' }, { type: 'image', source: { data: 'private-image' } }]),
      claude('assistant', [{ type: 'thinking', thinking: 'private-reasoning' }, { type: 'tool_use', input: { token: 'private-tool-input' } }], { uuid: 'tool-call' }),
      claude('user', [{ type: 'tool_result', content: 'private-tool-output' }], { uuid: 'tool-result' }),
      claude('assistant', [{ type: 'text', text: 'Tests fixed.' }], { message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Tests fixed.' }] } }),
      claude('assistant', 'Tests fixed.'),
      claude('user', 'sidechain prompt', { uuid: 'sidechain', isSidechain: true }),
      claude('user', 'metadata prompt', { uuid: 'meta', isMeta: true }),
      claude('assistant', 'nested tool response', { uuid: 'nested', parent_tool_use_id: 'parent-tool' }),
      { type: 'custom-title', customTitle: 'Test repair', sessionId: 'claude-session' },
    ]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.skippedFiles).toBe(0);
    expect(result.sessions).toHaveLength(1);
    const { candidate, items } = result.sessions[0];
    expect(candidate).toMatchObject({ source: 'claude', sourceSessionId: 'claude-session', title: 'Test repair', projectRoot: cwd, messageCount: 2, createdAt: Date.parse(start), updatedAt: Date.parse(finish) });
    expect(items).toMatchObject([{ kind: 'user', text: 'Fix the tests', ts: Date.parse(start) }, { kind: 'assistant', text: 'Tests fixed.', model: 'claude-test', ts: Date.parse(finish) }]);
    expect(JSON.stringify(result)).not.toMatch(/private-|never-import-settings|sidechain prompt|metadata prompt|nested tool response|session\.jsonl/);
  });

  it('skips old and new subagent transcript layouts without descending into nested session directories', async () => {
    await jsonl('claude/projects/encoded/session.jsonl', [claude('user', 'Parent conversation')]);
    await jsonl('claude/projects/encoded/agent-child.jsonl', [claude('user', 'Old child', { sessionId: 'old-child' })]);
    await jsonl('claude/projects/encoded/session/subagents/child.jsonl', [claude('user', 'New child', { sessionId: 'new-child' })]);
    await jsonl('claude/projects/encoded/teammate.jsonl', [{ type: 'agent-setting' }, claude('user', 'Teammate', { sessionId: 'teammate' })]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions.map((session) => session.candidate.title)).toEqual(['Parent conversation']);
    expect(result.skippedFiles).toBe(1);
  });

  it('counts malformed lines, tolerates an interrupted final write and keeps valid messages', async () => {
    await jsonl('claude/projects/encoded/session.jsonl', ['not json', 'null', claude('user', 'A valid conversation'), '{"type":']);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.malformedLines).toBe(3);
    expect(result.sessions[0].items).toMatchObject([{ kind: 'user', text: 'A valid conversation' }]);
  });

  it('uses CLAUDE_CONFIG_DIR without reading credentials or global history', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(fixture, 'custom-claude'));
    await jsonl('custom-claude/projects/encoded/session.jsonl', [claude('user', 'Imported from custom home')]);
    await jsonl('custom-claude/history.jsonl', [claude('user', 'global history is not a transcript', { sessionId: 'history' })]);
    await jsonl('custom-claude/credentials.jsonl', [claude('user', 'credentials', { sessionId: 'credentials' })]);
    expect((await discoverChatImports('claude')).sessions.map((session) => session.candidate.title)).toEqual(['Imported from custom home']);
  });
});

describe('Codex chat import', () => {
  it('reads dated rollout files once, ignores mirror events, tools, system/developer messages and reasoning', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(),
      codex('developer', 'private developer instructions'),
      codex('system', 'private system instructions'),
      codex('user', 'Build an importer', { id: 'user-message' }),
      { type: 'event_msg', timestamp: finish, payload: { type: 'user_message', message: 'Build an importer' } },
      { type: 'response_item', timestamp: finish, payload: { type: 'function_call_output', output: 'private tool output' } },
      codex('assistant', 'private reasoning', { channel: 'analysis' }),
      codex('assistant', 'I will inspect the files.', { phase: 'commentary', id: 'commentary-message' }),
      codex('assistant', 'Importer built.', { phase: 'final_answer', id: 'final-message' }),
      codex('assistant', 'Importer built.', { phase: 'final_answer', id: 'final-message' }),
      { type: 'event_msg', timestamp: finish, payload: { type: 'agent_message', message: 'Importer built.' } },
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].candidate).toMatchObject({ source: 'codex', sourceSessionId: 'codex-session', projectRoot: cwd, title: 'Build an importer', messageCount: 3 });
    expect(result.sessions[0].items).toMatchObject([
      { kind: 'user', text: 'Build an importer' },
      { kind: 'assistant', text: 'I will inspect the files.', phase: 'commentary' },
      { kind: 'assistant', text: 'Importer built.', phase: 'final' },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('discovers archived sessions and keeps the same opaque ID after moving a rollout', async () => {
    const filename = await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [meta(), codex('user', 'Continue this chat')]);
    const options = { codexDir: path.join(fixture, 'codex') };
    const first = await discoverChatImports('codex', options);
    await mkdir(path.join(fixture, 'codex/archived_sessions'), { recursive: true });
    await rename(filename, path.join(fixture, 'codex/archived_sessions/rollout-archived.jsonl'));
    const archived = await discoverChatImports('codex', options);
    expect(archived.sessions[0].candidate.id).toBe(first.sessions[0].candidate.id);
    await jsonl('codex/sessions/2026/06/01/rollout-copy.jsonl', [meta(), codex('user', 'Continue this chat')]);
    expect((await discoverChatImports('codex', options)).sessions).toHaveLength(1);
  });

  it('excludes subagent rollouts and unrelated files', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-parent.jsonl', [meta(), codex('user', 'Parent conversation')]);
    await jsonl('codex/sessions/2026/06/01/rollout-child.jsonl', [meta({ id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'codex-session' } } } }), codex('user', 'Child conversation')]);
    await jsonl('codex/sessions/2026/06/01/settings.jsonl', [meta({ id: 'settings' }), codex('user', 'Settings must not be read')]);
    await jsonl('codex/sessions/unexpected/rollout-other.jsonl', [meta({ id: 'unrelated' }), codex('user', 'Unexpected directory')]);
    expect((await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') })).sessions.map((session) => session.candidate.title)).toEqual(['Parent conversation']);
  });

  it('honors CODEX_HOME and accepts Windows project roots on any platform', async () => {
    vi.stubEnv('CODEX_HOME', path.join(fixture, 'custom-codex'));
    await jsonl('custom-codex/sessions/2026/06/01/rollout-session.jsonl', [meta({ cwd: 'C:\\Users\\test\\repo' }), codex('user', 'Windows history')]);
    expect((await discoverChatImports('codex')).sessions[0].candidate.projectRoot).toBe('C:\\Users\\test\\repo');
  });
});

describe('chat import boundaries', () => {
  it('skips histories with missing or invalid project roots', async () => {
    await jsonl('claude/projects/encoded/missing.jsonl', [claude('user', 'Missing cwd', { cwd: undefined, sessionId: 'missing' })]);
    await jsonl('claude/projects/encoded/relative.jsonl', [claude('user', 'Relative cwd', { cwd: 'relative/path', sessionId: 'relative' })]);
    await jsonl('codex/sessions/2026/06/01/rollout-invalid.jsonl', [meta({ cwd: 'not-an-absolute-path' }), codex('user', 'Invalid cwd')]);
    expect((await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') })).skippedFiles).toBe(2);
    expect((await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') })).skippedFiles).toBe(1);
  });

  it('treats missing homes and unsupported source layouts as empty', async () => {
    expect(await discoverChatImports('claude', { claudeDir: path.join(fixture, 'missing') })).toEqual({ sessions: [], skippedFiles: 0, malformedLines: 0, truncated: false });
    await expect(discoverChatImports('unsupported' as 'claude', { claudeDir: fixture })).rejects.toThrow('Unsupported chat import source');
  });

  it('does not follow symlinked homes, projects, files or session directories', async () => {
    await jsonl('outside/project/session.jsonl', [claude('user', 'Linked private history')]);
    await mkdir(path.join(fixture, 'claude/projects/real'), { recursive: true });
    const junction = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(path.join(fixture, 'outside'), path.join(fixture, 'linked-home'), junction);
    await symlink(path.join(fixture, 'outside/project'), path.join(fixture, 'claude/projects/linked'), junction);
    // Directory junctions need no elevated privilege on Windows; file symlinks do.
    if (process.platform !== 'win32') await symlink(path.join(fixture, 'outside/project/session.jsonl'), path.join(fixture, 'claude/projects/real/linked.jsonl'), 'file');
    expect((await discoverChatImports('claude', { claudeDir: path.join(fixture, 'linked-home') })).sessions).toEqual([]);
    expect((await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') })).sessions).toEqual([]);
    await mkdir(path.join(fixture, 'other-claude'), { recursive: true });
    await symlink(path.join(fixture, 'outside'), path.join(fixture, 'other-claude/projects'), junction);
    expect((await discoverChatImports('claude', { claudeDir: path.join(fixture, 'other-claude') })).sessions).toEqual([]);
  });

  it('skips oversized files while retaining other importable sessions', async () => {
    await jsonl('claude/projects/encoded/huge.jsonl', [claude('user', 'x'.repeat(4_000), { sessionId: 'huge' })]);
    await jsonl('claude/projects/encoded/small.jsonl', [claude('user', 'Small chat')]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude'), maxFileBytes: 1_000 });
    expect(result.skippedFiles).toBe(1);
    expect(result.sessions.map((session) => session.candidate.title)).toEqual(['Small chat']);
  });

  it('bounds traversed entries and files and reports incomplete discovery', async () => {
    for (let index = 0; index < 4; index++) {
      await jsonl(`claude/projects/encoded/session-${index}.jsonl`, [claude('user', `Chat ${index}`, { sessionId: `session-${index}` })]);
    }
    const byFiles = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude'), maxFiles: 2 });
    expect(byFiles.sessions).toHaveLength(2);
    expect(byFiles.truncated).toBe(true);
    const byEntries = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude'), maxEntries: 2 });
    expect(byEntries.sessions).toHaveLength(1);
    expect(byEntries.truncated).toBe(true);
  });

  it('bounds the aggregate bytes read across multiple histories', async () => {
    const records = [claude('user', 'A bounded conversation')];
    await jsonl('claude/projects/encoded/one.jsonl', records);
    await jsonl('claude/projects/encoded/two.jsonl', [claude('user', 'Another conversation', { sessionId: 'second-session' })]);
    const firstFileBytes = Buffer.byteLength(JSON.stringify(records[0]) + '\n');
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude'), maxTotalBytes: firstFileBytes });
    expect(result.sessions).toHaveLength(1);
    expect(result.truncated || result.skippedFiles > 0).toBe(true);
  });
});
