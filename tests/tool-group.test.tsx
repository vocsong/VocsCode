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

const text = (id: string, txt: string): TranscriptItem => ({ id, kind: 'assistant', ts: 0, text: txt });

describe('groupTranscript', () => {
  it('groups consecutive execute tools', () => {
    const items = [tool(), tool(), tool()];
    const chunks = groupTranscript(items);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: 'group', entries: items });
  });

  it('keeps a lone execute tool standalone', () => {
    const items = [tool()];
    expect(groupTranscript(items)).toEqual([{ kind: 'single', item: items[0] }]);
  });

  it('breaks groups on non-execute tools and user/approval/turn items', () => {
    const read = tool({ hint: 'read' });
    const msg: TranscriptItem = { id: 'm1', kind: 'assistant', ts: 0, text: 'hi', streaming: false };
    const user: TranscriptItem = { id: 'u1', kind: 'user', ts: 0, text: 'go' };
    const chunks = groupTranscript([tool(), tool(), read, tool(), tool(), user, tool(), tool()]);
    expect(chunks.filter((c) => c.kind === 'group')).toHaveLength(3);
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

  it('absorbs assistant text between two commands but keeps trailing text outside', () => {
    const before = text('m1', 'checking');
    const after = text('m2', 'all done');
    const c1 = tool();
    const c2 = tool();
    const chunks = groupTranscript([before, c1, c2, after]);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: 'single', item: { id: 'm1' } });
    expect(chunks[1]).toMatchObject({ kind: 'group' });
    expect((chunks[1] as { entries: TranscriptItem[] }).entries.map((e) => e.id)).toEqual([c1.id, c2.id]);
    expect(chunks[2]).toMatchObject({ kind: 'single', item: { id: 'm2' } });
  });

  it('keeps commentary standalone when it does not sit between two commands', () => {
    const chunks = groupTranscript([tool(), text('m1', 'solo')]);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.kind === 'single')).toBe(true);
  });

  it('breaks the run when a different parent follows a run with commentary', () => {
    const msg = text('m1', 'note');
    const top = tool();
    const nested = tool({ parentId: 'agent1' });
    const chunks = groupTranscript([top, msg, nested]);
    expect(chunks).toHaveLength(3);
  });
});

describe('ToolGroup', () => {
  const items = [
    tool({ summary: 'git status', output: 'clean' }),
    tool({ summary: 'git push', output: 'ok' }),
  ];
  const props = { sessionId: 's', showThinking: false, onImageExpand: () => undefined } as const;

  it('renders collapsed by default showing the ran count', () => {
    render(<ToolGroup entries={items} {...props} />);
    expect(screen.getByText('Ran 2 commands')).toBeTruthy();
    expect(screen.queryByText('git status')).toBeNull();
  });

  it('expands on click and collapses again', () => {
    const { container } = render(<ToolGroup entries={items} {...props} />);
    const head = container.querySelector('.tool-group-head') as HTMLElement;
    fireEvent.click(head);
    expect(screen.getByText('git status')).toBeTruthy();
    expect(screen.getByText('git push')).toBeTruthy();
    fireEvent.click(head);
    expect(screen.queryByText('git status')).toBeNull();
  });

  it('is expanded while a command is running', () => {
    const running = [items[0], tool({ status: 'running', summary: 'npm test' })];
    render(<ToolGroup entries={running} {...props} />);
    expect(screen.getByText('Running 2 commands')).toBeTruthy();
    expect(screen.getByText('git status')).toBeTruthy();
  });

  it('shows interleaved assistant text inside the body when expanded', () => {
    const { container } = render(<ToolGroup entries={[items[0], text('m1', 'note between'), items[1]]} {...props} />);
    fireEvent.click(container.querySelector('.tool-group-head') as HTMLElement);
    expect(screen.getByText('note between')).toBeTruthy();
  });

  it('shows a failed badge when a command errored', () => {
    render(<ToolGroup entries={[tool({ status: 'error', exitCode: 1 }), items[0]]} {...props} />);
    expect(screen.getByText('1 failed')).toBeTruthy();
  });
});