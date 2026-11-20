/** Keep the last Git panel results for recently visited checkouts in this window. */
import type { GitBranchOverview, GitIssueList, GitPullRequestList } from '../../shared/types';

const MAX_CHECKOUTS = 8;

export interface GitPanelReadOptions {
  background?: boolean;
  reuseFor?: number;
  force?: boolean;
}

type Snapshot<T> = { data?: T; loading: boolean };

export class GitPanelRead<T extends { error?: string }> {
  private snapshot: Snapshot<T> = { loading: false };
  private readonly listeners = new Set<() => void>();
  private updatedAt?: number;
  private pending?: Promise<T>;

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: Snapshot<T>) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  async load(fetch: () => Promise<T>, { background, reuseFor = 0, force }: GitPanelReadOptions) {
    if (!force && (this.pending || (this.updatedAt !== undefined && Date.now() - this.updatedAt < reuseFor))) return;
    // An explicit read after a Git action supersedes any request started before that action.
    const request = Promise.resolve().then(fetch);
    this.pending = request;
    if (!background) this.publish({ ...this.snapshot, loading: true });
    try {
      const data = await request;
      if (this.pending !== request || (background && this.snapshot.data && data.error)) return;
      this.updatedAt = data.error ? undefined : Date.now();
      this.publish({ data, loading: false });
    } catch (error) {
      if (this.pending === request) throw error;
    } finally {
      if (this.pending === request) {
        this.pending = undefined;
        if (this.snapshot.loading) this.publish({ ...this.snapshot, loading: false });
      }
    }
  }
}

class CheckoutGitReads {
  readonly overview = new GitPanelRead<GitBranchOverview>();
  readonly prs = new GitPanelRead<GitPullRequestList>();
  readonly issues = new GitPanelRead<GitIssueList>();
}

export class GitPanelCache {
  private readonly checkouts = new Map<string, CheckoutGitReads>();

  checkout(cwd: string) {
    return this.checkouts.get(cwd) ?? new CheckoutGitReads();
  }

  remember(cwd: string, reads: CheckoutGitReads) {
    this.checkouts.delete(cwd);
    this.checkouts.set(cwd, reads);
    const oldest = this.checkouts.keys().next();
    if (this.checkouts.size > MAX_CHECKOUTS && !oldest.done) this.checkouts.delete(oldest.value);
  }
}
