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
import type { HarnessId, ProviderConfig, TranscriptItem, UserInput } from '../src/shared/types';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';

const mocks = vi.hoisted(() => ({ sent: [] as { harness: HarnessId; input: UserInput; ctx: HarnessContext }[] }));

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: HarnessId, ctx: HarnessContext) =>
    ({
      id,
      get busy() {
        return false;
      },
      start: async () => undefined,
      send: async (input: UserInput) => {
        mocks.sent.push({ harness: id, input, ctx });
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
async function titleServer(reply: (prompt: string) => unknown | Promise<unknown>) {
  const state = { url: '', calls: 0, close: async () => undefined as void };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    state.calls++;
    const response = await reply(messages.at(-1).content);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
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

async function makeManager(
  baseUrl: string,
  kind: ProviderConfig['kind'] = 'openai-compatible',
  utility = true,
  store = new SessionStore(path.join(tmpRoot, `store${++counter}`))
) {
  await store.load();
  const log = vi.fn();
  const providers: ProviderConfig[] = [
    { id: 'fake', kind, name: 'Fake', enabled: true, hasApiKey: true, baseUrl, models: [{ id: 'cheap', provider: 'fake', displayName: 'Cheap' }] }
  ];
  const settings = { ...defaultSettings(), providers, utilityModel: utility ? { provider: 'fake', model: 'cheap' } : undefined };
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
  return { manager: new SessionManager(deps), store, asked: () => lines(true), settled: () => lines(false) };
}

const create = (manager: SessionManager, extra: Record<string, unknown> = {}) =>
  manager.create({ config: { harness: 'native', projectRoot: path.join(tmpRoot, 'proj'), permissionMode: 'ask' }, ...extra } as never);

function finishTurn(status: Extract<TranscriptItem, { kind: 'turn' }>['status'], text: string): void {
  const { ctx } = mocks.sent.at(-1)!;
  ctx.emit({ type: 'item.upsert', item: { id: `reply-${mocks.sent.length}`, kind: 'assistant', ts: Date.now(), text, streaming: false } });
  ctx.emit({ type: 'item.upsert', item: { id: `turn-${mocks.sent.length}`, kind: 'turn', ts: Date.now(), status } });
  ctx.emit({ type: 'status', status: 'idle' });
}

describe('message files', () => {
  it('sends a first-prompt upload to the adapter and retains only a file reference in the transcript', async () => {
    const { manager, store } = await makeManager('http://127.0.0.1:1');
    const data = Buffer.from('hello from upload').toString('base64');
    const meta = await create(manager, { initialPrompt: 'read this', initialFiles: [{ name: 'notes.txt', mimeType: 'text/plain', data }] });
    await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
    const text = mocks.sent[0].input.text;
    expect(text).toContain('read this');
    expect(text).toContain('notes.txt');
    const filePath = JSON.parse(text.match(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*$/m)![0]) as string;
    expect(await fs.readFile(filePath, 'utf8')).toBe('hello from upload');
    await vi.waitFor(async () => expect((await store.readTranscript(meta.id)).some((i) => i.kind === 'user')).toBe(true));
    const item = (await store.readTranscript(meta.id)).find((i) => i.kind === 'user');
    expect(item?.kind === 'user' && item.files?.[0]?.path).toBe(filePath);
    expect(JSON.stringify(item)).not.toContain(data);
    const reopened = new SessionStore(path.dirname(path.dirname(store.sessionDir(meta.id))));
    await reopened.load();
    const restored = (await reopened.readTranscript(meta.id)).find((i) => i.kind === 'user');
    expect(restored?.kind === 'user' && restored.files?.[0]?.path).toBe(filePath);
    expect(await fs.readFile(filePath, 'utf8')).toBe('hello from upload');
  });
});

describe('refreshing automatic titles after a turn', () => {
  it('refines a title after each completed turn and keeps doing so after restart', async () => {
    const server = await titleServer((prompt) => answer(
      prompt.includes('The orange badge uses') ? 'Fix the orange badge' : prompt.includes('The green banner needs') ? 'Test the green banner' : 'Investigate rendering'
    ));
    try {
      const first = await makeManager(server.url);
      const meta = await create(first.manager, { initialPrompt: 'look at the rendering issue' });
      await vi.waitFor(() => expect(first.manager.get(meta.id)?.title).toBe('Investigate rendering'));
      await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
      finishTurn('completed', 'The orange badge uses the wrong color.');
      await vi.waitFor(() => expect(first.manager.get(meta.id)?.title).toBe('Fix the orange badge'));
      await first.manager.stop(meta.id);
      await first.manager.flushPendingPersists();

      const reopened = new SessionStore(path.dirname(path.dirname(first.store.sessionDir(meta.id))));
      const restarted = await makeManager(server.url, 'openai-compatible', true, reopened);
      expect(restarted.manager.get(meta.id)?.title).toBe('Fix the orange badge');
      await restarted.manager.send(meta.id, { text: 'move on to the banner' });
      finishTurn('completed', 'The green banner needs a visual test.');
      await vi.waitFor(() => expect(restarted.manager.get(meta.id)?.title).toBe('Test the green banner'));
      expect(server.calls).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('does not let a slow opening title overwrite the completed-turn title', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const server = await titleServer(async (prompt) => {
      if (prompt.includes('Resolved the rendering bug')) return answer('Fix settings rendering');
      await hold;
      return answer('Investigate settings');
    });
    try {
      const { manager, settled } = await makeManager(server.url);
      const meta = await create(manager, { initialPrompt: 'look at the rendering issue' });
      await vi.waitFor(() => expect(server.calls).toBe(1));
      await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
      finishTurn('completed', 'Resolved the rendering bug');
      await vi.waitFor(() => expect(manager.get(meta.id)?.title).toBe('Fix settings rendering'));
      release();
      await vi.waitFor(() => expect(settled()).toHaveLength(2));
      expect(manager.get(meta.id)?.title).toBe('Fix settings rendering');
    } finally {
      release();
      await server.close();
    }
  });

  it('ignores failed and interrupted turns and keeps a manual rename over a late reply', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const server = await titleServer(async (prompt) => {
      if (!prompt.includes('Finished work')) return answer('Investigate rendering');
      await hold;
      return answer('Late automatic title');
    });
    try {
      const { manager, asked, settled } = await makeManager(server.url);
      const meta = await create(manager, { initialPrompt: 'look at the rendering issue' });
      await vi.waitFor(() => expect(manager.get(meta.id)?.title).toBe('Investigate rendering'));
      await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
      finishTurn('failed', 'Failed work');
      await manager.send(meta.id, { text: 'stop this one' });
      finishTurn('interrupted', 'Interrupted work');
      expect(asked()).toHaveLength(1);

      await manager.send(meta.id, { text: 'finish this one' });
      finishTurn('completed', 'Finished work');
      await vi.waitFor(() => expect(server.calls).toBe(2));
      // A same-title rename still makes the name the user's choice.
      await manager.patch(meta.id, { title: 'Investigate rendering' });
      release();
      await vi.waitFor(() => expect(settled()).toHaveLength(2));
      expect(manager.get(meta.id)?.title).toBe('Investigate rendering');
      await manager.send(meta.id, { text: 'one more' });
      finishTurn('completed', 'Completed more work');
      expect(asked()).toHaveLength(2);
    } finally {
      release();
      await server.close();
    }
  });

  it('keeps opening-prompt naming without a utility model but does not refresh on completion', async () => {
    const server = await titleServer(() => answer('Investigate rendering'));
    try {
      const { manager, asked } = await makeManager(server.url, 'openai-compatible', false);
      const meta = await create(manager, { initialPrompt: 'look at the rendering issue' });
      await vi.waitFor(() => expect(manager.get(meta.id)?.title).toBe('Investigate rendering'));
      await vi.waitFor(() => expect(mocks.sent).toHaveLength(1));
      finishTurn('completed', 'A different topic');
      expect(asked()).toHaveLength(1);
      expect(manager.get(meta.id)?.title).toBe('Investigate rendering');
    } finally {
      await server.close();
    }
  });
});

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

  it('routes retries for an OpenCode Go title under the existing session id', async () => {
    const headers: IncomingMessage['headers'][] = [];
    const server = createServer((req, res) => {
      headers.push(req.headers);
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (!req.headers['x-opencode-session'] || req.headers['x-opencode-client'] !== 'vocs-code') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'Request is missing x-opencode-session and cannot be routed efficiently' } }));
          return;
        }
        res.end(JSON.stringify(answer(headers.length === 1 ? '' : 'Name the session')));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const { manager, settled } = await makeManager(url, 'opencode-go');
      const meta = await create(manager, { initialPrompt: 'name this session' });
      await vi.waitFor(() => expect(settled()).toHaveLength(1));
      await manager.send(meta.id, { text: 'and retry the name' });
      await vi.waitFor(() => expect(manager.get(meta.id)?.title).toBe('Name the session'));
      expect(headers).toHaveLength(2);
      expect(headers.map((h) => h['x-opencode-session'])).toEqual([meta.id, meta.id]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
      finishTurn('completed', 'Fixed the crash');
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
