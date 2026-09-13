/** Display formatters for relative time, cost, token counts, durations and paths. */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function fmtCost(usd: number | undefined): string {
  if (!usd) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtTokens(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtDuration(ms: number | undefined): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/**
 * Output speed as `12.3 tok/s`, or '' when either side of the sample is missing. Wall time
 * includes tool execution, so this is the effective speed of a turn, not the raw decode rate.
 */
export function fmtRate(tokens: number | undefined, ms: number | undefined): string {
  if (!tokens || !ms || tokens <= 0 || ms <= 0) return '';
  const tps = (tokens / ms) * 1000;
  return `${tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)} tok/s`;
}

/** Sums the output tokens and wall time of turns that reported both, for a session-level speed. */
export function speedOfTurns(turns: { status: string; durationMs?: number; usage?: { outputTokens?: number } }[]): { tokens: number; ms: number } {
  const acc = { tokens: 0, ms: 0 };
  for (const t of turns) {
    const tokens = t.usage?.outputTokens ?? 0;
    const ms = t.durationMs ?? 0;
    if (t.status !== 'completed' || tokens <= 0 || ms <= 0) continue;
    acc.tokens += tokens;
    acc.ms += ms;
  }
  return acc;
}

/** Last path segment for both Windows and POSIX separators. */
export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Short display name for a harness id (sidebar badges, menus, analytics). */
export function harnessShort(id: string): string {
  return { claude: 'Claude', codex: 'Codex', 'codex-exec': 'Codex·exec', cursor: 'Cursor', pi: 'Pi', acp: 'ACP', native: 'Native' }[id] ?? id;
}
