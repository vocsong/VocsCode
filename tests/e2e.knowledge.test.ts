/**
 * End-to-end flow for Layer 2 project knowledge: a seeded wiki renders in the right panel's
 * Knowledge tab, a proposal is accepted only on an explicit click, and the accepted page is written
 * back to markdown with human-review provenance. The session and wiki are seeded on disk so no
 * harness and no provider key is involved. Requires `npm run build`; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { serializeKnowledgeDocument, type KnowledgePageMeta } from '../src/shared/knowledge';
import type { SessionMeta } from '../src/shared/types';
import { seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

function pageMeta(over: Partial<KnowledgePageMeta>): KnowledgePageMeta {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    claim: 'A harness process belongs to exactly one session.',
    keywords: ['harness', 'session'],
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    review: { state: 'reviewed', by: 'human' },
    ...over
  };
}

describe.runIf(enabled)('project knowledge panel', () => {
  it('shows the wiki, accepts a proposal on click, and writes it back as reviewed markdown', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-knowledge-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const wiki = path.join(project, '.vocs-code', 'wiki');
    await fs.mkdir(path.join(wiki, 'conventions'), { recursive: true });
    await fs.mkdir(path.join(wiki, '_proposals'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(wiki, 'conventions', 'harness-lifecycle.md'), serializeKnowledgeDocument(pageMeta({}), 'The main process owns harness lifetime.'));
    await fs.writeFile(
      path.join(wiki, '_proposals', 'pty-guard.md'),
      serializeKnowledgeDocument(
        pageMeta({
          id: 'pty-guard',
          title: 'PTY guard',
          kind: 'gotcha',
          status: 'proposed',
          claim: 'Renderer reconnects can duplicate a PTY.',
          targetPageId: 'gotchas/pty-guard',
          review: { state: 'unreviewed' }
        }),
        'Reconnects must stay in the main process.'
      )
    );
    // A generated draft, which the panel must be able to accept into the served wiki.
    await fs.mkdir(path.join(wiki, 'architecture'), { recursive: true });
    await fs.writeFile(
      path.join(wiki, 'architecture', 'process-split.md'),
      serializeKnowledgeDocument(
        pageMeta({ id: 'architecture/process-split', title: 'Process split', kind: 'architecture', status: 'draft', claim: 'The main process owns privileged work.', review: { state: 'unreviewed' } }),
        'The renderer stays sandboxed.'
      )
    );
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const sid = 's_knowledge_e2e';
    const session = {
      id: sid,
      title: 'Knowledge panel',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      queued: 0
    } as SessionMeta;
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', sid), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', sid, 'transcript.jsonl'), '');

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
      if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
      env[k] = v;
    }
    env.VOCS_CODE_USER_DATA = userData;

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')],
      env,
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    // Select the seeded session, then open the Knowledge tab in the panel's lower half.
    await win.locator('[data-testid="session-row"]').first().click();
    await win.getByTestId('panel-bottom-knowledge').click();

    const tab = win.getByTestId('knowledge-tab');
    await tab.waitFor({ timeout: 30_000 });
    const accepted = win.getByTestId('knowledge-page-conventions/harness-lifecycle');
    await accepted.waitFor({ timeout: 10_000 });
    expect(await accepted.innerText()).toContain('human-reviewed');

    // The proposal is rendered and nothing has been written yet.
    const proposal = win.getByTestId('knowledge-proposal-pty-guard');
    await proposal.waitFor({ timeout: 10_000 });
    expect(await proposal.innerText()).toContain('Renderer reconnects can duplicate a PTY.');
    const proposalFile = path.join(wiki, '_proposals', 'pty-guard.md');
    expect(await fs.readFile(proposalFile, 'utf8')).toContain('status: proposed');

    await win.getByTestId('knowledge-accept-pty-guard').click();
    await win.getByTestId('knowledge-page-gotchas/pty-guard').waitFor({ timeout: 10_000 });
    await proposal.waitFor({ state: 'detached', timeout: 10_000 });
    expect(await fs.readFile(proposalFile, 'utf8').catch(() => '')).toBe('');

    // The page landed in markdown with human-review provenance, under the target id.
    const stored = await fs.readFile(path.join(wiki, 'gotchas', 'pty-guard.md'), 'utf8');
    expect(stored).toContain('status: current');
    expect(stored).toContain('review_state: reviewed');
    expect(stored).not.toContain('target_page:');
    expect(stored).toContain('Reconnects must stay in the main process.');

    // The built-in MCP server for the wiki is injected and shown on the MCP tab.
    await win.getByTestId('panel-bottom-mcp').click();
    const builtin = win.getByTestId('builtin-vocs-memory');
    await builtin.waitFor({ timeout: 10_000 });
    expect(await builtin.innerText()).toContain('on');
    await win.getByTestId('panel-bottom-knowledge').click();

    // A generated draft is accepted in place: the file becomes current and human-reviewed.
    await win.getByTestId('knowledge-page-architecture/process-split').click();
    await win.getByTestId('knowledge-detail').waitFor({ timeout: 10_000 });
    await win.getByTestId('knowledge-page-accept').click();
    await win.getByTestId('knowledge-page-architecture/process-split').waitFor({ timeout: 10_000 });
    const draftFile = await fs.readFile(path.join(wiki, 'architecture', 'process-split.md'), 'utf8');
    expect(draftFile).toContain('status: current');
    expect(draftFile).toContain('review_state: reviewed');

    await app.close();
    app = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
