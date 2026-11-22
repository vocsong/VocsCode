/** @vitest-environment jsdom */
/**
 * What the transcript keeps on screen and what it folds away, checked through the rendered
 * component: every assistant message stays visible, only steps collapse, and one turn reads the
 * same whichever harness produced it. Each fixture is the same turn in the shape that harness's
 * adapter emits (see the harness matrix in docs/ARCHITECTURE.md).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

type Assistant = Extract<TranscriptItem, { kind: 'assistant' }>;
type Tool = Extract<TranscriptItem, { kind: 'tool' }>;

const SID = 's_messages';
const session = (status: SessionMeta['status'] = 'idle') =>
  ({ id: SID, title: 't', cwd: '/w', status, config: { harness: 'native' }, harnessRef: {}, usage: {} }) as unknown as SessionMeta;

afterEach(() => {
  cleanup();
  useStore.setState({ transcripts: {}, loaded: {}, showThinking: true });
});

const M1 = 'Thanks for the report. Looking at the worktree first.';
const M2 = 'The tree is clean, so I am starting a fresh branch.';
const ANSWER = 'The list now scrolls; the regression test covers it.';
const R1 = 'The rule probably stops the list from shrinking.';
const R2 = 'Two sessions were not enough to overflow the rail.';
const R3 = 'Everything passes; summarise.';

const user: TranscriptItem = { id: 'u1', kind: 'user', ts: 1, text: 'The rail cannot scroll.' };
const turn: TranscriptItem = { id: 'turn1', kind: 'turn', ts: 99, status: 'completed', durationMs: 61_000 };
const say = (id: string, text: string, over: Partial<Assistant> = {}): Assistant => ({ id, kind: 'assistant', ts: 2, text, ...over });
const reason = (id: string, thinking: string, over: Partial<Assistant> = {}): Assistant => ({ id, kind: 'assistant', ts: 2, text: '', thinking, ...over });
const step = (id: string, summary: string, over: Partial<Tool> = {}): Tool => ({ id, kind: 'tool', ts: 2, name: 'shell', hint: 'execute', summary, status: 'done', ...over });
const steps = () => ({ c1: step('c1', 'git status --short'), c2: step('c2', 'grep -n seed tests/e2e.ui-modes.test.ts'), c3: step('c3', 'git checkout -q -b fix') });

/** The same turn — reason, say, step, reason, step, say, step, reason, answer — per adapter. */
const shapes: Record<string, () => TranscriptItem[]> = {
  // Claude, Cursor, ACP and native: no phase; reasoning rides on the row of the prose it precedes,
  // and is a row of its own only when a tool call follows it directly.
  'claude / cursor / acp / native': () => {
    const { c1, c2, c3 } = steps();
    return [user, say('a1', M1, { thinking: R1 }), c1, reason('a2', R2), c2, say('a3', M2), c3, say('a4', ANSWER, { thinking: R3 }), turn];
  },
  // Pi: as above, plus the empty rows a tool-only message leaves behind.
  pi: () => {
    const { c1, c2, c3 } = steps();
    return [user, say('a1', M1, { thinking: R1 }), c1, reason('a2', R2), c2, say('a3', M2), reason('a3b', ''), c3, say('a4', ANSWER, { thinking: R3 }), turn];
  },
  // Codex app-server: prose is labelled commentary or final; reasoning is always its own row.
  'codex app-server': () => {
    const { c1, c2, c3 } = steps();
    return [user, reason('r1', R1, { phase: 'commentary' }), say('m1', M1, { phase: 'commentary' }), c1, reason('r2', R2, { phase: 'commentary' }), c2, say('m2', M2, { phase: 'commentary' }), c3, reason('r3', R3, { phase: 'commentary' }), say('f1', ANSWER, { phase: 'final' }), turn];
  },
  // Codex exec: every message is labelled final, preambles included; reasoning is its own row.
  'codex exec': () => {
    const { c1, c2, c3 } = steps();
    return [user, reason('r1', R1, { phase: 'commentary' }), say('m1', M1, { phase: 'final' }), c1, reason('r2', R2, { phase: 'commentary' }), c2, say('m2', M2, { phase: 'final' }), c3, reason('r3', R3, { phase: 'commentary' }), say('f1', ANSWER, { phase: 'final' }), turn];
  }
};

function show(items: TranscriptItem[], status: SessionMeta['status'] = 'idle') {
  useStore.setState({ transcripts: { [SID]: items }, loaded: { [SID]: true } });
  return render(<Transcript session={session(status)} />);
}

/**
 * What a reader sees, row by row. Reasoning shows as the same collapsed toggle whether it sits on
 * the message's row or on the row above it, so a toggle directly before a message reads as part of it.
 */
function outline(container: HTMLElement): string[] {
  /** A row's words without its time: every row carries one, and it is not what the row says. */
  const words = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    for (const stamp of copy.querySelectorAll('.stamp')) stamp.remove();
    return copy.textContent!.trim();
  };
  const rows: string[] = [];
  for (const row of container.querySelectorAll('.transcript-row')) {
    if (row.querySelector('.msg-user')) rows.push('user');
    else if (row.querySelector('.turn-footer')) rows.push('turn');
    else if (row.querySelector('.work-head')) rows.push(`work: ${words(row.querySelector('.work-head')!)}`);
    else if (row.querySelector('.info-line')) rows.push(`notice: ${words(row.querySelector('.info-line')!)}`);
    else if (row.querySelector('.msg-assistant')) {
      const toggle = row.querySelector('.thinking-toggle') ? 'thinking + ' : '';
      const prose = row.querySelector('.md')?.textContent?.trim();
      if (prose === undefined) rows.push('thinking');
      else if (rows.at(-1) === 'thinking') rows[rows.length - 1] = `thinking + message: ${prose}`;
      else rows.push(`${toggle}message: ${prose}`);
    }
  }
  return rows;
}

describe('assistant messages stay on screen on every harness', () => {
  const expected = [
    'user',
    `thinking + message: ${M1}`,
    'work: Worked2 steps',
    `message: ${M2}`,
    'work: Worked1 step',
    `thinking + message: ${ANSWER}`,
    'turn'
  ];

  for (const [harness, items] of Object.entries(shapes)) {
    it(`${harness}: shows each message, folds only the steps, and keeps reasoning closed`, () => {
      const { container } = show(items());
      expect(outline(container)).toEqual(expected);
      // Nothing the reader did not ask for: no step rows, no reasoning text.
      expect(container.querySelectorAll('.tool-card, .tool-group-head')).toHaveLength(0);
      expect(container.querySelectorAll('.thinking-body')).toHaveLength(0);
      expect(container.querySelectorAll('.thinking-toggle')).toHaveLength(2);
      for (const head of container.querySelectorAll('.work-head')) expect(head.getAttribute('aria-expanded')).toBe('false');
    });

    it(`${harness}: reads the same with thinking hidden`, () => {
      useStore.setState({ showThinking: false });
      const { container } = show(items());
      expect(outline(container)).toEqual(expected.map((row) => row.replace('thinking + ', '')));
      expect(container.querySelectorAll('.thinking-toggle')).toHaveLength(0);
    });
  }

  it('opens a stretch of work on demand, with its reasoning still behind its own toggle', () => {
    const { container } = show(shapes['codex app-server']!());
    fireEvent.click(container.querySelector('.work-head')!);
    expect([...container.querySelectorAll('.work-body .tool-summary')].map((el) => el.textContent)).toEqual(['git status --short', 'grep -n seed tests/e2e.ui-modes.test.ts']);
    expect(container.querySelector('.work-body .thinking-toggle')).not.toBeNull();
    expect(container.querySelector('.work-body .thinking-body')).toBeNull();
    fireEvent.click(container.querySelector('.work-body .thinking-toggle')!);
    expect(container.querySelector('.work-body .thinking-body')?.textContent).toBe(R2);
  });

  it('puts the turn duration on the header only when the turn worked in one stretch', () => {
    const { c1, c2 } = steps();
    const { container } = show([user, say('a1', M1), c1, c2, say('a2', ANSWER), turn]);
    expect(outline(container)).toEqual(['user', `message: ${M1}`, 'work: Worked for 1m 1s2 steps', `message: ${ANSWER}`, 'turn']);
  });

  it('shows a notice that sits apart from any step as a line, and one among the steps inside them', () => {
    const { c1, c2 } = steps();
    const { container } = show([
      user,
      c1,
      { id: 'i1', kind: 'info', ts: 3, level: 'info', text: 'Context compacted.' },
      c2,
      say('a1', ANSWER),
      turn,
      { id: 'i2', kind: 'info', ts: 100, level: 'info', text: 'Permission mode set to ask.' }
    ]);
    expect(outline(container)).toEqual(['user', 'work: Worked for 1m 1s2 steps', `message: ${ANSWER}`, 'turn', 'notice: Permission mode set to ask.']);
  });
});

describe('work in flight', () => {
  const heads = (container: HTMLElement) => [...container.querySelectorAll('.work-head')].map((head) => `${head.querySelector('.work-label')!.textContent} ${head.getAttribute('aria-expanded')}`);
  const set = (items: TranscriptItem[]) => act(() => useStore.setState({ transcripts: { [SID]: items } }));

  it('keeps the running stretch open and folds it once the next message starts', () => {
    const first = step('c1', 'git status --short', { status: 'running' });
    const { container } = show([user, say('a1', M1), first], 'running');
    expect(heads(container)).toEqual(['Working… true']);
    expect(container.querySelector('.tool-card')?.textContent).toContain('git status --short');

    // Reasoning after the step is still part of the work in flight, and shows while it streams.
    const done = { ...first, status: 'done' as const };
    set([user, say('a1', M1), done, reason('r1', R2, { streaming: true })]);
    expect(heads(container)).toEqual(['Working… true']);
    expect(container.querySelector('.work-body .thinking-body')?.textContent).toBe(R2);

    // The next message starts: the stretch before it is finished, and the message is on screen.
    set([user, say('a1', M1), done, reason('r1', R2), say('a2', M2, { streaming: true })]);
    expect(heads(container)).toEqual(['Worked false']);
    expect(container.querySelectorAll('.tool-card')).toHaveLength(0);
    expect([...container.querySelectorAll('.msg-assistant .md')].map((el) => el.textContent?.trim())).toEqual([M1, M2]);

    // More work: a new stretch opens under the message, the earlier one stays folded.
    set([user, say('a1', M1), done, reason('r1', R2), say('a2', M2), step('c2', 'npm test', { status: 'running' })]);
    expect(heads(container)).toEqual(['Worked false', 'Working… true']);
    expect([...container.querySelectorAll('.tool-card')].map((card) => card.querySelector('.tool-summary')?.textContent)).toEqual(['npm test']);
  });

  it('shows a message that is still streaming even though a tool call will follow it', () => {
    const { container } = show([user, say('a1', M1, { streaming: true })], 'running');
    expect(container.querySelector('.msg-assistant .md')?.textContent?.trim()).toBe(M1);
    set([user, say('a1', M1), step('c1', 'git status --short', { status: 'running' })]);
    expect(container.querySelector('.msg-assistant .md')?.textContent?.trim()).toBe(M1);
    expect(container.querySelector('.msg-assistant')!.closest('.work-group')).toBeNull();
  });
});
