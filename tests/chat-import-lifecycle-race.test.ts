import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/main/store';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred } from '../src/main/util/async';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const dirs: string[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup() {
  // Canonicalize macOS's /var -> /private/var alias before comparing injected filesystem paths.
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'vocs-import-lifecycle-'));
  dirs.push(dir);
  const store = new SessionStore(dir);
  await store.load();
  return { dir, store };
}

function meta(dir: string, id = 'imported', title = 'Imported session'): SessionMeta {
  return {
    id, title, createdAt: 1, updatedAt: 2,
    config: { harness: 'claude', projectRoot: dir, permissionMode: 'ask', useWorktree: false },
    cwd: dir, status: 'idle', harnessRef: {}, usage: emptyUsage(), queued: 0,
    importedFrom: { source: 'claude', sessionId: id }, pendingForkContext: true,
  };
}

function items(text: string): TranscriptItem[] {
  return [{ id: 'user', kind: 'user', text, ts: 1 }, { id: 'assistant', kind: 'assistant', text: `Answer: ${text}`, ts: 2 }];
}

function gate() {
  const entered = deferred<void>();
  const release = deferred<void>();
  releases.push(() => release.resolve());
  return { entered, release };
}

async function restarted(dir: string) {
  const store = new SessionStore(dir);
  await store.load();
  return store;
}

async function expectImported(dir: string, entry: SessionMeta, rows: TranscriptItem[], context: string) {
  const store = await restarted(dir);
  expect(store.list()).toEqual([entry]);
  expect(await store.readTranscript(entry.id)).toEqual(rows);
  expect(await store.readBlob(entry.id, 'fork-context.md')).toBe(context);
}

describe('chat import/remove lifecycle serialization', () => {
  it('finishes old directory deletion before publishing a same-ID replacement, without blocking other IDs', async () => {
    const { dir, store } = await setup();
    const original = meta(dir);
    await store.importSession(original, items('old'), 'old context');
    const deletion = gate();
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]) === store.sessionDir(original.id)) {
        deletion.entered.resolve();
        await deletion.release.promise;
      }
      return rm(...args);
    });
    const removal = store.remove(original.id);
    await deletion.entered.promise;

    let replacementStarted = false;
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation((...args) => {
      if (String(args[0]) === store.sessionDir(original.id)) replacementStarted = true;
      return mkdir(...args);
    });
    const replacement = meta(dir, original.id, 'Replacement');
    const replacementRows = items('replacement');
    const imported = store.importSession(replacement, replacementRows, 'replacement context');
    // Give an unqueued import a chance to enter its first filesystem call. If it does, let it
    // finish before releasing rm: the old implementation then loses real files, not a timeout.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (replacementStarted) await imported;
    const other = meta(dir, 'independent');
    await store.importSession(other, items('independent'), 'independent context');
    expect(store.get(other.id)).toEqual(other);
    await store.remove(other.id);
    deletion.release.resolve();
    await Promise.all([removal, imported]);

    expect(store.list()).toEqual([replacement]);
    await expectImported(dir, replacement, replacementRows, 'replacement context');
  });

  it('removes a session requested during import only after publication, and keeps duplicate imports safe', async () => {
    const { dir, store } = await setup();
    const entry = meta(dir);
    const contextWrite = gate();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[1]) === path.join(store.sessionDir(entry.id), 'fork-context.md')) {
        contextWrite.entered.resolve();
        await contextWrite.release.promise;
      }
      return rename(...args);
    });
    const events: string[] = [];
    store.hooks.onRewrite = (id) => { if (id === entry.id) events.push('imported'); };
    store.hooks.onRemove = (id) => { if (id === entry.id) events.push('removed'); };
    const imported = store.importSession(entry, items('first'), 'first context');
    await contextWrite.entered.promise;
    const removal = store.remove(entry.id);
    await expect(store.importSession(entry, items('duplicate'), 'duplicate context')).rejects.toThrow('Session already exists');
    const other = meta(dir, 'other');
    await store.importSession(other, items('other'), 'other context');
    await store.remove(other.id);
    contextWrite.release.resolve();
    await Promise.all([imported, removal]);
    expect(events).toEqual(['imported', 'removed']);
    expect(store.list()).toEqual([]);
    expect((await restarted(dir)).list()).toEqual([]);
    await expect(fs.access(store.sessionDir(entry.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await store.importSession(entry, items('retry'), 'retry context');
    await expect(store.importSession(entry, items('duplicate'), 'duplicate context')).rejects.toThrow('Session already exists');
    await expectImported(dir, entry, items('retry'), 'retry context');
  });

  it.each(['transcript.jsonl', 'fork-context.md', 'sessions.json'])(
    'recovers from a rejected %s write and failed import cleanup with a queued removal and retry', async (file) => {
      const { dir, store } = await setup();
      const entry = meta(dir);
      const failedWrite = gate();
      const failure = new Error(`injected ${file} failure`);
      const target = file === 'sessions.json' ? path.join(dir, file) : path.join(store.sessionDir(entry.id), file);
      const rename = fs.rename.bind(fs);
      let failWrite = true;
      vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        if (String(args[1]) === target && failWrite) {
          failWrite = false;
          failedWrite.entered.resolve();
          await failedWrite.release.promise;
          throw failure;
        }
        return rename(...args);
      });
      const rm = fs.rm.bind(fs);
      let failCleanup = true;
      vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
        if (String(args[0]) === store.sessionDir(entry.id) && failCleanup) {
          failCleanup = false;
          throw new Error('injected cleanup failure');
        }
        return rm(...args);
      });
      const imported = Promise.allSettled([store.importSession(entry, items('failed'), 'failed context')]);
      await failedWrite.entered.promise;
      const removal = store.remove(entry.id);
      failedWrite.release.resolve();
      expect(await imported).toEqual([{ status: 'rejected', reason: failure }]);
      await removal;
      expect(store.list()).toEqual([]);
      expect((await restarted(dir)).list()).toEqual([]);
      await expect(fs.access(store.sessionDir(entry.id))).rejects.toMatchObject({ code: 'ENOENT' });
      await store.importSession(entry, items('recovered'), 'recovered context');
      await expectImported(dir, entry, items('recovered'), 'recovered context');
    }
  );

  it.each(['index', 'cleanup'] as const)('does not poison a queued replacement after a failed removal %s operation', async (stage) => {
    const { dir, store } = await setup();
    const entry = meta(dir);
    await store.importSession(entry, items('old'), 'old context');
    const failedRemoval = gate();
    const failure = new Error(`injected removal ${stage} failure`);
    const rename = fs.rename.bind(fs);
    const rm = fs.rm.bind(fs);
    let fail = true;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (stage === 'index' && String(args[1]) === path.join(dir, 'sessions.json') && fail) {
        fail = false;
        failedRemoval.entered.resolve();
        await failedRemoval.release.promise;
        throw failure;
      }
      return rename(...args);
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (stage === 'cleanup' && String(args[0]) === store.sessionDir(entry.id) && fail) {
        fail = false;
        failedRemoval.entered.resolve();
        await failedRemoval.release.promise;
        throw failure;
      }
      return rm(...args);
    });
    const removal = Promise.allSettled([store.remove(entry.id)]);
    await failedRemoval.entered.promise;
    const replacement = meta(dir, entry.id, 'Recovered replacement');
    const imported = store.importSession(replacement, items('recovered'), 'recovered context');
    failedRemoval.release.resolve();
    expect(await removal).toEqual([{ status: 'rejected', reason: failure }]);
    await imported;
    await expectImported(dir, replacement, items('recovered'), 'recovered context');
    await store.remove(entry.id);
    expect((await restarted(dir)).list()).toEqual([]);
    await expect(fs.access(store.sessionDir(entry.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains a rejected transcript append before deleting and importing the replacement', async () => {
    const { dir, store } = await setup();
    const entry = meta(dir);
    await store.importSession(entry, items('old'), 'old context');
    const appendGate = gate();
    const appendFile = fs.appendFile.bind(fs);
    vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(store.sessionDir(entry.id), 'transcript.jsonl')) {
        appendGate.entered.resolve();
        await appendGate.release.promise;
        throw new Error('injected append failure');
      }
      return appendFile(...args);
    });
    const appended = expect(store.appendTranscript(entry.id, items('late')[0]!)).rejects.toThrow('injected append failure');
    await appendGate.entered.promise;
    const removal = store.remove(entry.id);
    const imported = store.importSession(entry, items('replacement'), 'replacement context');
    await store.upsert(meta(dir, 'other'));
    appendGate.release.resolve();
    await Promise.all([appended, removal, imported]);
    await store.remove('other');
    await expectImported(dir, entry, items('replacement'), 'replacement context');
  });
});
