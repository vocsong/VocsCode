/** @vitest-environment jsdom */
/** The code.vocs.io dashboard (src/web): loading and caching uploaded snapshots, the combined and
 *  per-computer views, the empty and stale states, and the Connect with Vocs page. The real-browser
 *  run against the relay is tests/e2e.web-dashboard.test.ts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Dashboard, STALE_MS } from '../src/web/dashboard/Dashboard';
import { DashboardLoader } from '../src/web/dashboard/data';
import { ConnectScreen } from '../src/web/screens/ConnectScreen';
import { DashboardApp } from '../src/web/shell/DashboardApp';
import { buildAnalyticsSnapshot, type AnalyticsSnapshot } from '../src/shared/analytics/snapshot';
import { encodeSnapshot } from '../src/shared/analytics/snapshot-codec';
import type { AnalyticsHost, AnalyticsPartBody } from '../src/shared/analytics/snapshot-wire';
import { emptyCodeOutputReport } from '../src/shared/analytics/code-output';
import { emptyReliabilityReport } from '../src/shared/analytics/reliability';
import { emptyCounters, emptyDimensions, emptySlice } from '../src/shared/usage-rollup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.now();
const today = new Date(NOW).toISOString().slice(0, 10);

function snapshot(prefix: string, project: string, cost: number): AnalyticsSnapshot {
  const by = emptyDimensions();
  by.harness.claude = { ...emptySlice('claude'), costUsd: cost, turns: 1, sessions: [`${prefix}-s1`] };
  by.project[project] = { ...emptySlice(project), costUsd: cost, turns: 1, sessions: [`${prefix}-s1`] };
  const reports = Object.fromEntries([7, 30, 90, 0].map((r) => [String(r), { reliability: emptyReliabilityReport(NOW, r), codeOutput: emptyCodeOutputReport(NOW, r) }]));
  return buildAnalyticsSnapshot(
    {
      days: { [today]: { ...emptyCounters(), costUsd: cost, turns: 1, by } },
      sessions: [{ id: `${prefix}-s1`, title: `${prefix} session`, harness: 'claude', projectRoot: project, createdAt: NOW, updatedAt: NOW, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: cost, turns: 1 }, toolCalls: 0 }],
      tools: {},
      modelTools: {},
      harnessTools: {},
      harnessModelTools: {},
      reports
    },
    { generatedAt: NOW, appVersion: '0.11.0', platform: 'win32 x64' }
  );
}

/** A fake relay: the overview plus every part, encoded exactly as a desktop uploads them. */
async function relayOf(computers: Array<{ hostId: string; name: string; snap: AnalyticsSnapshot | null; online?: boolean; receivedAt?: number }>) {
  const parts = new Map<string, AnalyticsPartBody>();
  const hosts: AnalyticsHost[] = [];
  for (const c of computers) {
    if (!c.snap) {
      hosts.push({ hostId: c.hostId, name: c.name, platform: 'win32 x64', online: c.online ?? true, lastSeen: NOW, manifest: null, receivedAt: null });
      continue;
    }
    const { manifest, changed } = await encodeSnapshot(c.snap);
    for (const p of changed) parts.set(`${c.hostId}:${p.id}`, { hash: p.hash, data: Buffer.from(p.body).toString('base64') });
    hosts.push({ hostId: c.hostId, name: c.name, platform: 'win32 x64', online: c.online ?? true, lastSeen: NOW, manifest, receivedAt: c.receivedAt ?? NOW - 60_000 });
  }
  const partCalls: string[] = [];
  return {
    hosts,
    parts,
    partCalls,
    loader: () =>
      new DashboardLoader({
        overview: async () => hosts,
        part: async (hostId, id) => {
          partCalls.push(`${hostId}:${id}`);
          const body = parts.get(`${hostId}:${id}`);
          if (!body) throw new Error('missing');
          return body;
        }
      })
  };
}

describe('dashboard loader', () => {
  it('fetches each part once, then only the parts whose hash changed', async () => {
    const relay = await relayOf([{ hostId: 'pc', name: 'Vocs PC', snap: snapshot('pc', 'funCentral', 3) }]);
    const loader = relay.loader();
    const first = await loader.load();
    expect(first.computers[0].snapshot?.sessions.map((s) => s.title)).toEqual(['pc session']);
    const initial = relay.partCalls.length;
    expect(initial).toBe(relay.hosts[0].manifest!.parts.length);

    await loader.load();
    expect(relay.partCalls).toHaveLength(initial);

    const next = await relayOf([{ hostId: 'pc', name: 'Vocs PC', snap: snapshot('pc', 'funCentral', 9) }]);
    relay.hosts.splice(0, 1, next.hosts[0]);
    for (const [k, v] of next.parts) relay.parts.set(k, v);
    const reloaded = await loader.load();
    expect(reloaded.computers[0].snapshot?.days[today].costUsd).toBe(9);
    // The days and sessions parts changed; tools and reports did not.
    expect(relay.partCalls.slice(initial).sort()).toEqual([`pc:days.${today.slice(0, 7)}`, `pc:sessions.${today.slice(0, 7)}`]);
  });

  it('reports one computer it cannot read without hiding the others', async () => {
    const relay = await relayOf([
      { hostId: 'pc', name: 'Vocs PC', snap: snapshot('pc', 'a', 1) },
      { hostId: 'mac', name: 'Vocs Macmini', snap: snapshot('mac', 'b', 2) }
    ]);
    // The Mac re-uploaded a part after the overview was read.
    const key = [...relay.parts.keys()].find((k) => k.startsWith('mac:days'))!;
    relay.parts.set(key, { ...relay.parts.get(key)!, hash: 'f'.repeat(64) });
    const data = await relay.loader().load();
    expect(data.computers.map((c) => [c.host.name, !!c.snapshot])).toEqual([['Vocs PC', true], ['Vocs Macmini', false]]);
    expect(data.computers[1].error).toMatch(/synced while loading/);
  });
});

describe('dashboard view', () => {
  it('adds computers together, names each session\'s computer, and keeps reliability per computer', async () => {
    const relay = await relayOf([
      { hostId: 'pc', name: 'Vocs PC', snap: snapshot('pc', 'funCentral', 3) },
      { hostId: 'mac', name: 'Vocs Macmini', snap: snapshot('mac', 'Vocs-Code', 4) }
    ]);
    render(<Dashboard loader={relay.loader()} />);
    await waitFor(() => expect(screen.getAllByTestId('computer-card')).toHaveLength(2));
    expect(screen.getAllByTestId('computer-spend').map((n) => n.textContent)).toEqual(['$3.00', '$4.00']);
    expect(screen.getByTestId('by-computer')).toBeTruthy();
    expect(document.querySelector('.kpi-value')?.textContent).toBe('$7.00');

    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    await waitFor(() => expect(document.querySelectorAll('.slist-computer')).toHaveLength(2));
    expect([...document.querySelectorAll('.slist-computer')].map((n) => n.textContent).sort()).toEqual(['Vocs Macmini', 'Vocs PC']);
    // Uploaded rows are not live sessions: no links and no "deleted" marks.
    expect(document.querySelectorAll('.slist-row.live, .slist-gone')).toHaveLength(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Reliability' }));
    expect(screen.getAllByTestId('per-computer-section').map((s) => s.querySelector('.w-per-computer-title')?.textContent)).toEqual(['Vocs PC', 'Vocs Macmini']);
  });

  it('shows one computer on its own from the switcher or its card', async () => {
    const relay = await relayOf([
      { hostId: 'pc', name: 'Vocs PC', snap: snapshot('pc', 'funCentral', 3) },
      { hostId: 'mac', name: 'Vocs Macmini', snap: snapshot('mac', 'Vocs-Code', 4) }
    ]);
    render(<Dashboard loader={relay.loader()} />);
    await waitFor(() => expect(screen.getAllByTestId('computer-card')).toHaveLength(2));
    fireEvent.click(screen.getByRole('radio', { name: 'Vocs Macmini' }));
    await waitFor(() => expect(document.querySelector('.kpi-value')?.textContent).toBe('$4.00'));
    expect(screen.queryByTestId('by-computer')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Reliability' }));
    expect(screen.queryAllByTestId('per-computer-section')).toHaveLength(0);

    // Clicking the selected card again goes back to all computers.
    const macCard = screen.getAllByTestId('computer-card')[1];
    expect(macCard.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(macCard);
    await waitFor(() => expect(screen.getAllByTestId('per-computer-section')).toHaveLength(2));
  });

  it('explains an account with no computers, and computers that do not share yet', async () => {
    const empty = await relayOf([]);
    render(<Dashboard loader={empty.loader()} />);
    await screen.findByTestId('dashboard-empty');
    expect(screen.getByTestId('dashboard-empty').textContent).toMatch(/Connect with Vocs/);
    cleanup();

    const waiting = await relayOf([{ hostId: 'pc', name: 'Vocs PC', snap: null }]);
    render(<Dashboard loader={waiting.loader()} />);
    await screen.findByTestId('dashboard-waiting');
    expect(screen.getByTestId('computer-sync').textContent).toBe('Not sharing analytics yet');
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('flags an online computer that has not synced for a day, but not an offline one', async () => {
    const relay = await relayOf([
      { hostId: 'pc', name: 'Vocs PC', snap: snapshot('pc', 'a', 1), online: true, receivedAt: NOW - STALE_MS - 60_000 },
      { hostId: 'mac', name: 'Vocs Macmini', snap: snapshot('mac', 'b', 1), online: false, receivedAt: NOW - STALE_MS - 60_000 }
    ]);
    render(<Dashboard loader={relay.loader()} />);
    await waitFor(() => expect(screen.getAllByTestId('computer-card')).toHaveLength(2));
    const [pc, mac] = screen.getAllByTestId('computer-card');
    expect(pc.className).toContain('is-stale');
    expect(pc.textContent).toContain('stale');
    expect(mac.className).not.toContain('is-stale');
  });
});

describe('connect with vocs page', () => {
  const HASH = 'ab'.repeat(32);

  it('adds the computer, waits for it to collect its credential, then offers the dashboard', async () => {
    const calls: string[] = [];
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/v1/owner/enroll-grant') return Response.json({ status: 'granted' });
      polls++;
      return Response.json(polls < 2 ? { status: 'granted' } : { status: 'redeemed', hostDeviceId: 'h_pc' });
    }));
    const done = vi.fn();
    render(<ConnectScreen nonceHash={HASH} onDone={done} poll={{ attempts: 5, intervalMs: 1 }} />);
    fireEvent.click(screen.getByTestId('connect-add'));
    await screen.findByTestId('connect-done');
    expect(calls).toEqual(['POST /v1/owner/enroll-grant', `GET /v1/owner/enroll-grant?h=${HASH}`, `GET /v1/owner/enroll-grant?h=${HASH}`]);
    // No browser pairing any more: nothing asks the computer to pair this browser.
    expect(calls.some((c) => c.includes('pair-request'))).toBe(false);
    fireEvent.click(screen.getByTestId('connect-done'));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('says so when the request expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/v1/owner/enroll-grant' ? { status: 'granted' } : { status: 'missing' })));
    render(<ConnectScreen nonceHash={HASH} onDone={() => undefined} poll={{ attempts: 5, intervalMs: 1 }} />);
    fireEvent.click(screen.getByTestId('connect-add'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired/);
    expect(screen.queryByTestId('connect-done')).toBeNull();
  });

  it('asks a signed-out visitor to sign in instead of loading anything', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<DashboardApp account={{ status: 'anonymous' }} connectHash={HASH} />);
    expect(screen.getByTestId('signed-out').querySelector('a')?.getAttribute('href')).toBe('/login?next=%2Fdashboard');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
