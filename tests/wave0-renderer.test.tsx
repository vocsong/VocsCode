// @vitest-environment jsdom
/**
 * Targeted renderer regression tests for Wave 0 security and state-integrity fixes.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { activeLeadWorkspace, fileScope } from '../src/renderer/src/file-open';
import { useStore } from '../src/renderer/src/store';
import { KnowledgeTab } from '../src/renderer/src/components/KnowledgeTab';
import type { MissionRecord } from '../src/shared/mission';
import type { AppSettings, SessionMeta } from '../src/shared/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function baseSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's_1',
    title: 'Test session',
    cwd: '/workspace',
    config: { harness: 'native', projectRoot: '/workspace', permissionMode: 'ask' },
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { ...ZERO_USAGE },
    harnessRef: {},
    ...overrides
  };
}

describe('KnowledgeTab snippet XSS protection', () => {
  it('renders snippet highlights via React nodes instead of raw HTML', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'knowledge:view') {
        return {
          projectRoot: '/workspace',
          cwd: '/workspace',
          wikiDir: '/workspace/.vocs-code/wiki',
          status: { hasWiki: true, pages: 1, stale: 0, pending: 0, rejected: 0, branch: null },
          pages: [{
            id: 'gotcha/xss',
            title: 'XSS test',
            kind: 'gotcha',
            status: 'current',
            authority: 3,
            scope: 'repo',
            claim: 'Test claim',
            snippet: `before \u0001${xss}\u0002 after`,
            labels: [],
            updatedAt: '2026-11-22T00:00:00Z'
          }],
          proposals: [],
          rejectedClaims: [],
          settings: { enabled: true }
        };
      }
      return {};
    });
    (window as unknown as { harness: unknown }).harness = { invoke, on: () => () => {} };
    useStore.setState({ settings: { providers: [] } as unknown as AppSettings });

    const { container } = render(<KnowledgeTab session={baseSession()} />);
    await screen.findByTestId('knowledge-page-gotcha/xss');
    expect(container.querySelector('img')).toBeNull();
    const mark = container.querySelector('.knowledge-snippet mark');
    expect(mark?.textContent).toBe(xss);
  });
});

describe('Renderer store reset() cleanup', () => {
  it('drops pending streaming deltas and clears per-host fields on reset()', () => {
    const scheduled: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      scheduled.push(cb);
      return scheduled.length;
    });
    useStore.setState({
      transcripts: { s_1: [{ id: 'a_1', kind: 'assistant', ts: 1, text: 'hello' }] },
      archiving: { s_1: true },
      toasts: [{ id: 't1', text: 'old', kind: 'info' }],
      changesVersion: 5
    });
    useStore.getState().applyEvent({ sessionId: 's_1', ts: 1, event: { type: 'item.delta', id: 'a_1', textDelta: ' stale' } });
    useStore.getState().reset();
    // Simulate a new host booting with the same session/item id before the old rAF callback fires.
    useStore.setState({ transcripts: { s_1: [{ id: 'a_1', kind: 'assistant', ts: 2, text: 'fresh' }] } });
    for (const cb of scheduled) cb(16);
    expect(useStore.getState().transcripts['s_1']).toEqual([{ id: 'a_1', kind: 'assistant', ts: 2, text: 'fresh' }]);
    expect(useStore.getState().archiving).toEqual({});
    expect(useStore.getState().toasts).toEqual([]);
    expect(useStore.getState().changesVersion).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('activeLeadWorkspace & fileScope', () => {
  it('picks the latest non-cleaned lead workspace after lead replacement', () => {
    const mission = {
      id: 'm_1',
      workspaces: [
        { id: 'ws_old', role: 'lead', ownerSessionId: 's_1', path: '/old-lead', cleanedAt: 100 },
        { id: 'ws_int', role: 'integration', path: '/integration' },
        { id: 'ws_new', role: 'lead', ownerSessionId: 's_1', path: '/new-lead' }
      ]
    } as unknown as MissionRecord;
    const session = baseSession({ id: 's_1', mission: { missionId: 'm_1', role: 'lead', generation: 2 } as SessionMeta['mission'] });
    expect(activeLeadWorkspace(mission, 's_1')?.id).toBe('ws_new');
    expect(fileScope(session, mission)).toEqual({ root: '/new-lead', missionWorkspaceId: 'ws_new' });
  });
});
