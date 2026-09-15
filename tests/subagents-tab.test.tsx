/**
 * @vitest-environment jsdom
 *
 * Offline tests for the Subagents tab: the run list, one run's transcript and per-call table, the
 * live refresh from session events, and the non-pi explanation. The tab never talks to a harness —
 * it reads run records through IPC — so everything here is real component code over a stubbed bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { SubagentsTab } from '../src/renderer/src/components/SubagentsTab';
import { useStore } from '../src/renderer/src/store';
import type { SubagentRun, SubagentRunSummary } from '../src/shared/subagents';
import type { SessionMeta } from '../src/shared/types';

const { invoke, on, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  return {
    listeners,
    invoke: vi.fn(),
    on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
      return () => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener));
      };
    })
  };
});
vi.mock('../src/renderer/src/api', () => ({ invoke, on, isMac: false, modKey: 'Ctrl', platform: 'win32', isWeb: false, webShim: vi.fn() }));

const session = (harness: SessionMeta['config']['harness'] = 'pi'): SessionMeta =>
  ({
    id: 's1',
    title: 'Session',
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness, permissionMode: 'ask' },
    status: 'idle',
    harnessRef: {},
    usage: { costUsd: 0 }
  }) as unknown as SessionMeta;

const summary = (overrides: Partial<SubagentRunSummary> = {}): SubagentRunSummary => ({
  runId: 'agent_1',
  agent: 'Explore',
  description: 'Find the harness registry',
  mode: 'foreground',
  status: 'completed',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  startedAt: 1000,
  endedAt: 2000,
  costUsd: 0.25,
  turns: 2,
  toolUses: 3,
  ...overrides
});

const run = (overrides: Partial<SubagentRun> = {}): SubagentRun => ({
  meta: { runId: 'agent_1', agent: 'Explore', description: 'Find the harness registry', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: 'G:/repo', startedAt: 1000 },
  status: 'completed',
  totals: { turns: 2, toolUses: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.25, durationMs: 4000 },
  endedAt: 2000,
  items: [
    { id: 'i1', ts: 1100, kind: 'tool', name: 'grep', summary: 'createAgentSession', status: 'done', output: 'src/main/harness/registry.ts:1' },
    { id: 'i2', ts: 1200, kind: 'assistant', text: 'The registry is at src/main/harness/registry.ts' }
  ],
  calls: [
    { index: 0, provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 800, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.1, durationMs: 1500, stopReason: 'toolUse', toolsInvoked: ['grep'] },
    { index: 1, provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 200, outputTokens: 60, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.15, durationMs: 2500, stopReason: 'stop', toolsInvoked: [] }
  ],
  ...overrides
});

async function renderTab(meta: SessionMeta = session()): Promise<void> {
  await act(async () => {
    render(<SubagentsTab session={meta} />);
  });
  // The list is fetched in an effect; settle one microtask round so rows exist.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  invoke.mockReset();
  on.mockClear();
  listeners.clear();
  useStore.setState({ settings: null, subagentReveal: null, panelBottomTab: 'subagents' } as never);
});
afterEach(cleanup);

describe('run list', () => {
  it('lists every run with its status, model and cost', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'subagents:list') return Promise.resolve([summary({ runId: 'agent_2', status: 'running', agent: 'Plan', description: 'Plan the change' }), summary()]);
      return Promise.resolve(null);
    });
    await renderTab();
    const rows = document.querySelectorAll('.subagent-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Plan');
    expect(rows[0]!.textContent).toContain('running');
    expect(rows[1]!.textContent).toContain('Explore');
    expect(rows[1]!.textContent).toContain('claude-sonnet-4-5');
    expect(rows[1]!.textContent).toContain('$0.25');
    expect(invoke).toHaveBeenCalledWith('subagents:list', { id: 's1' });
  });

  it('lists a Claude session\'s runs, which the SDK does record', async () => {
    invoke.mockImplementation((channel: string) => (channel === 'subagents:list' ? Promise.resolve([summary()]) : Promise.resolve(null)));
    await renderTab(session('claude'));
    expect(invoke).toHaveBeenCalledWith('subagents:list', { id: 's1' });
    expect(document.querySelectorAll('.subagent-row')).toHaveLength(1);
  });

  it('explains itself for a harness that records no runs at all', async () => {
    await renderTab(session('codex'));
    expect(document.querySelector('.subagents')!.textContent).toContain('This harness does not record subagent runs');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('says so when there are no runs yet', async () => {
    invoke.mockResolvedValue([]);
    await renderTab();
    expect(document.querySelector('.subagents')!.textContent).toContain('No subagent runs yet');
  });
});

describe('run detail', () => {
  it('shows the run transcript, its per-call rows and its cost', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'subagents:list') return Promise.resolve([summary()]);
      if (channel === 'subagents:get') return Promise.resolve(run());
      return Promise.resolve({ ok: true });
    });
    await renderTab();
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('subagents:get', { id: 's1', runId: 'agent_1' });
    const detail = document.querySelector('.subagent-detail')!;
    expect(detail.textContent).toContain('The registry is at src/main/harness/registry.ts');
    expect(detail.querySelector('.subagent-tool-output')!.textContent).toContain('registry.ts:1');
    const rows = detail.querySelectorAll('.subagent-calls tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('anthropic/claude-sonnet-4-5');
    expect(rows[0]!.textContent).toContain('800');
    expect(rows[1]!.textContent).toContain('$0.15');
    expect(rows[0]!.textContent).toContain('grep');
  });

  it('sends a steer and stops a running run through IPC', async () => {
    const stopped: unknown[] = [];
    invoke.mockImplementation((channel: string, request: unknown) => {
      if (channel === 'subagents:list') return Promise.resolve([summary({ status: 'running' })]);
      if (channel === 'subagents:get') return Promise.resolve(run({ status: 'running', endedAt: undefined }));
      if (channel === 'subagents:stop') {
        stopped.push(request);
        return Promise.resolve({ ok: true });
      }
      if (channel === 'subagents:steer') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    });
    await renderTab();
    await act(async () => {
      await Promise.resolve();
    });
    const stop = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Stop'))!;
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(stopped).toEqual([{ id: 's1', runId: 'agent_1' }]);

    const input = document.querySelector('.subagent-steer input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'focus on the registry' } });
    });
    const steer = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Steer'))!;
    await act(async () => {
      fireEvent.click(steer);
    });
    expect(invoke).toHaveBeenCalledWith('subagents:steer', { id: 's1', runId: 'agent_1', message: 'focus on the registry' });
  });

  it('opens the run a transcript card asked for', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'subagents:list') return Promise.resolve([summary({ runId: 'agent_1' }), summary({ runId: 'agent_9' })]);
      if (channel === 'subagents:get') return Promise.resolve(run({ meta: { ...run().meta, runId: 'agent_9' } }));
      return Promise.resolve(null);
    });
    useStore.setState({ subagentReveal: { sessionId: 's1', runId: 'agent_9' } } as never);
    await renderTab();
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('subagents:get', { id: 's1', runId: 'agent_9' });
    expect(useStore.getState().subagentReveal).toBeNull();
  });
});

describe('what each harness can do', () => {
  /** Render a session with one running run, so every affordance that needs a live run would show. */
  async function renderRunning(harness: SessionMeta['config']['harness']): Promise<void> {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'subagents:list') return Promise.resolve([summary({ status: 'running' })]);
      if (channel === 'subagents:get') return Promise.resolve(run({ status: 'running', endedAt: undefined }));
      return Promise.resolve({ ok: true });
    });
    await renderTab(session(harness));
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('offers pi the Agents view and run control, which it really has', async () => {
    await renderRunning('pi');
    expect(document.querySelector('[data-testid="subagent-view-agents"]')).not.toBeNull();
    expect(document.querySelector('.subagent-detail button')!.textContent).toBe('Stop');
    expect(document.querySelector('.subagent-steer input')).not.toBeNull();
  });

  it('hides both from Claude, whose SDK can stop a turn but not one child', async () => {
    await renderRunning('claude');
    // The run itself is still fully visible: list, transcript and the affordances it does have.
    expect(document.querySelectorAll('.subagent-row')).toHaveLength(1);
    expect(document.querySelector('.subagent-detail')).not.toBeNull();
    // …but the controls that would not do what the label says are gone, not disabled.
    expect(document.querySelector('[data-testid="subagent-view-agents"]')).toBeNull();
    expect(document.querySelector('.subagent-detail button')).toBeNull();
    expect(document.querySelector('.subagent-steer')).toBeNull();
  });
});

describe('live updates', () => {
  it('refreshes the list when the extension reports a run event for this session', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'subagents:list') return Promise.resolve([summary()]);
      return Promise.resolve(null);
    });
    await renderTab();
    const listCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'subagents:list').length;
    expect(listCalls()).toBe(1);
    await act(async () => {
      for (const listener of listeners.get('push:sessionEvent') ?? []) {
        listener({ sessionId: 's1', event: { type: 'subagent.run', run: { runId: 'agent_1', status: 'running' } }, ts: 1 });
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(listCalls()).toBe(2);

    // An event for another session is not this tab's business.
    const before = listCalls();
    await act(async () => {
      for (const listener of listeners.get('push:sessionEvent') ?? []) {
        listener({ sessionId: 'other', event: { type: 'subagent.run', run: { runId: 'agent_x', status: 'running' } }, ts: 2 });
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(listCalls()).toBe(before);
  }, 10_000);
});
