/**
 * @vitest-environment jsdom
 *
 * The right panel's Usage dashboard: the always-on summary block, and the three detail views the
 * segmented control switches between. Rendered as real component code over a plain props feed, so
 * these assert what the user reads rather than what the stats model returns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionUsage } from '../src/renderer/src/components/SessionUsage';
import type { AntigravityQuota } from '../src/shared/harness-setup';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T = Date.now() - 60_000;

function session(extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    title: 'Session',
    createdAt: T,
    updatedAt: T,
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness: 'native', permissionMode: 'ask' },
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 200, reasoningTokens: 0, costUsd: 1.5, turns: 2, contextWindow: 200_000, contextTokens: 180_000 },
    ...extra
  } as SessionMeta;
}

const items: TranscriptItem[] = [
  { id: 'u1', kind: 'user', ts: T, text: 'go' },
  { id: 't1', kind: 'tool', ts: T + 1, name: 'read_file', hint: 'read', status: 'done', durationMs: 100 },
  { id: 't2', kind: 'tool', ts: T + 2, name: 'bash', hint: 'execute', status: 'error', durationMs: 300, exitCode: 2, output: 'fatal: not a git repository' },
  { id: 't3', kind: 'tool', ts: T + 3, name: 'apply_patch', hint: 'edit', status: 'done', durationMs: 50, changes: [{ path: 'a.ts', kind: 'update' }] },
  { id: 'turn1', kind: 'turn', ts: T + 5, status: 'completed', durationMs: 4000, costUsd: 1, usage: { inputTokens: 700, outputTokens: 300 } },
  { id: 'turn2', kind: 'turn', ts: T + 12, status: 'failed', durationMs: 9000, costUsd: 0.5, error: 'rate limited' }
];

const detail = (name: 'Turns' | 'Tools' | 'Errors') => screen.getByRole('radio', { name });
const antigravity = session({ config: { projectRoot: 'G:/repo', harness: 'antigravity', permissionMode: 'ask' } });
const quota = (): ReturnType<typeof within> => within(screen.getByRole('region', { name: 'Antigravity account quota' }));
const quotaReply: AntigravityQuota = { groups: [{ name: 'Gemini models', buckets: [
  { name: 'Gemini Pro', remainingFraction: 0.726, resetAt: '2030-01-01T12:00:00Z' },
  { name: 'Gemini Flash', remainingFraction: 0 }
] }] };

describe('Usage panel', () => {
  it('checks Antigravity account quota only on click and meters it separately from session context', async () => {
    let finish!: (value: AntigravityQuota) => void;
    const invoke = vi.fn(() => new Promise<AntigravityQuota>((resolve) => { finish = resolve; }));
    vi.stubGlobal('harness', { invoke });
    render(<SessionUsage session={antigravity} />);

    const card = quota();
    expect(invoke).not.toHaveBeenCalled();
    expect(card.queryByRole('meter')).toBeNull();
    const check = card.getByRole('button', { name: 'Check quota' });
    fireEvent.click(check);
    fireEvent.click(check);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('harness:antigravityQuota', undefined);
    expect(card.getByRole('status').textContent).toContain('Checking Antigravity quota');

    finish(quotaReply);
    expect((await card.findByRole('meter', { name: 'Gemini Pro' })).getAttribute('aria-valuenow')).toBe('73');
    expect(card.getByRole('meter', { name: 'Gemini Flash' }).getAttribute('aria-valuenow')).toBe('0');
    expect(card.getByText(/^Resets /)).toBeTruthy();
    expect(card.getByText('Gemini models')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Context window' }).getAttribute('aria-valuenow')).toBe('90');
  });

  it('shows a quota check error without inventing percentages and allows a retry', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("Error invoking remote method 'harness:antigravityQuota': Error: Sign in with Google first."))
      .mockResolvedValueOnce(quotaReply);
    vi.stubGlobal('harness', { invoke });
    render(<SessionUsage session={antigravity} />);

    const card = quota();
    fireEvent.click(card.getByRole('button', { name: 'Check quota' }));
    expect((await card.findByRole('alert')).textContent).toBe('Sign in with Google first.');
    expect(card.queryByRole('meter')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Check quota' }));
    await card.findByRole('meter', { name: 'Gemini Pro' });
    expect(card.queryByRole('alert')).toBeNull();
    expect(card.getByRole('button', { name: 'Refresh quota' })).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('leaves other harnesses unchanged and does not offer a quota check to a remote transport', () => {
    const invoke = vi.fn();
    vi.stubGlobal('harness', { invoke, can: () => false });
    const { rerender } = render(<SessionUsage session={session()} />);
    expect(screen.queryByRole('region', { name: 'Antigravity account quota' })).toBeNull();
    rerender(<SessionUsage session={antigravity} />);
    expect(quota().getByText(/available in the desktop app/)).toBeTruthy();
    expect(quota().queryByRole('button')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('leads with session spend and the headline counters', () => {
    render(<SessionUsage session={session()} items={items} />);

    const panel = screen.getByTestId('usage-panel');
    expect(within(panel).getByText('Session spend')).toBeTruthy();
    expect(within(panel).getByText('$1.50')).toBeTruthy();
    expect(within(panel).getByText('2 turns · 3 tool calls · 13.0s working')).toBeTruthy();
    // Tool calls, failures and touched files are new counters the old page never showed.
    expect(within(panel).getByTitle(/Tool calls recorded/).textContent).toContain('3');
    expect(within(panel).getByTitle(/Failed tool calls/).textContent).toContain('2');
    expect(within(panel).getByTitle(/Distinct paths reported as changed/).textContent).toContain('+0 ~1 −0');
    expect(within(panel).getByTitle(/Cache reads as a share/).textContent).toContain('75%');
  });

  it('counts reasoning inside the token total rather than on top of it', () => {
    // The providers report reasoning as a subset of the output tokens (`TokensTab` labels it
    // "counted inside output"), so the headline total is input + output + cache and nothing else.
    const withReasoning = session({
      usage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 200, reasoningTokens: 400, costUsd: 1.5, turns: 2 }
    });
    render(<SessionUsage session={withReasoning} items={items} />);

    const kpi = screen.getByTitle(/Every token this session reported/);
    expect(within(kpi).getByText('4.6k')).toBeTruthy();
    expect(kpi.textContent).not.toContain('5.0k');
  });

  it('meters the context window and warns in the red band when it is nearly full', () => {
    render(<SessionUsage session={session()} items={items} />);

    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter.getAttribute('aria-valuenow')).toBe('90');
    expect(meter.className).toContain('tone-red');
    expect(screen.getByText('180k of 200k')).toBeTruthy();
  });

  it('meters a budget cap only when the session has one', () => {
    const { rerender } = render(<SessionUsage session={session()} items={items} />);
    expect(screen.queryByRole('meter', { name: 'Budget' })).toBeNull();

    rerender(<SessionUsage session={session({ config: { projectRoot: 'G:/repo', harness: 'native', permissionMode: 'ask', maxBudgetUsd: 3 } })} items={items} />);
    expect(screen.getByRole('meter', { name: 'Budget' }).getAttribute('aria-valuenow')).toBe('50');
  });

  it('charts each turn and reads the focused one out above the columns', () => {
    render(<SessionUsage session={session()} items={items} />);

    const columns = screen.getAllByRole('button', { name: /^Turn \d+,/ });
    expect(columns).toHaveLength(2);
    // With nothing hovered the readout shows the most recent turn.
    expect(screen.getByRole('status').textContent).toContain('Turn 2/2');
    fireEvent.mouseEnter(columns[0]);
    const readout = screen.getByRole('status').textContent ?? '';
    expect(readout).toContain('Turn 1/2');
    expect(readout).toContain('Completed');
    expect(readout).toContain('3 tools');
    // Switching the metric re-labels the same columns without changing their number.
    fireEvent.click(screen.getByRole('radio', { name: 'Time' }));
    expect(screen.getAllByRole('button', { name: /^Turn 2, Failed, 9.0s$/ })).toHaveLength(1);
  });

  it('breaks tools down by category and by name when the Tools view is chosen', () => {
    render(<SessionUsage session={session()} items={items} />);
    fireEvent.click(detail('Tools'));

    expect(screen.getByText('3 distinct tools')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Tool calls by category' })).toBeTruthy();
    const busiest = screen.getByTitle(/^bash · 1 call · 1 failed/);
    expect(busiest.textContent).toContain('Run');
    expect(busiest.textContent).toContain('1 failed');
    expect(screen.getByRole('img', { name: 'Reported file changes by kind' })).toBeTruthy();
  });

  it('lists every failure with its source and message in the Errors view', () => {
    render(<SessionUsage session={session()} items={items} />);
    fireEvent.click(detail('Errors'));

    expect(screen.getByRole('meter', { name: 'Turn completion' }).getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('Failed turns').previousSibling?.textContent).toBe('1');
    const log = screen.getAllByText(/rate limited|fatal: not a git repository/);
    expect(log).toHaveLength(2);
    expect(screen.getByText('exit 2 · fatal: not a git repository')).toBeTruthy();
  });

  it('renders an empty session without charts or failures', () => {
    const empty = session({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 } });
    render(<SessionUsage session={empty} items={[]} />);

    expect(screen.getByText('$0.00')).toBeTruthy();
    expect(screen.getByText(/No completed turns yet/)).toBeTruthy();
    expect(screen.queryByRole('meter', { name: 'Tool success' })).toBeNull();
    fireEvent.click(detail('Tools'));
    expect(screen.getByText('No tool calls in this session yet.')).toBeTruthy();
    fireEvent.click(detail('Errors'));
    expect(screen.getByText('Nothing has failed in this session.')).toBeTruthy();
  });
});
