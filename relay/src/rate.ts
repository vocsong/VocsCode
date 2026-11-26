/** Fixed-window rate limiter for the relay's public endpoints (docs/RELAY.md).
 *  In-memory on purpose: it is defense in depth in front of Durable Object storage, so losing
 *  the counters when a Hub hibernates costs nothing, and it never turns a request into a write. */
export interface RateLimiter {
  /** True when a call is allowed; false once the window's budget is spent. */
  hit(key: string, limit: number, windowMs: number): boolean;
}

export class FixedWindowLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    /** Upper bound on tracked keys, so hostile traffic cannot grow the map without bound. */
    private readonly maxKeys = 10_000
  ) {}

  hit(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const window = this.windows.get(key);
    if (!window || t >= window.resetAt) {
      if (this.windows.size >= this.maxKeys) this.prune(t);
      this.windows.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    if (window.count >= limit) return false;
    window.count++;
    return true;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) if (now >= window.resetAt) this.windows.delete(key);
    if (this.windows.size < this.maxKeys) return;
    // Every window is still live: drop the ones expiring soonest and keep going.
    const oldest = [...this.windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of oldest.slice(0, Math.floor(this.maxKeys / 2))) this.windows.delete(key);
  }
}

/** The caller as the relay's limits (edge and Hub) count it: an IPv4 address, or the /64 an IPv6 address sits in (one
 *  subscriber is usually handed a whole /64). An IPv4-mapped IPv6 address counts as its IPv4. */
export function callerKey(ip: string | null): string {
  if (!ip) return 'unknown';
  const value = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (!value.includes(':')) return value;
  const groups = ipv6Groups(value);
  if (!groups) return value;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of a textual IPv6 address, or null when it is not one. */
function ipv6Groups(value: string): number[] | null {
  let text = value;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    text = `${text.slice(0, v4.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}
