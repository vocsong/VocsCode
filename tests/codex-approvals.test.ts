/**
 * Offline tests for the Codex app-server approval handlers. The legacy applyPatchApproval request
 * must not auto-approve patches that write outside the workspace (issue #125).
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import type { ApprovalDecision, PermissionMode, SessionEvent } from '../src/shared/types';
import { deferred } from '../src/main/util/async';

const ROOT = path.resolve(path.sep, 'tmp', 'vocs-codex-approvals');

type ApprovalHandler = (params: unknown) => Promise<unknown>;

function makeAdapter(mode: PermissionMode, decision: ApprovalDecision = { optionId: 'allow' }) {
  const events: SessionEvent[] = [];
  const requestApproval = vi.fn(async (_draft: ApprovalDraft) => decision);
  const handlers = new Map<string, ApprovalHandler>();
  const ctx = {
    emit: (e: SessionEvent) => events.push(e),
    session: () => ({ cwd: ROOT, usage: {} }),
    permissionMode: () => mode,
    requestApproval,
    log: vi.fn(),
    updateMeta: vi.fn(),
    updateRef: vi.fn(),
    sessionDir: ROOT
  } as unknown as HarnessContext;
  const adapter = new CodexAppServerAdapter(ctx);
  const rpc = {
    onServerRequest: (method: string, handler: ApprovalHandler) => handlers.set(method, handler),
    onNotification: vi.fn()
  };
  (adapter as unknown as { wireServerRequests: (client: unknown) => void }).wireServerRequests(rpc);
  const applyPatch = handlers.get('applyPatchApproval');
  if (!applyPatch) throw new Error('applyPatchApproval handler was not registered');
  const requestUserInput = handlers.get('item/tool/requestUserInput');
  if (!requestUserInput) throw new Error('item/tool/requestUserInput handler was not registered');
  return { applyPatch, requestUserInput, requestApproval, events };
}

function questionInput() {
  return { questions: [{ id: 'database', header: 'Storage', question: 'Which database?', isOther: true, isSecret: false, options: [{ label: 'SQLite', description: 'Local storage' }, { label: 'Postgres', description: 'Shared storage' }] }] };
}

describe('item/tool/requestUserInput answers', () => {
  it.each(['SQLite', 'A custom database\nwith a typed explanation'])('delivers the raw answer plus the trimmed card comment (%s)', async (answer) => {
    const decision = { optionId: 'allow', answers: { database: answer }, note: '  Keep deployment simple.\n ' };
    const { requestUserInput, requestApproval } = makeAdapter('ask', decision);
    await expect(requestUserInput(questionInput())).resolves.toEqual({
      answers: { database: { answers: [`${answer}\n\nAdditional context: Keep deployment simple.`] } }
    });
    expect(requestApproval).toHaveBeenCalledExactlyOnceWith({
      kind: 'question', title: 'Codex has a question',
      options: [{ id: 'allow', label: 'Answer', kind: 'allow' }, { id: 'deny', label: 'Skip', kind: 'deny' }],
      questions: [{ id: 'database', header: 'Storage', question: 'Which database?', options: questionInput().questions[0]!.options, allowOther: true, secret: false }]
    });
    expect(decision).toEqual({ optionId: 'allow', answers: { database: answer }, note: '  Keep deployment simple.\n ' });
  });

  it.each([undefined, '', ' \n '])('preserves existing selected, typed and empty answers without a nonblank note (%s)', async (note) => {
    const { requestUserInput } = makeAdapter('ask', { optionId: 'allow', answers: { database: 'SQLite', cache: '  Use a local cache.\n', empty: '' }, note });
    const input = { questions: [...questionInput().questions,
      { id: 'cache', header: 'Cache', question: 'Any cache?', isOther: true, isSecret: true, options: null },
      { id: 'empty', header: 'Empty', question: 'Anything else?', isOther: true, isSecret: false, options: null },
      { id: 'missing', header: 'Missing', question: 'Unanswered?', isOther: true, isSecret: false, options: null }
    ] };
    await expect(requestUserInput(input)).resolves.toEqual({
      answers: { database: { answers: ['SQLite'] }, cache: { answers: ['  Use a local cache.\n'] }, empty: { answers: [] }, missing: { answers: [] } }
    });
  });

  it.each([undefined, ''])('delivers a note-only answer as context, never an invented selection (%s)', async (answer) => {
    const { requestUserInput } = makeAdapter('ask', { optionId: 'allow', answers: answer === undefined ? undefined : { database: answer }, note: '  I need more information.  ' });
    await expect(requestUserInput(questionInput())).resolves.toEqual({
      answers: { database: { answers: ['No answer selected.\n\nAdditional context: I need more information.'] } }
    });
  });

  it('attaches the card comment to each question without filling an unanswered question with another selection', async () => {
    const { requestUserInput } = makeAdapter('ask', { optionId: 'allow', answers: { database: 'SQLite' }, note: 'Offline first.' });
    await expect(requestUserInput({ questions: [...questionInput().questions,
      { id: 'cache', header: 'Cache', question: 'Any cache?', isOther: true, isSecret: false, options: null }
    ] })).resolves.toEqual({ answers: {
      database: { answers: ['SQLite\n\nAdditional context: Offline first.'] },
      cache: { answers: ['No answer selected.\n\nAdditional context: Offline first.'] }
    } });
  });

  it('delivers only explicit skipped-question context on Skip with a comment, discarding all stale selections', async () => {
    const decision = { optionId: 'deny', answers: { database: 'SQLite', cache: 'Redis' }, note: '  Ask me after reviewing the schema.\n ' };
    const { requestUserInput, requestApproval } = makeAdapter('ask', decision);
    await expect(requestUserInput({ questions: [...questionInput().questions,
      { id: 'cache', header: 'Cache', question: 'Any cache?', isOther: true, isSecret: false, options: null }
    ] })).resolves.toEqual({ answers: {
      database: { answers: ['The user skipped the question.\n\nAdditional context: Ask me after reviewing the schema.'] },
      cache: { answers: ['The user skipped the question.\n\nAdditional context: Ask me after reviewing the schema.'] }
    } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(decision.answers).toEqual({ database: 'SQLite', cache: 'Redis' });
  });

  it.each([undefined, ' \n '])('returns empty arrays on Skip without a nonblank comment, ignoring stale answers (%s)', async (note) => {
    const { requestUserInput } = makeAdapter('ask', { optionId: 'deny', answers: { database: 'SQLite' }, note });
    await expect(requestUserInput(questionInput())).resolves.toEqual({ answers: { database: { answers: [] } } });
  });

  it('does not promote another approval option to a question answer', async () => {
    const { requestUserInput } = makeAdapter('full-auto', { optionId: 'allow_session', answers: { database: 'SQLite' } });
    await expect(requestUserInput(questionInput())).resolves.toEqual({ answers: { database: { answers: [] } } });
  });

  it('still waits for a real question decision in full-auto mode', async () => {
    const { requestUserInput, requestApproval } = makeAdapter('full-auto');
    const pending = deferred<ApprovalDecision>();
    requestApproval.mockImplementationOnce(() => pending.promise);
    const settled = vi.fn();
    const result = requestUserInput(questionInput()).then(settled);
    await Promise.resolve();
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0].kind).toBe('question');
    expect(settled).not.toHaveBeenCalled();
    pending.resolve({ optionId: 'allow', answers: { database: 'Postgres' }, note: 'Shared access.' });
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith({ answers: { database: { answers: ['Postgres\n\nAdditional context: Shared access.'] } } });
  });

  it('propagates approval failures instead of responding with stale selected answers', async () => {
    const { requestUserInput, requestApproval } = makeAdapter('ask', { optionId: 'allow', answers: { database: 'SQLite' }, note: 'Never delivered.' });
    requestApproval.mockRejectedValueOnce(new Error('Question approval unavailable'));
    await expect(requestUserInput(questionInput())).rejects.toThrow('Question approval unavailable');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});

const inside = path.join(ROOT, 'src', 'app.ts');
const outside = path.resolve(ROOT, '..', 'elsewhere', 'secret.txt');

describe('applyPatchApproval workspace scope', () => {
  it('auto-approves in-workspace patches in auto mode without prompting', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto');
    await expect(applyPatch({ fileChanges: { [inside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('prompts for an outside-workspace patch in auto mode and honors the decision', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto', { optionId: 'allow' });
    await expect(applyPatch({ reason: 'update', fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const draft = requestApproval.mock.calls[0]![0];
    expect(draft.kind).toBe('file_change');
    expect(draft.changes?.map((c) => c.path)).toEqual([outside]);
  });

  it('prompts for an outside-workspace patch in accept-edits mode', async () => {
    const { applyPatch, requestApproval } = makeAdapter('accept-edits', { optionId: 'deny', note: 'not that file' });
    await expect(applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: { denied: { rejection: 'not that file' } } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('denies outside-workspace patches when the user declines', async () => {
    const { applyPatch } = makeAdapter('auto', { optionId: 'deny' });
    await expect(applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: { denied: { rejection: 'User declined' } } });
  });

  it('treats a grantRoot request as outside the workspace below full access', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto');
    await applyPatch({ fileChanges: { [inside]: {} }, grantRoot: path.resolve(ROOT, '..') });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('prompts when a patch moves an in-workspace file outside the workspace', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto');
    await applyPatch({ fileChanges: { [inside]: { type: 'update', unified_diff: '', move_path: outside } } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still asks for in-workspace patches in ask mode', async () => {
    const { applyPatch, requestApproval } = makeAdapter('ask');
    await expect(applyPatch({ fileChanges: { [inside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('leaves plan mode denying patches and full-auto approving them', async () => {
    const plan = makeAdapter('plan');
    await expect(plan.applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: { denied: { rejection: 'Plan mode' } } });
    expect(plan.requestApproval).not.toHaveBeenCalled();

    const full = makeAdapter('full-auto');
    await expect(full.applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(full.requestApproval).not.toHaveBeenCalled();
  });
});
