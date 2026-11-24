import { describe, expect, it } from 'vitest';
import type { IntelligenceEvidence } from '../src/shared/intelligence';
import { citationRank, distribution, evidenceCitations, rankGrep } from './fixtures/knowledge-benchmark-metrics';

const grep = (file: string, line: number, text: string) => `HEAD:${file}\0${line}\0${text}\n`;

const evidence = (patch: Partial<IntelligenceEvidence>): IntelligenceEvidence => ({
  provider: 'graph', projectId: 'fixture', projectName: 'fixture', ref: 'id', title: 'Title',
  authority: 'graph-extracted', historical: false, scope: 'project', score: 1, why: 'fixture', ...patch
});

describe('Knowledge benchmark scoring', () => {
  it('ranks a symbol definition over mentions and returns one row per file', () => {
    const raw = grep('a.ts', 1, 'import { SessionPanes } from "./view";') + grep('a.ts', 3, 'SessionPanes()') +
      grep('view.ts', 2, 'export function SessionPanes() {}');
    expect(rankGrep(raw, ['SessionPanes'], true).map(({ ref }) => ref)).toEqual(['view.ts', 'a.ts']);
  });

  it('ranks distinct term coverage above repetitions of just one term', () => {
    const raw = grep('a.md', 1, 'RELOAD, again reload') + grep('a.md', 2, 'another reload') +
      grep('b.md', 3, 'Renderer restore') + grep('b.md', 9, 'after reload');
    expect(rankGrep(raw, ['reload', 'renderer'], false).map(({ ref }) => ref)).toEqual(['b.md', 'a.md']);
  });

  it('preserves the order of distinct cited graph files and requires the right wiki claim and source', () => {
    const rows = evidenceCitations([
      evidence({ text: 'code in src\\a.ts:L8 — calls Terminal' }),
      evidence({ ref: 'other', text: 'code in src/a.ts:L22' }),
      evidence({ provider: 'wiki', ref: 'decision/unrelated', sources: [{ type: 'doc', ref: 'docs/DRIVER.md' }] }),
      evidence({ provider: 'wiki', ref: 'decision/driver', sources: [{ type: 'doc', ref: 'docs/DRIVER.md' }] })
    ]);
    expect(rows.map(({ ref }) => ref)).toEqual(['src/a.ts', 'decision/unrelated', 'decision/driver']);
    expect(citationRank(rows, ['src/a.ts'])).toBe(1);
    expect(citationRank(rows, ['docs/DRIVER.md'], 'decision/driver')).toBe(3);
    expect(citationRank(rows, ['docs/OTHER.md'], 'decision/driver')).toBeNull();
  });

  it('keeps sample counts, uses nearest-rank percentiles, and omits p95 for small samples', () => {
    expect(distribution([30, 10, 20])).toEqual({ n: 3, min: 10, p50: 20, max: 30 });
    expect(distribution(Array.from({ length: 20 }, (_, i) => 20 - i))).toEqual({ n: 20, min: 1, p50: 10, p95: 19, max: 20 });
    expect(() => distribution([])).toThrow('No benchmark samples');
  });
});
