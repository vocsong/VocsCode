/** The desktop's analytics uploader (src/main/remote/analytics-sync.ts) against the real relay routes:
 *  what it sends, what it skips, and that the owner reads back exactly the desktop's snapshot. */
import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../relay/src/rate';
import { handleHttp, type RouteContext } from '../relay/src/routes';
import { clearAnalytics } from '../relay/src/analytics';
import { AnalyticsSync } from '../src/main/remote/analytics-sync';
import { assembleSnapshot, buildAnalyticsSnapshot, type AnalyticsSnapshot } from '../src/shared/analytics/snapshot';
import { gunzipText } from '../src/shared/analytics/snapshot-codec';
import type { AnalyticsHost, AnalyticsPartBody } from '../src/shared/analytics/snapshot-wire';
import { emptyCounters } from '../src/shared/usage-rollup';
import type { UsageDay, UsageSessionRecord } from '../src/shared/types';
import { memStore } from './fake-relay';
import { testDevice } from './support/relay-auth';

const T = 1_700_000_000_000;
const OWNER = { authorization: 'Bearer enroll-secret' };

function day(cost: number): UsageDay {
  return { ...emptyCounters(), costUsd: cost, turns: 1 };
}

function session(id: string, createdAt: number): UsageSessionRecord {
  return { id, title: `Title ${id}`, harness: 'claude', projectRoot: 'G:\\Work\\funCentral', createdAt, updatedAt: createdAt, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 1, turns: 1 }, toolCalls: 0 };
}

async function setup() {
  const store = memStore();
  const ctx = (): RouteContext => ({ store, accountId: 'a', enrollToken: 'enroll-secret', now: T, ip: '203.0.113.7', rate: new FixedWindowLimiter(() => T), accountAuthenticated: true, sockets: () => [] });
  const host = await testDevice(store, 'host', { name: 'Vocs PC', now: T });
  const sent: string[] = [];
  let connected = true;
  const request = async (path: string, init: RequestInit = {}): Promise<Response | null> => {
    if (!connected) return null;
    sent.push(`${init.method ?? 'GET'} ${path.split('?')[0]}`);
    const url = `https://relay.example${path.replace(/^\/v1/, '')}${path.includes('?') ? '&' : '?'}device=${host.deviceId}`;
    return handleHttp(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${host.access}` } }), ctx());
  };
  const data = {
    days: { '2026-10-30': day(1), '2026-11-02': day(2) } as Record<string, UsageDay>,
    sessions: [session('s1', Date.UTC(2026, 9, 30)), session('s2', Date.UTC(2026, 10, 2))]
  };
  const snapshot = (): AnalyticsSnapshot =>
    buildAnalyticsSnapshot({ ...data, tools: {}, modelTools: {}, harnessTools: {}, harnessModelTools: {}, reports: {} }, { generatedAt: T, appVersion: '0.10.1', platform: 'win32' });
  let sharing = true;
  const sync = (): AnalyticsSync => new AnalyticsSync({ snapshot, request, sharing: () => sharing, log: () => undefined });

  const ownerView = async (): Promise<AnalyticsHost> => {
    const res = await handleHttp(new Request('https://relay.example/owner/analytics', { headers: OWNER }), ctx());
    return ((await res.json()) as { hosts: AnalyticsHost[] }).hosts[0];
  };
  const ownerSnapshot = async (): Promise<AnalyticsSnapshot> => {
    const { manifest } = await ownerView();
    const texts = new Map<string, string>();
    for (const p of manifest!.parts) {
      const res = await handleHttp(new Request(`https://relay.example/owner/analytics/part?host=${host.deviceId}&id=${p.id}`, { headers: OWNER }), ctx());
      const body = (await res.json()) as AnalyticsPartBody;
      texts.set(p.id, await gunzipText(Buffer.from(body.data, 'base64')));
    }
    return assembleSnapshot(manifest!, texts);
  };
  return {
    store,
    host,
    sent,
    data,
    snapshot,
    sync,
    ownerView,
    ownerSnapshot,
    setSharing: (on: boolean) => (sharing = on),
    setConnected: (on: boolean) => (connected = on)
  };
}

describe('analytics uploader', () => {
  it('uploads every part, then the manifest, and the owner reads back the same snapshot', async () => {
    const t = await setup();
    expect(await t.sync().sync()).toBe('uploaded');
    expect(t.sent).toEqual([
      'GET /v1/analytics',
      'PUT /v1/analytics/part',
      'PUT /v1/analytics/part',
      'PUT /v1/analytics/part',
      'PUT /v1/analytics/part',
      'PUT /v1/analytics/part',
      'PUT /v1/analytics/part',
      'PUT /v1/analytics/manifest'
    ]);
    expect(await t.ownerSnapshot()).toEqual(t.snapshot());
    expect(JSON.stringify(await t.ownerSnapshot())).not.toContain('G:\\\\Work');
  });

  it('resends only what changed, and still commits the manifest as a heartbeat', async () => {
    const t = await setup();
    const sync = t.sync();
    await sync.sync();
    t.sent.length = 0;
    expect(await sync.sync()).toBe('uploaded');
    expect(t.sent).toEqual(['PUT /v1/analytics/manifest']);

    t.sent.length = 0;
    t.data.days['2026-11-02'] = day(5);
    await sync.sync();
    expect(t.sent).toEqual(['PUT /v1/analytics/part', 'PUT /v1/analytics/manifest']);
    expect((await t.ownerSnapshot()).days['2026-11-02'].costUsd).toBe(5);
  });

  it('reads the relay manifest after a restart instead of re-uploading', async () => {
    const t = await setup();
    await t.sync().sync();
    t.sent.length = 0;
    expect(await t.sync().sync()).toBe('uploaded');
    expect(t.sent).toEqual(['GET /v1/analytics', 'PUT /v1/analytics/manifest']);
  });

  it('resends everything when the relay lost parts it was thought to hold', async () => {
    const t = await setup();
    const sync = t.sync();
    await sync.sync();
    await clearAnalytics(t.store, 'a', t.host.deviceId);
    t.data.days['2026-11-02'] = day(9);
    t.sent.length = 0;
    expect(await sync.sync()).toBe('uploaded');
    expect(t.sent.filter((s) => s === 'PUT /v1/analytics/part')).toHaveLength(1 + 6);
    expect(await t.ownerSnapshot()).toEqual(t.snapshot());
  });

  it('deletes the relay copy when sharing is turned off, and sends nothing more while off', async () => {
    const t = await setup();
    const sync = t.sync();
    await sync.sync();
    t.setSharing(false);
    expect(await sync.sharingChanged()).toBe('cleared');
    expect((await t.ownerView()).manifest).toBeNull();
    expect(await t.store.list(`analytics:a:${t.host.deviceId}:`)).toEqual([]);
    t.sent.length = 0;
    expect(await sync.sync()).toBe('skipped');
    expect(t.sent).toEqual([]);

    t.setSharing(true);
    expect(await sync.sharingChanged()).toBe('uploaded');
    expect(await t.ownerSnapshot()).toEqual(t.snapshot());
  });

  it('clears a copy an earlier run left when it starts with sharing off', async () => {
    const t = await setup();
    await t.sync().sync();
    t.setSharing(false);
    const restarted = t.sync();
    restarted.start();
    restarted.stop();
    expect(await restarted.sync()).toBe('cleared');
    expect((await t.ownerView()).manifest).toBeNull();
  });

  it('skips quietly while the computer is not connected, and retries a clear once it is', async () => {
    const t = await setup();
    t.setConnected(false);
    expect(await t.sync().sync()).toBe('skipped');
    t.setConnected(true);
    const sync = t.sync();
    await sync.sync();
    t.setSharing(false);
    t.setConnected(false);
    expect(await sync.sharingChanged()).toBe('skipped');
    t.setConnected(true);
    expect(await sync.sync()).toBe('cleared');
    expect((await t.ownerView()).manifest).toBeNull();
  });
});
