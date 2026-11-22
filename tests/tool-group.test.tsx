/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApprovalRequest, TranscriptItem } from '../src/shared/types';
import { groupCommands, groupTranscript, ToolGroup, WorkGroup } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';

afterEach(() => {
  cleanup();
  useStore.setState({ searchJump: null });
});

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

describe('groupTranscript', () => {
  const kinds = (chunks: ReturnType<typeof groupTranscript>) => chunks.map((c) => (c.kind === 'work' ? `work:${c.entries.map((e) => e.id).join(',')}` : c.kind === 'single' ? c.item.id : c.kind));
  const thinking = (id: string, over: Partial<Extract<TranscriptItem, { kind: 'assistant' }>> = {}): TranscriptItem => ({ id, kind: 'assistant', ts: 0, text: '', thinking: 'hmm', ...over });
  const turns = (chunks: ReturnType<typeof groupTranscript>) => chunks.flatMap((c) => (c.kind === 'work' ? [c.turn] : []));

  it('keeps every message on screen and collapses only the steps between them', () => {
    const items = [text('m1', 'Looking at the tree first.'), tool({ id: 'c1' }), text('m2', 'The tree is clean; branching.'), tool({ id: 'c2' }), tool({ id: 'c3' }), text('m3', 'all done')];
    expect(kinds(groupTranscript(items))).toEqual(['m1', 'work:c1', 'm2', 'work:c2,c3', 'm3']);
  });

  it('shows a message the same way whatever phase its harness gave it', () => {
    for (const phase of [undefined, 'commentary', 'final', 'plan'] as const) {
      const message = { ...text('m1', 'Checking the build.'), ...(phase ? { phase } : {}) } as TranscriptItem;
      expect(kinds(groupTranscript([message, tool({ id: 'c1' }), text('m2', 'done')]))).toEqual(['m1', 'work:c1', 'm2']);
    }
  });

  it('keeps users, answers, warnings and turns outside the work', () => {
    const items: TranscriptItem[] = [
      { id: 'u1', kind: 'user', ts: 0, text: 'go' },
      tool({ id: 'c1' }),
      { id: 'w1', kind: 'info', ts: 0, level: 'warn', text: 'MCP unavailable' },
      text('a1', 'the answer'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 12_000 }
    ];
    expect(kinds(groupTranscript(items))).toEqual(['u1', 'work:c1', 'w1', 'a1', 'turn1']);
  });

  it('keeps a plan update inside the work instead of splitting it in two', () => {
    const items: TranscriptItem[] = [tool({ id: 'c1' }), { id: 'p1', kind: 'plan', ts: 0, entries: [] }, tool({ id: 'c2' }), text('a1', 'done')];
    expect(kinds(groupTranscript(items))).toEqual(['work:c1,p1,c2', 'a1']);
  });

  it('keeps an approval inside the work so one stretch keeps one header', () => {
    const items = [tool({ id: 'c1' }), approval('ap1'), tool({ id: 'c2' })];
    expect(kinds(groupTranscript(items))).toEqual(['work:c1,ap1,c2']);
  });

  it('keeps info-level lines inside the work', () => {
    const items: TranscriptItem[] = [tool({ id: 'c1' }), { id: 'i1', kind: 'info', ts: 0, level: 'info', text: 'Compacted.' }, tool({ id: 'c2' })];
    expect(kinds(groupTranscript(items))).toEqual(['work:c1,i1,c2']);
  });

  it('keeps every reply visible when background follow-ups do more work before the turn closes', () => {
    const items: TranscriptItem[] = [
      tool({ id: 'c1' }),
      text('report', 'The change is merged.'),
      { ...text('p1', 'Fetching the result'), phase: 'commentary' } as TranscriptItem,
      tool({ id: 'lookup1', name: 'subagent_result', hint: 'agent' }),
      tool({ id: 'c2' }),
      text('update1', 'The review has no blockers.'),
      tool({ id: 'lookup2', name: 'subagent_result', hint: 'agent' }),
      text('update2', 'The background tests passed.'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed' }
    ];
    expect(kinds(groupTranscript(items))).toEqual(['work:c1', 'report', 'p1', 'work:lookup1,c2', 'update1', 'work:lookup2', 'update2', 'turn1']);
  });

  it('folds reasoning in with the steps beside it, and never puts a header over reasoning alone', () => {
    // Codex emits reasoning as rows of their own; Claude, Cursor, Pi, ACP and native put it on the
    // message's row. Either way a header only ever stands for steps.
    const items = [thinking('th0'), text('m1', 'On it.'), tool({ id: 'c1' }), thinking('th1'), tool({ id: 'c2' }), thinking('th2'), text('f1', 'answer')];
    expect(kinds(groupTranscript(items))).toEqual(['th0', 'm1', 'work:c1,th1,c2', 'th2', 'f1']);
  });

  it('keeps reasoning with the live work until the message it leads into arrives', () => {
    const live = [tool({ id: 'c1' }), thinking('th1', { streaming: true })];
    expect(kinds(groupTranscript(live))).toEqual(['work:c1,th1']);
    // Not a message: a turn row closing the work leaves the reasoning where it was.
    expect(kinds(groupTranscript([...live, { id: 'turn1', kind: 'turn', ts: 0, status: 'interrupted' }]))).toEqual(['work:c1,th1', 'turn1']);
  });

  it('shows a notice with no step beside it as its own line, not as a header over nothing', () => {
    const items: TranscriptItem[] = [
      text('a1', 'done'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed' },
      { id: 'i1', kind: 'info', ts: 0, level: 'info', text: 'Permission mode set to ask.' },
      { id: 'u2', kind: 'user', ts: 0, text: 'again' }
    ];
    expect(kinds(groupTranscript(items))).toEqual(['a1', 'turn1', 'i1', 'u2']);
  });

  it('keeps a message that also carries reasoning on screen', () => {
    const both = thinking('m1', { text: 'Reading the server first.' });
    expect(kinds(groupTranscript([both, tool({ id: 'c1' }), text('f1', 'answer')]))).toEqual(['m1', 'work:c1', 'f1']);
  });

  it('makes no row for reasoning when thinking is hidden, nor for a stream with nothing in it yet', () => {
    const items = [thinking('th0'), text('m1', 'On it.'), thinking('th1'), text('m2', 'Next.'), tool({ id: 'c1' }), thinking('th2'), text('f1', 'answer')];
    expect(kinds(groupTranscript(items, false))).toEqual(['m1', 'm2', 'work:c1', 'f1']);
    const pending: TranscriptItem = { id: 'a9', kind: 'assistant', ts: 0, text: '', streaming: true };
    expect(kinds(groupTranscript([text('m1', 'On it.'), pending]))).toEqual(['m1']);
  });

  it('splits work when an item that must stay visible sits between two runs', () => {
    const items: TranscriptItem[] = [tool({ id: 'c1' }), { id: 'w1', kind: 'info', ts: 0, level: 'warn', text: 'context is getting full' }, tool({ id: 'c2' })];
    expect(kinds(groupTranscript(items))).toEqual(['work:c1', 'w1', 'work:c2']);
  });

  it('gives a turn’s only stretch of work the duration of the turn that closed it', () => {
    const items: TranscriptItem[] = [
      text('m1', 'Checking.'),
      tool({ id: 'c1' }),
      text('a1', 'one'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 4200 },
      { id: 'u2', kind: 'user', ts: 0, text: 'again' },
      tool({ id: 'c2' }),
      text('a2', 'two'),
      { id: 'turn2', kind: 'turn', ts: 0, status: 'interrupted', durationMs: 900 }
    ];
    expect(turns(groupTranscript(items))).toEqual([
      { status: 'completed', durationMs: 4200 },
      { status: 'interrupted', durationMs: 900 }
    ]);
  });

  it('leaves the turn duration on the turn row when the turn worked in several stretches', () => {
    const items: TranscriptItem[] = [
      { id: 'u1', kind: 'user', ts: 0, text: 'go' },
      tool({ id: 'c1' }),
      text('m1', 'Now the tests.'),
      tool({ id: 'c2' }),
      text('a1', 'done'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 4200 }
    ];
    expect(turns(groupTranscript(items))).toEqual([undefined, undefined]);
  });

  it('does not let reasoning or a notice on its own block the turn duration', () => {
    const items: TranscriptItem[] = [
      thinking('th0'),
      text('m1', 'On it.'),
      tool({ id: 'c1' }),
      text('m2', 'Nearly there.'),
      { id: 'i1', kind: 'info', ts: 0, level: 'info', text: 'Compacted.' },
      text('a1', 'done'),
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 4200 }
    ];
    expect(turns(groupTranscript(items))).toEqual([{ status: 'completed', durationMs: 4200 }]);
  });

  it('finds the work behind a trailing warning line when the turn closes', () => {
    const items: TranscriptItem[] = [
      tool({ id: 'c1' }),
      { id: 'w1', kind: 'info', ts: 0, level: 'warn', text: 'context is getting full' },
      { id: 'turn1', kind: 'turn', ts: 0, status: 'completed', durationMs: 5000 }
    ];
    expect(turns(groupTranscript(items))).toEqual([{ status: 'completed', durationMs: 5000 }]);
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

  it('lets a thinking row break a run', () => {
    const items = [tool({ id: 'c1' }), { id: 'th1', kind: 'assistant', ts: 0, text: '', thinking: 'hmm' } as TranscriptItem, tool({ id: 'c2' })];
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

  it('keeps finished reasoning behind its own toggle once the work is opened', () => {
    const entry = { id: 'a1', kind: 'assistant', ts: 0, text: '', thinking: 'private reasoning' } as TranscriptItem;
    const { container } = render(<WorkGroup chunk={chunk([tool(), entry])} {...props} showThinking />);
    expect(container.querySelector('.thinking-toggle')).toBeNull();
    fireEvent.click(container.querySelector('.work-head') as HTMLElement);
    expect(screen.queryByText('private reasoning')).toBeNull();
    fireEvent.click(screen.getByText('Thinking'));
    expect(screen.getByText('private reasoning')).toBeTruthy();
  });

  it('shows reasoning while it is being written, then folds it away', () => {
    const entry = { id: 'a1', kind: 'assistant', ts: 0, text: '', thinking: 'private reasoning', streaming: true } as TranscriptItem;
    const view = render(<WorkGroup chunk={chunk([tool(), entry])} {...props} showThinking live />);
    expect(screen.getByText('Thinking…')).toBeTruthy();
    expect(screen.getByText('private reasoning')).toBeTruthy();
    view.rerender(<WorkGroup chunk={chunk([tool(), { ...entry, streaming: false } as TranscriptItem])} {...props} showThinking live />);
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.queryByText('private reasoning')).toBeNull();
  });

  it('opens the work and the reasoning a deep-search jump landed in', () => {
    const entry = { id: 'a1', kind: 'assistant', ts: 0, text: '', thinking: 'private reasoning' } as TranscriptItem;
    useStore.setState({ searchJump: { sessionId: 's', itemId: 'a1', n: 1 } });
    render(<WorkGroup chunk={chunk([tool({ summary: 'git status' }), entry])} {...props} showThinking />);
    expect(screen.getByText('git status')).toBeTruthy();
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

  it('keeps only the latest plan on screen while the work around it is collapsed', () => {
    const first: TranscriptItem = { id: 'p1', kind: 'plan', ts: 0, entries: [{ content: 'Write the limiter', status: 'in_progress' }, { content: 'Add tests', status: 'pending' }] };
    const latest: TranscriptItem = { id: 'p2', kind: 'plan', ts: 1, entries: [{ content: 'Write the limiter', status: 'completed' }, { content: 'Add tests', status: 'in_progress' }] };
    const { container } = render(<WorkGroup chunk={chunk([tool({ hint: 'read', name: 'Read', summary: 'git status' }), first, tool({ summary: 'npm test' }), latest], { status: 'completed', durationMs: 9000 })} {...props} />);
    // Collapsed: the steps are hidden, the one plan card is not.
    expect(screen.queryByText('git status')).toBeNull();
    expect(container.querySelectorAll('.plan-card')).toHaveLength(1);
    expect(container.querySelector('.plan-progress')?.textContent).toBe('1 of 2 done');
    expect(container.querySelector('.plan-completed')?.textContent).toContain('Write the limiter');
    expect(container.querySelector('.plan-in_progress')?.textContent).toContain('Add tests');
    // Opened: the steps appear and the plan is still shown once, not once per update.
    fireEvent.click(container.querySelector('.work-head') as HTMLElement);
    expect(screen.getByText('git status')).toBeTruthy();
    expect(container.querySelectorAll('.plan-card')).toHaveLength(1);
  });

  it('shows a plan-only turn as its card without an empty work header', () => {
    const plan: TranscriptItem = { id: 'p1', kind: 'plan', ts: 0, entries: [{ content: 'Read the code', status: 'pending' }] };
    const { container } = render(<WorkGroup chunk={chunk([plan])} {...props} />);
    expect(container.querySelector('.work-head')).toBeNull();
    expect(container.querySelector('.plan-card')?.textContent).toContain('Read the code');
  });

  it('sums the steps and the files they changed on the header', () => {
    const edit = tool({ hint: 'edit', name: 'Edit', summary: 'src/a.ts', changes: [{ path: 'src/a.ts', kind: 'update' }] });
    const write = tool({ hint: 'edit', name: 'Write', summary: 'src/b.ts', changes: [{ path: 'src/b.ts', kind: 'add' }, { path: 'src/a.ts', kind: 'update' }] });
    const { container } = render(<WorkGroup chunk={chunk([tool(), edit, write])} {...props} />);
    const stats = [...container.querySelectorAll('.work-head .work-stat')].map((el) => el.textContent);
    expect(stats).toEqual(['3 steps', '2 files changed']);
  });
});

describe('ToolCard rows', () => {
  const props = { sessionId: 's', showThinking: false, onImageExpand: () => undefined } as const;
  const open = (entries: TranscriptItem[]) => {
    const view = render(<WorkGroup chunk={{ kind: 'work', id: entries[0]!.id, entries }} {...props} />);
    fireEvent.click(view.container.querySelector('.work-head') as HTMLElement);
    return view;
  };

  it('gives a successful step no status badge, and a failed or declined one a badge', () => {
    const { container } = open([
      tool({ hint: 'read', name: 'Read', summary: 'src/ok.ts' }),
      tool({ hint: 'read', name: 'Read', summary: 'src/missing.ts', status: 'error' }),
      tool({ hint: 'edit', name: 'Edit', summary: 'src/locked.ts', status: 'declined' })
    ]);
    const rows = [...container.querySelectorAll('.tool-card')];
    expect(rows.map((row) => row.querySelector('.badge')?.textContent ?? null)).toEqual([null, 'error', 'declined']);
  });

  it('counts the lines an edit added and removed', () => {
    const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+added'].join('\n');
    const { container } = open([tool({ hint: 'edit', name: 'Edit', summary: 'src/a.ts', changes: [{ path: 'src/a.ts', kind: 'update', diff }] })]);
    expect(container.querySelector('.tool-changes .add')?.textContent).toBe('+2');
    expect(container.querySelector('.tool-changes .del')?.textContent).toBe('−1');
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
