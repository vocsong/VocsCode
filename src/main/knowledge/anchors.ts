/**
 * Live anchor resolution: a wiki page names a file and a symbol, and GitNexus says whether that
 * symbol still exists and where it moved to. Pages never store structure — this is how a pointer
 * becomes checkable without copying any.
 *
 * The app talks to the one shared GitNexus server directly (not through the session scope proxy),
 * so it passes the repo name explicitly, exactly as the proxy does for a harness. A project that is
 * not indexed, a server that is not running, and a call that fails all resolve to `unavailable`
 * rather than an error: the panel must render a page whose anchors cannot be checked. One
 * wall-clock budget bounds the whole call, so a slow or wedged server cannot hold the panel.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KnowledgeAnchor, KnowledgeAnchorResolution, KnowledgeScope } from '../../shared/knowledge';
import { connectServer, type ConnectedMcpServer } from '../mcp/client';
import { errorMessage } from '../util/async';
import { parseLeadingJson } from '../util/json';

export interface AnchorResolver {
  /** One resolution per anchor, in the same order; never throws. */
  resolve(scope: KnowledgeScope, anchors: KnowledgeAnchor[]): Promise<KnowledgeAnchorResolution[]>;
}

export interface GitnexusAnchorDeps {
  /** The shared GitNexus endpoint, started lazily; null when it cannot start. */
  url: () => Promise<string | null>;
  /** The registry name of the index covering this project, or null when it is not indexed. */
  repoName: (scope: KnowledgeScope) => Promise<string | null>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** How long a resolution stays fresh. Default 5 minutes. */
  ttlMs?: number;
  /** Wall-clock ceiling for one `resolve()` call, covering the connect. Default 15 seconds. */
  budgetMs?: number;
  /** How many `context` calls may be in flight at once. Default 4. */
  concurrency?: number;
  now?: () => number;
}

interface ContextReply {
  status?: string;
  error?: string;
  symbol?: { uid?: string; name?: string; filePath?: string; startLine?: number; endLine?: number };
}

const DEFAULT_BUDGET_MS = 15_000;
/** One symbol lookup may never outlive the whole budget, but there is no point asking for less. */
const CALL_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;
const TIMED_OUT = 'Anchor resolution ran out of time.';

/**
 * Resolves `work`, or the fallback once `ms` have passed, retaining which side won. The loser
 * is left running — a GitNexus start cannot be cancelled — but its rejection is already handled
 * by the race, and nothing it does afterwards touches this resolver's cache.
 */
async function withinBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<{ value: T; timedOut: boolean }> {
  if (ms <= 0) return { value: fallback, timedOut: true };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ value, timedOut: false })),
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const anchorKey = (a: KnowledgeAnchor): string => `${a.file}\u0000${a.symbol ?? ''}`;
const cacheKey = (repo: string, a: KnowledgeAnchor): string => `${repo}\u0000${a.file}\u0000${a.symbol ?? ''}`;

/** Reads the leading JSON object GitNexus prints, tolerating the advice line it appends. */
export function parseContextReply(text: string, anchor: KnowledgeAnchor): KnowledgeAnchorResolution {
  const parsed = parseLeadingJson<ContextReply>(text);
  if (!parsed) return { ...anchor, status: 'unresolved', note: 'GitNexus returned no symbol data.' };
  if (parsed.error || parsed.status !== 'found' || !parsed.symbol) {
    return { ...anchor, status: 'unresolved', note: parsed.error ?? 'Not in GitNexus\u2019 index.' };
  }
  const symbol = parsed.symbol;
  const normalize = (p: string) => p.replace(/\\/g, '/');
  const moved = !!symbol.filePath && normalize(symbol.filePath) !== normalize(anchor.file);
  const lines = typeof symbol.startLine === 'number' && typeof symbol.endLine === 'number' ? { start: symbol.startLine, end: symbol.endLine } : undefined;
  return {
    ...anchor,
    status: 'resolved',
    ...(symbol.filePath ? { foundFile: symbol.filePath } : {}),
    ...(symbol.name ? { foundName: symbol.name } : {}),
    ...(symbol.uid ? { uid: symbol.uid } : {}),
    ...(lines ? { lines } : {}),
    ...(moved ? { note: `Now in ${symbol.filePath}.` } : {})
  };
}

export function createGitnexusAnchorResolver(deps: GitnexusAnchorDeps): AnchorResolver {
  const cache = new Map<string, { at: number; value: KnowledgeAnchorResolution }>();

  return {
    async resolve(scope, anchors) {
      if (!anchors.length) return [];
      const clock = deps.now ?? Date.now;
      // One budget covers the whole call — including the connect, which is the slowest failure —
      // because the panel waits on this synchronously: a page naming a dozen symbols must not hold
      // the detail view for minutes when GitNexus is wedged.
      const deadline = clock() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
      const left = () => deadline - clock();
      const spent = () => left() <= 0;
      // Ask the registry first: an unindexed project must not start the GitNexus server at all (on a
      // machine without the binary that is a slow npx attempt the panel would visibly wait on).
      const { value: repo, timedOut: repoTimedOut } = await withinBudget(deps.repoName(scope), left(), null);
      if (!repo) return anchors.map((a) => ({ ...a, status: 'unavailable' as const, note: repoTimedOut ? TIMED_OUT : 'This project is not indexed by GitNexus.' }));
      const { value: url, timedOut: urlTimedOut } = await withinBudget(deps.url(), left(), null);
      if (!url) return anchors.map((a) => ({ ...a, status: 'unavailable' as const, note: urlTimedOut ? TIMED_OUT : 'GitNexus is not running.' }));

      const now = clock();
      const ttl = deps.ttlMs ?? 300_000;
      const resolved = new Map<string, KnowledgeAnchorResolution>();
      const pending: KnowledgeAnchor[] = [];
      for (const anchor of anchors) {
        if (!anchor.symbol) continue;
        const hit = cache.get(cacheKey(repo, anchor));
        if (hit && now - hit.at < ttl) resolved.set(anchorKey(anchor), hit.value);
        else pending.push(anchor);
      }

      if (pending.length) {
        let client: ConnectedMcpServer | null = null;
        const queue = [...pending];
        try {
          client = await connectServer({ id: 'gitnexus', transport: 'http', url }, { timeoutMs: Math.max(left(), 1) });
          // Bounded parallelism: a few workers share the queue, each call capped by what is left of
          // the budget. `allSettled` keeps one failed call from returning while other workers are
          // still awaiting a client that `finally` closes — which leaks unhandled rejections and
          // writes into the cache after the caller has the answer.
          const workers = Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, queue.length);
          const calls = Array.from({ length: workers }, async () => {
            for (let anchor = queue.shift(); anchor; anchor = queue.shift()) {
              if (spent()) return;
              try {
                const result = await client!.call('context', { repo, name: anchor.symbol, file: anchor.file }, { timeoutMs: Math.min(CALL_TIMEOUT_MS, Math.max(left(), 1)) });
                const value = parseContextReply(result.output, anchor);
                resolved.set(anchorKey(anchor), value);
                cache.set(cacheKey(repo, anchor), { at: now, value });
              } catch (e) {
                deps.log('debug', `knowledge: anchor lookup failed for ${anchor.file}#${anchor.symbol}: ${errorMessage(e)}`);
              }
            }
          });
          await Promise.allSettled(calls);
        } catch (e) {
          deps.log('warn', `knowledge: anchor resolution failed: ${errorMessage(e)}`);
        } finally {
          await client?.close();
        }
        const note = spent() ? TIMED_OUT : 'GitNexus did not answer.';
        for (const anchor of pending) {
          if (!resolved.has(anchorKey(anchor))) resolved.set(anchorKey(anchor), { ...anchor, status: 'unavailable', note });
        }
      }

      // A file-only anchor has no symbol to look up; presence on disk is the honest answer.
      for (const anchor of anchors) {
        if (anchor.symbol || resolved.has(anchorKey(anchor))) continue;
        const exists = await fs
          .stat(path.join(scope.projectRoot, anchor.file))
          .then(() => true)
          .catch(() => false);
        resolved.set(anchorKey(anchor), { ...anchor, status: exists ? 'resolved' : 'unresolved', ...(exists ? {} : { note: 'File not found.' }) });
      }

      return anchors.map((a) => resolved.get(anchorKey(a)) ?? { ...a, status: 'unavailable' as const, note: 'Not checked.' });
    }
  };
}
