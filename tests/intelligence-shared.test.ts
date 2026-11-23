/** The intelligence contract's pure helpers: identity, lifecycle rules, federation policy, merging and the context packet. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTELLIGENCE_SETTINGS,
  canTransition,
  classifyIntent,
  collectionGrantsFor,
  compileContextPacket,
  estimateTokens,
  evidenceRung,
  isExpired,
  isRecallableState,
  isServableState,
  mergeEvidence,
  normalizeRemoteUrl,
  projectDisplayName,
  promotionProblem,
  queryTerms,
  resolveIntelligenceSettings,
  transitionProblem,
  type IntelligenceEvidence,
  type ProjectCollection
} from '../src/shared/intelligence';

function evidence(over: Partial<IntelligenceEvidence>): IntelligenceEvidence {
  return { provider: 'wiki', projectId: 'prj_a', projectName: 'alpha', ref: 'concept/x', title: 'X', authority: 'accepted', historical: false, scope: 'project', score: 1, why: 'matched', ...over };
}

describe('project identity', () => {
  it('reduces every spelling of one remote to the same key and drops credentials', () => {
    const expected = 'github.com/owner/repo';
    for (const url of [
      'git@github.com:Owner/Repo.git',
      'https://github.com/Owner/Repo',
      'https://github.com/Owner/Repo.git/',
      'https://user:s3cret@github.com/owner/repo.git',
      'ssh://git@github.com:22/owner/repo.git',
      'git://github.com/owner/repo'
    ]) {
      expect(normalizeRemoteUrl(url), url).toBe(expected);
    }
    expect(normalizeRemoteUrl('https://user:s3cret@github.com/owner/repo.git')).not.toContain('s3cret');
  });

  it('never treats a local path or an empty remote as a portable identity', () => {
    for (const url of ['', '   ', null, undefined, 'C:\\repos\\thing', 'C:/repos/thing', '/srv/git/thing.git', '../sibling', 'file:///srv/git/thing.git']) {
      expect(normalizeRemoteUrl(url), String(url)).toBeNull();
    }
  });

  it('keeps a fork and its upstream apart', () => {
    expect(normalizeRemoteUrl('git@github.com:alice/tool.git')).not.toBe(normalizeRemoteUrl('git@github.com:bob/tool.git'));
  });

  it('names a project from its origin, else from its folder', () => {
    expect(projectDisplayName('github.com/owner/repo', 'C:\\work\\checkout-2')).toBe('repo');
    expect(projectDisplayName(null, 'C:\\work\\my-app\\')).toBe('my-app');
    expect(projectDisplayName(undefined, '/home/me/thing')).toBe('thing');
  });
});

describe('memory lifecycle', () => {
  it('serves only active and verified records as guidance', () => {
    expect(['captured', 'candidate', 'verified', 'active', 'uncertain', 'superseded', 'expired', 'revoked', 'rejected'].filter((s) => isServableState(s as never))).toEqual(['verified', 'active']);
    expect(isRecallableState('candidate')).toBe(true);
    expect(isRecallableState('revoked')).toBe(false);
    expect(isRecallableState('rejected')).toBe(false);
  });

  it('never lets a terminal state come back', () => {
    for (const to of ['captured', 'candidate', 'verified', 'active', 'uncertain', 'superseded', 'expired'] as const) {
      expect(canTransition('revoked', to)).toBe(false);
      expect(canTransition('rejected', to)).toBe(false);
    }
    expect(canTransition('captured', 'active')).toBe(false); // captured evidence must first become a candidate
    expect(canTransition('candidate', 'verified')).toBe(true);
  });

  it('requires recorded verification before a record is verified', () => {
    const record = { state: 'candidate' as const, type: 'episodic' as const, kind: 'fix' as const };
    expect(transitionProblem(record, 'verified', 'agent')).toMatch(/needs recorded verification/);
    expect(transitionProblem({ ...record, verification: { method: 'commit', at: 'now', revision: 'abc' } }, 'verified', 'agent')).toBeNull();
  });

  it('keeps human review and design intent out of a model\u2019s hands', () => {
    const reviewed = { method: 'human-review' as const, at: 'now' };
    expect(transitionProblem({ state: 'candidate', type: 'episodic', kind: 'fix', verification: reviewed }, 'verified', 'agent')).toMatch(/Only a human/);
    expect(transitionProblem({ state: 'candidate', type: 'semantic', kind: 'decision', verification: { method: 'commit', at: 'now' } }, 'verified', 'agent')).toMatch(/verified by a human/);
    expect(transitionProblem({ state: 'candidate', type: 'preference', kind: 'preference', verification: { method: 'commit', at: 'now' } }, 'verified', 'agent')).toMatch(/verified by a human/);
    expect(transitionProblem({ state: 'candidate', type: 'semantic', kind: 'decision', verification: reviewed }, 'verified', 'human')).toBeNull();
  });

  it('only promotes a verified, cited record beyond its project and never narrows a scope', () => {
    const base = { state: 'verified' as const, scope: 'project' as const, sources: [{ type: 'doc' as const, ref: 'wiki:x' }], verification: { method: 'human-review' as const, at: 'now' } };
    expect(promotionProblem(base, 'collection')).toBeNull();
    expect(promotionProblem(base, 'personal')).toBeNull();
    expect(promotionProblem({ ...base, state: 'active' }, 'collection')).toMatch(/Only a verified record/);
    expect(promotionProblem({ ...base, state: 'candidate', verification: undefined }, 'collection')).toMatch(/Only a verified record/);
    expect(promotionProblem({ ...base, sources: [] }, 'collection')).toMatch(/cite its original source/);
    expect(promotionProblem({ ...base, scope: 'collection' }, 'project')).toMatch(/only widens/);
    expect(promotionProblem({ ...base, scope: 'collection' }, 'personal')).toMatch(/not promoted to personal/);
    expect(promotionProblem(base, 'project')).toMatch(/already project-scoped/);
  });

  it('expires at read time from the recorded instant', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(isExpired({ state: 'candidate', expiresAt: '2026-05-31T23:59:59Z' }, now)).toBe(true);
    expect(isExpired({ state: 'candidate', expiresAt: '2026-06-01T00:00:01Z' }, now)).toBe(false);
    expect(isExpired({ state: 'verified' }, now)).toBe(false);
    expect(isExpired({ state: 'expired' }, now)).toBe(true);
  });
});

describe('collection grants', () => {
  const collections: ProjectCollection[] = [
    { id: 'col_1', name: 'Platform', members: [{ projectId: 'prj_a', share: 'promoted' }, { projectId: 'prj_b', share: 'wiki' }, { projectId: 'prj_c', share: 'promoted' }], createdAt: '', updatedAt: '' },
    { id: 'col_2', name: 'Other', members: [{ projectId: 'prj_d', share: 'wiki' }, { projectId: 'prj_e', share: 'wiki' }], createdAt: '', updatedAt: '' }
  ];

  it('grants only the collections a project is a member of', () => {
    expect(collectionGrantsFor('prj_a', collections).map((g) => g.collectionId)).toEqual(['col_1']);
    expect(collectionGrantsFor('prj_zzz', collections)).toEqual([]);
  });

  it('lets a member read another member\u2019s wiki only when that member chose to share it', () => {
    const [grant] = collectionGrantsFor('prj_a', collections);
    expect(grant.wikiProjectIds).toEqual(['prj_b']);
    expect(grant.memberProjectIds).toEqual(['prj_b', 'prj_c']);
    // prj_a shares `promoted` only, so nobody else reads its wiki through this collection.
    expect(collectionGrantsFor('prj_b', collections)[0].wikiProjectIds).toEqual([]);
  });
});

describe('query understanding', () => {
  it('reads intent from the question, cross-project first', () => {
    expect(classifyIntent('Which other projects use this authorization pattern?')).toBe('cross-project');
    expect(classifyIntent('What previous attempt to fix the Windows reconnect failed?')).toBe('history');
    expect(classifyIntent('Why did we choose this authentication architecture?')).toBe('rationale');
    expect(classifyIntent('Where is the authorization middleware called by the router?')).toBe('structure');
    expect(classifyIntent('Did we try this design before?')).toBe('history');
    expect(classifyIntent('pty guard')).toBe('general');
  });

  it('keeps the content words of a natural-language question', () => {
    expect(queryTerms('Why did we choose this authentication architecture?')).toEqual(['choose', 'authentication', 'architecture']);
    expect(queryTerms('PTY  guard, PTY!')).toEqual(['pty', 'guard']);
    expect(queryTerms('what is it')).toEqual(['what', 'is', 'it']); // nothing but function words: keep them all
    expect(queryTerms('alpha beta gamma delta epsilon', 3)).toEqual(['alpha', 'beta', 'gamma']);
    expect(queryTerms('x y z')).toEqual([]); // a single character is not a searchable term
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('evidence merging', () => {
  it('ranks by intent-weighted score and lets authority break near-ties', () => {
    const wiki = evidence({ ref: 'decision/auth', title: 'Auth decision', text: 'Sessions are authorized by scope.', authority: 'human-reviewed', score: 0.8 });
    const history = evidence({ provider: 'history', ref: 's_1#u_1', title: 'Old session', text: 'we tried a token cache', authority: 'history', historical: true, score: 1 });
    expect(mergeEvidence([history, wiki], 'rationale').map((e) => e.ref)).toEqual(['decision/auth', 's_1#u_1']);
    expect(mergeEvidence([history, wiki], 'history')[0].ref).toBe('s_1#u_1');
  });

  it('collapses the same statement from two sources into the stronger authority', () => {
    const accepted = evidence({ provider: 'memory', ref: 'mem_1', title: 'Guard', text: 'Reconnects must be guarded.', authority: 'candidate', historical: true, score: 1 });
    const reviewed = evidence({ ref: 'gotcha/guard', title: 'Guard', text: 'reconnects must be GUARDED', authority: 'human-reviewed', score: 0.5 });
    const merged = mergeEvidence([accepted, reviewed], 'general');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ ref: 'gotcha/guard', authority: 'human-reviewed' });
    expect(merged[0].why).toContain('mem_1');
  });

  it('penalises stale evidence, clamps scores and honours the limit', () => {
    const fresh = evidence({ ref: 'a', title: 'A', text: 'alpha fact', score: 0.9, freshness: 'fresh' });
    const stale = evidence({ ref: 'b', title: 'B', text: 'beta fact', score: 0.9, freshness: 'stale' });
    expect(mergeEvidence([stale, fresh], 'general').map((e) => e.ref)).toEqual(['a', 'b']);
    const many = Array.from({ length: 60 }, (_, i) => evidence({ ref: `p${i}`, title: `P${i}`, text: `fact number ${i}`, score: 5 }));
    const out = mergeEvidence(many, 'general', 100);
    expect(out).toHaveLength(40);
    expect(Math.max(...out.map((e) => e.score))).toBeLessThanOrEqual(1.15);
    expect(mergeEvidence(many, 'general', 3)).toHaveLength(3);
  });

  it('places graph-inferred edges and history on the weakest rung', () => {
    expect(evidenceRung('human-reviewed')).toBe(3);
    expect(evidenceRung('verified')).toBe(3);
    expect(evidenceRung('accepted')).toBe(4);
    expect(evidenceRung('graph-extracted')).toBe(4);
    for (const weak of ['history', 'candidate', 'uncertain', 'graph-inferred'] as const) expect(evidenceRung(weak)).toBe(5);
  });
});

describe('context packet', () => {
  const scope = { projectId: 'prj_a', projectName: 'alpha', branch: 'feat/x', collections: ['Platform'] };

  it('separates current knowledge, history and graph references, each with a citation', () => {
    const packet = compileContextPacket({
      query: 'reconnect guard',
      intent: 'general',
      scope,
      evidence: [
        evidence({ ref: 'gotcha/guard', title: 'Reconnect guard', text: 'Reconnects must be guarded.', authority: 'human-reviewed', revision: '0123456789abcdef0123', freshness: 'stale', staleReason: 'src/x.ts changed' }),
        evidence({ provider: 'history', ref: 's_1#u_2', title: 'Earlier session', text: 'the \u0001guard\u0002 was missing', authority: 'history', historical: true }),
        evidence({ provider: 'graph', ref: 'guard_fn', title: 'guard()', text: 'code in src/x.ts', authority: 'graph-extracted', revision: 'feedfacefeedface' })
      ],
      conflicts: [{ a: 'wiki:gotcha/guard', b: 'wiki:gotcha/old', reason: 'superseded by the newer page' }],
      missing: ['Graphify is enabled for this project but has no index yet.']
    });
    expect(packet.sections.map((s) => s.heading)).toEqual(['Current knowledge', 'History', 'Graph references']);
    const text = packet.text;
    expect(text.indexOf('## Current knowledge')).toBeLessThan(text.indexOf('## History'));
    expect(text).toContain('[wiki:gotcha/guard · alpha · human-reviewed · @0123456789ab · stale (src/x.ts changed)]');
    expect(text).toContain('Past events and unverified recollection');
    expect(text).not.toMatch(/[\u0001\u0002]/);
    expect(text).toContain('## Conflicts and uncertainty');
    expect(text).toContain('## Missing evidence');
    expect(text).toContain('project alpha · branch feat/x · collections Platform');
    expect(text).toContain('AGENTS.md');
    expect(packet.truncated).toBe(false);
    expect(packet.usedTokens).toBe(estimateTokens(text));
  });

  it('drops the weakest evidence to stay inside the budget and says so', () => {
    const many = Array.from({ length: 40 }, (_, i) => evidence({ ref: `concept/p${i}`, title: `Page ${i}`, text: `Statement number ${i} `.repeat(12) }));
    const packet = compileContextPacket({ query: 'q', intent: 'general', scope, evidence: many, budgetTokens: 400 });
    const kept = packet.sections.flatMap((s) => s.items);
    expect(packet.truncated).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(40);
    // Rank order is preserved: what survives is the top of the list.
    expect(kept.map((e) => e.ref)).toEqual(many.slice(0, kept.length).map((e) => e.ref));
    expect(packet.usedTokens).toBeLessThanOrEqual(400 + 40);
    expect(packet.text).toMatch(/Truncated to 400 tokens: \d+ weaker result\(s\) were dropped\./);
  });

  it('says plainly when nothing matched', () => {
    const packet = compileContextPacket({ query: 'nothing', intent: 'general', scope, evidence: [] });
    expect(packet.sections).toEqual([]);
    expect(packet.text).toContain('No evidence matched');
  });
});

describe('settings', () => {
  it('enables the bundled graph by default without enabling personal memory or automatic reflection', () => {
    expect(DEFAULT_INTELLIGENCE_SETTINGS).toEqual({ gateway: true, reflection: 'manual', collections: true, personalMemory: false, graphify: { enabled: true, excludedProjects: [] } });
    expect(resolveIntelligenceSettings(undefined)).toEqual(DEFAULT_INTELLIGENCE_SETTINGS);
  });

  it('accepts only values of the right type from a hand-edited file', () => {
    const resolved = resolveIntelligenceSettings({
      gateway: 'yes',
      reflection: 'always',
      collections: 0,
      personalMemory: 'true',
      graphify: { enabled: 'true', excludedProjects: [7, '', null], command: '  ' }
    } as never);
    expect(resolved).toEqual({ ...DEFAULT_INTELLIGENCE_SETTINGS, graphify: { enabled: false, excludedProjects: [] } });
  });

  it('honors a saved opt-out and never migrates a pilot executable or allowlist', () => {
    expect(resolveIntelligenceSettings({ graphify: { enabled: false, projects: ['prj_a'], command: 'C:/tools/graphify.exe' } } as never).graphify)
      .toEqual({ enabled: false, excludedProjects: [] });
    expect(resolveIntelligenceSettings({ graphify: { enabled: true, excludedProjects: ['prj_b', 'prj_a', 'prj_b'] } }).graphify)
      .toEqual({ enabled: true, excludedProjects: ['prj_a', 'prj_b'] });
  });
});
