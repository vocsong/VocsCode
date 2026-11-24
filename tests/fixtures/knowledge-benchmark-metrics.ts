import type { IntelligenceEvidence } from '../../src/shared/intelligence';

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round = (value: number): number => Number(value.toFixed(2));

/** Nearest-rank percentiles. Cold starts have too few samples for a useful p95. */
export function distribution(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (!sorted.length) throw new Error('No benchmark samples');
  const percentile = (p: number) => round(sorted[Math.ceil(p * sorted.length) - 1]!);
  return {
    n: sorted.length, min: percentile(1 / sorted.length), p50: percentile(0.5),
    ...(sorted.length >= 20 ? { p95: percentile(0.95) } : {}), max: percentile(1)
  };
}

export interface BenchCitation { provider: 'grep' | 'graph' | 'wiki'; ref: string; paths: string[] }

/** The actual Evidence ranking, deduplicated to distinct source locations just like Git. */
export function evidenceCitations(evidence: readonly IntelligenceEvidence[]): BenchCitation[] {
  const seen = new Set<string>();
  return evidence.flatMap((item): BenchCitation[] => {
    if (item.provider === 'graph') {
      const where = / in (.+?)(?::[^ ]*)?$/.exec(item.text?.split(' — ', 1)[0] ?? '')?.[1]?.replaceAll('\\', '/');
      if (!where || seen.has(`file:${where}`)) return [];
      seen.add(`file:${where}`);
      return [{ provider: 'graph', ref: where, paths: [where] }];
    }
    if (item.provider !== 'wiki' || seen.has(`wiki:${item.ref}`)) return [];
    seen.add(`wiki:${item.ref}`);
    const paths = item.sources?.filter(({ type }) => type === 'file' || type === 'doc').map(({ ref }) => ref) ?? [];
    return [{ provider: 'wiki', ref: item.ref, paths }];
  });
}

export function citationRank(citations: readonly BenchCitation[], expectedPaths: readonly string[], wikiId?: string): number | null {
  const index = citations.findIndex(({ provider, ref, paths }) =>
    (provider === 'wiki' && ref === wikiId && paths.some((file) => expectedPaths.includes(file))) ||
    (provider !== 'wiki' && paths.some((file) => expectedPaths.includes(file))));
  return index === -1 ? null : index + 1;
}

/** `git grep -z -n HEAD` emits HEAD:path\0line\0text\n. Rank files, not individual lines. */
export function rankGrep(stdout: string, terms: readonly string[], symbol: boolean): BenchCitation[] {
  const flags = symbol ? '' : 'i';
  const token = terms.map((term) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(term)}(?![\\p{L}\\p{N}_])`, `${flags}u`));
  const declaration = symbol ? new RegExp(`\\b(?:class|function|interface|type|const|let|enum)\\s+${escapeRegex(terms[0]!)}\\b`) : undefined;
  const rows = new Map<string, { terms: Set<number>; best: number; lines: number; declaration: boolean }>();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const first = line.indexOf('\0');
    const second = line.indexOf('\0', first + 1);
    if (!line.startsWith('HEAD:') || first < 5 || second === -1) throw new Error('Unexpected git grep output');
    const file = line.slice(5, first);
    const text = line.slice(second + 1);
    const row = rows.get(file) ?? { terms: new Set<number>(), best: 0, lines: 0, declaration: false };
    let count = 0;
    token.forEach((pattern, index) => { if (pattern.test(text)) { row.terms.add(index); count++; } });
    row.best = Math.max(row.best, count);
    row.lines++;
    row.declaration ||= declaration?.test(text) ?? false;
    rows.set(file, row);
  }
  return [...rows].sort(([fileA, a], [fileB, b]) => Number(b.declaration) - Number(a.declaration) ||
    b.terms.size - a.terms.size || b.best - a.best || b.lines - a.lines || (fileA < fileB ? -1 : fileA > fileB ? 1 : 0))
    .map(([ref]) => ({ provider: 'grep', ref, paths: [ref] }));
}
