/** @vitest-environment jsdom */
/** The approval card answers with the harness's real option ids, carries question answers and
 *  edited input, and degrades honestly when the host refuses the answer (view-only or a browser). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApprovalCard } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import type { ApprovalDecision, ApprovalRequest, TranscriptItem } from '../src/shared/types';

const invoke = vi.fn(async () => undefined);
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

it('labels a decided card by the option the harness chose, not a hardcoded allow', () => {
  render(<ApprovalCard item={item(request, { optionId: 'acp-deny' })} sessionId="s1" />);
  expect(screen.getByText('Deny')).toBeTruthy();
  expect(screen.getByText('rm -rf build')).toBeTruthy();
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
