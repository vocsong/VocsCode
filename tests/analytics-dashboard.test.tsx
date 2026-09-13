/**
 * The analytics dashboard against a stubbed summary: range requests, tab switching, legend and
 * table toggles, the unattributed footnote and opening a live session.
 */
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsDayPoint, AnalyticsSummary, SessionMeta, UsageSessionRecord } from '../src/shared/types';
import { addCounters, addSlice, emptyCounters, emptyDimensions } from '../src/shared/usage-rollup';

const DAY = 86_400_000;
const now = Date.now();
const dateOf = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString().slice(0, 10);

function sliced(daysAgo: number, rows: { id: string; harness: 'claude' | 'pi'; model: string; project: string; costUsd: number; turns: number; toolCalls?: number }[]): AnalyticsDayPoint {
  const usage = emptyCounters();
  const by = emptyDimensions();
  for (const r of rows) {
    const delta = { costUsd: r.costUsd, turns: r.turns, toolCalls: r.toolCalls ?? 0, inputTokens: 1000, cacheReadTokens: 500, outputTokens: 100, speedTokens: 100, speedMs: 1000 };
    addCounters(usage, delta);
    addSlice(by.harness, r.harness, r.harness, delta, r.id);
    addSlice(by.model, `p/${r.model}`, r.model, delta, r.id);
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
  byProject: [],
  modelRates: [{ key: 'p/opus', label: 'opus', usdPerMTok: 2, usdPerCall: 0.5, costUsd: 5, tokens: 2_500_000, calls: 10 }],
  toolTotals: { calls: 8, errors: 0, declined: 0, durationMs: 0 },
  tools: [{ name: 'Bash', calls: 8, errors: 0, declined: 0, durationMs: 0 }],
  modelTools: [],
  harnessModelTools: [],
  files: [],
  sessions: [rec('s1', 'claude', 'opus', 5, 6), rec('s2', 'pi', 'glm', 1, 2), rec('s3', 'pi', 'glm', 0.5, 1)],
  sessionCount: 3,
  activeDays: 3,
  firstDay: days[0].date
};

const invokeMock = vi.fn().mockImplementation((channel: string) => Promise.resolve(channel === 'analytics:summary' ? summary : []));
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { fireEvent, render, waitFor } from '@testing-library/react';
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
  summary.harnessModelTools = [];
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
      { key: 'p/sol', label: 'sol', name: 'bash', calls: 10, errors: 2, declined: 0, durationMs: 0 },
      { key: 'p/glm', label: 'glm', name: 'bash', calls: 9, errors: 1, declined: 0, durationMs: 0 },
      { key: 'p/luna', label: 'luna', name: 'bash', calls: 8, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/deepseek', label: 'deepseek', name: 'bash', calls: 7, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/fable', label: 'fable-5-1', name: 'Bash', calls: 6, errors: 1, declined: 0, durationMs: 0 },
      { key: 'p/astra', label: 'astra', name: 'bash', calls: 5, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/terra', label: 'terra', name: 'bash', calls: 2, errors: 0, declined: 0, durationMs: 0 },
      { key: 'anthropic/opus', label: 'opus', name: 'Bash', calls: 1, errors: 0, declined: 0, durationMs: 0 },
      { key: 'p/fable', label: 'fable-5-1', name: 'Read', calls: 2, errors: 0, declined: 0, durationMs: 0 }
    ];
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    fireEvent.click(container.querySelector("[data-tab='tools']") as HTMLButtonElement);
    // The bounded range rolls its per-model tool slices up from the day buckets, so the card is empty
    // until the stub days carry them; all time reads the summary directly.
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'All time') as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain('Error rate by model'));
    const table = Array.from(container.querySelectorAll('.atable')).find((t) => t.querySelector('th')?.textContent === 'Model') as HTMLTableElement;
    expect(table).toBeTruthy();
    // Models are the rows and tools the columns, so adding a model makes the table taller, not wider.
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual(['Model', 'bash', 'Read']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(8);
    // Built-in names from Claude use title case, while Pi/native use lower case. They share columns.
    const solRow = Array.from(table.querySelectorAll('tr')).find((tr) => tr.textContent?.startsWith('sol')) as HTMLTableRowElement;
    expect(Array.from(solRow.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['sol', '(2/10) 20%', '—']);
    const fableRow = Array.from(table.querySelectorAll('tr')).find((tr) => tr.textContent?.startsWith('fable-5-1')) as HTMLTableRowElement;
    expect(Array.from(fableRow.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual(['fable-5-1', '(1/6) 17%', '(0/2) 0%']);
    expect(Array.from(table.querySelectorAll('tr')).filter((tr) => tr.textContent?.toLowerCase().startsWith('bash'))).toHaveLength(0);
    // No harness+model data in this stub: the sibling card says so instead of rendering an empty table.
    expect(container.textContent).toContain('No per-harness tool calls recorded yet');
  });

  it('shows the error rate of each harness and model pair, worst first', async () => {
    reset();
    summary.harnessModelTools = [
      { harness: 'claude', key: 'anthropic/opus', label: 'opus', name: 'Bash', calls: 8, errors: 1, declined: 0, durationMs: 0 },
      { harness: 'claude', key: 'anthropic/opus', label: 'opus', name: 'Read', calls: 4, errors: 0, declined: 0, durationMs: 0 },
      { harness: 'pi', key: 'openrouter/glm', label: 'glm', name: 'bash', calls: 5, errors: 2, declined: 0, durationMs: 0 },
      { harness: 'codex', key: 'openai/gpt', label: 'gpt', name: 'Read', calls: 3, errors: 0, declined: 0, durationMs: 0 },
      // The same model in another harness is its own row, not merged into the first.
      { harness: 'pi', key: 'anthropic/opus', label: 'opus', name: 'Bash', calls: 2, errors: 0, declined: 0, durationMs: 0 }
    ];
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(container.querySelector('.kpi-value')).toBeTruthy());
    fireEvent.click(container.querySelector("[data-tab='tools']") as HTMLButtonElement);
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'All time') as HTMLButtonElement);
    await waitFor(() => expect(container.textContent).toContain('Error rate by harness + model'));
    const table = Array.from(container.querySelectorAll('.atable')).find((t) => t.querySelector('th')?.textContent === 'Harness · model') as HTMLTableElement;
    expect(table).toBeTruthy();
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual(['Harness · model', 'Calls', 'Errors', 'Error rate']);
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((cell) => cell.textContent));
    // Worst rate first: Pi/glm 40%, Claude/opus 8.3% (Bash and Read combined), Pi/opus and Codex/gpt at 0%.
    expect(rows).toEqual([
      ['Pi · glm', '5', '2', '40%'],
      ['Claude · opus', '12', '1', '8.3%'],
      ['Codex · gpt', '3', '0', '0%'],
      ['Pi · opus', '2', '0', '0%']
    ]);
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
});
