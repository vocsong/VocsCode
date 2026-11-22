/** Desktop-owned background refresh for one selected session. No database or tool call schedules work. */
export class GraphScheduler {
  private selected: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running?: { controller: AbortController; done: Promise<void> };
  private closed = false;

  constructor(private readonly deps: {
    enabled: () => boolean;
    refresh: (sessionId: string, signal: AbortSignal) => Promise<void>;
    onError: (error: unknown) => void;
    settleMs?: number;
    pollMs?: number;
  }) {}

  select(sessionId: string | null): void {
    if (sessionId === this.selected || this.closed) return;
    this.selected = sessionId;
    this.settingsChanged();
  }

  settingsChanged(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running?.controller.abort();
    this.arm(this.deps.settleMs ?? 1500);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.settingsChanged();
    await this.running?.done;
  }

  private arm(delay: number): void {
    if (this.closed || this.timer || this.running || !this.selected || !this.deps.enabled()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, delay);
    this.timer.unref?.();
  }

  private refresh(): void {
    const id = this.selected;
    if (!id || this.closed || !this.deps.enabled()) return;
    const controller = new AbortController();
    const done = Promise.resolve().then(() => {
      if (!controller.signal.aborted) return this.deps.refresh(id, controller.signal);
    }).catch((error) => {
      if (!controller.signal.aborted) this.deps.onError(error);
    }).finally(() => {
      this.running = undefined;
      this.arm(controller.signal.aborted ? this.deps.settleMs ?? 1500 : this.deps.pollMs ?? 30_000);
    });
    this.running = { controller, done };
  }
}
