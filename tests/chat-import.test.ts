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

function codexEvent(type: string, fields: Record<string, unknown> = {}): unknown {
  return { type: 'event_msg', timestamp: finish, payload: { type, ...fields } };
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

  it.each(['string', 'blocks'] as const)('excludes local commands from %s content, the title and message count', async (format) => {
    const command = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
    const content = (text: string) => format === 'string' ? text : [{ type: 'text', text }];
    await jsonl('claude/projects/encoded/session.jsonl', [
      claude('user', content(command), { uuid: 'clear' }),
      claude('user', content('<local-command-stdout>Conversation cleared.</local-command-stdout>'), { uuid: 'stdout' }),
      claude('user', content('<local-command-stderr>Local command failed.</local-command-stderr>'), { uuid: 'stderr' }),
      claude('user', content('<local-command-caveat>These messages were generated while running local commands.</local-command-caveat>'), { uuid: 'caveat' }),
      claude('user', content('Fix the tests')),
      claude('assistant', 'Tests fixed.'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Fix the tests', messageCount: 2 });
    expect(result.sessions[0].items).toMatchObject([{ kind: 'user', text: 'Fix the tests' }, { kind: 'assistant', text: 'Tests fixed.' }]);
    expect(result.skippedFiles).toBe(0);
    expect(result.malformedLines).toBe(0);
  });

  it('does not offer a transcript consisting only of local command artifacts', async () => {
    await jsonl('claude/projects/encoded/session.jsonl', [
      claude('user', '<command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args>'),
      claude('user', '<local-command-stdout></local-command-stdout>', { uuid: 'stdout' }),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(1);
  });

  it.each([
    '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>src/main</command-args>',
    '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/main</command-args>',
  ])('keeps model-facing slash commands as readable prompts: %s', async (command) => {
    await jsonl('claude/projects/encoded/session.jsonl', [claude('user', command), claude('assistant', 'Review complete.')]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions[0].candidate).toMatchObject({ title: '/review src/main', messageCount: 2 });
    expect(result.sessions[0].items).toMatchObject([{ kind: 'user', text: '/review src/main' }, { kind: 'assistant', text: 'Review complete.' }]);
  });

  it('preserves namespaced commands, multiline arguments and authoritative custom titles', async () => {
    await jsonl('claude/projects/encoded/session.jsonl', [
      claude('user', '<command-message>team:review</command-message><command-name>/team:review</command-name><command-args>Inspect café.ts\nKeep <types> intact</command-args>'),
      { type: 'custom-title', customTitle: 'Team review', sessionId: 'claude-session' },
    ]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Team review', messageCount: 1 });
    expect(result.sessions[0].items).toMatchObject([{ kind: 'user', text: '/team:review Inspect café.ts\nKeep <types> intact' }]);
  });

  it('does not treat a local clear artifact as permission to delete earlier conversation', async () => {
    await jsonl('claude/projects/encoded/session.jsonl', [
      claude('user', 'Accepted question'), claude('assistant', 'Accepted answer'),
      claude('user', '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>', { uuid: 'clear' }),
      claude('user', 'Next question', { uuid: 'next' }),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions[0].items).toMatchObject([
      { kind: 'user', text: 'Accepted question' }, { kind: 'assistant', text: 'Accepted answer' }, { kind: 'user', text: 'Next question' },
    ]);
  });

  it('filters individual artifact blocks without losing real text or assistant examples', async () => {
    const command = '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>';
    await jsonl('claude/projects/encoded/session.jsonl', [
      claude('user', [
        { type: 'text', text: command },
        { type: 'text', text: 'Keep this genuine prompt' },
        { type: 'text', text: '<local-command-stdout>Local output</local-command-stdout>' },
      ]),
      claude('assistant', command),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Keep this genuine prompt', messageCount: 2 });
    expect(result.sessions[0].items).toMatchObject([{ kind: 'user', text: 'Keep this genuine prompt' }, { kind: 'assistant', text: command }]);
  });

  it.each([
    '/clear',
    'Explain <command-name>/clear</command-name> and how it works.',
    '<command-name>/clear</command-name><command-message>Explain what this command does</command-message><command-args></command-args>',
    '<command-name>/clear</command-name><command-message>clear</command-message><command-name>/clear</command-name><command-args></command-args>',
    '<command-name>/clear</command-name>',
    '<command-name>/clear</command-name><command-message>clear</command-message><command-args>unfinished',
    '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>\nPlease explain this record.',
    '```xml\n<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>\n```',
    '<local-command-stdout>unfinished',
    '<local-command-stdout>example</local-command-stdout>\nExplain the output.',
    '<local-command-stdout>first</local-command-stdout>\nPlease compare these outputs.\n<local-command-stdout>second</local-command-stdout>',
  ])('preserves genuine prose and incomplete command lookalikes: %s', async (text) => {
    await jsonl('claude/projects/encoded/session.jsonl', [claude('user', text)]);
    const result = await discoverChatImports('claude', { claudeDir: path.join(fixture, 'claude') });
    expect(result.sessions[0].items).toMatchObject([{ kind: 'user', text }]);
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
  it('removes a rolled-back user turn, its assistant output and later context-only or autonomous activity', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
      codexEvent('task_started', { turn_id: 'discard' }),
      codex('user', 'Discard question'), codexEvent('user_message', { message: 'Discard question' }),
      codex('assistant', 'Discard commentary', { phase: 'commentary' }),
      codex('user', '<environment_context>hidden cwd update</environment_context>'),
      codex('assistant', 'Discard answer', { phase: 'final_answer' }),
      codexEvent('task_started', { turn_id: 'automatic' }), codex('assistant', 'Discard automatic continuation'),
      codexEvent('thread_rolled_back', { num_turns: 1 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].candidate.messageCount).toBe(2);
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
    expect(JSON.stringify(result)).not.toMatch(/Discard|hidden cwd/);
  });

  it('counts real user prompts rather than task starts or mirrored events, including mid-turn steering', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codexEvent('task_started', { turn_id: 'one' }),
      codex('user', 'Keep question'), codexEvent('user_message', { message: 'Keep question' }), codex('assistant', 'Keep answer'),
      codexEvent('task_started', { turn_id: 'two' }),
      codex('user', 'Discard question'), codexEvent('user_message', { message: 'Discard question' }), codex('assistant', 'Discard answer'),
      codex('user', 'Discard steer'), codexEvent('user_message', { message: 'Discard steer' }), codex('assistant', 'Discard steered answer'),
      codexEvent('thread_rolled_back', { num_turns: 2 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
  });

  it('applies repeated rollback before replacement turns and allows discarded message identifiers to be reused', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Discard first', { id: 'user-reused' }), codex('assistant', 'Discard first answer', { id: 'answer-reused' }),
      codex('user', 'Discard second'), codex('assistant', 'Discard second answer'),
      codexEvent('thread_rolled_back', { num_turns: 1 }),
      codex('user', 'Discard replacement'), codex('assistant', 'Discard replacement answer'),
      codexEvent('thread_rolled_back', { num_turns: 2 }),
      codex('user', 'Final replacement', { id: 'user-reused' }), codex('assistant', 'Final answer', { id: 'answer-reused' }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Final replacement', messageCount: 2 });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Final replacement', 'Final answer']);
  });

  it('preserves the prefix before the first real prompt when rollback exceeds the available turn count', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('assistant', 'Standalone prefix'), codex('user', 'Discard question'), codex('assistant', 'Discard answer'),
      codexEvent('thread_rolled_back', { num_turns: 99 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items).toMatchObject([{ kind: 'assistant', text: 'Standalone prefix' }]);
  });

  it('treats zero rollback and rollback without any previous user prompt as no-ops', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('assistant', 'Standalone prefix'), codexEvent('thread_rolled_back', { num_turns: 5 }),
      codex('user', 'Keep question'), codex('assistant', 'Keep answer'), codexEvent('thread_rolled_back', { num_turns: 0 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items).toHaveLength(3);
  });

  it('counts image-only prompts even though attachments are excluded from imported text', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
      { type: 'response_item', timestamp: finish, payload: { type: 'message', role: 'user', id: 'image-question', content: [{ type: 'input_image', image_url: 'private-image' }] } },
      codex('assistant', 'Discard image analysis'), codexEvent('thread_rolled_back', { num_turns: 1 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
  });

  it('does not import an empty conversation after all user turns are rolled back', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [meta(), codex('user', 'Discard question'), codex('assistant', 'Discard answer'), codexEvent('thread_rolled_back', { num_turns: 1 })]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(1);
    expect(result.malformedLines).toBe(0);
  });

  it('excludes contextual user fragments from rollback boundaries but retains ordinary lookalike prompts', async () => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
      codex('user', '<environment_context>user-authored text without closing marker'), codex('assistant', 'Discard answer'),
      codex('user', '# AGENTS.md instructions for /work/app\n<INSTRUCTIONS>context</INSTRUCTIONS>'),
      { type: 'response_item', timestamp: finish, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }, { type: 'input_text', text: 'Mixed contextual fragment' }] } },
      codexEvent('thread_rolled_back', { num_turns: 1 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
  });

  it('counts structured assistant inter-agent instructions while excluding their text from imported chats', async () => {
    const instruction = JSON.stringify({ author: 'root', recipient: 'root/child', content: 'Hidden inter-agent instruction', trigger_turn: true });
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
      codex('assistant', instruction), codex('assistant', 'Discard inter-agent answer'),
      codexEvent('thread_rolled_back', { num_turns: 1 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
  });

  it.each([
    '<environment_context>cwd update</environment_context>',
    '<ENVIRONMENT_CONTEXT>case-insensitive native marker</ENVIRONMENT_CONTEXT>',
    '<user_shell_command>shell result</user_shell_command>',
    '<turn_aborted>runtime interruption</turn_aborted>',
    '<subagent_notification>child status</subagent_notification>',
    '<agent_message_board_notification>board status</agent_message_board_notification>',
    '<recommended_plugins>plugin catalog</recommended_plugins>',
    '<skill>selected skill</skill>',
    '# AGENTS.md instructions for /work/app\n<INSTRUCTIONS>project rules</INSTRUCTIONS>',
    '# agents.md instructions for /work/app\n<instructions>case-insensitive native marker</instructions>',
    '<goal_context>legacy internal context</goal_context>',
    '<codex_internal_context source="task_1">internal steering</codex_internal_context>',
    '<external_file_context>external context</external_file_context>',
    '<external_>empty-key external context</external_>',
    'Warning: apply_patch was requested via a shell. Use the apply_patch tool instead of exec_command.',
    'Warning: The maximum number of unified exec processes you can keep open is 64.',
    'Warning: Your account was flagged for potentially high-risk cyber activity. Runtime notice.',
    '<hook_prompt hook_run_id="hook-run-1">Runtime steering</hook_prompt>',
    "<hook_prompt hook_run_id='hook-run-1'>Retry with tests &amp; care.</hook_prompt>",
    '<hook_prompt other="retained" hook_run_id="hook&#45;run&#x2D;1">Retry &lt;carefully&gt;.</hook_prompt>',
  ])('does not let a native contextual fragment consume the rollback boundary: %s', async (context) => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
      codex('user', 'Discard question'), codex('assistant', 'Discard answer'),
      codex('user', context), codexEvent('thread_rolled_back', { num_turns: 1 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
  });

  it.each([
    '<environment_context extra="not-a-native-marker">An actual prompt</environment_context>',
    '<GOAL_CONTEXT>An actual prompt</GOAL_CONTEXT>',
    '<CODEX_INTERNAL_CONTEXT source="task">An actual prompt</CODEX_INTERNAL_CONTEXT>',
    '<codex_internal_context source="INVALID">An actual prompt</codex_internal_context>',
    '<external_note>An actual prompt</external_other>',
    '<hook_prompt>An actual prompt with no run id</hook_prompt>',
    '<hook_prompt hook_run_id="">An actual prompt with an empty run id</hook_prompt>',
    '<hook_prompt hook_run_id=" &#32;&#x20; ">Whitespace run id</hook_prompt>',
    '<hook_prompt hook_run_id=unquoted>An actual prompt</hook_prompt>',
    '<hook_prompt hook_run_id="one" hook_run_id="two">Duplicate attribute</hook_prompt>',
    '<hook_prompt hook_run_id="one">Unescaped & body</hook_prompt>',
    '<hook_prompt hook_run_id="&unknown;">Unknown entity</hook_prompt>',
    '<hook_prompt hook_run_id="&#0;">Invalid XML character</hook_prompt>',
    '<HOOK_PROMPT hook_run_id="hook-run-1">Case-sensitive XML</HOOK_PROMPT>',
    '<hook_prompt hook_run_id="hook-run-1">Incomplete wrapper',
  ])('retains genuine lookalike prompts as rollback boundaries: %s', async (prompt) => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
      codex('user', prompt), codex('assistant', 'Discard answer'), codexEvent('thread_rolled_back', { num_turns: 1 }),
    ]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
  });

  it('excludes the exact synthetic compaction prefix from rollback boundaries without reading replacement history', async () => {
    const prefix = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
      meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
      codex('user', 'Discard question'), codex('assistant', 'Discard answer'),
      codex('user', prefix + '\nSynthetic summary'), codexEvent('thread_rolled_back', { num_turns: 1 }),
    ]);
    const options = { codexDir: path.join(fixture, 'codex') };
    expect((await discoverChatImports('codex', options)).sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
    for (const prompt of [prefix, ' ' + prefix + '\nAn ordinary prefixed prompt']) {
      await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [
        meta(), codex('user', 'Keep question'), codex('assistant', 'Keep answer'),
        codex('user', prompt), codex('assistant', 'Discard answer'), codexEvent('thread_rolled_back', { num_turns: 1 }),
      ]);
      expect((await discoverChatImports('codex', options)).sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Keep question', 'Keep answer']);
    }
  });

  it.each([-1, 0.5, '1', undefined, 4_294_967_296])('refuses a history with an invalid rollback count (%s) instead of importing discarded turns', async (num_turns) => {
    await jsonl('codex/sessions/2026/06/01/rollout-session.jsonl', [meta(), codex('user', 'Potentially discarded'), codexEvent('thread_rolled_back', { num_turns })]);
    const result = await discoverChatImports('codex', { codexDir: path.join(fixture, 'codex') });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(1);
    expect(result.malformedLines).toBe(1);
  });

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
