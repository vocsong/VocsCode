/** Session instructions must reach engines without an append-system-prompt API, exactly once. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { sessionAppendPrompt } from '../src/main/harness/system-prompt';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { HarnessId, HarnessRef, UserInput } from '../src/shared/types';

const script = vi.hoisted(() => ({
  sent: [] as UserInput[],
  starts: [] as HarnessRef[],
  contexts: [] as HarnessContext[],
  failSend: false,
  turns: 0,
  disposals: 0
}));
vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: HarnessId, ctx: HarnessContext): HarnessAdapter => {
    script.contexts.push(ctx);
    return {
      id,
      busy: false,
      start: async () => { script.starts.push({ ...ctx.session().harnessRef }); },
      send: async (input) => {
        script.sent.push(input);
        if (script.failSend) {
          script.failSend = false;
          throw new Error('injected send failure');
        }
        const turn = ++script.turns;
        ctx.emit({ type: 'status', status: 'running' });
        if (id === 'codex') ctx.updateRef({ codexThreadId: 'fixture-thread' });
        ctx.emit({ type: 'item.upsert', item: { id: `a_${turn}`, kind: 'assistant', ts: turn, text: `Answer ${turn}`, streaming: true } });
        ctx.emit({ type: 'item.upsert', item: { id: `a_${turn}`, kind: 'assistant', ts: turn, text: `Answer ${turn}` } });
        ctx.emit({ type: 'item.upsert', item: { id: `t_${turn}`, kind: 'turn', ts: turn, status: 'completed', durationMs: 1 } });
        ctx.emit({ type: 'status', status: 'idle' });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => { script.disposals++; }
    };
  }
}));

let dir = '';
const managers: SessionManager[] = [];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-session-instructions-'));
  script.sent.length = 0;
  script.starts.length = 0;
  script.contexts.length = 0;
  script.failSend = false;
  script.turns = 0;
  script.disposals = 0;
});
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.stopAll();
    await manager.flushPendingPersists();
  }
  await fs.rm(dir, { recursive: true, force: true });
});

async function fixture(appText: string | undefined = 'App instructions.') {
  const store = new SessionStore(dir);
  await store.load();
  const settings = defaultSettings();
  settings.providers = [];
  const manager = new SessionManager({
    store,
    settings: { get: () => settings, update: async (patch) => Object.assign(settings, patch) } as SessionManagerDeps['settings'],
    runtime: {} as SessionManagerDeps['runtime'],
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as unknown as SessionManagerDeps['analytics'],
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn(),
    appInstructions: async () => appText,
    knowledgeDigest: async () => 'Project knowledge.'
  });
  managers.push(manager);
  return { manager, store };
}

const config = (harness: HarnessId, appendSystemPrompt = '  Session instructions.  ') => ({ harness, projectRoot: dir, permissionMode: 'plan' as const, appendSystemPrompt });

// These all share the existing first-message priming contract, not a replacement system prompt.
describe('session instruction preamble', () => {
  it.each(['codex', 'codex-exec', 'cursor', 'acp'] as const)('primes %s once, in app/session/knowledge order, without changing the transcript', async (harness) => {
    const { manager, store } = await fixture();
    const meta = await manager.create({ config: config(harness), title: 'Instruction fixture' });
    const images = [{ mimeType: 'image/png', data: 'fixture' }];
    await manager.send(meta.id, { text: 'First question', images });
    await manager.send(meta.id, { text: 'Second question' });
    expect(script.sent.map((input) => input.text)).toEqual([
      'App instructions.\n\nSession instructions.\n\nProject knowledge.\n\nFirst question',
      'Second question'
    ]);
    expect(script.sent[0].images).toEqual(images);
    expect(manager.get(meta.id)?.pendingAppInstructions).toBeUndefined();
    expect(manager.get(meta.id)?.pendingKnowledgeDigest).toBeUndefined();
    expect(manager.get(meta.id)?.status).toBe('idle');
    const items = await manager.transcript(meta.id);
    expect(items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['First question', 'Second question']);
    expect(items.filter((item) => item.kind === 'turn').map((item) => item.status)).toEqual(['completed', 'completed']);
    expect((await store.readTranscript(meta.id)).filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['First question', 'Second question']);
  });

  it('sends session instructions even when no app instruction file exists, and keeps blank additions empty', async () => {
    const { manager } = await fixture('');
    const meta = await manager.create({ config: config('codex'), title: 'Session only' });
    await manager.send(meta.id, { text: 'Question' });
    expect(script.sent[0].text).toBe('Session instructions.\n\nProject knowledge.\n\nQuestion');
    const blank = await manager.create({ config: config('codex', ' \n '), title: 'Blank instructions' });
    await manager.send(blank.id, { text: 'Another question' });
    expect(script.sent[1].text).toBe('Project knowledge.\n\nAnother question');
  });

  it('retains priming across a rejected send and restart, then never repeats it on a resumed thread', async () => {
    const first = await fixture();
    const meta = await first.manager.create({ config: config('codex'), title: 'Retry fixture' });
    script.failSend = true;
    await expect(first.manager.send(meta.id, { text: 'Failed question' })).rejects.toThrow('injected send failure');
    expect(first.manager.get(meta.id)?.pendingAppInstructions).toBe(true);
    await first.manager.stopAll();
    await first.manager.flushPendingPersists();
    expect(script.disposals).toBe(1);

    const retry = await fixture();
    expect(retry.manager.get(meta.id)?.pendingAppInstructions).toBe(true);
    await retry.manager.send(meta.id, { text: 'Retry question' });
    expect(script.sent.slice(0, 2).map((input) => input.text)).toEqual([
      'App instructions.\n\nSession instructions.\n\nProject knowledge.\n\nFailed question',
      'App instructions.\n\nSession instructions.\n\nProject knowledge.\n\nRetry question'
    ]);
    await retry.manager.stopAll();
    await retry.manager.flushPendingPersists();
    const resumed = await fixture();
    expect(resumed.manager.get(meta.id)?.pendingAppInstructions).toBeUndefined();
    await resumed.manager.send(meta.id, { text: 'After restart' });
    expect(script.starts).toEqual([{}, {}, { codexThreadId: 'fixture-thread' }]);
    expect(script.sent.map((input) => input.text)).toHaveLength(3);
    expect(script.sent[2].text).toBe('After restart');
    expect(resumed.manager.get(meta.id)?.status).toBe('idle');
    const items = await resumed.manager.transcript(meta.id);
    expect(items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['Failed question', 'Retry question', 'After restart']);
    expect(items.filter((item) => item.kind === 'turn').map((item) => item.status)).toEqual(['completed', 'completed']);
  });

  it('places instructions before knowledge and fork context without duplicating either on later turns', async () => {
    const { manager, store } = await fixture();
    const source = await manager.create({ config: config('claude'), title: 'Fork source' });
    await store.appendTranscript(source.id, { id: 'prior', kind: 'user', ts: 1, text: 'Previous question' });
    const fork = (await manager.fork(source.id, 'codex'))!;
    await manager.send(fork.id, { text: 'Continue' });
    expect(script.sent[0].text).toMatch(/^App instructions\.\n\nSession instructions\.\n\nProject knowledge\.\n\n/);
    expect(script.sent[0].text).toContain('Previous question');
    expect(script.sent[0].text.endsWith('\n\nContinue')).toBe(true);
    await manager.send(fork.id, { text: 'Next' });
    expect(script.sent[1].text).toBe('Next');
    expect(manager.get(fork.id)?.pendingForkContext).toBeUndefined();
  });

  it.each(['pi', 'claude', 'native'] as const)('leaves %s instructions to its supported append-system-prompt path', async (harness) => {
    const { manager } = await fixture();
    const meta = await manager.create({ config: config(harness), title: 'Supported fixture' });
    await manager.send(meta.id, { text: 'Question' });
    expect(script.sent.map((input) => input.text)).toEqual(['Question']);
    const ctx = script.contexts[0];
    expect(sessionAppendPrompt(ctx.session(), await ctx.appInstructions?.())).toBe('App instructions.\n\nSession instructions.\n\nProject knowledge.');
  });
});
