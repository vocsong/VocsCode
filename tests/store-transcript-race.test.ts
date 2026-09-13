/** Regression test: a transcript read must wait for in-flight appends, or the first prompt is dropped. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/main/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function store(): SessionStore {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-store-'));
  dirs.push(d);
  return new SessionStore(d);
}

function meta(id: string): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    config: { harness: 'native', permissionMode: 'ask', projectRoot: '/repo' },
    cwd: '/repo',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  } as SessionMeta;
}

const userItem = (text: string): TranscriptItem => ({ id: `u_${text}`, kind: 'user', ts: 1, text });
const assistantItem = (text: string): TranscriptItem => ({ id: `a_${text}`, kind: 'assistant', ts: 2, text });

describe('SessionStore transcript write/read race', () => {
  it('readTranscript includes an append that is still in flight (new-session first prompt)', async () => {
    const s = store();
    await s.upsert(meta('race1'));
    // Mirrors session-manager.send(): the item is pushed to the renderer, its append not yet awaited.
    const pending = s.appendTranscript('race1', userItem('hello'));
    const items = await s.readTranscript('race1');
    await pending;
    expect(items.map((i) => i.id)).toContain('u_hello');
  });

  it('serializes concurrent appends so the file keeps emission order', async () => {
    const s = store();
    await s.upsert(meta('race2'));
    await Promise.all([
      s.appendTranscript('race2', userItem('one')),
      s.appendTranscript('race2', assistantItem('two')),
      s.appendTranscript('race2', userItem('three'))
    ]);
    const items = await s.readTranscript('race2');
    expect(items.map((i) => i.id)).toEqual(['u_one', 'a_two', 'u_three']);
  });

  it('rewriteTranscript lands after pending appends so a cleared item is not resurrected', async () => {
    const s = store();
    await s.upsert(meta('race3'));
    const pending = s.appendTranscript('race3', userItem('stale'));
    await s.rewriteTranscript('race3', [assistantItem('fresh')]);
    await pending;
    const items = await s.readTranscript('race3');
    expect(items.map((i) => i.id)).toEqual(['a_fresh']);
  });

  it('a failed append does not block later writes, and onAppend fires only after the write', async () => {
    const s = store();
    await s.upsert(meta('race4'));
    const order: string[] = [];
    s.hooks.onAppend = (id, item) => {
      if (id === 'race4') order.push(item.id);
    };
    await expect(s.appendTranscript('bad~id', userItem('x'))).rejects.toThrow();
    await s.appendTranscript('race4', userItem('ok'));
    expect(order).toEqual(['u_ok']);
    const items = await s.readTranscript('race4');
    expect(items.map((i) => i.id)).toEqual(['u_ok']);
  });

  it('remove waits for in-flight appends before deleting the session directory', async () => {
    const s = store();
    await s.upsert(meta('race5'));
    const append = s.appendTranscript('race5', userItem('last'));
    await s.remove('race5');
    await append;
    // The directory is gone only if remove waited for the in-flight append to finish first.
    await expect(fs.access(path.join(dirs.at(-1) as string, 'sessions', 'race5'))).rejects.toThrow();
  });

  it('onAppend hook sees the item after it is durably appended', async () => {
    const s = store();
    await s.upsert(meta('race6'));
    const seen: TranscriptItem[] = [];
    s.hooks.onAppend = (id, item) => {
      if (id === 'race6') seen.push(item);
    };
    await s.appendTranscript('race6', userItem('hooked'));
    const items = await s.readTranscript('race6');
    expect(seen).toHaveLength(1);
    expect(items.map((i) => i.id)).toContain('u_hooked');
  });
});
