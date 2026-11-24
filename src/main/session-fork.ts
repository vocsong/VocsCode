/** Session forking (same-harness & cross-harness worktree/context handoff) and Markdown export. */
import type { AppSettings, HarnessId, HarnessRef, SessionMeta, TranscriptItem } from '../shared/types';
import { normalizeBranchPrefix } from '../shared/branch-prefix';
import { HARNESS_BY_ID, closestPermissionMode } from '../shared/harness-meta';
import { tokensPerSecond, turnSpeed } from './analytics';
import { renderForkContext } from './fork-context';
import { createForkWorktree, slugify } from './git';
import { emptyUsage } from './models/static-models';
import { describeModel, describeResume, FORK_CONTEXT_FILE } from './session-types';
import type { SessionStore } from './store';
import { errorMessage, shortId } from './util/async';

export interface SessionForkHost {
  store: Pick<SessionStore, 'upsert' | 'rewriteTranscript' | 'readNativeHistory' | 'writeNativeHistory' | 'writeBlob'>;
  getSession(id: string): SessionMeta | undefined;
  transcript(id: string): Promise<TranscriptItem[]>;
  settings(): AppSettings;
  pushSessions(): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

/**
 * Forks a session (optionally into another harness), allocating a new worktree when the source
 * has one, zeroing inherited usage counters so spend is never double-counted, and writing a plain
 * text handoff blob whenever provider-side resume cannot carry over.
 */
export async function forkSession(host: SessionForkHost, id: string, harness?: HarnessId): Promise<SessionMeta | null> {
  const src = host.getSession(id);
  if (!src) return null;
  const items = await host.transcript(id);
  const nid = shortId('s_');
  const cross = !!harness && harness !== src.config.harness;
  const target = cross ? harness! : src.config.harness;
  const title = cross ? `${src.title} (fork → ${HARNESS_BY_ID[target].name})` : `${src.title} (fork)`;
  // A fork of a worktree session gets a worktree — and a branch — of its own. Sharing the source's
  // directory used to be the whole fork: archiving the source with its worktree removed deleted the
  // folder the fork was running in. The new branch starts at the source checkout's HEAD, so
  // committed work carries over; uncommitted changes stay in the source worktree.
  const own = await forkWorktree(src, title, host.log);
  const meta: SessionMeta = {
    ...structuredClone(src),
    id: nid,
    title,
    // The fork suffix names which session this came from; a title model would drop that.
    titleIsPlaceholder: undefined,
    titleIsAutomatic: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    statusDetail: undefined,
    fastModeStatus: { state: !cross && src.config.fastMode ? 'requested' : 'off' },
    queued: 0,
    // A fork carries the conversation, not the ledger. The source's totals describe work this
    // session did not do, and inheriting them charges the same dollars to two sessions — which
    // the dashboard then adds up twice. Its own counters start at zero; the copied rows below
    // keep their text and tokens for context but are worth nothing.
    usage: emptyUsage(),
    forkedFrom: src.id,
    controlCreation: undefined,
    importedFrom: undefined,
    // A fork of a mission session is an ordinary session: it carries the conversation, not the role.
    mission: undefined,
    harnessRef: {},
    pendingForkContext: undefined,
    pendingKnowledgeDigest: undefined,
    goal: undefined,
    // A fresh fork starts unpinned and active, never in the archive.
    pinned: undefined,
    pinnedAt: undefined,
    archived: undefined,
    // Nobody has looked at a fork yet, and nothing it did has finished unviewed.
    unseenAt: undefined,
    unseenFailed: undefined,
    lastViewedAt: undefined,
    cwd: own?.path ?? src.cwd,
    // Only a worktree this fork created is the fork's to remove. When it shares the source's
    // directory it owns no worktree: claiming the source's would make archiving the fork delete it.
    worktreeBranch: own?.branch
  };
  if (cross) {
    // A different harness cannot resume the source's provider session: it starts fresh in the
    // fork's own worktree. The copied transcript is carried over for reference only.
    const s = host.settings();
    meta.config = {
      ...src.config,
      harness: target,
      model: s.defaultModelByHarness[target],
      acpAgent: undefined,
      codexModelProvider: undefined,
      fastMode: false,
      permissionMode: closestPermissionMode(target, src.config.permissionMode),
      useWorktree: !!own
    };
    meta.activeModel = meta.config.model;
    meta.activeEffort = undefined;
  } else {
    // Claude can fork a provider session only in its original directory. Native can copy
    // its local history. Other harnesses deliberately start a new provider session.
    if (!own && src.config.harness === 'claude' && src.harnessRef.claudeSessionId) {
      meta.harnessRef = { claudeSessionId: src.harnessRef.claudeSessionId, forkOnResume: true } as HarnessRef;
    }
    if (src.config.harness === 'native') {
      const hist = await host.store.readNativeHistory(id);
      if (hist) await host.store.writeNativeHistory(nid, hist);
      meta.harnessRef = { nativeHistory: true };
    }
  }
  // The fork keeps the project's digest (same project) but hands it over the way
  // its own harness can: in the system prompt, or on the first message.
  if (meta.knowledgeDigest && !HARNESS_BY_ID[meta.config.harness].capabilities.systemPrompt) meta.pendingKnowledgeDigest = true;
  if (!HARNESS_BY_ID[meta.config.harness].capabilities.systemPrompt) meta.pendingAppInstructions = true;
  const keep = items.filter((i) => !(i.kind === 'approval' && !i.decision)).map(carriedItem);
  // When a provider session isn't reused, the fork starts with the copied conversation as text,
  // even if it still uses the same harness. Native disk history and Claude fork-on-resume stay as-is.
  const lostResume = !cross && !describeResume(meta.harnessRef) && !!describeResume(src.harnessRef);
  if (cross || lostResume || src.pendingForkContext) {
    // Hand the prior conversation over as plain text: the first message in the fork carries it
    // and then the flag is cleared.
    await host.store.writeBlob(nid, FORK_CONTEXT_FILE, renderForkContext(keep, src.config.harness, target));
    meta.pendingForkContext = true;
    keep.push({
      id: shortId('i_'),
      kind: 'info',
      ts: Date.now(),
      level: 'info',
      text: forkNote(src, target, own, cross)
    });
  }
  await host.store.upsert(meta);
  await host.store.rewriteTranscript(nid, keep);
  host.log(
    'info',
    `[${nid}] forked from ${id}${cross ? ` (${src.config.harness} → ${target})` : ''}; ${keep.length} transcript item(s) carried over${own ? `; worktree ${own.branch} at ${own.path}` : '; sharing the source directory'}`
  );
  host.pushSessions();
  return meta;
}

/**
 * The worktree a fork runs in, when its source had one. Returns null for a source that was never
 * isolated, and for one whose new worktree could not be created — a fork that runs in the
 * source's directory is better than no fork, and the archive risk is only the old one.
 */
async function forkWorktree(
  src: SessionMeta,
  title: string,
  log: SessionForkHost['log']
): Promise<{ path: string; branch: string } | null> {
  if (!src.worktreeBranch) return null;
  try {
    return await createForkWorktree(src.config.projectRoot, slugify(title), {
      cwd: src.cwd,
      branch: src.worktreeBranch,
      branchPrefix: normalizeBranchPrefix(src.config.branchPrefix)
    });
  } catch (e) {
    log('warn', `fork: could not create a worktree from ${src.cwd}: ${errorMessage(e)} — the fork shares the source directory`);
    return null;
  }
}

/** Renders a session transcript as a portable Markdown document. */
export function exportSessionMarkdown(meta: SessionMeta | undefined, items: readonly TranscriptItem[]): string {
  const lines: string[] = [
    `# ${meta?.title ?? 'Session'}`,
    '',
    `- Harness: ${meta?.config.harness}`,
    `- Model: ${describeModel(meta?.activeModel)}`,
    `- Directory: ${meta?.cwd}`,
    `- Cost: $${(meta?.usage.costUsd ?? 0).toFixed(4)}`,
    ''
  ];
  for (const it of items) {
    switch (it.kind) {
      case 'user':
        lines.push(`## User`, '', it.text, '');
        break;
      case 'assistant':
        if (it.thinking) lines.push(`<details><summary>Thinking</summary>\n\n${it.thinking}\n\n</details>`, '');
        if (it.text) lines.push(`## Assistant${it.model ? ` (${it.model})` : ''}`, '', it.text, '');
        break;
      case 'tool':
        lines.push(`### Tool: ${it.name} — ${it.summary ?? ''}`, '', '```', (it.output ?? '').slice(0, 20_000), '```', '');
        if (it.changes) for (const c of it.changes) if (c.diff) lines.push('```diff', c.diff, '```', '');
        break;
      case 'approval':
        lines.push(`> Approval: ${it.request.title} → ${it.decision?.optionId ?? 'pending'}`, '');
        break;
      case 'info':
        lines.push(`> ${it.level}: ${it.text}`, '');
        break;
      case 'turn':
        lines.push(`---`, `_Turn ${it.status}${it.durationMs ? ` in ${(it.durationMs / 1000).toFixed(1)}s` : ''}${speedLabel(it)}${it.costUsd ? `, $${it.costUsd.toFixed(4)}` : ''}_`, '');
        break;
      case 'plan':
        lines.push('### Plan', ...it.entries.map((e) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`), '');
        break;
    }
  }
  return lines.join('\n');
}

/**
 * The transcript row that says where a fork landed and why the conversation above is being trusted:
 * a fork with its own worktree gets its own branch, one that stayed behind shares the source's
 * directory and claims no worktree of its own.
 */
function forkNote(src: SessionMeta, target: HarnessId, own: { path: string; branch: string } | null, cross: boolean): string {
  const from = HARNESS_BY_ID[src.config.harness].name;
  const intro = cross ? `Forked from ${from} into ${HARNESS_BY_ID[target].name}` : 'Forked';
  const where = own
    ? `onto a new worktree (branch ${own.branch}, from ${src.worktreeBranch})`
    : `in the same directory${src.worktreeBranch ? ` (branch ${src.worktreeBranch})` : ''}`;
  return `${intro} ${where}. The conversation above is handed over as context on your next message.`;
}

/**
 * One transcript row the source session hands to its fork. Text, tool calls and tokens stay —
 * they are what the new harness can see — but a turn's dollars do not, because the session that
 * spent them already reports them.
 */
export function carriedItem(item: TranscriptItem): TranscriptItem {
  return item.kind === 'turn' ? { ...item, costUsd: 0, carried: true } : item;
}

/** `, 12.3 tok/s` for the markdown export, or '' when the turn has no speed sample. */
function speedLabel(turn: Extract<TranscriptItem, { kind: 'turn' }>): string {
  const tps = tokensPerSecond(turnSpeed(turn) ?? undefined);
  return tps ? `, ${tps.toFixed(1)} tok/s` : '';
}
