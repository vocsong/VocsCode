/** An explicit no-effort selection must survive the session boundary and restart without borrowing
 *  the saved preference. Drive the real manager/store/Claude adapter, stubbing only the SDK and MCP. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, SessionConfig, SessionEvent } from '../src/shared/types';
import { ClaudeAdapter } from '../src/main/harness/claude';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings } from '../src/main/settings';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (_id: string, ctx: ConstructorParameters<typeof ClaudeAdapter>[0]) => new ClaudeAdapter(ctx)
}));
vi.mock('../src/main/mcp/effective', async (original) => ({
  ...await original<typeof import('../src/main/mcp/effective')>(), resolveForSession: async () => []
}));

let root: string;
const managers: SessionManager[] = [];
const settings = defaultSettings();
const events: SessionEvent[] = [];
const closes: ReturnType<typeof vi.fn>[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-effort-boundary-'));
  settings.defaultEffort = 'high';
  settings.claude.settingSources = [];
  events.length = 0;
  closes.length = 0;
  queryMock.mockReset();
  queryMock.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const close = vi.fn();
    closes.push(close);
    return {
      close,
      interrupt: vi.fn(),
      supportedModels: async () => [],
      supportedCommands: async () => [],
      supportedAgents: async () => [],
      applyFlagSettings: vi.fn(),
      setModel: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'claude-effort-test', model: options.model, tools: [], slash_commands: [] };
        for await (const _message of prompt) {
          // A real subprocess responds after send() has returned to the manager.
          await new Promise<void>((resolve) => setImmediate(resolve));
          yield { type: 'assistant', message: { role: 'assistant', model: options.model, content: [{ type: 'text', text: 'PONG' }] } };
          yield { type: 'result', subtype: 'success', duration_ms: 10, total_cost_usd: 0, usage: {}, modelUsage: {} };
        }
      }
    };
  });
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAll();
  await fs.rm(root, { recursive: true, force: true });
});

async function boot() {
  const store = new SessionStore(root);
  await store.load();
  const manager = new SessionManager({
    store, settings: { get: () => settings, update: async (patch: Partial<AppSettings>) => Object.assign(settings, patch) } as never,
    runtime: { resolve: () => null } as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => undefined,
    pushEvent: ({ event }) => events.push(event), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn()
  });
  managers.push(manager);
  return manager;
}

async function turn(manager: SessionManager, id: string, turns: number) {
  await manager.send(id, { text: 'Say PONG' });
  await vi.waitFor(() => {
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(manager.get(id)?.status).toBe('idle');
    expect(manager.get(id)?.usage.turns).toBe(turns);
  });
  expect(events.filter((e) => e.type === 'error')).toEqual([]);
}

describe('session effort at the SDK boundary', () => {
  it('omits effort on start and restart while keeping the remembered preference', async () => {
    const manager = await boot();
    const meta = await manager.create({ title: 'No effort', config: {
      harness: 'claude', projectRoot: root, permissionMode: 'ask',
      model: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }, effort: null
    } });
    await turn(manager, meta.id, 1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].options).not.toHaveProperty('effort');
    expect(settings.defaultEffort).toBe('high');
    await manager.stopAll();
    expect(closes[0]).toHaveBeenCalledOnce();

    const restarted = await boot();
    expect(restarted.get(meta.id)?.config.effort).toBeNull();
    await turn(restarted, meta.id, 2);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1][0].options).toMatchObject({ resume: 'claude-effort-test' });
    expect(queryMock.mock.calls[1][0].options).not.toHaveProperty('effort');
    const transcript = await restarted.transcript(meta.id);
    expect(transcript.filter((item) => item.kind === 'assistant').map((item) => item.kind === 'assistant' && item.text)).toEqual(['PONG', 'PONG']);
    expect(settings.defaultEffort).toBe('high');

    // A later explicit choice on a capable model replaces the omission, not the app preference.
    await restarted.setModel(meta.id, { provider: 'anthropic', model: 'claude-sonnet-5' });
    await restarted.setEffort(meta.id, 'low');
    await restarted.stopAll();
    expect(closes[1]).toHaveBeenCalledOnce();
    const switched = await boot();
    await turn(switched, meta.id, 3);
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[2][0].options).toMatchObject({ model: 'claude-sonnet-5', effort: 'low' });
    expect(settings.defaultEffort).toBe('high');
  });

  it('does not start on a failed config write and preserves omission when creation is retried', async () => {
    const manager = await boot();
    const config: SessionConfig = { harness: 'claude', projectRoot: root, permissionMode: 'ask', effort: null,
      model: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } };
    const write = vi.spyOn(SessionStore.prototype, 'upsert').mockRejectedValueOnce(new Error('disk unavailable'));
    try {
      await expect(manager.create({ title: 'No effort', config, initialPrompt: 'Say PONG' })).rejects.toThrow('disk unavailable');
      expect(queryMock).not.toHaveBeenCalled();
      expect(settings.defaultEffort).toBe('high');
    } finally {
      write.mockRestore();
    }
    const meta = await manager.create({ title: 'No effort', config });
    const restarted = await boot();
    expect(restarted.get(meta.id)?.config.effort).toBeNull();
    await turn(restarted, meta.id, 1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].options).not.toHaveProperty('effort');
  });

  it.each([
    { effort: undefined, expected: 'high' },
    { effort: 'low', expected: 'low' }
  ] as const)('still sends $expected for effort=$effort', async ({ effort, expected }) => {
    const manager = await boot();
    const config: SessionConfig = { harness: 'claude', projectRoot: root, permissionMode: 'ask', effort,
      model: { provider: 'anthropic', model: 'claude-sonnet-5' } };
    const meta = await manager.create({ title: 'Effort supported', config });
    await turn(manager, meta.id, 1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].options.effort).toBe(expected);
    expect(settings.defaultEffort).toBe('high');
  });
});
