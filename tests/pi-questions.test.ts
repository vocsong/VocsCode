/** Question tool and host RPC boundary, including absence, cancellation and broker isolation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuestionTool, parseQuestionInput, parseQuestionPayload, QUESTION_MARKER, type QuestionPayload } from '../resources/pi/question-tool';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import type { ApprovalDecision } from '../src/shared/types';

const input = { question: 'Which environment?', options: [{ label: 'staging', description: 'Preview the release.' }, { label: 'production', description: 'Update the public service.' }] };
const payload: QuestionPayload = { ...input, header: 'Deployment', version: 1, nonce: 'question-runtime', toolCallId: 'tool-question' };

beforeEach(() => {
  vi.stubEnv('VOCS_CODE_PI_NONCE', 'question-runtime');
  vi.stubEnv('VOCS_CODE_MISSION_POLICY', '');
});
afterEach(() => vi.unstubAllEnvs());

function host(decision: ApprovalDecision = { optionId: 'allow', answers: { answer: 'staging' }, note: 'Wait for Friday.' }, mission = false) {
  const requestApproval = vi.fn(async () => decision);
  const log = vi.fn();
  const ctx = { session: () => ({ cwd: '/repo', usage: {}, ...(mission ? { mission: {} } : {}) }), requestApproval, log, emit: vi.fn() } as unknown as HarnessContext;
  const adapter = new PiAdapter(ctx);
  const access = adapter as unknown as { handleUiRequest(request: object): Promise<void>; extensionNonce: string; write(message: object): void };
  access.extensionNonce = 'question-runtime';
  const write = vi.fn(); access.write = write;
  const ask = (data: unknown = payload) => access.handleUiRequest({ id: 'dialog1', method: 'select', title: QUESTION_MARKER + JSON.stringify(data), options: ['staging', 'production'] });
  return { ask, access, write, requestApproval, log };
}

describe('Pi structured question host bridge', () => {
  it('preserves option descriptions and returns selection plus comment without changing the selection', async () => {
    const h = host(); await h.ask();
    expect(h.requestApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'question', toolName: 'ask_user', toolItemId: 'tool-question',
      questions: [{ id: 'answer', header: 'Deployment', question: input.question, options: input.options, allowOther: true }],
    }));
    expect(h.write).toHaveBeenCalledTimes(1);
    const reply = h.write.mock.calls[0][0] as { type: string; id: string; value: string };
    expect(reply).toMatchObject({ type: 'extension_ui_response', id: 'dialog1' });
    expect(JSON.parse(reply.value)).toEqual({ cancelled: false, answer: 'staging', comment: 'Wait for Friday.' });
  });

  it('returns only cancellation and context for Skip, never stale selected answers', async () => {
    const h = host({ optionId: 'deny', answers: { answer: 'production' }, note: 'Do not deploy yet.' }); await h.ask();
    expect(JSON.parse(h.write.mock.calls[0][0].value)).toEqual({ cancelled: true, comment: 'Do not deploy yet.' });
  });

  it.each([{ ...payload, nonce: 'old-runtime' }, { ...payload, version: 2 }, { ...payload, options: [{ label: '' }] }])('rejects invalid/stale request metadata before asking', async (bad) => {
    const h = host(); await h.ask(bad);
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledExactlyOnceWith({ type: 'extension_ui_response', id: 'dialog1', cancelled: true });
  });

  it('returns cancellation if the pending host approval is interrupted', async () => {
    const h = host(); h.requestApproval.mockRejectedValueOnce(new Error('Session stopped'));
    await h.ask();
    expect(h.write).toHaveBeenCalledExactlyOnceWith({ type: 'extension_ui_response', id: 'dialog1', cancelled: true });
  });

  it('keeps managed Mission questions on the broker even if a runtime requests this dialog', async () => {
    const h = host(undefined, true); await h.ask();
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledExactlyOnceWith({ type: 'extension_ui_response', id: 'dialog1', cancelled: true });
  });

  it('keeps raw extension selects exact and does not advertise unsupported comments', async () => {
    const h = host({ optionId: 'allow', answers: { choice: 'staging' }, note: 'not part of scalar choice' });
    await h.access.handleUiRequest({ id: 'raw', method: 'select', title: 'Choose', options: ['staging'] });
    expect(h.requestApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ supportsQuestionComment: false }));
    expect(h.write).toHaveBeenCalledExactlyOnceWith({ type: 'extension_ui_response', id: 'raw', value: 'staging' });
  });
});

describe('Pi question tool', () => {
  it('uses RPC-compatible UI and returns selected answer and context as separate model-facing fields', async () => {
    const select = vi.fn(async (_title: string) => JSON.stringify({ cancelled: false, answer: 'staging', comment: 'After review.' }));
    const result = await createQuestionTool().execute('tool-question', input, undefined, undefined, { hasUI: true, ui: { select } });
    expect(select).toHaveBeenCalledTimes(1);
    expect(parseQuestionPayload(select.mock.calls[0][0].slice(QUESTION_MARKER.length), 'question-runtime')).toMatchObject({ question: input.question, options: input.options });
    expect(result.details).toEqual({ question: input.question, cancelled: false, answer: 'staging', comment: 'After review.' });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
  });

  it('never invents an answer for a cancelled dialog', async () => {
    const result = await createQuestionTool().execute('q', input, undefined, undefined, { hasUI: true, ui: { select: async () => undefined } });
    expect(result.details).toEqual({ question: input.question, cancelled: true });
    expect(result.content[0].text).toContain('Do not infer a choice');
  });

  it('refuses to ask when UI is absent, an abort has already happened, or a Mission broker owns the conversation', async () => {
    const select = vi.fn(); const ctx = { hasUI: true, ui: { select } };
    await expect(createQuestionTool().execute('q', input, undefined, undefined, { hasUI: false })).rejects.toThrow(/UI is unavailable/);
    await expect(createQuestionTool().execute('q', input, AbortSignal.abort(), undefined, ctx)).rejects.toThrow(/interrupted/);
    vi.stubEnv('VOCS_CODE_MISSION_POLICY', '{}');
    await expect(createQuestionTool().execute('q', input, undefined, undefined, ctx)).rejects.toThrow(/Mission broker/);
    expect(select).not.toHaveBeenCalled();
  });

  it.each(['not json', '{}', '{"cancelled":false}', '{"cancelled":false,"answer":4}'])('rejects malformed app reply %j rather than treating it as an answer', async (reply) => {
    await expect(createQuestionTool().execute('q', input, undefined, undefined, { hasUI: true, ui: { select: async () => reply } })).rejects.toThrow();
  });

  it('does not accept a custom choice when typed alternatives are disabled', async () => {
    await expect(createQuestionTool().execute('q', { ...input, allowOther: false }, undefined, undefined, { hasUI: true, ui: { select: async () => JSON.stringify({ cancelled: false, answer: 'elsewhere' }) } })).rejects.toThrow(/outside the offered options/);
  });

  it.each([{ question: '' }, { ...input, options: [{ label: 'same' }, { label: 'same' }] }, { question: 'x', allowOther: false }, { ...input, options: Array(13).fill({ label: 'a' }) }])('bounds and validates tool input %j', (bad) => {
    expect(() => parseQuestionInput(bad)).toThrow();
  });
});
