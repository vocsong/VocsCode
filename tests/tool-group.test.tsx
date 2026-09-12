/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TranscriptItem } from '../src/shared/types';
import { groupTranscript, ToolGroup } from '../src/renderer/src/components/Transcript';

let seq = 0;
const tool = (over: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): Extract<TranscriptItem, { kind: 'tool' }> => ({
  id: `t${++seq}`,
  kind: 'tool',
  ts: 0,
  name: 'bash',
  hint: 'execute',
  status: 'done',
  ...over,
});

describe('groupTranscript', () => {
  it('groups consecutive execute tools', () => {
    const items = [tool(), tool(), tool()];
    const chunks = groupTranscript(items);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: 'group', items });
  });

  it('keeps a lone execute tool standalone', () => {
    const items = [tool()];
    expect(groupTranscript(items)).toEqual([{ kind: 'single', item: items[0] }]);
  });

  it('breaks groups on non-execute tools and other item kinds', () => {
    const read = tool({ hint: 'read' });
    const msg: TranscriptItem = { id: 'm1', kind: 'assistant', ts: 0, text: 'hi' };
    const chunks = groupTranscript([tool(), tool(), read, tool(), msg, tool(), tool()]);
    expect(chunks).toHaveLength(5);
    expect(chunks.filter((c) => c.kind === 'group')).toHaveLength(2);
  });

  it('breaks groups across different nesting parents', () => {
    const top = tool();
    const nested = tool({ parentId: 'agent1' });
    const chunks = groupTranscript([top, nested, top]);
    expect(chunks).toHaveLength(3);
  });

  it('flushes a trailing run', () => {
    const chunks = groupTranscript([tool({ hint: 'read' }), tool(), tool()]);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({ kind: 'group' });
  });
});

describe('ToolGroup', () => {
  const items = [
    tool({ summary: 'git status', output: 'clean' }),
    tool({ summary: 'git push', output: 'ok' }),
  ];

  it('renders collapsed by default showing the ran count', () => {
    render(<ToolGroup items={items} />);
    expect(screen.getByText('Ran 2 commands')).toBeTruthy();
    expect(screen.queryByText('git status')).toBeNull();
  });

  it('expands on click and collapses again', () => {
    const { container } = render(<ToolGroup items={items} />);
    const head = container.querySelector('.tool-group-head') as HTMLElement;
    fireEvent.click(head);
    expect(screen.getByText('git status')).toBeTruthy();
    expect(screen.getByText('git push')).toBeTruthy();
    fireEvent.click(head);
    expect(screen.queryByText('git status')).toBeNull();
  });

  it('is expanded while a command is running', () => {
    const running = [items[0], tool({ status: 'running', summary: 'npm test' })];
    render(<ToolGroup items={running} />);
    expect(screen.getByText('Running 2 commands')).toBeTruthy();
    expect(screen.getByText('git status')).toBeTruthy();
  });

  it('shows a failed badge when a command errored', () => {
    render(<ToolGroup items={[tool({ status: 'error', exitCode: 1 }), items[0]]} />);
    expect(screen.getByText('1 failed')).toBeTruthy();
  });
});