/** @vitest-environment jsdom */
/** The approval card answers with the harness's real option ids, carries question answers and
 *  edited input, and degrades honestly when the host refuses the answer (view-only or a browser). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApprovalCard } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import type { ApprovalDecision, ApprovalRequest, TranscriptItem } from '../src/shared/types';

const invoke = vi.fn(async (): Promise<void> => undefined);
const can = vi.fn((_channel: string) => true);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  can.mockReset();
  can.mockReturnValue(true);
  (window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke, on: () => () => undefined, can };
  useStore.setState({ remoteAccess: { viewOnly: false }, toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const request: ApprovalRequest = {
  id: 'ap1', sessionId: 's1', harness: 'acp', kind: 'permission', title: 'Run a command',
  command: 'rm -rf build', cwd: '/repo',
  options: [
    { id: 'acp-allow-once', label: 'Allow once', kind: 'allow' },
    { id: 'acp-deny', label: 'Deny', kind: 'deny' }
  ],
  createdAt: 1
};

const item = (request: ApprovalRequest, decision?: ApprovalDecision): Extract<TranscriptItem, { kind: 'approval' }> =>
  ({ id: 'ap1', kind: 'approval', ts: 1, request, decision });

it('sends the harness option id with the question answers and the edited command', () => {
  const req: ApprovalRequest = {
    ...request,
    input: { command: 'rm -rf build' },
    questions: [{ id: 'q1', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'production' }] }]
  };
  const { container } = render(<ApprovalCard item={item(req)} sessionId="s1" />);
  fireEvent.click(screen.getByRole('button', { name: 'staging' }));
  fireEvent.change(container.querySelector('.approval-cmd')!, { target: { value: 'rm -rf dist' } });
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

  expect(invoke).toHaveBeenCalledWith('approvals:respond', {
    sessionId: 's1',
    requestId: 'ap1',
    decision: {
      optionId: 'acp-allow-once',
      note: undefined,
      answers: { q1: 'staging' },
      updatedInput: { command: 'rm -rf dist' }
    }
  });
});

it('unselects a chosen option when it is clicked again, and sends no answer for that question', () => {
  const req: ApprovalRequest = {
    ...request,
    questions: [{ id: 'q1', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'production' }] }]
  };
  render(<ApprovalCard item={item(req)} sessionId="s1" />);
  const staging = screen.getByRole('button', { name: 'staging' });
  fireEvent.click(staging);
  expect(staging.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(staging);
  expect(staging.getAttribute('aria-pressed')).toBe('false');
  expect(staging.className).not.toContain('active');
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('approvals:respond', expect.objectContaining({
    decision: expect.objectContaining({ optionId: 'acp-allow-once', answers: {} })
  }));
});

it('switches to another option without keeping the previous one', () => {
  const req: ApprovalRequest = {
    ...request,
    questions: [{ id: 'q1', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'production' }] }]
  };
  render(<ApprovalCard item={item(req)} sessionId="s1" />);
  fireEvent.click(screen.getByRole('button', { name: 'staging' }));
  fireEvent.click(screen.getByRole('button', { name: 'production' }));
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  expect(invoke).toHaveBeenCalledWith('approvals:respond', expect.objectContaining({
    decision: expect.objectContaining({ answers: { q1: 'production' } })
  }));
});

it('labels a decided card by the option the harness chose, not a hardcoded allow', () => {
  render(<ApprovalCard item={item(request, { optionId: 'acp-deny' })} sessionId="s1" />);
  expect(screen.getByText('Deny')).toBeTruthy();
  expect(screen.getByText('rm -rf build')).toBeTruthy();
});

it('does not present stale selected answers as accepted on a skipped question', () => {
  const req: ApprovalRequest = { ...request, kind: 'question', questions: [{ id: 'q1', question: 'Where?', options: [{ label: 'production', description: 'Ship publicly.' }] }] };
  render(<ApprovalCard item={item(req, { optionId: 'acp-deny', answers: { q1: 'production' }, note: 'Wait for review.' })} sessionId="s1" />);
  expect(screen.queryByText('production', { exact: true })).toBeNull();
  expect(screen.queryByText('Ship publicly.', { exact: true })).toBeNull();
  expect(screen.getByText('No answer provided')).toBeTruthy();
  expect(screen.getByText('Wait for review.')).toBeTruthy();
});

it('tells the user to decide on the computer when the answer would be refused', () => {
  can.mockImplementation((channel: string) => channel !== 'approvals:respond');
  render(<ApprovalCard item={item(request)} sessionId="s1" />);
  expect(screen.getByText('Decide on your computer')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
});

it('reports a failed answer as an error toast', async () => {
  invoke.mockRejectedValueOnce(new Error('not paired'));
  render(<ApprovalCard item={item(request)} sessionId="s1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  await waitFor(() => expect(useStore.getState().toasts.some((t) => t.kind === 'error' && t.text.includes('not paired'))).toBe(true));
});

const question: ApprovalRequest = {
  id: 'question1', sessionId: 's1', harness: 'pi', kind: 'question', title: 'Deployment',
  questions: [{
    id: 'environment', question: 'Which environment?', allowOther: true,
    options: [
      { label: 'staging', description: 'Test safely before shipping to customers.' },
      { label: 'production', description: 'Ship directly to all customers.' }
    ]
  }],
  options: [{ id: 'answer', label: 'Answer', kind: 'allow' }, { id: 'skip', label: 'Skip', kind: 'deny' }],
  createdAt: 1
};

const contextLabel = 'Additional context (optional)';

function expectQuestionDecision(optionId: string, answers: Record<string, string>, note: string) {
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('approvals:respond', {
    sessionId: 's1', requestId: 'question1', decision: { optionId, answers, note }
  });
}

describe('structured questions', () => {
  it('shows option details upfront, with a label-only button name and linked description', () => {
    render(<ApprovalCard item={item(question)} sessionId="s1" />);
    for (const option of question.questions![0]!.options!) {
      const button = screen.getByRole('button', { name: option.label });
      const description = within(button).getByText(option.description!);
      expect(description.hidden).toBe(false);
      expect(button.getAttribute('aria-describedby')).toBe(description.id);
      expect(description.id).not.toBe('');
      expect(button.getAttribute('title')).toBeNull();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('submits the chosen option together with optional card-level context before the actions', () => {
    const { container } = render(<ApprovalCard item={item(question)} sessionId="s1" />);
    const staging = screen.getByRole('button', { name: 'staging' });
    fireEvent.click(staging);
    const context = screen.getByRole('textbox', { name: contextLabel });
    fireEvent.change(context, { target: { value: '  Use the release branch.  ' } });
    expect(staging.getAttribute('aria-pressed')).toBe('true');
    expect(context.compareDocumentPosition(container.querySelector('.approval-actions')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expectQuestionDecision('answer', { environment: 'staging' }, 'Use the release branch.');
  });

  it('keeps a typed alternative separate from the additional context', () => {
    render(<ApprovalCard item={item(question)} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Type an answer/ }), { target: { value: 'preview' } });
    fireEvent.change(screen.getByRole('textbox', { name: contextLabel }), { target: { value: 'For the design review only.' } });
    expect(screen.getByRole('button', { name: 'staging' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expectQuestionDecision('answer', { environment: 'preview' }, 'For the design review only.');
  });

  it('clears a typed alternative when a listed option is selected', () => {
    render(<ApprovalCard item={item(question)} sessionId="s1" />);
    const alternative = screen.getByRole('textbox', { name: /Type an answer/ }) as HTMLInputElement;
    fireEvent.change(alternative, { target: { value: 'preview' } });
    fireEvent.click(screen.getByRole('button', { name: 'production' }));
    expect(alternative.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(invoke).toHaveBeenCalledWith('approvals:respond', expect.objectContaining({
      decision: { optionId: 'answer', answers: { environment: 'production' }, note: undefined }
    }));
  });

  it('submits context when the question is skipped', () => {
    render(<ApprovalCard item={item(question)} sessionId="s1" />);
    fireEvent.change(screen.getByRole('textbox', { name: contextLabel }), { target: { value: 'Wait for release approval.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expectQuestionDecision('skip', {}, 'Wait for release approval.');
  });

  it('does not offer context on a raw extension dialog that cannot carry it', () => {
    render(<ApprovalCard item={item({ ...question, supportsQuestionComment: false })} sessionId="s1" />);
    expect(screen.queryByRole('textbox', { name: contextLabel })).toBeNull();
    expect(screen.queryByPlaceholderText(/note for the agent/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(invoke).toHaveBeenCalledWith('approvals:respond', expect.objectContaining({
      decision: { optionId: 'answer', answers: { environment: 'staging' }, note: undefined }
    }));
  });

  it('renders the persisted answer and its details, not a stale local selection or every option', () => {
    const { rerender } = render(<ApprovalCard item={item(question)} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    fireEvent.change(screen.getByRole('textbox', { name: contextLabel }), { target: { value: 'Unsaved draft' } });
    rerender(<ApprovalCard item={item(question, { optionId: 'answer', answers: { environment: 'production' }, note: 'Saved release context' })} sessionId="s1" />);
    expect(screen.getByText('production')).toBeTruthy();
    expect(screen.getByText('Ship directly to all customers.')).toBeTruthy();
    expect(screen.getByText('Additional context')).toBeTruthy();
    expect(screen.getByText('Saved release context')).toBeTruthy();
    expect(screen.queryByText('staging')).toBeNull();
    expect(screen.queryByText('Unsaved draft')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders persisted typed answers and their context on answered cards', () => {
    render(<ApprovalCard item={item(question, { optionId: 'answer', answers: { environment: 'preview' }, note: 'Preview only; do not deploy publicly.' })} sessionId="s1" />);
    expect(screen.getByText('Answer').className).toContain('badge-green');
    expect(screen.getByText('preview')).toBeTruthy();
    expect(screen.getByText('Preview only; do not deploy publicly.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('requires a nonblank answer or context before answering a structured question', () => {
    render(<ApprovalCard item={item(question)} sessionId="s1" />);
    const answer = screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Type an answer' }), { target: { value: '   ' } });
    fireEvent.change(screen.getByRole('textbox', { name: contextLabel }), { target: { value: '   ' } });
    expect(answer.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    expect(answer.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    expect(answer.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: contextLabel }), { target: { value: 'I need advice before choosing.' } });
    expect(answer.disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Skip' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('validates the combined encoded response before submitting and retains a draft that is too long', async () => {
    render(<ApprovalCard item={item({ ...question, maxQuestionResponseLength: 100 })} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    const context = screen.getByRole('textbox', { name: contextLabel }) as HTMLTextAreaElement;
    fireEvent.change(context, { target: { value: '"'.repeat(60) } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('100-character response limit');
    expect(context.value).toBe('"'.repeat(60));
    expect(context.disabled).toBe(false);
    fireEvent.change(context, { target: { value: 'After review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('approvals:respond', expect.objectContaining({ decision: expect.objectContaining({ answers: { environment: 'staging' }, note: 'After review.' }) }));
  });

  it('never reveals a persisted secret answer or its matching option details', () => {
    const secret = { ...question, questions: [{ ...question.questions![0]!, secret: true }] };
    const { container } = render(<ApprovalCard item={item(secret, { optionId: 'answer', answers: { environment: 'staging' } })} sessionId="s1" />);
    expect(screen.getByText('Answer hidden')).toBeTruthy();
    expect(container.innerHTML).not.toContain('staging');
    expect(container.innerHTML).not.toContain('Test safely');
  });

  it('masks a typed secret while editing', () => {
    render(<ApprovalCard item={item({ ...question, questions: [{ id: 'token', question: 'Access token?', secret: true }] })} sessionId="s1" />);
    expect(screen.getByLabelText(/Type an answer/).getAttribute('type')).toBe('password');
  });

  it('disables all editable fields for a client without response capability', () => {
    can.mockImplementation((channel: string) => channel !== 'approvals:respond');
    render(<ApprovalCard item={item({ ...question, command: 'deploy staging', input: { command: 'deploy staging' } })} sessionId="s1" />);
    expect((screen.getByRole('button', { name: 'staging' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: /Type an answer/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: contextLabel }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Command' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(screen.getByText('Decide on your computer')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('locks all editing and prevents duplicate submissions until the saved decision arrives', async () => {
    let resolve!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    render(<ApprovalCard item={item({ ...question, command: 'deploy staging' })} sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    fireEvent.change(screen.getByRole('textbox', { name: contextLabel }), { target: { value: 'Ship carefully.' } });
    const answer = screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    fireEvent.click(answer);
    fireEvent.click(answer);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    for (const control of [...screen.getAllByRole('button'), ...screen.getAllByRole('textbox')]) {
      expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByRole('status').textContent).toContain('Sending');
    expectQuestionDecision('answer', { environment: 'staging' }, 'Ship carefully.');
    await act(async () => resolve());
    expect(answer.disabled).toBe(true);
    fireEvent.click(answer);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['staging', 'preview'])('preserves the %s answer, context and edited command on IPC failure and allows one retry', async (value) => {
    invoke.mockRejectedValueOnce(new Error('connection lost'));
    render(<ApprovalCard item={item({ ...question, command: 'deploy staging', input: { command: 'deploy staging' } })} sessionId="s1" />);
    if (value === 'staging') fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    else fireEvent.change(screen.getByRole('textbox', { name: /Type an answer/ }), { target: { value } });
    const context = screen.getByRole('textbox', { name: contextLabel }) as HTMLTextAreaElement;
    const command = screen.getByRole('textbox', { name: 'Command' }) as HTMLTextAreaElement;
    fireEvent.change(context, { target: { value: 'Keep the canary small.' } });
    fireEvent.change(command, { target: { value: 'deploy staging --canary' } });
    const answer = screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement;
    fireEvent.click(answer);
    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.kind === 'error' && t.text.includes('connection lost'))).toBe(true));
    expect(answer.disabled).toBe(false);
    expect(context.value).toBe('Keep the canary small.');
    expect(command.value).toBe('deploy staging --canary');
    expect(screen.getByRole('button', { name: 'staging' }).getAttribute('aria-pressed')).toBe(value === 'staging' ? 'true' : 'false');
    expect((screen.getByRole('textbox', { name: /Type an answer/ }) as HTMLInputElement).value).toBe(value === 'preview' ? 'preview' : '');
    fireEvent.click(answer);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('approvals:respond', {
      sessionId: 's1', requestId: 'question1', decision: {
        optionId: 'answer', answers: { environment: value }, note: 'Keep the canary small.',
        updatedInput: { command: 'deploy staging --canary' }
      }
    });
  });
});

it.each(['Allow once', 'Deny'])('keeps permission notes honestly deny-only when choosing %s', (action) => {
  render(<ApprovalCard item={item(request)} sessionId="s1" />);
  expect(screen.queryByRole('textbox', { name: contextLabel })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Note for the agent (sent with Deny only)' }), { target: { value: 'Do not delete the cache.' } });
  fireEvent.click(screen.getByRole('button', { name: action }));
  expect(invoke).toHaveBeenCalledWith('approvals:respond', expect.objectContaining({
    decision: { optionId: action === 'Deny' ? 'acp-deny' : 'acp-allow-once', note: action === 'Deny' ? 'Do not delete the cache.' : undefined }
  }));
});
