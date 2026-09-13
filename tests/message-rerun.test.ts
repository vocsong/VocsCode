import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SessionStore } from '../src/main/store';
import type { SessionMeta, TranscriptItem, UserInput } from '../src/shared/types';

const sent = vi.hoisted((): UserInput[] => []);

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (_id: string, ctx: { emit: (event: { type: 'status'; status: 'idle' }) => void }) => ({
    id: 'native',
    busy: false,
    start: async () => ctx.emit({ type: 'status', status: 'idle' }),
    send: async (input: UserInput) => void sent.push(input),
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    rewindToUserMessage: async () => true,
    dispose: async () => undefined
  })
}));

describe('editing a sent message', () => {
  it('rewrites the transcript through the edited prompt and starts a fresh turn', async () => {
    sent.length = 0;
    const session: SessionMeta = {
      id: 's_edit',
      title: 'Session',
      createdAt: 1,
      updatedAt: 1,
      cwd: 'G:/project',
      config: { harness: 'native', projectRoot: 'G:/project', permissionMode: 'ask' },
      harnessRef: { nativeHistory: true },
      status: 'idle',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const items: TranscriptItem[] = [
      { id: 'u_before', kind: 'user', ts: 1, text: 'keep this' },
      { id: 'a_before', kind: 'assistant', ts: 2, text: 'kept reply' },
      { id: 'u_edit', kind: 'user', ts: 3, text: 'old prompt' },
      { id: 'a_discard', kind: 'assistant', ts: 4, text: 'discard this reply' },
      { id: 'u_discard', kind: 'user', ts: 5, text: 'discard this prompt' }
    ];
    const transcripts = new Map([[session.id, items]]);
    const store = {
      list: () => [session],
      get: (id: string) => id === session.id ? session : undefined,
      upsert: vi.fn(async () => undefined),
      readTranscript: async (id: string) => transcripts.get(id) ?? [],
      rewriteTranscript: vi.fn(async (id: string, next: TranscriptItem[]) => void transcripts.set(id, next)),
      appendTranscript: vi.fn(async (id: string, item: TranscriptItem) => void transcripts.set(id, [...(transcripts.get(id) ?? []), item])),
      sessionDir: (id: string) => path.join('G:/tmp', id)
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });

    const result = await manager.editAndResend(session.id, 'u_edit', { text: 'revised prompt', mode: 'now' });

    expect(result.map((item) => item.id)).toEqual(['u_before', 'a_before', 'u_edit']);
    expect(result.at(-1)).toMatchObject({ kind: 'user', text: 'revised prompt', queuedAs: 'now' });
    expect(store.rewriteTranscript).toHaveBeenCalledWith(session.id, expect.arrayContaining([expect.objectContaining({ id: 'u_edit', text: 'revised prompt' })]));
    expect(sent).toEqual([{ text: 'revised prompt', images: undefined, mode: 'now', transcriptItemId: 'u_edit' }]);
  });
});
