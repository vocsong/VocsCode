/** Legacy pi-subagents model names must never guess a provider from catalog order or the parent. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import type { ModelInfo, ModelRef, SessionEvent, SessionMeta } from '../src/shared/types';

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
const NOW = Date.UTC(2026, 5, 10, 12);
const UNKNOWN = '/(unknown)';
const catalog: ModelInfo[] = [
  { provider: 'openrouter', id: 'claude-opus-5', displayName: 'Claude Opus 5' },
  { provider: 'anthropic', id: 'claude-opus-5', displayName: 'Claude Opus 5' },
  { provider: 'anthropic', id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
  { provider: 'openrouter', id: 'deepseek/deepseek-flash', displayName: 'DeepSeek Flash' }
];
const stores: { store: AnalyticsStore; dir: string }[] = [];

afterAll(async () => {
  for (const { store, dir } of stores) {
    await store.flush();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function host(models = catalog) {
  const events: SessionEvent[] = [];
  const meta: SessionMeta = {
    id: 's1', title: 'Attribution', createdAt: NOW, updatedAt: NOW,
    config: { harness: 'pi', projectRoot: '/repo', permissionMode: 'ask' },
    cwd: '/repo', status: 'idle', harnessRef: {}, usage: { ...ZERO },
    activeModel: { provider: 'openai', model: 'parent' }
  };
  let store: AnalyticsStore | undefined;
  const ctx = {
    sessionId: meta.id, session: () => meta, sessionDir: '.',
    settings: () => ({ pi: { extraArgs: [] } }), runtime: {},
    permissionMode: () => 'ask', effort: () => undefined,
    emit: (event: SessionEvent) => {
      events.push(event);
      if (event.type === 'usage') {
        meta.usage = event.totals;
        store?.recordUsage(meta, event.totals, NOW, event.subagentCostByModel);
      } else if (event.type === 'subagent') store?.recordSubagent(meta, event.completion, NOW);
      else if (event.type === 'item.upsert' && event.item.kind === 'tool') store?.recordToolCall(meta.id, event.item, NOW, meta.activeModel);
    },
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch), updateRef: () => {}, log: () => {}
  } as unknown as HarnessContext;
  const adapter = new PiAdapter(ctx);
  const priv = adapter as unknown as { models: ModelInfo[]; child: unknown; request: (type: string) => Promise<unknown> };
  priv.models = models;
  priv.child = {};
  let cost = 0;
  priv.request = async () => ({ tokens: { input: 100, output: 10 }, cost });
  const feed = (event: Record<string, unknown>) => (adapter as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify(event));
  const notification = (details: Record<string, unknown>) => feed({ type: 'message_end', message: { role: 'custom', customType: 'subagent-notification', details } });
  const result = (details: Record<string, unknown>) => {
    const toolCallId = `tool_${details.agentId}`;
    feed({ type: 'tool_execution_start', toolCallId, toolName: 'Agent', args: {} });
    feed({ type: 'tool_execution_end', toolCallId, toolName: 'Agent', isError: false, result: { content: [], details } });
  };
  return {
    adapter, events, meta, feed, result, notification,
    async connect() {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pi-attribution-'));
      store = new AnalyticsStore(dir, { log: () => {} });
      stores.push({ store, dir });
      await store.load([meta]);
      return store;
    },
    async turn(totalCost: number) {
      cost = totalCost;
      feed({ type: 'agent_start' });
      feed({ type: 'agent_end', messages: [] });
      feed({ type: 'agent_settled' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

const completions = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: 'subagent' }> => e.type === 'subagent').map((e) => e.completion);
const usages = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage');

describe('legacy Pi subagent model resolution', () => {
  const cases: [string | undefined, ModelRef | null][] = [
    ['Claude Opus 5', null], ['claude-opus-5', null], ['opus', null], ['ClAuDe OPUS 5', null],
    ['not-in-the-catalog', null], [undefined, null], ['!!!', null],
    ['anthropic/claude-opus-5', { provider: 'anthropic', model: 'claude-opus-5' }],
    ['openrouter/claude-opus-5', { provider: 'openrouter', model: 'claude-opus-5' }],
    ['openrouter/deepseek/deepseek-flash', { provider: 'openrouter', model: 'deepseek/deepseek-flash' }],
    ['deepseek/deepseek-flash', { provider: 'openrouter', model: 'deepseek/deepseek-flash' }],
    ['Claude Haiku 4.5', { provider: 'anthropic', model: 'claude-haiku-4-5' }],
    ['haiku', { provider: 'anthropic', model: 'claude-haiku-4-5' }],
    ['missing/claude-haiku-4-5', null]
  ];
  for (const reversed of [false, true]) {
    it.each(cases)(`resolves %s without guessing (reversed catalog: ${reversed})`, (name, expected) => {
      const h = host(reversed ? [...catalog].reverse() : catalog);
      h.result({ agentId: 'child', modelName: name, status: 'completed', toolUses: 3, cost: 0.2 });
      expect(completions(h.events)).toHaveLength(1);
      expect(completions(h.events)[0].model).toEqual(expected);
      if (!expected) expect(h.events.some((e) => e.type === 'item.upsert' && e.item.kind === 'info' && e.item.text.includes('model unknown'))).toBe(true);
    });
  }

  it.each([false, true])('rejects punctuation-normalized identity collisions (reversed: %s)', (reversed) => {
    const models = [
      { provider: 'custom', id: 'model-a', displayName: 'Model A' },
      { provider: 'custom', id: 'model.a', displayName: 'Model.A' }
    ];
    const h = host(reversed ? models.reverse() : models);
    h.result({ agentId: 'unknown', modelName: 'model_a', status: 'completed', cost: 0.2 });
    h.result({ agentId: 'qualified', modelName: 'custom/model-a', status: 'completed', cost: 0.1 });
    expect(completions(h.events).map((c) => c.model)).toEqual([null, { provider: 'custom', model: 'model-a' }]);
  });

  it('does not mistake duplicate catalog rows for different identities', () => {
    const h = host([catalog[2], { ...catalog[2] }]);
    h.result({ agentId: 'child', modelName: 'haiku', status: 'completed', cost: 0.2 });
    expect(completions(h.events)[0].model).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('uses each background notification\'s own model name before the remembered spawn name', () => {
    const h = host();
    h.result({ agentId: 'child', status: 'background', modelName: 'Claude Opus 5' });
    h.notification({ id: 'child', modelName: 'anthropic/claude-opus-5', status: 'completed', totalCost: 0.2,
      others: [{ id: 'grouped', modelName: 'Claude Haiku 4.5', status: 'completed', totalCost: 0.1 }] });
    expect(completions(h.events).map((c) => c.model)).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }
    ]);
  });
});

describe('Pi adapter → AnalyticsStore subagent cost boundary', () => {
  it.each(['Claude Opus 5', 'opus', 'not-in-the-catalog', undefined])('keeps %s spend unknown, not on the parent, and dedupes terminal reports', async (modelName) => {
    const h = host();
    const store = await h.connect();
    const details = { agentId: 'child', modelName, status: 'completed', cost: 0.2, toolUses: 3 };
    h.result(details);
    h.notification({ ...details, id: 'child', totalCost: 0.2 });
    await h.turn(0.3);
    const summary = store.summary(30, NOW + 1000);
    const day = summary.days.at(-1)!.usage;
    expect(completions(h.events)).toHaveLength(1);
    expect(usages(h.events).flatMap((e) => e.subagentCostByModel ?? [])).toEqual([{ provider: null, model: null, costUsd: 0.2 }]);
    expect(summary.totals.costUsd).toBeCloseTo(0.3);
    expect(summary.sessions.find((s) => s.id === 's1')!.usage.costUsd).toBeCloseTo(0.3);
    expect(day.by!.harness.pi.costUsd).toBeCloseTo(0.3);
    expect(day.by!.project['/repo'].costUsd).toBeCloseTo(0.3);
    expect(day.by!.model['openai/parent'].costUsd).toBeCloseTo(0.1);
    expect(day.by!.harnessModel['pi|openai/parent'].costUsd).toBeCloseTo(0.1);
    expect(day.by!.model[UNKNOWN]).toMatchObject({ label: '(unknown)', sessions: ['s1'] });
    expect(day.by!.model[UNKNOWN].costUsd).toBeCloseTo(0.2);
    expect(day.by!.harnessModel[`pi|${UNKNOWN}`].costUsd).toBeCloseTo(0.2);
    expect(Object.keys(day.by!.model).sort()).toEqual([UNKNOWN, 'openai/parent']);
    expect(day.turns).toBe(1);
    expect(day.toolCalls).toBe(4); // The spawning Agent call plus three delegated calls, once each.
    expect(summary.tools.find((t) => t.name === 'subagent')!.calls).toBe(3);
    expect(summary.harnessTools.find((t) => t.name === 'subagent')!.calls).toBe(3);
    expect(store.queryExecutions({ sessionId: 's1' }, NOW + 1000).filter((r) => r.role === 'subagent')).toMatchObject([{ model: UNKNOWN, parentModel: 'openai/parent', weight: 3 }]);
  });

  it('carries unknown cost through an underreported total and flushes it exactly once', async () => {
    const h = host();
    const store = await h.connect();
    h.notification({ id: 'child', modelName: 'Claude Opus 5', status: 'completed', totalCost: 0.2, toolUses: 3 });
    await h.turn(0.1);
    let day = store.summary(30, NOW + 1000).days.at(-1)!.usage;
    expect(day.costUsd).toBeCloseTo(0.1);
    expect(day.by!.model['openai/parent'].costUsd).toBeCloseTo(0);
    expect(day.by!.model[UNKNOWN].costUsd).toBeCloseTo(0.1);
    await h.turn(0.3);
    await h.turn(0.3);
    day = store.summary(30, NOW + 1000).days.at(-1)!.usage;
    expect(day.costUsd).toBeCloseTo(0.3);
    expect(day.by!.harness.pi.costUsd).toBeCloseTo(0.3);
    expect(day.by!.project['/repo'].costUsd).toBeCloseTo(0.3);
    expect(day.by!.model['openai/parent'].costUsd).toBeCloseTo(0.1);
    expect(day.by!.model[UNKNOWN].costUsd).toBeCloseTo(0.2);
    expect(day.by!.harnessModel['pi|openai/parent'].costUsd).toBeCloseTo(0.1);
    expect(day.by!.harnessModel[`pi|${UNKNOWN}`].costUsd).toBeCloseTo(0.2);
    expect(usages(h.events).flatMap((e) => e.subagentCostByModel ?? [])).toEqual([{ provider: null, model: null, costUsd: 0.2 }]);
    expect(day.toolCalls).toBe(3);
  });

  it('reassigns a late notification after totals were already reported, without another cost delta', async () => {
    const h = host();
    const store = await h.connect();
    await h.turn(0.3);
    h.notification({ id: 'child', modelName: 'missing', status: 'completed', totalCost: 0.2, toolUses: 1 });
    await h.turn(0.3);
    const day = store.summary(30, NOW + 1000).days.at(-1)!.usage;
    expect(day.costUsd).toBeCloseTo(0.3);
    expect(day.by!.model['openai/parent'].costUsd).toBeCloseTo(0.1);
    expect(day.by!.model[UNKNOWN].costUsd).toBeCloseTo(0.2);
    expect(day.by!.harnessModel[`pi|${UNKNOWN}`].costUsd).toBeCloseTo(0.2);
    expect(day.toolCalls).toBe(1);
  });

  it('retains a completion received while streamed usage and the final stats request are in flight', async () => {
    const h = host();
    const store = await h.connect();
    let release!: (value: unknown) => void;
    (h.adapter as unknown as { request: () => Promise<unknown> }).request = () => new Promise((resolve) => { release = resolve; });
    h.feed({ type: 'agent_start' });
    h.feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
    h.feed({ type: 'message_update', usage: { input: 100, output: 10, cost: { total: 0.3 } }, assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
    expect(usages(h.events).at(-1)!.totals.costUsd).toBeCloseTo(0.3);
    h.feed({ type: 'agent_end', messages: [] });
    h.feed({ type: 'agent_settled' });
    h.notification({ id: 'child', modelName: 'Claude Opus 5', status: 'completed', totalCost: 0.2, toolUses: 2 });
    // A later poll for the same run must not settle it again or change the initial attribution.
    h.result({ agentId: 'child', modelName: 'anthropic/claude-opus-5', status: 'completed', cost: 0.2, toolUses: 2 });
    release({ tokens: { input: 100, output: 10 }, cost: 0.3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const day = store.summary(30, NOW + 1000).days.at(-1)!.usage;
    expect(completions(h.events)).toHaveLength(1);
    expect(day.costUsd).toBeCloseTo(0.3);
    expect(day.by!.model['openai/parent'].costUsd).toBeCloseTo(0.1);
    expect(day.by!.model[UNKNOWN].costUsd).toBeCloseTo(0.2);
    expect(day.by!.harnessModel[`pi|${UNKNOWN}`].costUsd).toBeCloseTo(0.2);
    expect(day.toolCalls).toBe(3);
    expect(usages(h.events).flatMap((e) => e.subagentCostByModel ?? [])).toEqual([{ provider: null, model: null, costUsd: 0.2 }]);
  });

  it('keeps an explicit nested provider/model attributable at the same boundary', async () => {
    const h = host();
    const store = await h.connect();
    h.notification({ id: 'child', modelName: 'openrouter/deepseek/deepseek-flash', status: 'completed', totalCost: 0.2, toolUses: 2 });
    await h.turn(0.3);
    const day = store.summary(30, NOW + 1000).days.at(-1)!.usage;
    expect(day.costUsd).toBeCloseTo(0.3);
    expect(day.by!.model['openai/parent'].costUsd).toBeCloseTo(0.1);
    expect(day.by!.model['openrouter/deepseek/deepseek-flash'].costUsd).toBeCloseTo(0.2);
    expect(day.by!.harnessModel['pi|openrouter/deepseek/deepseek-flash'].costUsd).toBeCloseTo(0.2);
    expect(day.by!.model[UNKNOWN]).toBeUndefined();
  });
});
