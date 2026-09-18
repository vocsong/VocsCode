/**
 * The analytics dashboard against a stubbed summary: range requests, tab switching, legend and
 * table toggles, the unattributed footnote and opening a live session.
 */
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsDayPoint, AnalyticsSummary, SessionMeta, UsageSessionRecord } from '../src/shared/types';
import { emptyReliabilityReport } from '../src/shared/analytics/reliability';
import { codeOutputReport, emptyCodeOutputReport } from '../src/shared/analytics/code-output';
import type { ExecutionRecord, TurnRecord } from '../src/shared/analytics/records';
import { addCounters, addSlice, emptyCounters, emptyDimensions, harnessModelKey } from '../src/shared/usage-rollup';

const DAY = 86_400_000;
const now = Date.now();
const dateOf = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString().slice(0, 10);

function sliced(daysAgo: number, rows: { id: string; harness: 'claude' | 'pi'; model: string; project: string; costUsd: number; turns: number; toolCalls?: number; inputTokens?: number; cacheReadTokens?: number }[]): AnalyticsDayPoint {
  const usage = emptyCounters();
  const by = emptyDimensions();
  for (const r of rows) {
    const delta = { costUsd: r.costUsd, turns: r.turns, toolCalls: r.toolCalls ?? 0, inputTokens: r.inputTokens ?? 1000, cacheReadTokens: r.cacheReadTokens ?? 500, outputTokens: 100, speedTokens: 100, speedMs: 1000 };
    addCounters(usage, delta);
    addSlice(by.harness, r.harness, r.harness, delta, r.id);
    addSlice(by.model, `p/${r.model}`, r.model, delta, r.id);
    addSlice(by.harnessModel, harnessModelKey(r.harness, `p/${r.model}`), `p/${r.model}`, delta, r.id);
    addSlice(by.project, r.project, r.project, delta, r.id);
  }
  by.tool = { Bash: { calls: usage.toolCalls, errors: 0, declined: 0, durationMs: 0 } };
  return { date: dateOf(daysAgo), usage: { ...usage, by } };
}

const days: AnalyticsDayPoint[] = [
  sliced(3, [
    { id: 's1', harness: 'claude', model: 'opus', project: 'G:/proj/a', costUsd: 2, turns: 4, toolCalls: 6 },
    { id: 's2', harness: 'pi', model: 'glm', project: 'G:/proj/b', costUsd: 1, turns: 2 }
  ]),
  // A day written before per-dimension tracking existed: totals only.
  { date: dateOf(2), usage: { ...emptyCounters(), costUsd: 0.5, turns: 1, toolCalls: 2 } },
  sliced(1, [{ id: 's1', harness: 'claude', model: 'opus', project: 'G:/proj/a', costUsd: 3, turns: 2 }])
];

const rec = (id: string, harness: 'claude' | 'pi', model: string, costUsd: number, turns: number): UsageSessionRecord => ({
  id,
  title: `Session ${id}`,
  harness,
  provider: 'p',
  model,
  projectRoot: 'G:/proj/a',
  createdAt: now - 4 * DAY,
  updatedAt: now - DAY,
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0, reasoningTokens: 0, costUsd, turns },
  toolCalls: 3,
  speed: { tokens: 100, ms: 1000 }
});

const summary: AnalyticsSummary = {
  totals: { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 1500, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 6.5, turns: 9 },
  speed: { tokens: 300, ms: 3000 },
  days,
  previous: { ...emptyCounters(), costUsd: 3.25, turns: 3, toolCalls: 4 },
  byHarness: [],
  byModel: [],
  byHarnessModel: [],
  byProject: [],
  modelRates: [{ key: 'p/opus', label: 'p/opus', usdPerMTok: 2, usdPerCall: 0.5, costUsd: 5, tokens: 2_500_000, calls: 10 }],
  toolTotals: { calls: 8, errors: 0, declined: 0, durationMs: 0 },
  tools: [{ name: 'Bash', calls: 8, errors: 0, declined: 0, durationMs: 0 }],
  modelTools: [],
  harnessTools: [],
  harnessModelTools: [],
  files: [],
  sessions: [rec('s1', 'claude', 'opus', 5, 6), rec('s2', 'pi', 'glm', 1, 2), rec('s3', 'pi', 'glm', 0.5, 1)],
  sessionCount: 3,
  activeDays: 3,
  firstDay: days[0].date,
  reliability: emptyReliabilityReport(now),
  codeOutput: emptyCodeOutputReport(now)
};

/** One finished turn of a session that wrote code: the calls that added `lines`, and the verdict. */
function codeTurn(
  sessionId: string,
  harness: string,
  model: string,
  lines: number[],
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
  costUsd: number
): { records: ExecutionRecord[]; turns: TurnRecord[] } {
  const startTs = now - DAY;
  const records = lines.map((addedLines, i) => ({
    v: 3,
    id: `${sessionId}:t${i}`,
    sessionId,
    ts: startTs + i * 1000,
    endTs: startTs + i * 1000,
    harness,
    model,
    // The later calls are the same turn's subagent work: delegated lines, counted, not subtracted.
    role: i === 0 ? 'parent' : 'subagent',
    projectRoot: 'G:/proj/a',
    os: 'win32',
    turn: 1,
    ingest: 'live',
    facts: {} as ExecutionRecord['facts'],
    derived: {} as ExecutionRecord['derived'],
    addedLines
  })) as ExecutionRecord[];
  return { records, turns: [{ v: 3, id: `${sessionId}:turn:1`, sessionId, turn: 1, harness, model, projectRoot: 'G:/proj/a', startTs, status: 'completed', ingest: 'live', usage: { ...usage, cacheWriteTokens: 0, costUsd } }] };
}

/** A turn that only answered: tokens spent, no line written, so its tokens belong to no rate. */
function noCodeTurn(sessionId: string): TurnRecord {
  return {
    v: 3,
    id: `${sessionId}:turn:2`,
    sessionId,
    turn: 2,
    harness: 'claude',
    model: 'anthropic/opus',
    projectRoot: 'G:/proj/a',
    startTs: now - DAY,
    status: 'completed',
    ingest: 'live',
    usage: { inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 0, costUsd: 0.5 }
  };
}

const invokeMock = vi.fn().mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? summary : []));
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { AnalyticsDashboard } from '../src/renderer/src/components/AnalyticsDashboard';
import { useStore } from '../src/renderer/src/store';

const liveSession = (id: string): SessionMeta =>
  ({
    id,
    title: `Session ${id}`,
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask' },
    cwd: 'G:/proj/a',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  }) as SessionMeta;

function reset() {
  invokeMock.mockClear();
  summary.modelTools = [];
  summary.harnessTools = [];
  summary.harnessModelTools = [];
  summary.codeOutput = emptyCodeOutputReport(now);
  useStore.setState({ sessions: [liveSession('s1'), liveSession('s2')], activeId: null, view: 'analytics', analyticsTab: 'overview', analyticsRange: 30 });
}

describe('analytics dashboard', () => {
  it('loads the selected range, shows its totals and re-requests when the range changes', async () => {
    reset();
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith('analytics:summary', { days: 30 });
    // Spend over the three days in range, including the legacy day: 2 + 1 + 0.5 + 3.
    expect(container.querySelector('.kpi-value')?.textContent).toBe('$6.50');
    // Period-over-period change against the previous window (3.25 -> 6.5).
    expect(container.querySelector('.kpi-delta')?.textContent).toContain('+100%');
    // Usage from before per-model tracking is called out instead of silently missing from the breakdowns.
    expect(container.textContent).toContain('recorded before per-model tracking');

    fireEvent.click(container.querySelector('.analytics-top .segment:first-child') as HTMLButtonElement);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('analytics:summary', { days: 7 }));
    expect(useStore.getState().analyticsRange).toBe(7);
    fireEvent.click(container.querySelector('.analytics-top .segment:last-child') as HTMLButtonElement);
    // All time is an explicit 0, never an absent request (which the main process reads as 30 days).
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('analytics:summary', { days: 0 }));
    // All time is built from the session records, so the legacy note no longer applies.
    await waitFor(() => expect(container.textContent).not.toContain('recorded before per-model tracking'));
  });

  it('switches tabs, remembers the tab in the store and opens a live session from the table', async () => {
    reset();
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    fireEvent.click(container.querySelector("[data-tab='sessions']") as HTMLButtonElement);
    expect(useStore.getState().analyticsTab).toBe('sessions');
    const rows = container.querySelectorAll('.slist-row:not(.slist-head)');
    expect(rows).toHaveLength(3);
    // s3 was deleted: it stays in the history, marked, and cannot be opened.
    expect(container.querySelectorAll('.slist-row.gone')).toHaveLength(1);
    fireEvent.click(rows[0]);
    await waitFor(() => expect(useStore.getState().activeId).toBe('s1'));
  });

  it("shows each model's per-tool error rates on the tools tab", async () => {
    reset();
    summary.modelTools = [
      { key: 'p/sol', label: 'p/sol', name: 'bash', calls: 10, errors: 2, declined: 0, durationMs: 0 },
      { key: 'p/glm', label: 'p/glm', name: 'bash', calls: 9, errors: 1, declined: 0, durationMs: 0 },
      { key: 'p/luna', label: 'p/luna', name: 'bash', calls: 8, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/deepseek', label: 'p/deepseek', name: 'bash', calls: 7, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/fable', label: 'p/fable', name: 'Bash', calls: 6, errors: 1, declined: 0, durationMs: 0 },
      { key: 'p/astra', label: 'p/astra', name: 'bash', calls: 5, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/terra', label: 'p/terra', name: 'bash', calls: 2, errors: 0, declined: 0, durationMs: 0 },
      { key: 'anthropic/opus', label: 'anthropic/opus', name: 'Bash', calls: 1, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/fable', label: 'p/fable', name: 'Read', calls: 3, errors: 0, declined: 0, durationMs: 0 }
    ];
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    fireEvent.click(container.querySelector("[data-tab='tools']") as HTMLButtonElement);
    // The bounded range rolls its per-model tool slices up from the day buckets, so the card is empty
    // until the stub days carry them; all time reads the summary directly.
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'All time') as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain('Raw error rate by model'));
    const table = Array.from(container.querySelectorAll('.atable')).find((t) => t.querySelector('th')?.textContent === 'Model') as HTMLTableElement;
    expect(table).toBeTruthy();
    // Models are the rows in alphabetical order and Total leads the tool columns.
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual(['Model', 'Total', 'bash', 'Read']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(8);
    // Rows are named by the qualified key each model was filed under, so they sort provider first.
    expect(Array.from(table.querySelectorAll('tbody tr')).map((tr) => tr.querySelector('td')?.textContent)).toEqual(['anthropic/opus', 'p/astra', 'p/deepseek', 'p/fable', 'p/glm', 'p/luna', 'p/sol', 'p/terra']);
    // Built-in names from Claude use title case, while Pi/native use lower case. They share columns.
    const solRow = Array.from(table.querySelectorAll('tr')).find((tr) => tr.textContent?.startsWith('p/sol')) as HTMLTableRowElement;
    expect(Array.from(solRow.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['p/sol', '(2/10) 20%', '(2/10) 20%', '—']);
    const fableRow = Array.from(table.querySelectorAll('tr')).find((tr) => tr.textContent?.startsWith('p/fable')) as HTMLTableRowElement;
    expect(Array.from(fableRow.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['p/fable', '(1/9) 11%', '(1/6) 17%', '(0/3) 0%']);
    expect(Array.from(table.querySelectorAll('tr')).filter((tr) => tr.textContent?.toLowerCase().startsWith('bash'))).toHaveLength(0);
    // No harness+model data in this stub: the sibling card says so instead of rendering an empty table.
    expect(container.textContent).toContain('No per-harness tool calls recorded yet');
  });

  it('shows the error rate by harness and model in the same matrix as the model table', async () => {
    reset();
    summary.harnessModelTools = [
      { harness: 'claude', key: 'anthropic/opus', label: 'anthropic/opus', name: 'Bash', calls: 8, errors: 2, declined: 0, durationMs: 0 },
      { harness: 'claude', key: 'anthropic/opus', label: 'anthropic/opus', name: 'Read', calls: 4, errors: 0, declined: 0, durationMs: 0 },
      { harness: 'pi', key: 'openrouter/glm', label: 'openrouter/glm', name: 'bash', calls: 5, errors: 2, declined: 0, durationMs: 0 },
      { harness: 'codex', key: 'openai/gpt', label: 'openai/gpt', name: 'Read', calls: 3, errors: 0, declined: 0, durationMs: 0 },
      // The same model in another harness is its own row, not merged into the first.
      { harness: 'pi', key: 'anthropic/opus', label: 'anthropic/opus', name: 'Bash', calls: 2, errors: 0, declined: 0, durationMs: 0 }
    ];
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    fireEvent.click(container.querySelector("[data-tab='tools']") as HTMLButtonElement);
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'All time') as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain('Raw error rate by harness + model'));
    const table = Array.from(container.querySelectorAll('.atable')).find((t) => t.querySelector('th')?.textContent === 'Harness · model') as HTMLTableElement;
    expect(table).toBeTruthy();
    // Same shape as the model table: harness+model rows alphabetical, tool columns, Total first.
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual(['Harness · model', 'Total', 'bash', 'Read']);
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Claude · anthropic/opus', '(2/12) 17%', '(2/8) 25%', '(0/4) 0%'],
      ['Codex · openai/gpt', '(0/3) 0%', '—', '(0/3) 0%'],
      ['Pi · anthropic/opus', '(0/2) 0%', '(0/2) 0%', '—'],
      ['Pi · openrouter/glm', '(2/5) 40%', '(2/5) 40%', '—']
    ]);
  });

  it('shows per-harness error rates by tool, counting only executed calls, for the selected dates and all time', async () => {
    reset();
    const old = sliced(10, [{ id: 's1', harness: 'claude', model: 'same', project: '/p', costUsd: 0, turns: 0 }]);
    const recent = sliced(1, [
      { id: 's1', harness: 'claude', model: 'same', project: '/p', costUsd: 0, turns: 0 },
      { id: 's2', harness: 'pi', model: 'same', project: '/p', costUsd: 0, turns: 0 }
    ]);
    old.usage.by!.harnessTool = { claude: { Read: { calls: 3, errors: 1, declined: 1, durationMs: 0 } } };
    recent.usage.by!.harnessTool = {
      claude: { read: { calls: 3, errors: 1, declined: 1, durationMs: 0 } },
      pi: { Read: { calls: 2, errors: 0, declined: 1, durationMs: 0 }, bash: { calls: 1, errors: 0, declined: 1, durationMs: 0 } }
    };
    const response: AnalyticsSummary = {
      ...summary,
      days: [old, recent],
      modelTools: [{ key: 'p/same', label: 'p/same', name: 'read', calls: 10, errors: 3, declined: 4, durationMs: 0 }],
      harnessModelTools: [{ harness: 'claude', key: 'p/same', label: 'p/same', name: 'read', calls: 10, errors: 3, declined: 4, durationMs: 0 }],
      harnessTools: [
        { key: 'claude', label: 'claude', name: 'read', calls: 10, errors: 3, declined: 4, durationMs: 0 },
        { key: 'pi', label: 'pi', name: 'read', calls: 2, errors: 0, declined: 1, durationMs: 0 },
        { key: 'pi', label: 'pi', name: 'bash', calls: 1, errors: 0, declined: 1, durationMs: 0 }
      ]
    };
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? response : []));
    const view = render(<AnalyticsDashboard />);
    const ui = within(view.container);
    const table = () => ui.getByRole('table', { name: 'Raw error rate by harness' });
    const cells = () => within(table()).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    try {
      fireEvent.click(ui.getByRole('tab', { name: 'Tools & files' }));
      // One row per harness, one column per tool, Total first; the denominator is executed calls, so
      // Pi's all-declined bash column reads — rather than a 0% that would imply it ran clean.
      await waitFor(() => expect(cells()).toEqual([
        ['Claude', '(2/4) 50%', '(2/4) 50%', '—'],
        ['Pi', '(0/1) 0%', '(0/1) 0%', '—']
      ]));
      expect(within(table()).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Harness', 'Total', 'read', 'bash']);
      expect(ui.getByText(/Recorded since update/).textContent).toContain('same model and workload');
      expect(ui.getByText(/Raw error rate = harness-flagged errors/).textContent).toContain('executed calls (calls − declined)');
      fireEvent.click(ui.getByRole('radio', { name: '7 days' }));
      await waitFor(() => expect(cells()[0]).toEqual(['Claude', '(1/2) 50%', '(1/2) 50%', '—']));
      expect(invokeMock).toHaveBeenCalledWith('analytics:summary', { days: 7 });
      expect(ui.getByText(`last 7 days · ${dateOf(6)} – ${dateOf(0)}`)).toBeTruthy();
      fireEvent.click(ui.getByRole('radio', { name: 'All time' }));
      await waitFor(() => expect(cells()[0]).toEqual(['Claude', '(3/6) 50%', '(3/6) 50%', '—']));
      expect(invokeMock).toHaveBeenCalledWith('analytics:summary', { days: 0 });
      // The sibling matrices keep upstream's errors/calls math, unlike this executed-call one.
      // Each sibling row shows the rate twice: once in Total and once in its only tool column.
      expect(ui.getAllByText('(3/10) 30%')).toHaveLength(4);
      const modelTable = ui.getByRole('columnheader', { name: 'Harness · model' }).closest('table')!;
      expect(within(modelTable).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
        ['Claude · p/same', '(3/10) 30%', '(3/10) 30%']
      ]);
      fireEvent.click(ui.getByRole('radio', { name: '30 days' }));
      await waitFor(() => expect(cells()[0]).toEqual(['Claude', '(2/4) 50%', '(2/4) 50%', '—']));
    } finally {
      view.unmount();
      invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? summary : []));
    }
  });

  it('lets the legend hide a series and every chart card swap to its table', async () => {
    reset();
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    fireEvent.click(container.querySelector("[data-tab='tokens']") as HTMLButtonElement);
    const cacheRead = Array.from(container.querySelectorAll('button.legend-item')).find((b) => b.textContent?.includes('Cache read')) as HTMLButtonElement;
    expect(cacheRead).toBeTruthy();
    fireEvent.click(cacheRead);
    expect(cacheRead.className).toContain('off');
    expect(container.querySelector('.atable')).toBeNull();
    fireEvent.click(container.querySelector("button[title='Show as table']") as HTMLButtonElement);
    const table = container.querySelector('.atable');
    expect(table).toBeTruthy();
    expect(table?.querySelector('th')?.textContent).toBe('Day');
  });

  it('shows the cache hit rate of each model on the tokens tab', async () => {
    reset();
    const days: AnalyticsDayPoint[] = [
      sliced(1, [
        { id: 's1', harness: 'claude', model: 'warm', project: '/p', costUsd: 2, turns: 1, inputTokens: 1000, cacheReadTokens: 3000 },
        { id: 's2', harness: 'pi', model: 'cold', project: '/p', costUsd: 1, turns: 1, inputTokens: 800, cacheReadTokens: 0 },
        // No prompt tokens counted: no rate to show, and it does not take a slot either.
        { id: 's3', harness: 'pi', model: 'dry', project: '/p', costUsd: 0, turns: 0, inputTokens: 0, cacheReadTokens: 0 }
      ])
    ];
    const response: AnalyticsSummary = { ...summary, days };
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? response : []));
    try {
      const { container } = render(<AnalyticsDashboard />);
      await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
      fireEvent.click(container.querySelector("[data-tab='tokens']") as HTMLButtonElement);
      const card = Array.from(container.querySelectorAll('.acard')).find((c) => c.querySelector('.acard-title')?.textContent === 'Cache hit rate by model') as HTMLElement;
      expect(card).toBeTruthy();
      const meters = Array.from(card.querySelectorAll('.meter'));
      expect(meters).toHaveLength(2);
      expect(meters.map((m) => m.querySelector('.meter-head span')?.textContent)).toEqual(['p/warm', 'p/cold']);
      expect(meters.map((m) => m.querySelector('.meter-value')?.textContent)).toEqual(['75%', '0%']);
      expect(meters.map((m) => m.querySelector('.meter-sub')?.textContent)).toEqual(['3.0k of 4.0k prompt tokens', '0 of 800 prompt tokens']);
    } finally {
      invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? summary : []));
    }
  });

  it('shows the cache hit rate per harness and per harness × model on the tokens tab', async () => {
    reset();
    // One model under two harnesses: only the pair separates the two caching behaviours, which is
    // what the model-only card has to merge into a single row.
    const days: AnalyticsDayPoint[] = [
      sliced(1, [
        { id: 's1', harness: 'claude', model: 'opus', project: '/p', costUsd: 2, turns: 1, inputTokens: 1000, cacheReadTokens: 3000 },
        { id: 's2', harness: 'pi', model: 'opus', project: '/p', costUsd: 1, turns: 1, inputTokens: 800, cacheReadTokens: 0 }
      ])
    ];
    const response: AnalyticsSummary = { ...summary, days };
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? response : []));
    try {
      const { container } = render(<AnalyticsDashboard />);
      await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
      fireEvent.click(container.querySelector("[data-tab='tokens']") as HTMLButtonElement);
      const meters = (title: string) => {
        const card = Array.from(container.querySelectorAll('.acard')).find((c) => c.querySelector('.acard-title')?.textContent === title) as HTMLElement;
        expect(card).toBeTruthy();
        return Array.from(card.querySelectorAll('.meter')).map((m) => [m.querySelector('.meter-head span')?.textContent, m.querySelector('.meter-value')?.textContent, m.querySelector('.meter-sub')?.textContent]);
      };

      expect(meters('Cache hit rate by harness')).toEqual([
        ['Claude', '75%', '3.0k of 4.0k prompt tokens'],
        ['Pi', '0%', '0 of 800 prompt tokens']
      ]);
      // The merged model row sits between the two, so the pair card is what explains the difference.
      expect(meters('Cache hit rate by model')).toEqual([['p/opus', '63%', '3.0k of 4.8k prompt tokens']]);
      expect(meters('Cache hit rate by harness × model')).toEqual([
        ['Claude · p/opus', '75%', '3.0k of 4.0k prompt tokens'],
        ['Pi · p/opus', '0%', '0 of 800 prompt tokens']
      ]);
    } finally {
      invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? summary : []));
    }
  });

  it('names models by the key they were filed under, not the bare label recorded with them', async () => {
    reset();
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    // The stub days store the bare model id as the slice label, the way analytics.json did before
    // the provider became part of the name; every surface names them from the key instead.
    const legend = () => Array.from(container.querySelectorAll('.legend-item')).map((b) => b.textContent);
    await waitFor(() => expect(legend()).toEqual(['p/opus', 'p/glm', 'Unattributed']));
    fireEvent.click(container.querySelector("[data-tab='spend']") as HTMLButtonElement);
    const byModel = Array.from(container.querySelectorAll('.acard')).find((c) => c.querySelector('.acard-title')?.textContent === 'By model') as HTMLElement;
    expect(Array.from(byModel.querySelectorAll('.hbar-name')).map((n) => n.textContent)).toEqual(['p/opus', 'p/glm']);
    // The rates table names the same model the same way.
    expect(container.querySelector('.atable .mono')?.textContent).toBe('p/opus');
  });

  it('rates the code output the summary carries and lists the turns it had to leave out', async () => {
    reset();
    const claude = codeTurn('s1', 'claude', 'anthropic/opus', [100, 50], { inputTokens: 100_000, outputTokens: 100_000, cacheReadTokens: 800_000 }, 2);
    const pi = codeTurn('s2', 'pi', 'p/glm', [50], { inputTokens: 100_000, outputTokens: 100_000, cacheReadTokens: 300_000 }, 0.25);
    summary.codeOutput = codeOutputReport([...claude.records, ...pi.records], [...claude.turns, ...pi.turns, noCodeTurn('s1')], { now, rangeDays: 30, retention: { maxRecords: 50_000, maxDays: 90 } });

    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    fireEvent.click(container.querySelector("[data-tab='code']") as HTMLButtonElement);
    expect(useStore.getState().analyticsTab).toBe('code');

    // 200 lines over the 1.5M tokens the two counted turns spent; the 1M of the no-code turn is out.
    expect(container.querySelector('.hero-label')?.textContent).toBe('Code written per token spent');
    expect(container.querySelector('.hero-value')?.textContent).toBe('133 lines / M tokens');
    const tile = (label: string) => Array.from(container.querySelectorAll('.kpi')).find((k) => k.querySelector('.kpi-label')?.textContent === label) as HTMLElement;
    expect(tile('Cost per 1k lines').querySelector('.kpi-value')?.textContent).toBe('$11.25 / 1k lines');
    expect(tile('Written by subagents').querySelector('.kpi-value')?.textContent).toBe('25%');
    expect(tile('Turns excluded').querySelector('.kpi-value')?.textContent).toBe('1');

    const table = (header: string) => Array.from(container.querySelectorAll('.atable')).find((t) => t.querySelector('th')?.textContent === header) as HTMLTableElement;
    const rowsOf = (t: HTMLTableElement) => Array.from(t.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((cell) => cell.textContent));
    // Each harness carries its own rate and its own cost per 1000 lines, with the sample badge.
    expect(rowsOf(table('Harness'))).toEqual([
      ['Claude', '1', '150', '1.00M', '150', '$13.33 / 1k lines', '33%', 'n<3'],
      ['Pi', '1', '50', '500k', '100', '$5.00 / 1k lines', '0%', 'n<3']
    ]);
    expect(rowsOf(table('Harness · model'))[0][0]).toBe('Claude · anthropic/opus');
    // Every turn in range is accounted for, and only the counted one says it is in the rate.
    expect(rowsOf(table('Bucket')).slice(0, 2)).toEqual([
      ['Wrote code and reported tokens', '2', '200', '1.50M', 'yes'],
      ['Wrote no code (question, read, answer)', '1', '0', '1.00M', 'no']
    ]);
    expect(container.textContent).toContain('their 1.00M tokens are left out of every rate');
  });
});
