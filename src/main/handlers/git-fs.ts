/** Git repository/PR/worktree and workspace filesystem IPC handlers. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FILE_PREVIEW_MAX_BYTES } from '../../shared/ipc';
import {
  gitBranches,
  gitBranchesOverview,
  gitCheckout,
  gitCommit,
  gitCreateGitHubRepo,
  gitCreatePr,
  gitDeleteBranch,
  gitDiff,
  gitFetchPrune,
  gitFolderBranch,
  gitGithubIdentity,
  gitInit,
  gitInitialCommit,
  gitIssueComments,
  gitIssues,
  gitMergePr,
  gitPruneWorktrees,
  gitPullRequest,
  gitPullRequestComments,
  gitPullRequests,
  gitPush,
  gitRangeEvidence,
  gitRevertFile,
  gitRoot,
  gitSetIdentity,
  gitSetRemote,
  gitSetupStatus,
  gitStageAll,
  gitSummary,
  gitUpdateBranch,
  gitWorktrees,
  removeWorktree,
  type SessionPrQuery
} from '../git';
import { errorMessage } from '../util/async';
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceImage,
  resolveWorkspaceFile,
  validateWorkspaceFileTarget,
  writeWorkspaceText
} from '../workspace-files';
import { fuzzyMatch, sessionIdSchema, type HandlerContext } from './context';

export function registerGitFsHandlers(ctx: HandlerContext): void {
  const { deps, handle, cwdOf, knowledgeScopeOf, pickedFolders, scheduleGitnexus } = ctx;
  const { settings, sessions } = deps;

  // Neither probe takes a session id, so both gate on a folder the app already knows about (or one
  // the local user just picked): an invoking caller must not be able to walk the host's disk.
  const knownFolder = (projectRoot: string) =>
    pickedFolders.has(projectRoot) || settings.get().folders.includes(projectRoot) || sessions.list().some((s) => s.config.projectRoot === projectRoot);

  handle('git:folderBranch', ({ projectRoot }) => (knownFolder(projectRoot) ? gitFolderBranch(projectRoot) : {}));
  // The new-session dialog disables worktree isolation for a folder that has no repository, because
  // `git worktree add` there fails the whole session creation.
  handle('git:folderIsRepo', async ({ projectRoot }) => ({ isRepo: knownFolder(projectRoot) ? !!(await gitRoot(projectRoot)) : false }));
  handle('git:suggestBranchName', ({ prompt, model }) => sessions.suggestBranchName(typeof prompt === 'string' ? prompt : '', model));
  // What a new worktree branch may start from, chosen in the same dialog.
  handle('git:folderBranches', async ({ projectRoot }) => {
    if (!knownFolder(projectRoot) || !(await gitRoot(projectRoot))) return { branches: [] };
    const { current, branches } = await gitBranches(projectRoot);
    return { ...(current ? { current } : {}), branches: branches.map((b) => b.name) };
  });

  handle('git:summary', ({ sessionId }) => gitSummary(cwdOf(sessionId)));
  handle('git:diff', ({ sessionId, path: p, staged }) => gitDiff(cwdOf(sessionId), p, staged));
  handle('git:revert', ({ sessionId, path: p }) => gitRevertFile(cwdOf(sessionId), p));
  handle('git:stageAll', ({ sessionId }) => gitStageAll(cwdOf(sessionId)));
  handle('git:commit', async ({ sessionId, message }) => {
    const r = await gitCommit(cwdOf(sessionId), message);
    if (r.ok) {
      deps.knowledge?.recordEpisode(knowledgeScopeOf(sessionId), {
        kind: 'commit',
        sessionId,
        summary: message.trim().split('\n')[0].slice(0, 200),
        detail: r.output.slice(-600),
        at: new Date().toISOString()
      });
      const session = sessions.get(sessionId);
      if (session) scheduleGitnexus(session, 'commit');
    }
    return r;
  });

  // Local /pr and /merge run outside a turn, so nothing else triggers the sidebar's PR state check.
  // The outcome is recorded as a persistent transcript note so it survives a restart (local-only
  // info lines from the renderer do not). PRs opened from another session's agent branch must
  // not be attributed to this one; transcript PR references, the other sessions' branch names
  // and the activity window keep the fallback honest.
  const prQueryOf = async (sessionId: string): Promise<SessionPrQuery> => {
    const m = sessions.get(sessionId);
    if (!m) return {};
    return {
      prRefs: await sessions.sessionPrRefs(sessionId),
      branches: m.worktreeBranch ? [m.worktreeBranch] : [],
      excludeBranches: sessions.list().filter((s) => s.id !== sessionId && s.worktreeBranch).map((s) => s.worktreeBranch!),
      extraRoots: await sessions.knownRepoRoots(sessionId),
      createdAfter: m.createdAt,
      updatedBefore: m.updatedAt
    };
  };

  handle('git:pr', async ({ sessionId, base, head }) => {
    const r = await gitCreatePr(cwdOf(sessionId), base, head);
    sessions.note(sessionId, r.ok ? `PR opened${head ? ` for ${head}` : ''}: ${r.url ?? ''}`.trim() : `PR failed: ${r.output ?? 'unknown error'}`, r.ok ? 'info' : 'error');
    if (r.ok) deps.log('info', `[${sessionId}] PR opened${head ? ` for ${head}` : ''}: ${r.url ?? ''}`.trim());
    else deps.log('warn', `[${sessionId}] PR creation failed: ${(r.output ?? 'unknown error').trim().slice(0, 600)}`);
    if (r.ok) sessions.refreshGitState(sessionId);
    if (r.ok) {
      const session = sessions.get(sessionId);
      if (session) scheduleGitnexus(session, 'pull-request');
      // PR reflection: the commits and a bounded patch are reflected over the whole wiki, then
      // ingested automatically. Gathering evidence is best-effort; the PR itself already succeeded.
      const evidence = await gitRangeEvidence(cwdOf(sessionId), base, head).catch(() => ({ commits: [], diff: '' }));
      const detail = [r.url, evidence.commits.length ? `Commits:\n${evidence.commits.join('\n')}` : '', evidence.diff ? `Diff:\n${evidence.diff}` : '']
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 14_000);
      void deps.knowledge?.reflectPr(knowledgeScopeOf(sessionId), {
        kind: 'pr',
        sessionId,
        summary: `PR into ${base}${head ? ` from ${head}` : ''}`,
        detail,
        at: new Date().toISOString()
      });
    }
    return r;
  });

  handle('git:merge', async ({ sessionId, base, head }) => {
    // An explicit head branch pins the PR (Branches panel); otherwise the session's own is resolved.
    const r = await gitMergePr(cwdOf(sessionId), base, head, head ? {} : await prQueryOf(sessionId));
    sessions.note(sessionId, r.ok ? `Merged${head ? ` ${head}` : ''}: ${r.url ?? 'PR merged'}` : r.output ?? 'Failed to merge the PR', r.ok ? 'info' : 'error');
    if (r.ok) deps.log('info', `[${sessionId}] PR merged${head ? ` (${head})` : ''}: ${r.url ?? ''}`.trim());
    else deps.log('warn', `[${sessionId}] PR merge failed: ${(r.output ?? 'unknown error').trim().slice(0, 600)}`);
    if (r.ok) {
      sessions.refreshGitState(sessionId);
      const session = sessions.get(sessionId);
      if (session) scheduleGitnexus(session, 'merge');
      deps.knowledge?.recordEpisode(knowledgeScopeOf(sessionId), {
        kind: 'merge',
        sessionId,
        summary: `Merged${head ? ` ${head}` : ''}${base ? ` into ${base}` : ''}`,
        detail: r.url,
        at: new Date().toISOString()
      });
    }
    return r;
  });

  handle('git:branches', ({ sessionId }) => gitBranches(cwdOf(sessionId)));
  handle('git:worktrees', ({ sessionId }) => gitWorktrees(cwdOf(sessionId)));
  handle('git:checkout', ({ sessionId, branch }) => gitCheckout(cwdOf(sessionId), branch));
  handle('git:branchesOverview', ({ sessionId }) => gitBranchesOverview(cwdOf(sessionId)));
  // Guided setup for a folder that is not a repository yet (or has no GitHub remote).
  handle('git:setupStatus', ({ sessionId }) => gitSetupStatus(cwdOf(sessionId)));
  handle('git:init', ({ sessionId }) => gitInit(cwdOf(sessionId)));
  handle('git:initialCommit', ({ sessionId, message }) => gitInitialCommit(cwdOf(sessionId), message));
  handle('git:setRemote', ({ sessionId, url }) => gitSetRemote(cwdOf(sessionId), url));
  handle('git:push', async ({ sessionId }) => {
    const r = await gitPush(cwdOf(sessionId));
    if (r.ok) sessions.refreshGitState(sessionId);
    return r;
  });
  handle('git:createGitHubRepo', async ({ sessionId, name, private: isPrivate }) => {
    const r = await gitCreateGitHubRepo(cwdOf(sessionId), name, !!isPrivate);
    if (r.ok) sessions.refreshGitState(sessionId);
    return r;
  });
  handle('git:setIdentity', ({ sessionId, name, email, global }) => gitSetIdentity(cwdOf(sessionId), name, email, !!global));
  handle('git:githubIdentity', ({ sessionId }) => gitGithubIdentity(cwdOf(sessionId)));
  handle('git:deleteBranch', ({ sessionId, branch, force }) => gitDeleteBranch(cwdOf(sessionId), branch, !!force));
  handle('git:updateBranch', ({ sessionId, branch }) => gitUpdateBranch(cwdOf(sessionId), branch));
  // Only registered worktrees may be removed; `path` must match one git reports so the
  // client cannot ask for an arbitrary directory deletion.
  handle('git:removeWorktree', async ({ sessionId, path: p }) => {
    const target = path.resolve(p);
    const { worktrees } = await gitWorktrees(cwdOf(sessionId));
    if (!worktrees.some((w) => w.path === target)) return { ok: false, error: 'Not a registered worktree' };
    try {
      await removeWorktree(cwdOf(sessionId), target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });
  handle('git:pruneWorktrees', ({ sessionId }) => gitPruneWorktrees(cwdOf(sessionId)));
  handle('git:fetchPrune', ({ sessionId }) => gitFetchPrune(cwdOf(sessionId)));
  handle('git:pullRequests', ({ sessionId }) => gitPullRequests(cwdOf(sessionId)));
  handle('git:pullRequest', (input) => {
    const { sessionId, url } = z.strictObject({ sessionId: z.string(), url: z.string() }).parse(input);
    if (!sessions.get(sessionId)) throw new Error('Session not found');
    return gitPullRequest(url);
  });
  handle('git:issues', ({ sessionId }) => gitIssues(cwdOf(sessionId)));
  handle('git:issueComments', ({ sessionId, number }) => gitIssueComments(cwdOf(sessionId), number));
  handle('git:prComments', ({ sessionId, number }) => gitPullRequestComments(cwdOf(sessionId), number));

  handle('fs:resolve', async (input) => {
    const { sessionId, path: target } = z.strictObject({ sessionId: sessionIdSchema, path: z.string() }).parse(input);
    const relative = validateWorkspaceFileTarget(target);
    return resolveWorkspaceFile(cwdOf(sessionId), relative);
  });
  handle('fs:list', ({ sessionId, relPath }) => listWorkspaceFiles(cwdOf(sessionId), relPath));
  handle('fs:search', async ({ sessionId, query, limit }) => {
    const root = cwdOf(sessionId);
    const q = query.toLowerCase();
    const max = limit ?? 30;
    const out: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', 'target', '.vocs-code']);
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (out.length >= max || depth > 8) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!skip.has(e.name)) await walk(path.join(dir, e.name), r, depth + 1);
        } else if (!q || fuzzyMatch(r.toLowerCase(), q)) out.push(r);
      }
    };
    await walk(root, '', 0);
    return out;
  });
  handle('fs:read', ({ sessionId, path: p, maxBytes }) =>
    readWorkspaceFile(cwdOf(sessionId), p, maxBytes, async () => {
      try {
        validateWorkspaceFileTarget(p);
        return true;
      } catch {
        return false; // Inspection remains available for a target the preview cannot save.
      }
    })
  );
  handle('fs:readImage', ({ sessionId, path: p }) => readWorkspaceImage(cwdOf(sessionId), p));
  handle('fs:writeText', async (input) => {
    const text = z.string().max(FILE_PREVIEW_MAX_BYTES, 'Text exceeds the preview size limit.');
    const { sessionId, path: target, content, expectedContent } = z
      .strictObject({
        sessionId: sessionIdSchema,
        path: z.string(),
        content: text,
        expectedContent: text
      })
      .parse(input);
    const relative = validateWorkspaceFileTarget(target);
    const cwd = cwdOf(sessionId);
    sessions.assertNotHousekeeping?.(sessionId);
    await writeWorkspaceText(cwd, relative, content, expectedContent);
  });
}
