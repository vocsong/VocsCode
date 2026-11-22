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

const startOfDay = (ts: number): number => new Date(ts).setHours(0, 0, 0, 0);

/**
 * When a transcript item happened, as short as it can be while still unambiguous: the time alone
 * today, the weekday within the last week, the date before that, and the year once it differs.
 */
export function fmtStamp(ts: number, now = Date.now()): string {
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 0) return new Date(ts).toLocaleTimeString(undefined, time);
  if (days > 0 && days < 7) return new Date(ts).toLocaleString(undefined, { weekday: 'short', ...time });
  const year = new Date(ts).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const };
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', ...year, ...time });
}

/** The full date and time to the second, for a timestamp's tooltip. */
export function fmtStampFull(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
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

export { basename, harnessShort } from '../../shared/session-title';

export function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** A byte count as `512 KB`, `48 MB` or `1.2 GB`. */
export function fmtBytes(n: number | undefined): string {
  if (!n || n < 0) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** How long something has been running, coarsely: `45s`, `12m`, `3h 5m`, `2d 4h`. */
export function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
