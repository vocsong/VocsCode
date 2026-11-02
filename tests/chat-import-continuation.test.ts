import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverChatImports } from '../src/main/chat-import';
import { SessionStore } from '../src/main/store';
import { SettingsStore } from '../src/main/settings';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import type { HarnessContext } from '../src/main/harness/types';
import type { ChatImportSource } from '../src/shared/chat-import';
import type { HarnessId, HarnessRef, UserInput } from '../src/shared/types';

const runtime = vi.hoisted(() => ({
  sent: [] as { harness: HarnessId; sessionId: string; input: UserInput }[],
  started: [] as { harness: HarnessId; sessionId: string; ref: HarnessRef }[],
  disposed: [] as string[]
}));
vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (harness: HarnessId, ctx: HarnessContext) => ({
    id: harness, busy: false,
    start: async () => {
      runtime.started.push({ harness, sessionId: ctx.sessionId, ref: structuredClone(ctx.session().harnessRef) });
      ctx.updateRef(harness === 'claude' ? { claudeSessionId: `provider-${ctx.sessionId}` } : { codexThreadId: `provider-${ctx.sessionId}` });
    },
    send: async (input: UserInput) => {
      runtime.sent.push({ harness, sessionId: ctx.sessionId, input });
      const id = `answer-${runtime.sent.length}`;
      ctx.emit({ type: 'status', status: 'running' });
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'assistant', ts: Date.now(), text: '', streaming: true } });
      ctx.emit({ type: 'item.delta', id, textDelta: 'Scripted answer' });
      ctx.emit({ type: 'item.upsert', item: { id, kind: 'assistant', ts: Date.now(), text: 'Scripted answer', streaming: false } });
      ctx.emit({ type: 'item.upsert', item: { id: `${id}-turn`, kind: 'turn', ts: Date.now(), status: 'completed' } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
    interrupt: async () => undefined,
    setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined,
    dispose: async () => { runtime.disposed.push(ctx.sessionId); }
  })
}));

const managers: SessionManager[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.stopAll();
    await manager.flushPendingPersists();
  }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  runtime.sent.length = 0;
  runtime.started.length = 0;
  runtime.disposed.length = 0;
});

async function open(dir: string) {
  const store = new SessionStore(dir);
  await store.load();
  const settings = new SettingsStore(dir);
  await settings.load();
  const deps = {
    store, settings, runtime: {}, getSecret: async () => undefined,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn() },
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn()
  } as unknown as SessionManagerDeps;
  const manager = new SessionManager(deps);
  managers.push(manager);
  return { store, manager };
}

const discarded = 'DISCARDED-CODEX-TURN';
async function fixture(dir: string, source: ChatImportSource) {
  const home = path.join(dir, 'source');
  const file = source === 'claude'
    ? path.join(home, 'projects', 'fixture-project', 'original.jsonl')
    : path.join(home, 'sessions', '2026', '10', '30', 'rollout-original.jsonl');
  const message = (role: 'user' | 'assistant', text: string, id: string) => source === 'claude'
    ? { type: role, uuid: id, sessionId: 'external-session', cwd: dir, timestamp: '2026-10-30T01:00:00Z', message: { role, content: [{ type: 'text', text }] } }
    : { type: 'response_item', timestamp: '2026-10-30T01:00:00Z', payload: { id, type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
  const records = source === 'claude' ? [
    message('user', '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>', 'local-clear'),
    message('user', '<local-command-stdout>Conversation cleared.</local-command-stdout>', 'local-output'),
  ] : [{ type: 'session_meta', timestamp: '2026-10-30T01:00:00Z', payload: { id: 'external-session', cwd: dir } }];
  const rows: unknown[] = [...records, message('user', 'Historical question', 'old-user'), message('assistant', 'Historical answer', 'old-assistant')];
  if (source === 'codex') rows.push(
    message('user', `${discarded} question`, 'discarded-user'),
    message('assistant', `${discarded} answer`, 'discarded-assistant'),
    { type: 'event_msg', timestamp: '2026-10-30T01:01:00Z', payload: { type: 'thread_rolled_back', num_turns: 1 } }
  );
  const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  const scan = () => discoverChatImports(source, source === 'claude' ? { claudeDir: home } : { codexDir: home });
  return { file, bytes, scan };
}

const cases = (['claude', 'codex'] as const).flatMap((source) =>
  (['continue', 'fork-before', 'fork-after'] as const).map((mode) => ({ source, mode }))
);

describe('imported conversation lifecycle', () => {
  it.each(['continue', 'fork'] as const)('never sends Claude local command artifacts in the first %s prompt after restart', async (mode) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-import-commands-'));
    dirs.push(dir);
    const original = await fixture(dir, 'claude');
    const first = await open(path.join(dir, 'user-data'));
    const { imported } = await first.manager.importChats((await original.scan()).sessions);
    const { store, manager } = await open(path.join(dir, 'user-data'));
    const session = mode === 'fork' ? (await manager.fork(imported[0]!.id))! : store.get(imported[0]!.id)!;
    await manager.send(session.id, { text: 'Continue accepted work' });
    expect(runtime.sent).toHaveLength(1);
    const delivered = runtime.sent[0]!.input.text;
    expect(delivered).toContain('Historical question');
    expect(delivered).toContain('Historical answer');
    expect(delivered.endsWith('Continue accepted work')).toBe(true);
    expect(delivered).not.toMatch(/command-name|local-command-stdout|Conversation cleared/);
    expect(await store.readBlob(session.id, 'fork-context.md')).not.toMatch(/command-name|local-command-stdout|Conversation cleared/);
    const items = await store.readTranscript(session.id);
    expect(items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['Historical question', 'Continue accepted work']);
    expect(imported[0]!.title).toBe('Historical question');
    expect(await fs.readFile(original.file)).toEqual(original.bytes);
  });

  it.each(['continue', 'fork'] as const)('never sends a discarded Codex turn in the first %s prompt after import and restart', async (mode) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-import-rollback-'));
    dirs.push(dir);
    const original = await fixture(dir, 'codex');
    const first = await open(path.join(dir, 'user-data'));
    const { imported } = await first.manager.importChats((await original.scan()).sessions);
    const { store, manager } = await open(path.join(dir, 'user-data'));
    const session = mode === 'fork' ? (await manager.fork(imported[0]!.id))! : store.get(imported[0]!.id)!;
    await manager.send(session.id, { text: 'Continue accepted work' });
    expect(runtime.sent).toHaveLength(1);
    // Check the production handoff delivered to the adapter, independently of parser assertions.
    expect(runtime.sent[0]!.input.text).not.toContain(discarded);
    expect(runtime.sent[0]!.input.text).toContain('Historical question');
    expect(runtime.sent[0]!.input.text).toContain('Historical answer');
    expect(runtime.sent[0]!.input.text.endsWith('Continue accepted work')).toBe(true);
    expect(await store.readBlob(session.id, 'fork-context.md')).not.toContain(discarded);
    expect(JSON.stringify(await store.readTranscript(session.id))).not.toContain(discarded);
    expect(await fs.readFile(original.file)).toEqual(original.bytes);
  });

  it.each(cases)('$source $mode preserves accepted history, deduplicates, survives restart and leaves source bytes unchanged', async ({ source, mode }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-import-continue-'));
    dirs.push(dir);
    const original = await fixture(dir, source);
    const parsed = (await original.scan()).sessions;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.items.map((item) => 'text' in item ? item.text : '')).toEqual(['Historical question', 'Historical answer']);
    const first = await open(path.join(dir, 'user-data'));
    const duplicate = await Promise.all([first.manager.importChats(parsed), first.manager.importChats(parsed)]);
    expect(duplicate.map((result) => [result.imported.length, result.skipped])).toEqual([[1, 0], [0, 1]]);
    const originalId = duplicate[0]!.imported[0]!.id;
    expect(await first.store.readBlob(originalId, 'fork-context.md')).not.toContain(discarded);
    expect(await fs.readFile(original.file)).toEqual(original.bytes);

    const { store, manager } = await open(path.join(dir, 'user-data'));
    expect(await manager.importChats((await original.scan()).sessions)).toEqual({ imported: [], skipped: 1 });
    expect(store.list()).toHaveLength(1);
    expect(await store.readTranscript(originalId)).toEqual(parsed[0]!.items);
    if (mode === 'fork-after') {
      await manager.send(originalId, { text: 'First continuation' });
      expect(runtime.sent[0]!.input.text).toContain('Historical answer');
      await manager.stop(originalId);
      await manager.flushPendingPersists();
    }
    const session = mode === 'continue' ? store.get(originalId)! : (await manager.fork(originalId))!;
    expect(session.config.harness).toBe(source);
    if (mode !== 'continue') expect(session.importedFrom).toBeUndefined();
    const needsHandoff = session.pendingForkContext === true;
    // Claude can fork its newly created Vocs session through the SDK. Codex must carry text when
    // its fork starts without a provider reference; a visible transcript alone is not context.
    if (!needsHandoff) {
      expect(source).toBe('claude');
      expect(mode).toBe('fork-after');
      expect(session.harnessRef).toEqual({ claudeSessionId: `provider-${originalId}`, forkOnResume: true });
    }
    const before = runtime.sent.length;
    await manager.send(session.id, { text: 'Continue now' });
    expect(runtime.sent).toHaveLength(before + 1);
    const delivered = runtime.sent[before]!;
    expect(delivered).toMatchObject({ harness: source, sessionId: session.id });
    if (needsHandoff) {
      expect(runtime.started.at(-1)!.ref).toEqual({});
      expect(delivered.input.text).toContain('Historical question');
      expect(delivered.input.text).toContain('Historical answer');
      if (mode === 'fork-after') expect(delivered.input.text).toContain('First continuation');
    } else {
      expect(runtime.started.at(-1)!.ref).toEqual({ claudeSessionId: `provider-${originalId}`, forkOnResume: true });
    }
    expect(delivered.input.text).not.toContain(discarded);
    expect(delivered.input.text.endsWith('Continue now')).toBe(true);
    expect(manager.get(session.id)!.pendingForkContext).toBeUndefined();
    await manager.send(session.id, { text: 'Next question' });
    expect(runtime.sent).toHaveLength(before + 2);
    expect(runtime.sent[before + 1]!.input.text).toBe('Next question');
    await manager.stop(session.id);
    await manager.flushPendingPersists();
    expect(runtime.disposed.filter((id) => id === session.id)).toHaveLength(1);
    expect(manager.get(session.id)!.status).toBe('idle');
    const items = await store.readTranscript(session.id);
    expect(items.filter((item) => item.kind === 'turn' && !item.carried)).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([
      'Historical question', ...(mode === 'fork-after' ? ['First continuation'] : []), 'Continue now', 'Next question'
    ]);
    expect(JSON.stringify(items)).not.toContain(discarded);
    const context = await store.readBlob(session.id, 'fork-context.md');
    expect(context ?? '').not.toContain(discarded);
    const restarted = await open(path.join(dir, 'user-data'));
    expect(await restarted.store.readTranscript(session.id)).toEqual(items);
    expect(restarted.store.get(session.id)!.pendingForkContext).toBeUndefined();
    expect(restarted.store.list()).toHaveLength(mode === 'continue' ? 1 : 2);
    expect(await restarted.manager.importChats((await original.scan()).sessions)).toEqual({ imported: [], skipped: 1 });
    expect(await fs.readFile(original.file)).toEqual(original.bytes);
  });
});
