/** Offline coverage of structured answers at the Claude SDK canUseTool boundary. */
import path from 'node:path';
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import type { ApprovalDecision, PermissionMode, SessionEvent } from '../src/shared/types';
import { AsyncQueue, deferred } from '../src/main/util/async';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter } from '../src/main/harness/claude';

const ROOT = path.resolve(path.sep, 'tmp', 'vocs-claude-questions');
const adapters: ClaudeAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  queryMock.mockReset();
});

function questionInput() {
  return { questions: [{ header: 'Storage', question: 'Which database?', options: [{ label: 'SQLite', description: 'Local storage' }, { label: 'Postgres', description: 'Shared storage' }], multiSelect: false }] };
}

async function makeAdapter(decision: ApprovalDecision, mode: PermissionMode = 'ask') {
  const events: SessionEvent[] = [];
  const requestApproval = vi.fn(async (_draft: ApprovalDraft) => decision);
  const messages = new AsyncQueue<SDKMessage>();
  queryMock.mockReturnValue({ [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close() });
  const ctx = {
    sessionId: 'claude-questions',
    sessionDir: ROOT,
    session: () => ({ cwd: ROOT, config: { harness: 'claude', projectRoot: ROOT, permissionMode: mode }, harnessRef: {}, usage: {} }),
    settings: () => ({ claude: { settingSources: [], useProviderKey: false }, providers: [] }),
    runtime: { resolve: () => ({ path: process.execPath, source: 'system' }) },
    permissionMode: () => mode,
    effort: () => undefined,
    getApiKey: async () => undefined,
    mcpServers: async () => [],
    emit: (event: SessionEvent) => events.push(event),
    requestApproval,
    updateRef: vi.fn(),
    updateMeta: vi.fn(),
    log: vi.fn()
  } as unknown as HarnessContext;
  const adapter = new ClaudeAdapter(ctx);
  adapters.push(adapter);
  await adapter.start();
  const options = (queryMock.mock.calls.at(-1)![0] as { options: Options }).options;
  const canUseTool = options.canUseTool as CanUseTool;
  const ask = (input: Record<string, unknown> = questionInput()) => canUseTool('AskUserQuestion', input, {
    signal: new AbortController().signal, toolUseID: 'question-tool', requestId: 'question-request'
  });
  return { ask, requestApproval, events };
}

describe('Claude structured question answers', () => {
  it.each(['SQLite', 'A custom database\nwith a typed explanation'])('delivers the raw answer plus the trimmed card comment (%s)', async (answer) => {
    const decision = { optionId: 'allow', answers: { '0': answer }, note: '  Keep deployment simple.\n ' };
    const { ask, requestApproval } = await makeAdapter(decision);
    const input = questionInput();
    await expect(ask(input)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Which database?': `${answer}\n\nAdditional context: Keep deployment simple.` } }
    });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0]).toEqual({
      kind: 'question', title: 'Claude has a question', toolName: 'AskUserQuestion', input,
      options: [{ id: 'allow', label: 'Answer', kind: 'allow' }, { id: 'deny', label: 'Skip', kind: 'deny' }],
      questions: [{ id: '0', header: 'Storage', question: 'Which database?', options: input.questions[0]!.options, allowOther: true }]
    });
    expect(decision).toEqual({ optionId: 'allow', answers: { '0': answer }, note: '  Keep deployment simple.\n ' });
  });

  it.each([undefined, '', ' \n '])('preserves existing selected and typed answers without a nonblank note (%s)', async (note) => {
    const { ask } = await makeAdapter({ optionId: 'allow', answers: { '0': 'SQLite', '1': '  Use a local cache.\n', '2': '' }, note });
    const input = { questions: [...questionInput().questions, { question: 'Any cache?' }, { question: 'Anything else?' }, { question: 'Unanswered?' }] };
    await expect(ask(input)).resolves.toEqual({
      behavior: 'allow', updatedInput: { ...input, answers: { 'Which database?': 'SQLite', 'Any cache?': '  Use a local cache.\n', 'Anything else?': '' } }
    });
  });

  it.each([undefined, ''])('delivers a note-only answer as context, never an invented selection (%s)', async (answer) => {
    const { ask } = await makeAdapter({ optionId: 'allow', answers: answer === undefined ? undefined : { '0': answer }, note: '  I need more information.  ' });
    const input = questionInput();
    await expect(ask(input)).resolves.toEqual({
      behavior: 'allow', updatedInput: { ...input, answers: { 'Which database?': 'No answer selected.\n\nAdditional context: I need more information.' } }
    });
  });

  it('attaches the card comment to each question without filling an unanswered question with another selection', async () => {
    const { ask } = await makeAdapter({ optionId: 'allow', answers: { '0': 'SQLite' }, note: 'Offline first.' });
    const input = { questions: [...questionInput().questions, { question: 'Any cache?' }] };
    await expect(ask(input)).resolves.toEqual({
      behavior: 'allow', updatedInput: { ...input, answers: {
        'Which database?': 'SQLite\n\nAdditional context: Offline first.',
        'Any cache?': 'No answer selected.\n\nAdditional context: Offline first.'
      } }
    });
  });

  it('uses the trimmed denial comment on Skip and never returns stale selected answers', async () => {
    const { ask, requestApproval } = await makeAdapter({ optionId: 'deny', answers: { '0': 'SQLite' }, note: '  Ask me after reviewing the schema.\n ' });
    await expect(ask()).resolves.toEqual({ behavior: 'deny', message: 'Ask me after reviewing the schema.' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, ' \n '])('keeps the default Skip reason without a nonblank comment and discards stale answers (%s)', async (note) => {
    const { ask } = await makeAdapter({ optionId: 'deny', answers: { '0': 'SQLite' }, note });
    await expect(ask()).resolves.toEqual({ behavior: 'deny', message: 'The user skipped the question.' });
  });

  it('still waits for a real question decision in full-auto mode', async () => {
    const { ask, requestApproval } = await makeAdapter({ optionId: 'allow' }, 'full-auto');
    const pending = deferred<ApprovalDecision>();
    requestApproval.mockImplementationOnce(() => pending.promise);
    const settled = vi.fn();
    const result = ask().then(settled);
    await Promise.resolve();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0].kind).toBe('question');
    expect(settled).not.toHaveBeenCalled();
    pending.resolve({ optionId: 'allow', answers: { '0': 'Postgres' }, note: 'Shared access.' });
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith({ behavior: 'allow', updatedInput: { ...questionInput(), answers: { 'Which database?': 'Postgres\n\nAdditional context: Shared access.' } } });
  });

  it('propagates approval failures rather than returning an allowed answer', async () => {
    const { ask, requestApproval } = await makeAdapter({ optionId: 'allow', answers: { '0': 'SQLite' }, note: 'Never delivered.' });
    requestApproval.mockRejectedValueOnce(new Error('Question approval unavailable'));
    await expect(ask()).rejects.toThrow('Question approval unavailable');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});
