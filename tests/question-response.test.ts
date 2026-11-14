/** Validate before consuming a live question: rejected drafts must remain editable/retryable. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { ApprovalDraft } from '../src/main/harness/types';
import { createHandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import type { ApprovalDecision, ApprovalRequest, SessionEventEnvelope, SessionMeta, TranscriptItem } from '../src/shared/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-question-response-')); dirs.push(dir);
  const store = new SessionStore(dir); await store.load();
  const meta: SessionMeta = { id: 's_question', title: 'Question', cwd: dir, config: { harness: 'pi', projectRoot: dir, permissionMode: 'ask' },
    createdAt: 1, updatedAt: 1, status: 'idle', harnessRef: {}, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 } };
  await store.upsert(meta);
  const events: SessionEventEnvelope[] = [];
  const manager = new SessionManager({ store, settings: { get: () => defaultSettings() } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver, analytics: {} as AnalyticsStore, getSecret: async () => undefined,
    pushEvent: (event) => events.push(event), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn() });
  const active = { approvals: new Map(), liveItems: new Map(), dirty: new Set(), lastAssistantText: '', starting: null, models: null,
    adapter: { busy: true, id: 'pi' }, nativeChildren: new Map() };
  const access = manager as unknown as { active: Map<string, unknown>; requestApproval(id: string, request: ApprovalDraft): Promise<ApprovalDecision> };
  access.active.set(meta.id, active);
  const resolution = vi.fn();
  const pending = access.requestApproval(meta.id, { kind: 'question', title: 'Pi has a question', toolName: 'ask_user', supportsQuestionComment: true,
    maxQuestionResponseLength: 100, questions: [{ id: 'answer', question: 'Where?', allowOther: true, options: [{ label: 'staging' }] }],
    options: [{ id: 'allow', label: 'Answer', kind: 'allow' }, { id: 'deny', label: 'Skip', kind: 'deny' }] }).then((decision) => { resolution(decision); return decision; });
  const request = (events.find((entry) => entry.event.type === 'approval.request')!.event as { request: ApprovalRequest }).request;
  const registry = createHandlerRegistry({ sessions: manager, log: vi.fn() } as unknown as HandlerDeps);
  const respond = (decision: ApprovalDecision) => registry.invoke('approvals:respond', { sessionId: meta.id, requestId: request.id, decision });
  return { dir, store, manager, active, meta, request, pending, respond, resolution, events };
}

describe('live question response validation over registered IPC', () => {
  it.each([
    { label: 'empty', decision: { optionId: 'allow', answers: { answer: '   ' }, note: '   ' }, error: /Choose an option/ },
    { label: 'encoded oversized', decision: { optionId: 'allow', answers: { answer: 'staging' }, note: '"'.repeat(60) }, error: /100-character response limit/ },
    { label: 'oversized skip context', decision: { optionId: 'deny', answers: { answer: 'staging' }, note: '"'.repeat(60) }, error: /100-character response limit/ },
  ])('keeps an $label response pending until a valid retry, and persists only the accepted decision', async ({ decision, error }) => {
    const f = await fixture();
    await expect(f.respond(decision)).rejects.toThrow(error);
    expect(f.resolution).not.toHaveBeenCalled();
    expect(f.active.approvals.has(f.request.id)).toBe(true);
    expect(f.manager.get(f.meta.id)?.status).toBe('awaiting');
    expect(f.events.filter((event) => event.event.type === 'approval.resolved')).toEqual([]);
    expect(f.active.liveItems.get(f.request.id).decision).toBeUndefined();

    const accepted: ApprovalDecision = { optionId: 'allow', answers: { answer: 'staging' }, note: 'After review.' };
    await f.respond(accepted);
    expect(await f.pending).toEqual(accepted);
    expect(f.resolution).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(f.active.approvals.size).toBe(0);
    expect(f.manager.get(f.meta.id)?.status).toBe('running');
    expect(f.events.filter((event) => event.event.type === 'approval.resolved')).toHaveLength(1);
    await f.respond({ optionId: 'deny', note: 'Late response' });
    expect(f.resolution).toHaveBeenCalledTimes(1);
    expect(f.events.filter((event) => event.event.type === 'approval.resolved')).toHaveLength(1);

    await vi.waitFor(async () => {
      const saved = (await f.store.readTranscript(f.meta.id)).find((item) => item.id === f.request.id) as Extract<TranscriptItem, { kind: 'approval' }>;
      expect(saved?.decision).toEqual(accepted);
    });
    const reopened = new SessionStore(f.dir); await reopened.load();
    const saved = (await reopened.readTranscript(f.meta.id)).find((item) => item.id === f.request.id) as Extract<TranscriptItem, { kind: 'approval' }>;
    expect(saved.decision).toEqual(accepted);
    expect(saved.request.maxQuestionResponseLength).toBe(100);
  });
});
