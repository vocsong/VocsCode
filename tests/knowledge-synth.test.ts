/** The knowledge jobs: bootstrap drafts from real docs, distillation proposals from episodes. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { KnowledgeStore } from '../src/main/knowledge/store';
import { parseJsonReply, salvageArrayEntries } from '../src/main/knowledge/llm';
import { bootstrapKnowledge, distillKnowledge, type KnowledgeSynthDeps } from '../src/main/knowledge/synth';
import type { KnowledgeProposalInput, KnowledgeScope } from '../src/shared/knowledge';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function deps(over: Partial<KnowledgeSynthDeps> = {}): KnowledgeSynthDeps {
  return {
    store: new KnowledgeStore(),
    log: () => undefined,
    settings: { prime: true, autoDistill: false },
    ...over
  };
}

describe('parseJsonReply', () => {
  it('reads a fenced reply and ignores surrounding prose', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Sure! {"pages":[]} done')).toEqual({ pages: [] });
    expect(parseJsonReply('no json here')).toBeNull();
    expect(parseJsonReply(null)).toBeNull();
  });
});

describe('salvageArrayEntries', () => {
  it('recovers complete entries from a reply truncated mid-array', () => {
    const text = '{"pages":[{"title":"A","body":"one"},{"title":"B","body":"two"},{"title":"C","body":"thr';
    expect(salvageArrayEntries<{ title: string }>(text, 'pages').map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('ignores braces inside strings and stops at the closing bracket', () => {
    const text = '{"pages":[{"title":"a { b }","body":"x"}],"other":[{"title":"nope"}]}';
    expect(salvageArrayEntries<{ title: string }>(text, 'pages')).toEqual([{ title: 'a { b }', body: 'x' }]);
  });

  it('is empty when the key never appears', () => {
    expect(salvageArrayEntries('{}', 'pages')).toEqual([]);
    expect(salvageArrayEntries(null, 'pages')).toEqual([]);
  });
});

describe('bootstrapKnowledge', () => {
  it('turns project docs into draft pages with file provenance', async () => {
    const projectRoot = tmpDir('vocs-synth-');
    await fs.writeFile(path.join(projectRoot, 'README.md'), '# Demo\n\nA demo project with a main process and a renderer. The main process owns privileged work, and the renderer talks to it through a narrow typed bridge; nothing in the UI layer touches Node APIs directly, which is what keeps the sandbox honest.\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'docs', 'ARCH.md'), '# Architecture\n\nThe main process owns state and lifecycle. Renderer views subscribe to pushed events and keep no durable state of their own; every mutation goes through an IPC channel with a validated payload.\n', 'utf8');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const completer = {
      label: () => 'test/model',
      complete: async () => JSON.stringify({
        pages: [
          {
            title: 'Process split',
            kind: 'architecture',
            claim: 'All privileged work happens in the main process.',
            body: '## Intent\n\nThe renderer never touches Node directly, which keeps the trust boundary in one place and lets the UI stay sandboxed.',
            keywords: ['main process', 'renderer'],
            sources: [{ type: 'doc', ref: 'docs/ARCH.md' }],
            anchors: [{ file: 'src/main/index.ts' }]
          },
          { title: 'Too short', kind: 'concept', body: 'nope' }
        ]
      })
    };
    const result = await bootstrapKnowledge(scope, deps({ store, completer }));
    expect(result.ok).toBe(true);
    const pages = await store.load(scope);
    expect(pages).toHaveLength(1);
    expect(pages[0].meta.status).toBe('draft');
    expect(pages[0].meta.kind).toBe('architecture');
    expect(pages[0].meta.scope).toBe('repo');
    expect(pages[0].meta.sources).toEqual([{ type: 'doc', ref: 'docs/ARCH.md' }]);
    expect(pages[0].meta.anchors).toEqual([{ file: 'src/main/index.ts' }]);
    expect(pages[0].body).toContain('trust boundary');
  });

  it('refuses to guess when there is nothing to read', async () => {
    const projectRoot = tmpDir('vocs-synth-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const result = await bootstrapKnowledge(scope, deps({ store, completer: { label: () => 'x', complete: async () => '{}' } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Not enough project documentation');
  });

  it('keeps the pages a truncated reply did write', async () => {
    const projectRoot = tmpDir('vocs-synth-');
    await fs.writeFile(path.join(projectRoot, 'README.md'), `# Demo\n\n${'The main process owns state and the renderer keeps none of it. '.repeat(12)}\n`, 'utf8');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    const longBody = 'Explain the boundary in enough words to be a real page body. '.repeat(3);
    const truncated =
      `{"pages":[` +
      `{"title":"First","kind":"architecture","claim":"one","body":"${longBody}"},` +
      `{"title":"Second","kind":"concept","claim":"two","body":"${longBody}"},` +
      `{"title":"Third","kind":"concept","claim":"thr`;
    const result = await bootstrapKnowledge(scope, deps({ store, completer: { label: () => 'x', complete: async () => truncated } }));
    expect(result.ok).toBe(true);
    expect((await store.load(scope)).map((p) => p.meta.title).sort()).toEqual(['First', 'Second']);
  });
});

describe('distillKnowledge', () => {
  it('turns episodes into proposals through the injected pipeline', async () => {
    const projectRoot = tmpDir('vocs-synth-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const store = new KnowledgeStore();
    await store.appendEpisode(scope, { kind: 'merge', sessionId: 's7', at: '2026-09-14T10:00:00.000Z', summary: 'Merged vocscode/fix-pty into develop' });
    await store.write(scope, {
      id: 'conventions/harness-lifecycle',
      title: 'Harness lifecycle',
      kind: 'convention',
      status: 'current',
      scope: 'repo',
      claim: 'A harness belongs to one session.',
      keywords: [],
      sources: [],
      anchors: [],
      related: [],
      supersedes: [],
      contradicts: []
    }, 'body');
    const proposed: KnowledgeProposalInput[] = [];
    const result = await distillKnowledge(
      scope,
      deps({
        store,
        transcript: async () => ['user: fix the double PTY', 'assistant: moved the guard'],
        propose: async (input) => {
          proposed.push(input);
          return { promoted: false, rejected: false };
        },
        completer: {
          label: () => 'test/model',
          complete: async (req) => {
            expect(req.prompt).toContain('conventions/harness-lifecycle');
            expect(req.prompt).toContain('Merged vocscode/fix-pty');
            expect(req.prompt).toContain('moved the guard');
            return '```json\n{"proposals":[{"title":"PTY guard","claim":"Reconnects must be guarded.","body":"Explain the guard.","kind":"gotcha"}]}\n```';
          }
        }
      })
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('proposed 1');
    expect(proposed).toHaveLength(1);
    expect(proposed[0].title).toBe('PTY guard');
    expect(proposed[0].kind).toBe('gotcha');
  });

  it('reports nothing to do without episodes', async () => {
    const projectRoot = tmpDir('vocs-synth-');
    const scope: KnowledgeScope = { projectRoot, cwd: projectRoot };
    const result = await distillKnowledge(
      scope,
      deps({ completer: { label: () => 'x', complete: async () => '{}' }, propose: async () => ({ promoted: false, rejected: false }) })
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('nothing to distil');
  });
});
