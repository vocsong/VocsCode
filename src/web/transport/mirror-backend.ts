/** Answers the read surface from the desktop's sealed offline mirror (docs/REMOTE-ACCESS.md P4),
 *  so the shared store and Transcript render while the computer is unreachable. Everything here is
 *  a snapshot: nothing writes, and a session's snapshot is fetched the first time it is opened. */
import type { MirrorIndex, MirrorSnapshot } from '@shared/mirror';
import { TRANSCRIPT_PAGE_DEFAULT, TRANSCRIPT_PAGE_MAX } from '@shared/transcript-page';
import type { DesktopFocus, SessionMeta, SessionStatus, TranscriptItem } from '@shared/types';
import type { RelayClient } from '../../../relay/src/web-client';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

export class MirrorBackend {
  private index: MirrorIndex | null = null;
  private readonly snapshots = new Map<string, MirrorSnapshot>();

  constructor(private readonly client: RelayClient) {}

  /** Reads the sealed index. False when this browser holds no mirror key, or none was uploaded. */
  async load(): Promise<boolean> {
    if (!this.client.hasMirror()) return false;
    const index = await this.client.mirrorIndex();
    this.index = index;
    return !!index;
  }

  reset(): void {
    this.index = null;
    this.snapshots.clear();
  }

  get ready(): boolean {
    return !!this.index;
  }

  /** The channels a mirror can answer; anything else returns undefined and reaches the desktop. */
  async answer(channel: string, request: unknown): Promise<unknown | undefined> {
    if (!this.index) return undefined;
    if (channel === 'sessions:list') return this.sessions();
    if (channel === 'desktop:focus') return this.focus();
    if (channel === 'sessions:transcriptPage') return this.page(request as { id?: unknown; start?: unknown; end?: unknown; limit?: unknown });
    return undefined;
  }

  sessions(): SessionMeta[] {
    return (this.index?.sessions ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      createdAt: entry.updatedAt,
      updatedAt: entry.updatedAt,
      config: { harness: entry.harness as SessionMeta['config']['harness'], permissionMode: 'ask', projectRoot: entry.projectRoot },
      cwd: entry.projectRoot,
      status: entry.status as SessionStatus,
      harnessRef: {},
      usage: { ...ZERO_USAGE }
    }));
  }

  focus(): DesktopFocus {
    return { sessionId: this.index?.focus ?? null, at: this.index?.updatedAt ?? 0, windowFocused: false };
  }

  private async snapshot(id: string): Promise<MirrorSnapshot | null> {
    const cached = this.snapshots.get(id);
    if (cached) return cached;
    const snapshot = await this.client.mirrorSession(id);
    if (snapshot) this.snapshots.set(id, snapshot);
    return snapshot;
  }

  private async page(request: { id?: unknown; start?: unknown; end?: unknown; limit?: unknown }): Promise<{ items: TranscriptItem[]; start: number; total: number }> {
    const id = typeof request.id === 'string' ? request.id : '';
    const snapshot = id ? await this.snapshot(id) : null;
    const items = snapshot?.items ?? [];
    const total = items.length;
    const int = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback);
    const end = Math.min(total, Math.max(0, int(request.end, total)));
    const limit = Math.min(TRANSCRIPT_PAGE_MAX, Math.max(1, int(request.limit, TRANSCRIPT_PAGE_DEFAULT)));
    const start = Math.max(0, end - TRANSCRIPT_PAGE_MAX, Math.min(end, int(request.start, end - limit)));
    return { items: items.slice(start, end), start, total };
  }
}
