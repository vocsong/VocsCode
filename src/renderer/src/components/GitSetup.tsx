/**
 * Guided git setup for the panel. When a folder is not a repository it walks through initializing,
 * the first commit, connecting a GitHub repository (one click through gh when it is signed in, or
 * step by step on github.com) and pushing. Once the repository exists but has no remote, the same
 * steps appear as a compact banner on top of the Git tab, so the guide is not lost at `git init`.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { GitSetupStatus, SessionMeta } from '../../../shared/types';
import { invoke, platform } from '../api';
import { useStore } from '../store';
import * as host from '../terminal/host';
import { Badge, Button, Icon, Spinner } from './ui';

/** Stable fallback so the zustand selector never returns a fresh array. */
const EMPTY: string[] = [];

/** Install command per platform; the CLI docs page covers anything else. */
const GH_INSTALL: Record<string, string> = {
  win32: 'winget install --id GitHub.cli',
  darwin: 'brew install gh',
  linux: 'sudo apt install gh'
};

const ghInstallCommand = (): string | undefined => GH_INSTALL[platform];

/** Folder name turned into something GitHub accepts as a repository name. */
export function repoNameFor(cwd: string): string {
  const name = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'project';
  return name.replace(/[^\w.-]+/g, '-').replace(/^[^\w]+/, '') || 'project';
}

/** Browser URL for a git remote (`https://github.com/o/r.git`, `ssh://git@host/o/r.git` or `git@host:o/r.git`). */
export function remoteWebUrl(remote: string): string | undefined {
  const t = remote.trim();
  const https = t.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (https) return `https://${https[1]}/${https[2]}`;
  const ssh = t.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const scp = t.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return undefined;
}

export function GitSetup({
  session,
  variant,
  onChanged,
  onStatus
}: {
  session: SessionMeta;
  variant: 'page' | 'banner';
  onChanged?: () => void;
  onStatus?: (status: GitSetupStatus) => void;
}) {
  const toast = useStore((s) => s.toast);
  const skipped = useStore((s) => s.settings?.gitSetupSkipped ?? EMPTY);
  const [status, setStatus] = useState<GitSetupStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('Initial commit');
  const [repoName, setRepoName] = useState(() => repoNameFor(session.cwd));
  const [isPrivate, setIsPrivate] = useState(true);
  const [remoteUrl, setRemoteUrl] = useState('');
  /** The session this instance belongs to; responses from other sessions are dropped. */
  const liveId = useRef(session.id);

  const load = async () => {
    const sid = session.id;
    try {
      const s = await invoke('git:setupStatus', { sessionId: sid });
      if (liveId.current !== sid) return;
      setStatus(s);
      onStatus?.(s);
    } catch {
      // The panel already surfaces git errors; the guide falls back to the initialize step.
    }
  };

  useEffect(() => {
    liveId.current = session.id;
    setStatus(null);
    setBusy(null);
    setProblem(null);
    setManualOpen(false);
    setCommitMsg('Initial commit');
    setRepoName(repoNameFor(session.cwd));
    setRemoteUrl('');
    void load();
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const root = status?.root ?? session.cwd;
  const dismissed = skipped.includes(root);

  /** Runs one step, reports the outcome, and re-reads the state so the guide advances. */
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; output?: string }>, success: string) => {
    setBusy(key);
    setProblem(null);
    try {
      const r = await fn();
      if (!r.ok) {
        const message = r.error ?? r.output ?? 'Something went wrong';
        setProblem(message);
        toast(message, 'error');
      } else {
        toast(success, 'success');
        await load();
        onChanged?.();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setProblem(message);
      toast(message, 'error');
    } finally {
      if (liveId.current === session.id) setBusy(null);
    }
  };

  const copy = (text: string, label = 'Copied') => void navigator.clipboard.writeText(text).then(() => toast(label, 'success')).catch(() => undefined);

  /** Opens a terminal and types the command in, for steps that are interactive (gh login, installers). */
  const runInTerminal = (command: string) => {
    void host.runInTerminal(session.id, command).catch((e: unknown) => toast(String((e as Error).message ?? e), 'error'));
  };

  const dismiss = () => {
    if (!dismissed) void invoke('settings:update', { gitSetupSkipped: [...skipped, root] });
  };

  if (!status) {
    if (variant === 'banner') return null;
    return (
      <div className="git-setup pad">
        <Spinner />
      </div>
    );
  }

  // The banner is only the "repository exists but is not on GitHub yet" continuation, and it
  // stays until the branch actually exists on origin (not merely once a remote is configured).
  if (variant === 'banner' && (!status.isRepo || status.pushed || dismissed)) return null;

  const isRepo = status.isRepo;
  const hasCommits = status.hasCommits;
  const remote = status.remote;
  const pushed = status.pushed;
  const branch = status.branch ?? 'main';
  const done = [isRepo, hasCommits, !!remote, pushed];
  const open = done.findIndex((d) => !d);
  const webUrl = remote ? remoteWebUrl(remote) : undefined;
  const showManual = manualOpen || !status.gh.authenticated;

  return (
    <div className={`git-setup ${variant === 'banner' ? 'git-setup-banner' : ''}`}>
      <div className="git-setup-head">
        <Icon name="branch" size={variant === 'banner' ? 18 : 24} />
        <div>
          <div className="git-setup-title">{isRepo ? 'Publish this repository to GitHub' : 'Set up git in this folder'}</div>
          <div className="muted small">
            {isRepo
              ? 'Connect a GitHub repository to back up your work and open pull requests.'
              : 'Git records every change so you can review diffs, revert, and publish to GitHub. This folder is not a repository yet.'}
          </div>
        </div>
        <span className="spacer" />
        {variant === 'banner' && (
          <Button variant="ghost" size="sm" icon="x" title="Not now — you can reopen this from the Git tab's menu" aria-label="Dismiss GitHub setup" onClick={dismiss} />
        )}
      </div>

      {problem && (
        <div className="callout warn" role="status">
          {problem}
        </div>
      )}

      <Step n={1} title="Initialize the repository" state={done[0] ? 'done' : open === 0 ? 'active' : 'pending'}>
        <p className="setup-note">
          Creates a hidden <code>.git</code> folder here and starts on the <code>main</code> branch. Nothing is uploaded yet.
        </p>
        <CommandRow command="git init -b main" onCopy={copy} />
        <div className="setup-actions">
          <Button variant="primary" icon="branch" disabled={busy !== null} onClick={() => void run('init', () => invoke('git:init', { sessionId: session.id }), 'Repository initialized')}>
            {busy === 'init' ? <Spinner size={12} /> : 'Initialize repository'}
          </Button>
        </div>
      </Step>

      <Step n={2} title="Create the first commit" state={done[1] ? 'done' : open === 1 ? 'active' : 'pending'}>
        <p className="setup-note">Commits everything currently in the folder, so there is something to push.</p>
        <div className="setup-row">
          <input
            value={commitMsg}
            placeholder="Commit message"
            aria-label="Commit message"
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commitMsg.trim() && void run('commit', () => invoke('git:initialCommit', { sessionId: session.id, message: commitMsg }), 'Initial commit created')}
          />
          <Button
            variant="primary"
            icon="check"
            disabled={busy !== null || !commitMsg.trim()}
            onClick={() => void run('commit', () => invoke('git:initialCommit', { sessionId: session.id, message: commitMsg }), 'Initial commit created')}
          >
            {busy === 'commit' ? <Spinner size={12} /> : 'Commit'}
          </Button>
        </div>
      </Step>

      <Step n={3} title="Connect a GitHub repository" state={done[2] ? 'done' : open === 2 ? 'active' : 'pending'}>
        {status.gh.authenticated ? (
          <>
            <p className="setup-note">
              Signed in to the GitHub CLI{status.gh.account ? <> as <strong>@{status.gh.account}</strong></> : null}. This creates the repository, sets it as{' '}
              <code>origin</code>, and pushes the first commit in one go.
            </p>
            <div className="setup-row">
              <input value={repoName} placeholder="repository-name" aria-label="Repository name" onChange={(e) => setRepoName(e.target.value)} />
              <div className="setup-vis" role="radiogroup" aria-label="Repository visibility">
                <button type="button" role="radio" aria-checked={isPrivate} className={isPrivate ? 'active' : ''} onClick={() => setIsPrivate(true)}>
                  Private
                </button>
                <button type="button" role="radio" aria-checked={!isPrivate} className={!isPrivate ? 'active' : ''} onClick={() => setIsPrivate(false)}>
                  Public
                </button>
              </div>
            </div>
            <div className="setup-actions">
              <Button
                variant="primary"
                icon="cloud"
                disabled={busy !== null || !repoName.trim()}
                onClick={() =>
                  void run('create', () => invoke('git:createGitHubRepo', { sessionId: session.id, name: repoName, private: isPrivate }), 'GitHub repository created')
                }
              >
                {busy === 'create' ? <Spinner size={12} /> : 'Create repository and push'}
              </Button>
              <button type="button" className="link-btn" onClick={() => setManualOpen((v) => !v)}>
                {showManual ? 'Hide manual setup' : 'or create it on github.com yourself'}
              </button>
            </div>
          </>
        ) : status.gh.installed ? (
          <>
            <p className="setup-note">
              <Badge tone="amber">gh not signed in</Badge> Sign in once and GitHub setup becomes one click — it also teaches git how to push with your account. PRs and
              Issues appear in this panel afterwards.
            </p>
            <CommandRow command="gh auth login" onCopy={copy} onRun={runInTerminal} />
            <p className="setup-note">The login opens a browser. When it finishes, reopen this tab — or set up the repository by hand below.</p>
          </>
        ) : (
          <>
            <p className="setup-note">
              <Badge tone="neutral">GitHub CLI not installed</Badge> The <code>gh</code> CLI makes this one click and unlocks the PR and Issues views. Or set the repository up
              by hand below.
            </p>
            {ghInstallCommand() && <CommandRow command={ghInstallCommand()!} onCopy={copy} onRun={runInTerminal} />}
            <div className="setup-actions">
              <Button variant="ghost" size="sm" icon="external" onClick={() => void invoke('app:openExternal', { url: 'https://cli.github.com/' })}>
                Install page
              </Button>
              <span className="muted small">Then run `gh auth login` and reopen this tab.</span>
            </div>
          </>
        )}

        {showManual && (
          <div className="setup-manual">
            <ol className="setup-how">
              <li>
                Open{' '}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => void invoke('app:openExternal', { url: `https://github.com/new?name=${encodeURIComponent(repoName)}&visibility=${isPrivate ? 'private' : 'public'}` })}
                >
                  github.com/new <Icon name="external" size={11} />
                </button>{' '}
                and create a repository. Private is fine.
              </li>
              <li>
                Leave <strong>Add a README</strong>, .gitignore and license unchecked — this folder already has files, and an existing README blocks the first push.
              </li>
              <li>Copy the repository URL it shows and paste it here.</li>
            </ol>
            <div className="setup-row">
              <input value={remoteUrl} placeholder="https://github.com/you/project.git" aria-label="Repository URL" onChange={(e) => setRemoteUrl(e.target.value)} />
              <Button
                icon="link"
                disabled={busy !== null || !remoteUrl.trim()}
                onClick={() => void run('remote', () => invoke('git:setRemote', { sessionId: session.id, url: remoteUrl }), 'Origin connected')}
              >
                {busy === 'remote' ? <Spinner size={12} /> : 'Connect'}
              </Button>
            </div>
          </div>
        )}
      </Step>

      <Step n={4} title="Push your work" state={done[3] ? 'done' : open === 3 ? 'active' : 'pending'}>
        {remote ? (
          <>
            <p className="setup-note">
              Pushes <code>{branch}</code> to <code>origin</code> and remembers it as the upstream branch.
            </p>
            <CommandRow command={`git push -u origin ${branch}`} onCopy={copy} />
            <div className="setup-actions">
              <Button variant="primary" icon="cloud" disabled={busy !== null} onClick={() => void run('push', () => invoke('git:push', { sessionId: session.id }), 'Pushed to GitHub')}>
                {busy === 'push' ? <Spinner size={12} /> : pushed ? 'Push again' : 'Push to GitHub'}
              </Button>
              {webUrl && (
                <Button variant="ghost" size="sm" icon="external" onClick={() => void invoke('app:openExternal', { url: webUrl })}>
                  Open on GitHub
                </Button>
              )}
            </div>
            {!pushed && !status.gh.authenticated && (
              <p className="setup-note">
                If git asks for credentials, run <code>gh auth login</code> in the terminal first — it signs git in too.
              </p>
            )}
          </>
        ) : (
          <p className="setup-note muted">Connect a repository above to enable pushing.</p>
        )}
      </Step>

      {variant === 'page' && pushed && (
        <div className="callout" role="status">
          Your repository is on GitHub{webUrl ? <> — <button type="button" className="link-btn" onClick={() => void invoke('app:openExternal', { url: webUrl })}>{webUrl.replace(/^https?:\/\//, '')}</button></> : null}.
        </div>
      )}
    </div>
  );
}

type StepState = 'done' | 'active' | 'pending';

function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children: React.ReactNode }) {
  return (
    <div className={`setup-step ${state}`}>
      <div className="setup-step-head">
        <span className="setup-step-n">{state === 'done' ? <Icon name="check" size={12} /> : n}</span>
        <span className="setup-step-title">{title}</span>
      </div>
      {state === 'active' && <div className="setup-step-body">{children}</div>}
    </div>
  );
}

function CommandRow({ command, onCopy, onRun }: { command: string; onCopy: (text: string, label?: string) => void; onRun?: (command: string) => void }) {
  return (
    <div className="setup-cmd">
      <code>{command}</code>
      <Button variant="ghost" size="sm" icon="copy" title="Copy command" aria-label={`Copy: ${command}`} onClick={() => onCopy(command, 'Command copied')} />
      {onRun && <Button variant="ghost" size="sm" icon="terminal" title="Run in terminal" aria-label={`Run in terminal: ${command}`} onClick={() => onRun(command)} />}
    </div>
  );
}
