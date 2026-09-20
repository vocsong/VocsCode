/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApprovalRequest, TranscriptItem } from '../src/shared/types';
import { groupCommands, groupTranscript, ToolGroup, WorkGroup } from '../src/renderer/src/components/Transcript';

afterEach(cleanup);

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

const approval = (id: string, decided = false): TranscriptItem => ({
  id,
  kind: 'approval',
  ts: 0,
  request: { id, sessionId: 's', harness: 'native', kind: 'command', title: 'Run it?', options: [], createdAt: 0 } as ApprovalRequest,
  ...(decided ? { decision: { optionId: 'allow' } } : {})
});

const workEntries = (chunks: ReturnType<typeof groupTranscript>): TranscriptItem[] => {
  const work = chunks.find((c) => c.kind === 'work');
  if (!work || work.kind !== 'work') throw new Error('no work chunk');
  return work.entries;
};

describe('groupTranscript', () => {
  it('collapses a turn of commands and commentary into one work chunk', () => {
    const items = [tool(), text('m1', 'checking'), tool()];
    const chunks = groupTranscript(items);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: 'work', entries: items });
  });

  it('keeps users, answers, warnings, plans and turns outside the work', () => {
    const items: TranscriptItem[] = [
      { id: 'u1', kind: 'user', ts: 0, text: 'go' },
      tool({ id: 'c1' }),
      { id: 'w1', kind: 'info', ts: 0, level: 'warn', text: 'MCP unavailable' },
      { id: 'p1', kind: 'plan', ts: 0, entries: [] },
      text('a1', 'the answer'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 12_000 }
    ];
    const chunks = groupTranscript(items);
    expect(chunks.map((c) => c.kind)).toEqual(['single', 'work', 'single', 'single', 'single', 'single']);
    expect(workEntries(chunks).map((e) => e.id)).toEqual(['c1']);
  });

  it('keeps an approval inside the work so one turn keeps one header', () => {
    const items = [tool({ id: 'c1' }), approval('ap1'), tool({ id: 'c2' })];
    const chunks = groupTranscript(items);
    expect(chunks).toHaveLength(1);
    expect(workEntries(chunks).map((e) => e.id)).toEqual(['c1', 'ap1', 'c2']);
  });

  it('keeps info-level lines inside the work', () => {
    const items: TranscriptItem[] = [tool({ id: 'c1' }), { id: 'i1', kind: 'info', ts: 0, level: 'info', text: 'Compacted.' }, tool({ id: 'c2' })];
    const chunks = groupTranscript(items);
    expect(chunks).toHaveLength(1);
    expect(workEntries(chunks).map((e) => e.id)).toEqual(['c1', 'i1', 'c2']);
  });

  it('treats an unlabelled text before another command as commentary and the trailing one as the answer', () => {
    const items = [tool({ id: 'c1' }), text('m1', 'narrating'), tool({ id: 'c2' }), text('m2', 'all done')];
    const chunks = groupTranscript(items);
    expect(chunks.map((c) => c.kind)).toEqual(['work', 'single']);
    expect(workEntries(chunks).map((e) => e.id)).toEqual(['c1', 'm1', 'c2']);
    expect(chunks[1]).toMatchObject({ kind: 'single', item: { id: 'm2' } });
  });

  it('treats thinking-only items as work and keeps an explicit final outside', () => {
    const thinking = { id: 'th1', kind: 'assistant', ts: 0, text: '', thinking: 'hmm' } as TranscriptItem;
    const final: TranscriptItem = { id: 'f1', kind: 'assistant', ts: 0, text: 'answer', phase: 'final' };
    const items = [tool({ id: 'c1' }), thinking, tool({ id: 'c2' }), final];
    const chunks = groupTranscript(items);
    expect(chunks.map((c) => c.kind)).toEqual(['work', 'single']);
    expect(workEntries(chunks).map((e) => e.id)).toEqual(['c1', 'th1', 'c2']);
  });

  it('splits work when an item that must stay visible sits between two runs', () => {
    const items: TranscriptItem[] = [tool({ id: 'c1' }), { id: 'p1', kind: 'plan', ts: 0, entries: [] }, tool({ id: 'c2' })];
    const chunks = groupTranscript(items);
    expect(chunks.map((c) => c.kind)).toEqual(['work', 'single', 'work']);
  });

  it('gives each work chunk the duration of the turn that closed it', () => {
    const items: TranscriptItem[] = [
      tool({ id: 'c1' }),
      text('a1', 'one'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 4200 },
      { id: 'u2', kind: 'user', ts: 0, text: 'again' },
      tool({ id: 'c2' }),
      text('a2', 'two'),
      { id: 'turn2', kind: 'turn', ts: 0, status: 'interrupted', durationMs: 900 }
    ];
    const chunks = groupTranscript(items);
    const work = chunks.filter((c) => c.kind === 'work');
    expect(work.map((c) => (c.kind === 'work' ? c.turn : null))).toEqual([
      { status: 'completed', durationMs: 4200 },
      { status: 'interrupted', durationMs: 900 }
    ]);
  });

  it('finds the work behind a trailing warning line when the turn closes', () => {
    const items: TranscriptItem[] = [
      tool({ id: 'c1' }),
      { id: 'w1', kind: 'info', ts: 0, level: 'warn', text: 'context is getting full' },
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 5000 }
    ];
    const chunks = groupTranscript(items);
    expect(chunks.find((c) => c.kind === 'work')).toMatchObject({ turn: { status: 'completed', durationMs: 5000 } });
  });
});

describe('groupCommands', () => {
  it('collapses consecutive commands into one run', () => {
    const items = [tool({ id: 'c1' }), tool({ id: 'c2' })];
    expect(groupCommands(items)).toEqual([{ kind: 'run', id: 'c1', entries: items }]);
  });

  it('keeps a lone command as its own row', () => {
    const cmd = tool({ id: 'c1' });
    expect(groupCommands([cmd])).toEqual([{ kind: 'single', item: cmd }]);
  });

  it('lets commentary break a run', () => {
    const items = [tool({ id: 'c1' }), text('m1', 'note'), tool({ id: 'c2' })];
    expect(groupCommands(items).map((c) => c.kind)).toEqual(['single', 'single', 'single']);
  });

  it('breaks a run at a non-command tool and at a different nesting parent', () => {
    const read = tool({ id: 'r1', hint: 'read' });
    const top = tool({ id: 'c1' });
    const nested = tool({ id: 'c2', parentId: 'agent1' });
    expect(groupCommands([top, read, nested]).map((c) => c.kind)).toEqual(['single', 'single', 'single']);
  });
});

describe('WorkGroup', () => {
  const props = { sessionId: 's', showThinking: false, onImageExpand: () => undefined } as const;
  const chunk = (entries: TranscriptItem[], turn?: { status: 'completed'; durationMs: number }) => ({ kind: 'work' as const, id: entries[0]!.id, entries, turn });

  it('renders collapsed showing the worked duration and hides its entries', () => {
    render(<WorkGroup chunk={chunk([tool({ summary: 'git status', output: 'clean' })], { status: 'completed', durationMs: 47_000 })} {...props} />);
    expect(screen.getByText('Worked for 47.0s')).toBeTruthy();
    expect(screen.queryByText('git status')).toBeNull();
  });

  it('expands on click to show its commands and collapses again', () => {
    const { container } = render(<WorkGroup chunk={chunk([tool({ summary: 'git status' })])} {...props} />);
    fireEvent.click(container.querySelector('.work-head') as HTMLElement);
    expect(screen.getByText('git status')).toBeTruthy();
    fireEvent.click(container.querySelector('.work-head') as HTMLElement);
    expect(screen.queryByText('git status')).toBeNull();
  });

  it('stays open while live and shows the working label', () => {
    render(<WorkGroup chunk={chunk([tool({ summary: 'npm test', status: 'running' })])} {...props} live />);
    expect(screen.getByText('Working…')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('shows commentary but keeps its thinking collapsed', () => {
    const entry = { id: 'a1', kind: 'assistant', ts: 0, text: 'Looking into it', thinking: 'private reasoning' } as TranscriptItem;
    const { container } = render(<WorkGroup chunk={chunk([tool(), entry])} {...props} showThinking />);
    fireEvent.click(container.querySelector('.work-head') as HTMLElement);
    expect(screen.getByText('Looking into it')).toBeTruthy();
    expect(screen.queryByText('private reasoning')).toBeNull();
    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.getByText('private reasoning')).toBeTruthy();
  });

  it('flags failed commands on the collapsed header', () => {
    render(<WorkGroup chunk={chunk([tool({ status: 'error', exitCode: 1 }), tool()])} {...props} />);
    expect(screen.getByText('1 failed')).toBeTruthy();
  });

  it('stays open while an approval is undecided', () => {
    render(<WorkGroup chunk={chunk([tool(), approval('ap1')])} {...props} />);
    expect(screen.getByText('Run it?')).toBeTruthy();
  });

  it('collapses again once the only approval has been decided', () => {
    render(<WorkGroup chunk={chunk([tool(), approval('ap2', true)])} {...props} />);
    expect(screen.queryByText('Run it?')).toBeNull();
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

  it('labels a command row Ran and opens its shell panel with the command and exit status', () => {
    const cmd = tool({ summary: 'npm run build', output: 'built ok', durationMs: 2400 });
    const read = tool({ hint: 'read', name: 'read_file', summary: 'src/a.ts' });
    const { container } = render(<ToolGroup entries={[cmd, read]} {...props} />);
    fireEvent.click(container.querySelector('.tool-group-head') as HTMLElement);
    expect(screen.getByText('Ran')).toBeTruthy();
    fireEvent.click(container.querySelector('.tool-head') as HTMLElement);
    expect(screen.getByText('Shell')).toBeTruthy();
    expect(container.querySelector('.shell-cmd')?.textContent).toContain('npm run build');
    expect(container.querySelector('.shell-foot')?.textContent).toContain('done');
    expect(container.querySelector('.shell-foot')?.textContent).toContain('2.4s');
  });
});
