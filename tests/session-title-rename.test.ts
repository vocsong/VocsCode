/**
 * Who gets to name a session. A session created from the dialog's prompt box — or from a goal — is
 * named before its first message is sent, and that name is a six-word cut of what the user typed.
 * It used to stay that way forever: the title model only ran when the title was still the literal
 * 'New session', which a seeded session never is. The placeholder flag is what lets the model
 * replace it, and what stops it from touching a name the user or the caller chose.
 */
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { HarnessId, ProviderConfig, UserInput } from '../src/shared/types';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';

const mocks = vi.hoisted(() => ({ sent: [] as { harness: HarnessId; input: UserInput }[] }));

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: HarnessId, ctx: HarnessContext) =>
    ({
      id,
      get busy() {
        return false;
      },
      start: async () => undefined,
      send: async (input: UserInput) => {
        mocks.sent.push({ harness: id, input });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => undefined,
      _ctx: ctx
    }) as unknown as HarnessAdapter
}));

/** A title endpoint that answers every request with `reply`, and counts the calls it got. */
async function titleServer(reply: () => unknown): Promise<{ url: string; calls: number; close: () => Promise<void> }> {
  const state = { url: '', calls: 0, close: async () => undefined as void };
  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    state.calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state as { url: string; calls: number; close: () => Promise<void> };
}

const answer = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });

let tmpRoot = '';
let counter = 0;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-title-'));
});
afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});
beforeEach(() => {
  mocks.sent.length = 0;
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

async function makeManager(baseUrl: string): Promise<{ manager: SessionManager; asked: () => string[]; settled: () => string[] }> {
  const store = new SessionStore(path.join(tmpRoot, `store${++counter}`));
  await store.load();
  const log = vi.fn();
  const providers: ProviderConfig[] = [
    { id: 'fake', kind: 'openai-compatible', name: 'Fake', enabled: true, hasApiKey: true, baseUrl, models: [{ id: 'cheap', provider: 'fake', displayName: 'Cheap' }] }
  ];
  const settings = { ...defaultSettings(), providers, utilityModel: { provider: 'fake', model: 'cheap' } };
  const deps: SessionManagerDeps = {
    store,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as never,
    runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => 'sk-test',
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log
  };
  // Each title call logs when it goes out and again when it comes back, so a test can wait for an
  // attempt to settle rather than for its request to arrive — the two are a scheduling gap apart.
  const lines = (keep: boolean) => log.mock.calls.map((c) => String(c[1])).filter((m) => m.startsWith('session title') && m.includes('asking') === keep);
  return { manager: new SessionManager(deps), asked: () => lines(true), settled: () => lines(false) };
}

const create = (manager: SessionManager, extra: Record<string, unknown> = {}) =>
  manager.create({ config: { harness: 'native', projectRoot: path.join(tmpRoot, 'proj'), permissionMode: 'ask' }, ...extra } as never);

describe('naming a session', () => {
  it('replaces the placeholder of a session created from the dialog prompt', async () => {
    const server = await titleServer(() => answer('Validate cap2 against cap4 profit'));
    try {
      const { manager } = await makeManager(server.url);
      const meta = await create(manager, { initialPrompt: 'i wanna validate my thinking, with cap2 vs cap4 at around 1.2m vs 1.4m profit' });
      // The cut prompt shows immediately, marked as the stand-in it is.
      expect(meta.title).toBe('i wanna validate my thinking, with…');
      expect(meta.titleIsPlaceholder).toBe(true);
      await vi.waitFor(() => expect(manager.get(meta.id)?.title).toBe('Validate cap2 against cap4 profit'));
      expect(manager.get(meta.id)?.titleIsPlaceholder).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('names a goal session after the objective, then lets the model name it properly', async () => {
    const server = await titleServer(() => answer('Ship the quarterly release'));
    try {
      const { manager } = await makeManager(server.url);
      const meta = await create(manager, { goal: 'ship the release before the end of the quarter' });
      // The objective's own words, not the `/goal …` command the app composed from them.
      expect(meta.title).toBe('ship the release before the end…');
      await vi.waitFor(() => expect(manager.get(meta.id)?.title).toBe('Ship the quarterly release'));
    } finally {
      await server.close();
    }
  });

  it('never re-titles a session the caller named', async () => {
    const server = await titleServer(() => answer('Something the model preferred'));
    try {
      const { manager } = await makeManager(server.url);
      const meta = await create(manager, { title: 'Fix issue #230', initialPrompt: 'fix the crash reported in issue 230' });
      expect(meta.titleIsPlaceholder).toBeUndefined();
      await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
      expect(manager.get(meta.id)?.title).toBe('Fix issue #230');
      expect(server.calls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('never re-titles a session the user renamed while the first turn ran', async () => {
    const server = await titleServer(() => answer('Something the model preferred'));
    try {
      const { manager } = await makeManager(server.url);
      const meta = await create(manager, { initialPrompt: 'look at the failing test' });
      await manager.patch(meta.id, { title: 'My own name' });
      await manager.send(meta.id, { text: 'and now the next one' });
      await vi.waitFor(() => expect(mocks.sent).toHaveLength(2));
      expect(manager.get(meta.id)?.title).toBe('My own name');
      expect(manager.get(meta.id)?.titleIsPlaceholder).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('retries once on a message that follows an unusable reply, then stops asking', async () => {
    // An unusable reply leaves the placeholder, and the next message is a better prompt to try
    // again with — but an unattended goal session sends many, and none of them should pay for a
    // title model that is not answering.
    const server = await titleServer(() => answer('   '));
    try {
      const { manager, asked, settled } = await makeManager(server.url);
      const meta = await create(manager, { initialPrompt: 'first message' });
      await vi.waitFor(() => expect(settled()).toHaveLength(1));
      await manager.send(meta.id, { text: 'second message' });
      await vi.waitFor(() => expect(settled()).toHaveLength(2));
      await manager.send(meta.id, { text: 'third message' });
      await vi.waitFor(() => expect(mocks.sent).toHaveLength(3));
      expect(asked()).toHaveLength(2);
      expect(server.calls).toBe(2);
      expect(manager.get(meta.id)?.title).toBe('first message');
      expect(manager.get(meta.id)?.titleIsPlaceholder).toBe(true);
    } finally {
      await server.close();
    }
  });
});
