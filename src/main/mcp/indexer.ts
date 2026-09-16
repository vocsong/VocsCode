/**
 * Passive GitNexus indexing.
 *
 * Lifecycle hooks enqueue work and return immediately. Runs are serialized because GitNexus writes
 * one global registry, while duplicate hooks for the same checkout are coalesced. The analysis is
 * also forbidden from editing AGENTS.md / CLAUDE.md, so freshness cannot rewrite the instructions
 * that govern a live session.
 */
import path from 'node:path';
import { runCapture, type CaptureResult } from '../runtime';

export type GitnexusIndexReason = 'session-start' | 'commit' | 'pull-request' | 'merge' | 'manual';

export interface GitnexusIndexRequest {
  cwd: string;
  /** Settings are keyed by the main checkout even when cwd is a session worktree. */
  projectRoot: string;
  reason: GitnexusIndexReason;
}

export interface GitnexusIndexResult {
  ok: boolean;
  output?: string;
  error?: string;
  /** Internal/passive result: no process was needed. */
  skipped?: boolean;
}

interface PendingRun {
  request: GitnexusIndexRequest;
  reasons: Set<GitnexusIndexReason>;
  waiters: Array<(result: GitnexusIndexResult) => void>;
}

export interface GitnexusIndexerOptions {
  /** Resolved `gitnexus`/`gitnexus.cmd`, or npx when no install exists. */
  command: string | null;
  /** Empty for gitnexus; `['-y', 'gitnexus@latest']` for npx. */
  baseArgs?: string[];
  /** Passive work respects the app-wide and per-project built-in switches. */
  enabled?: (projectRoot: string) => boolean;
  /** Passive hooks refresh existing indexes only; the first index remains an explicit user action. */
  indexed?: (request: GitnexusIndexRequest) => Promise<boolean>;
  run?: (command: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<CaptureResult>;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  timeoutMs?: number;
}

function keyFor(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class GitnexusIndexer {
  private readonly pending = new Map<string, PendingRun>();
  private draining = false;

  constructor(private readonly opts: GitnexusIndexerOptions) {}

  /** Queue a best-effort refresh without delaying the lifecycle event that requested it. */
  schedule(request: GitnexusIndexRequest): void {
    if (this.opts.enabled && !this.opts.enabled(request.projectRoot)) {
      this.opts.log?.('debug', `gitnexus index skipped (${request.reason}): built-in disabled for ${request.projectRoot}`);
      return;
    }
    void this.enqueue(request);
  }

  /** Run through the same serialized queue, but report the outcome to the manual Re-index action. */
  index(request: GitnexusIndexRequest): Promise<GitnexusIndexResult> {
    return this.enqueue(request);
  }

  private enqueue(request: GitnexusIndexRequest): Promise<GitnexusIndexResult> {
    const cwd = path.resolve(request.cwd);
    const key = keyFor(cwd);
    return new Promise((resolve) => {
      const existing = this.pending.get(key);
      if (existing) {
        existing.reasons.add(request.reason);
        existing.waiters.push(resolve);
      } else {
        this.pending.set(key, { request: { ...request, cwd }, reasons: new Set([request.reason]), waiters: [resolve] });
      }
      if (!this.draining) {
        this.draining = true;
        queueMicrotask(() => void this.drain());
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      const [key, job] = this.pending.entries().next().value as [string, PendingRun];
      this.pending.delete(key);
      const result = await this.execute(job.request, [...job.reasons]);
      for (const resolve of job.waiters) resolve(result);
    }
    this.draining = false;
    // A hook can enqueue between the empty check and clearing the flag.
    if (this.pending.size) {
      this.draining = true;
      queueMicrotask(() => void this.drain());
    }
  }

  private async execute(request: GitnexusIndexRequest, reasons: GitnexusIndexReason[]): Promise<GitnexusIndexResult> {
    if (!this.opts.command) return { ok: false, error: 'GitNexus is not available. Install gitnexus or npx, then try again.' };
    const label = reasons.join(', ');
    if (!reasons.includes('manual') && this.opts.indexed && !(await this.opts.indexed(request))) {
      this.opts.log?.('debug', `gitnexus index skipped (${label}): ${request.projectRoot} has no index yet`);
      return { ok: true, skipped: true };
    }
    this.opts.log?.('debug', `gitnexus index started (${label}) in ${request.cwd}`);
    let result: CaptureResult;
    try {
      result = await (this.opts.run ?? runCapture)(
        this.opts.command,
        [...(this.opts.baseArgs ?? []), 'analyze', '--skip-agents-md'],
        { cwd: request.cwd, timeoutMs: this.opts.timeoutMs ?? 120_000 }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.log?.('warn', `gitnexus index failed (${label}) in ${request.cwd}: ${message}`);
      return { ok: false, error: message };
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.code !== 0) {
      const error = output || `GitNexus indexing failed${result.timedOut ? ' (timed out)' : ''}.`;
      this.opts.log?.('warn', `gitnexus index failed (${label}) in ${request.cwd}: ${error.slice(0, 600)}`);
      return { ok: false, error };
    }
    this.opts.log?.('info', `gitnexus index updated (${label}) in ${request.cwd}`);
    return { ok: true, output };
  }
}
