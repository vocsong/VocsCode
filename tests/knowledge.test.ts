/** Layer 2 shared schema: frontmatter round-trip, identity, authority and the session digest. */
import { describe, expect, it } from 'vitest';
import {
  authorityOf,
  claimKey,
  isServable,
  isSameClaim,
  knowledgeSlug,
  normalizeClaim,
  pageIdFromPath,
  parseKnowledgeDocument,
  renderKnowledgeDigest,
  serializeKnowledgeDocument,
  type KnowledgePageMeta,
  type KnowledgePageSummary
} from '../src/shared/knowledge';

function meta(over: Partial<KnowledgePageMeta> = {}): KnowledgePageMeta {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    keywords: ['harness', 'lifecycle'],
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    ...over
  };
}

describe('knowledge codec', () => {
  it('round-trips every field through frontmatter', () => {
    const page = meta({
      claim: 'A harness belongs to exactly one session.',
      confidence: 'high',
      branch: undefined,
      sources: [
        { type: 'file', ref: 'src/main/session-manager.ts', note: 'buildContext owns it' },
        { type: 'transcript', ref: 's_ab12#u_9' }
      ],
      anchors: [{ file: 'src/main/session-manager.ts', symbol: 'SessionManager.buildContext' }],
      related: ['harness/session-restore'],
      supersedes: ['harness/old-lifecycle'],
      contradicts: ['harness/shared-process'],
      targetPageId: 'conventions/harness-lifecycle',
      evidenceCount: 3,
      review: { state: 'reviewed', by: 'human', at: '2026-09-01T00:00:00.000Z', note: 'looks right' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'human'
    });
    const text = serializeKnowledgeDocument(page, '# Body\n\nSome prose with a claim: "quoted: value".\n');
    const parsed = parseKnowledgeDocument(text, 'conventions/harness-lifecycle.md');
    expect(parsed).not.toBeNull();
    expect(parsed!.meta).toMatchObject({
      id: page.id,
      title: page.title,
      kind: 'convention',
      status: 'current',
      scope: 'repo',
      claim: page.claim,
      keywords: ['harness', 'lifecycle'],
      related: ['harness/session-restore'],
      supersedes: ['harness/old-lifecycle'],
      contradicts: ['harness/shared-process'],
      targetPageId: 'conventions/harness-lifecycle',
      evidenceCount: 3,
      updatedBy: 'human'
    });
    expect(parsed!.meta.review).toEqual(page.review);
    expect(parsed!.meta.sources).toEqual(page.sources);
    expect(parsed!.meta.anchors).toEqual(page.anchors);
    expect(parsed!.body).toContain('quoted: value');
  });

  it('keeps unknown hand-edited keys out of the typed page without breaking it', () => {
    const text = ['---', 'id: concepts/retries', 'title: Retries', 'kind: concept', 'status: current', 'owner: someone', '---', '', 'Body'].join('\n');
    const parsed = parseKnowledgeDocument(text, 'concepts/retries.md');
    expect(parsed?.meta.id).toBe('concepts/retries');
    expect(parsed?.meta.status).toBe('current');
    expect(parsed?.body).toBe('Body');
  });

  it('rejects a file that is not a knowledge page', () => {
    expect(parseKnowledgeDocument('# just a readme', 'README.md')).toBeNull();
    expect(parseKnowledgeDocument('---\ntitle: no id\n---\nbody', 'x.md')).toBeNull();
  });

  it('guards identity and paths', () => {
    expect(knowledgeSlug('Harness lifecycle & session ownership!')).toBe('harness-lifecycle-session-ownership');
    expect(knowledgeSlug('!!!')).toBe('note');
    expect(pageIdFromPath('conventions/harness-lifecycle.md')).toBe('conventions/harness-lifecycle');
    expect(pageIdFromPath('_proposals/x.md')).toBeNull();
    expect(pageIdFromPath('../../escape.md')).toBeNull();
    expect(pageIdFromPath('notes.txt')).toBeNull();
  });

  it('dedupes claims case- and punctuation-insensitively', () => {
    expect(normalizeClaim('Renderer retries PTY connects.')).toBe('renderer retries pty connects');
    expect(claimKey('Renderer retries PTY connects.')).toBe(claimKey('renderer  retries pty CONNECTS'));
    expect(isSameClaim('Renderer retries PTY connects', 'renderer retries pty connects and leaks')).toBe(true);
    expect(isSameClaim('Renderer retries PTY connects', 'Terminal tabs survive a reload')).toBe(false);
  });
});

describe('authority', () => {
  it('ranks reviewed and human pages above unreviewed drafts', () => {
    const reviewed = authorityOf(meta({ status: 'current', review: { state: 'reviewed' } }));
    const human = authorityOf(meta({ updatedBy: 'human' }));
    const current = authorityOf(meta({ status: 'current' }));
    const uncertain = authorityOf(meta({ status: 'uncertain' }));
    const draft = authorityOf(meta({ status: 'draft' }));
    expect(reviewed).toBeLessThan(current);
    expect(human).toBeLessThan(current);
    expect(current).toBeLessThan(uncertain);
    expect(uncertain).toBeLessThan(draft);
  });

  it('only serves current and uncertain pages as knowledge', () => {
    expect(isServable(meta({ status: 'current' }))).toBe(true);
    expect(isServable(meta({ status: 'uncertain' }))).toBe(true);
    expect(isServable(meta({ status: 'draft' }))).toBe(false);
    expect(isServable(meta({ status: 'proposed' }))).toBe(false);
    expect(isServable(meta({ status: 'superseded' }))).toBe(false);
  });
});

describe('session digest', () => {
  const summary = (over: Partial<KnowledgePageSummary>): KnowledgePageSummary => ({
    id: 'conventions/x',
    title: 'X',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    path: 'conventions/x.md',
    keywords: [],
    authority: 3,
    ...over,
    ...(over.path ? {} : { path: `${over.id ?? 'conventions/x'}.md` })
  });

  it('names pages without pasting bodies and skips non-servable ones', () => {
    const digest = renderKnowledgeDigest(
      [
        summary({ id: 'architecture/layers', title: 'Memory layers', kind: 'architecture', claim: 'Four layers with one facade.' }),
        summary({ id: 'gotchas/pty', title: 'PTY duplication', kind: 'gotcha', claim: 'Reconnects can double PTYs.' }),
        summary({ id: 'draft/idea', title: 'Half-baked', status: 'draft' })
      ],
      { projectName: 'VocsCode', wikiDir: '/repo/.vocs-code/wiki' }
    );
    expect(digest).toContain('architecture/layers.md');
    expect(digest).toContain('Reconnects can double PTYs');
    expect(digest).not.toContain('Half-baked');
    expect(digest).toContain('/repo/.vocs-code/wiki');
    expect(digest!.length).toBeLessThan(3000);
  });

  it('is null when nothing is servable', () => {
    expect(renderKnowledgeDigest([summary({ status: 'draft' })], { projectName: 'X', wikiDir: '.' })).toBeNull();
    expect(renderKnowledgeDigest([], { projectName: 'X', wikiDir: '.' })).toBeNull();
  });
});
