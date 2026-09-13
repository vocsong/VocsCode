/** Git reads live only while subscribed: one in flight, one debounced latest request. */
import { useEffect, useRef, useState } from 'react';
import type { GitSummary } from '../../shared/types';
import { invoke } from './api';

const DEBOUNCE_MS = 80;
type Snapshot<T> = { data?: T; error?: Error; loading: boolean };

class GitRead<T extends { error?: string }> {
  snapshot: Snapshot<T> = { loading: true };
  listeners = new Set<() => void>();
  private key?: string;
  private generation = 0;
  private running = false;
  private pending = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private fetch: (key: string) => Promise<T>) {}

  request(key: string, immediate = false, force = false) {
    if (this.disposed || (!force && key === this.key && ((!this.snapshot.error && !this.snapshot.data?.error) || this.snapshot.loading))) return;
    const first = this.key === undefined;
    this.key = key;
    this.generation++;
    this.pending = true;
    this.publish({ ...this.snapshot, error: undefined, loading: true });
    clearTimeout(this.timer);
    this.timer = undefined;
    // Let StrictMode finish its setup/cleanup replay before issuing the first IPC.
    if (first) queueMicrotask(() => this.run());
    else if (immediate) this.run();
    else this.timer = setTimeout(() => { this.timer = undefined; this.run(); }, DEBOUNCE_MS);
  }

  refresh(key = this.key) {
    if (key !== undefined) this.request(key, true, true);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }

  private publish(snapshot: Snapshot<T>) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  private async run() {
    if (this.disposed || this.running || !this.pending || this.timer !== undefined) return;
    this.running = true;
    this.pending = false;
    const generation = this.generation;
    try {
      const data = await this.fetch(this.key!);
      if (!this.disposed && generation === this.generation) this.publish({ data, loading: false });
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ ...this.snapshot, error: error instanceof Error ? error : new Error(String(error)), loading: false });
      }
    } finally {
      this.running = false;
      // A timer may already have elapsed during IPC; only the latest request survives.
      this.run();
    }
  }
}

const summaries = new Map<string, GitRead<GitSummary>>();
function summaryRead(sessionId: string) {
  let read = summaries.get(sessionId);
  if (!read) {
    read = new GitRead(() => invoke('git:summary', { sessionId }));
    summaries.set(sessionId, read);
  } else if (!read.snapshot.loading) {
    // A later panel mount must observe external edits even while Header retains its subscription.
    // Simultaneous mounts still share the pending initial read.
    read.refresh();
  }
  return read;
}
function releaseSummary(sessionId: string, read: GitRead<GitSummary>) {
  if (read.listeners.size) return;
  read.dispose();
  summaries.delete(sessionId);
}

type DiffResult = { diff: string; error?: string };
function diffRead(sessionId: string) {
  return new GitRead<DiffResult>((key) => {
    const [, path] = JSON.parse(key) as [number, string | null];
    return invoke('git:diff', { sessionId, path: path ?? undefined });
  });
}
function releaseDiff(_sessionId: string, read: GitRead<DiffResult>) { read.dispose(); }

function useGitRead<T extends { error?: string }>(
  sessionId: string,
  key: string,
  acquire: (id: string) => GitRead<T>,
  release: (id: string, read: GitRead<T>) => void,
) {
  const current = useRef<GitRead<T> | null>(null);
  const [state, setState] = useState<{ sessionId: string; snapshot: Snapshot<T> }>();
  useEffect(() => {
    const read = acquire(sessionId);
    current.current = read;
    const update = () => setState({ sessionId, snapshot: read.snapshot });
    read.listeners.add(update);
    update();
    return () => {
      read.listeners.delete(update);
      current.current = null;
      release(sessionId, read);
    };
  }, [sessionId, acquire, release]);
  useEffect(() => { current.current?.request(key); }, [sessionId, key]);
  const snapshot = state?.sessionId === sessionId ? state.snapshot : { loading: true };
  return {
    ...snapshot,
    refresh: (overrideKey?: string) => current.current?.refresh(overrideKey),
  };
}

export function useGitSummary(sessionId: string, version: number) {
  return useGitRead(sessionId, String(version), summaryRead, releaseSummary);
}

export function useGitDiff(sessionId: string, version: number, path: string | null) {
  const latestVersion = useRef(version);
  latestVersion.current = version;
  const read = useGitRead(sessionId, JSON.stringify([version, path]), diffRead, releaseDiff);
  return {
    ...read,
    refresh: (nextPath?: string | null) => read.refresh(nextPath === undefined ? undefined : JSON.stringify([latestVersion.current, nextPath])),
  };
}
