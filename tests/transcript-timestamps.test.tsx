/** @vitest-environment jsdom */
/**
 * Every message, thought and step in the transcript says when it happened: a `<time>` on its own
 * row, short enough to scan, with the full date to the second in its tooltip. Zen hides the times
 * until a row is pointed at; that is CSS, and the interface-modes E2E checks it in the real window.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { search } from '../src/renderer/src/components/TranscriptFind';
import { fmtDuration, fmtStamp, fmtStampFull } from '../src/renderer/src/format';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

afterEach(() => {
  cleanup();
  useStore.setState({ transcripts: {}, loaded: {}, showThinking: true });
});

describe('fmtStamp', () => {
  const now = new Date('2026-11-22T16:30:00').getTime();
  const at = (iso: string) => new Date(iso).getTime();
  const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  it('is the time alone for anything today, even just after midnight', () => {
    expect(fmtStamp(at('2026-11-22T09:05:00'), now)).toBe(time(at('2026-11-22T09:05:00')));
    expect(fmtStamp(at('2026-11-22T00:01:00'), now)).toBe(time(at('2026-11-22T00:01:00')));
  });

  it('names the weekday within the last week, then the date, then the year once it differs', () => {
    const yesterday = at('2026-11-21T23:59:00');
    expect(fmtStamp(yesterday, now)).toContain(new Date(yesterday).toLocaleDateString(undefined, { weekday: 'short' }));
    expect(fmtStamp(yesterday, now)).toContain(time(yesterday));
    const lastMonth = at('2026-10-20T08:00:00');
    expect(fmtStamp(lastMonth, now)).toContain(new Date(lastMonth).toLocaleDateString(undefined, { month: 'short' }));
    expect(fmtStamp(lastMonth, now)).toContain('20');
    expect(fmtStamp(lastMonth, now)).not.toContain('2026');
    expect(fmtStamp(at('2025-12-30T08:00:00'), now)).toContain('2025');
  });

  it('spells out the full date to the second for the tooltip', () => {
    const ts = at('2026-11-22T09:05:07');
    expect(fmtStampFull(ts)).toBe(new Date(ts).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' }));
  });
});

const SID = 's_stamps';
const session = { id: SID, title: 't', cwd: '/w', status: 'idle', config: { harness: 'native' }, harnessRef: {}, usage: {} } as unknown as SessionMeta;
const T = new Date('2026-11-22T14:00:00').getTime();
const s = (seconds: number) => T + seconds * 1000;

const items: TranscriptItem[] = [
  { id: 'u1', kind: 'user', ts: s(0), text: 'Add rate limiting.' },
  { id: 'a1', kind: 'assistant', ts: s(1), text: 'Looking at the server first.', thinking: 'Where are routes registered?' },
  { id: 'r1', kind: 'assistant', ts: s(2), text: '', thinking: 'The router lives in server.ts.' },
  { id: 'c1', kind: 'tool', ts: s(3), name: 'Read', hint: 'read', summary: 'src/server.ts', status: 'done', durationMs: 4200 },
  { id: 'i1', kind: 'info', ts: s(4), level: 'info', text: 'Context compacted.' },
  {
    id: 'ap1', kind: 'approval', ts: s(5), decidedAt: s(9),
    request: { id: 'ap1', sessionId: SID, harness: 'native', kind: 'command', title: 'Run npm test', command: 'npm test', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }], createdAt: s(5) },
    decision: { optionId: 'allow' }
  },
  { id: 'p1', kind: 'plan', ts: s(6), entries: [{ content: 'Add the limiter', status: 'in_progress' }] },
  { id: 'a2', kind: 'assistant', ts: s(10), text: 'Rate limiting is in place.' },
  { id: 'warn1', kind: 'info', ts: s(11), level: 'warn', text: 'One test was skipped.' },
  { id: 'turn1', kind: 'turn', ts: s(12), status: 'completed', durationMs: 12_000 }
];

function show() {
  useStore.setState({ transcripts: { [SID]: items }, loaded: { [SID]: true } });
  const view = render(<Transcript session={session} />);
  fireEvent.click(view.container.querySelector('.work-head')!);
  return view;
}

/** The times shown inside one item's row. */
const stampsOf = (container: HTMLElement, id: string) => [...container.querySelectorAll(`[data-item-id="${id}"] time.stamp`)] as HTMLTimeElement[];

describe('transcript timestamps', () => {
  it('times every message, thought, step, notice, approval and plan with its own moment', () => {
    const { container } = show();
    for (const item of items.filter((i) => i.kind !== 'plan' && i.kind !== 'turn')) {
      const stamps = stampsOf(container, item.id);
      expect(stamps, `${item.id} carries one time`).toHaveLength(1);
      expect(stamps[0]!.getAttribute('datetime')).toBe(new Date(item.ts).toISOString());
      expect(stamps[0]!.textContent).toBe(fmtStamp(item.ts));
      expect(stamps[0]!.getAttribute('title')).toContain(fmtStampFull(item.ts));
    }
    const plan = container.querySelector('.plan-title time.stamp');
    expect(plan?.getAttribute('datetime')).toBe(new Date(s(6)).toISOString());
  });

  it('gives reasoning on a message’s row the message’s time once, and reasoning alone a time of its own', () => {
    const { container } = show();
    expect(container.querySelector('[data-item-id="a1"] .thinking .stamp')).toBeNull();
    expect(stampsOf(container, 'a1').map((el) => el.className)).toEqual(['stamp msg-stamp']);
    expect(container.querySelector('[data-item-id="r1"] .thinking-toggle')).not.toBeNull();
    expect(stampsOf(container, 'r1').map((el) => el.getAttribute('datetime'))).toEqual([new Date(s(2)).toISOString()]);
  });

  it('dates a stretch of work from its first entry, and says in the tooltip how long a step took and when an approval was answered', () => {
    const { container } = show();
    expect(container.querySelector('.work-head time.stamp')?.getAttribute('datetime')).toBe(new Date(s(2)).toISOString());
    expect(stampsOf(container, 'c1')[0]!.getAttribute('title')).toBe(`${fmtStampFull(s(3))} · took ${fmtDuration(4200)}`);
    expect(stampsOf(container, 'ap1')[0]!.getAttribute('title')).toBe(`${fmtStampFull(s(5))} · answered ${fmtStampFull(s(9))}`);
  });

  it('keeps the times out of find-in-transcript', () => {
    const { container } = show();
    const label = fmtStamp(s(3));
    expect(container.textContent).toContain(label);
    expect(search(container, label)).toHaveLength(0);
  });
});
