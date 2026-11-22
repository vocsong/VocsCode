/**
 * End-to-end flow for Layer 2 project knowledge: a wiki seeded on disk is ingested and rendered in
 * the right panel's Knowledge tab without any accept step, labels and provenance are shown, a claim
 * is rejected (tombstoned) from its row, and an open page's anchors and relation graph render. The
 * session and wiki are seeded on disk so no harness and no provider key is involved. Requires
 * `npm run build`; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { serializeKnowledgeDocument, type KnowledgePageMeta } from '../src/shared/knowledge';
import type { SessionMeta } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

/** Launches the built app against a throwaway userData directory and returns its window. */
async function launchApp(userData: string): Promise<Page> {
  const packaged = process.env.HARNESS_E2E_EXE;
  app = await electron.launch({
    executablePath: packaged || (require('electron') as string),
    args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')],
    env: isolatedEnv(userData),
    timeout: 60_000
  });
  const win: Page = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  return win;
}

/** An idle native session so the panel opens without a harness or a provider key. */
function sessionFor(project: string, id: string, title = 'Knowledge panel'): SessionMeta {
  return {
    id,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
    cwd: project,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    queued: 0
  } as SessionMeta;
}

async function seedSessions(userData: string, ...sessions: SessionMeta[]): Promise<void> {
  await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
  await Promise.all(sessions.map(async ({ id }) => {
    const dir = path.join(userData, 'sessions', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'transcript.jsonl'), '');
  }));
}

/** Selects a session and opens the same Knowledge entry in either interface mode. */
async function openKnowledge(win: Page, title?: string): Promise<void> {
  const rows = win.getByTestId('session-row');
  const row = title ? rows.filter({ hasText: title }) : rows.first();
  // Zen restores the selected session with its sidebar collapsed to a rail. Do not click behind it.
  if (!(await row.evaluate((el) => el.classList.contains('active')))) await row.click();
  const knowledge = win.getByTestId('knowledge-tab');
  if (!(await knowledge.isVisible())) await win.getByTestId('panel-bottom-knowledge').click();
  await knowledge.waitFor({ timeout: 30_000 });
}

function pageMeta(over: Partial<KnowledgePageMeta>): KnowledgePageMeta {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    claim: 'A harness process belongs to exactly one session.',
    keywords: ['harness', 'session'],
    labels: ['session-lifecycle'],
    updatedBy: 'agent:bootstrap',
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    ...over
  };
}

describe.runIf(enabled)('project knowledge panel', () => {
  it('renders the auto-ingested wiki, rejects a claim, and shows anchors and relations', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-knowledge-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const wiki = path.join(project, '.vocs-code', 'wiki');
    await fs.mkdir(path.join(wiki, 'conventions'), { recursive: true });
    await fs.mkdir(path.join(wiki, 'gotchas'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    // An auto-ingested page: current with no human review step, and an anchor to check.
    await fs.writeFile(path.join(wiki, 'conventions', 'harness-lifecycle.md'), serializeKnowledgeDocument(pageMeta({ anchors: [{ file: 'src/main/session-manager.ts', symbol: 'buildContext' }] }), 'The main process owns harness lifetime.'));
    // A second current page that relates to the first, so the graph has an edge to render.
    await fs.writeFile(
      path.join(wiki, 'gotchas', 'duplicate-pty.md'),
      serializeKnowledgeDocument(
        pageMeta({
          id: 'gotchas/duplicate-pty',
          title: 'Duplicate PTYs',
          kind: 'gotcha',
          claim: 'Renderer reconnects can duplicate a PTY.',
          labels: ['pty-lifecycle'],
          updatedBy: 'agent:distill',
          related: ['conventions/harness-lifecycle']
        }),
        'Reconnects must stay in the main process.'
      )
    );
    // A throwaway page to reject; its claim must end up tombstoned and its file removed.
    await fs.writeFile(
      path.join(wiki, 'gotchas', 'stale-flag.md'),
      serializeKnowledgeDocument(pageMeta({ id: 'gotchas/stale-flag', title: 'Stale flag', kind: 'gotcha', claim: 'The stale flag is set by the CLI.', labels: ['cli'] }), 'A flag the CLI sets.')
    );
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    await seedSessions(userData, sessionFor(project, 's_knowledge_e2e'));

    const win = await launchApp(userData);
    await openKnowledge(win);

    // The page is there on first paint: ingestion is automatic, with no queue to accept from.
    const lifecycle = win.getByTestId('knowledge-page-conventions/harness-lifecycle');
    await lifecycle.waitFor({ timeout: 10_000 });
    const lifecycleText = await lifecycle.innerText();
    expect(lifecycleText).toContain('accepted');
    expect(lifecycleText).toContain('agent:bootstrap');
    expect(await win.getByTestId('knowledge-labels-conventions/harness-lifecycle').innerText()).toContain('session-lifecycle');
    expect(await win.getByTestId('knowledge-auto-note').innerText()).toContain('automatically');
    expect(await win.getByTestId('knowledge-accept-all').count()).toBe(0);
    expect(await win.getByTestId('knowledge-proposals').count()).toBe(0);

    // Rejecting a claim tombstones it and removes the page, with nothing left on disk.
    const staleFile = path.join(wiki, 'gotchas', 'stale-flag.md');
    expect(await fs.readFile(staleFile, 'utf8')).toContain('status: current');
    expect(await win.getByTestId('knowledge-rejected').count()).toBe(0);
    await win.getByTestId('knowledge-row-reject-gotchas/stale-flag').click();
    await win.getByTestId('knowledge-page-gotchas/stale-flag').waitFor({ state: 'detached', timeout: 10_000 });
    expect(await fs.readFile(staleFile, 'utf8').catch(() => '')).toBe('');
    const rejected = JSON.parse(await fs.readFile(path.join(wiki, '_rejected.json'), 'utf8')) as Record<string, { claim: string }>;
    expect(Object.values(rejected).map((r) => r.claim)).toContain('The stale flag is set by the CLI.');

    // The ledger is what keeps that accountable: the claim being kept out of every agent's reach is
    // readable, not just remembered.
    const ledger = win.getByTestId('knowledge-rejected');
    await ledger.waitFor({ timeout: 10_000 });
    expect(await ledger.innerText()).toContain('1 rejected claim');
    await ledger.locator('summary').click();
    expect(await ledger.innerText()).toContain('The stale flag is set by the CLI.');

    // An anchor is checked against GitNexus live; this sandbox has no index, so the panel says so
    // instead of failing or pretending the pointer is good.
    await lifecycle.click();
    await win.getByTestId('knowledge-detail').waitFor({ timeout: 10_000 });
    const detail = await win.getByTestId('knowledge-detail').innerText();
    // innerText reflects the rendered case (the heading is uppercased by CSS) and the flex row
    // breaks the anchor into separate lines.
    expect(detail).toContain('The main process owns harness lifetime.');
    expect(detail).toContain('GITNEXUS ANCHORS');
    expect(detail).toContain('buildContext');
    expect(detail).toContain('not checked');
    expect(detail).toContain('This project is not indexed by GitNexus.');

    // The relation graph is derived from the pages: the gotcha points at this page.
    const relations = win.getByTestId('knowledge-graph');
    await relations.waitFor({ timeout: 10_000 });
    const relationText = await relations.innerText();
    expect(relationText).toContain('related');
    expect(relationText).toContain('Duplicate PTYs');

    // The built-in MCP server for the wiki is injected and shown on the MCP tab.
    await win.getByTestId('panel-bottom-mcp').click();
    const builtin = win.getByTestId('builtin-vocs-memory');
    await builtin.waitFor({ timeout: 10_000 });
    expect(await builtin.innerText()).toContain('on');
    // The AGENTS.md snippet stays collapsed until asked for, and copies to the real clipboard.
    expect(await win.getByTestId('memory-guide-text').count()).toBe(0);
    await win.getByTestId('memory-guide-toggle').click();
    const guide = win.getByTestId('memory-guide-text');
    await guide.waitFor({ timeout: 10_000 });
    const guideText = await guide.innerText();
    expect(guideText).toContain('Memory — you have three layers');
    expect(guideText).toContain('session_history_search');
    await win.getByTestId('memory-guide-copy').click();
    await expect.poll(() => app!.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 }).toContain('**L3 — session history.**');

    await app!.close();
    app = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('starts an empty wiki for a project whose docs cannot bootstrap one', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-knowledge-empty-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const wiki = path.join(project, '.vocs-code', 'wiki');
    await fs.mkdir(userData, { recursive: true });
    // A directory with nothing to scan and no wiki: without this control the project could never
    // have one, because "generate from docs" has nothing to read.
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await seedSessions(userData, sessionFor(project, 's_knowledge_empty'));

    const win = await launchApp(userData);
    await openKnowledge(win);

    // Passive seeding can finish before first paint. Remove its completed output and reattach
    // the renderer to the same host (whose once-per-project seed attempt has already run).
    await expect.poll(async () => fs.stat(path.join(wiki, '_scan.json')).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
    await fs.rm(wiki, { recursive: true, force: true });
    await win.reload();
    await openKnowledge(win);
    const empty = win.getByText('No project wiki yet');
    await empty.waitFor({ timeout: 10_000 });
    await win.getByTestId('knowledge-create').click();
    // The panel stops calling this project wiki-less, and the directory agents write into is there.
    await empty.waitFor({ state: 'detached', timeout: 10_000 });
    await expect.poll(async () => (await fs.stat(wiki).catch(() => null))?.isDirectory() ?? false, { timeout: 10_000 }).toBe(true);

    await app!.close();
    app = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('shares only an explicitly promoted lesson and keeps forgotten records gone after restart', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-intelligence-e2e-'));
    const userData = path.join(tmp, 'userData');
    const alpha = path.join(tmp, 'alpha-lab');
    const beta = path.join(tmp, 'beta-lab');
    const outside = path.join(tmp, 'outside-lab');
    const lesson = 'Titanium grounding procedure';
    try {
      await Promise.all([userData, alpha, beta, outside].map((dir) => fs.mkdir(dir, { recursive: true })));
      await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(alpha, { folders: [alpha, beta, outside], mcpDisabledBuiltins: ['gitnexus', 'cua-driver'] }));
      await seedSessions(userData, sessionFor(alpha, 's_intel_alpha', 'Alpha lab session'), sessionFor(beta, 's_intel_beta', 'Beta lab session'), sessionFor(outside, 's_intel_outside', 'Outside lab session'));

      let win = await launchApp(userData);
      const tab = async (view: string) => { await win.getByTestId(`knowledge-view-${view}`).click(); };
      const memoryRow = () => win.getByTestId('memory-row').filter({ hasText: lesson });
      // Opening a project registers its real root, so only a project known on this machine is a
      // possible member. Collection creation never adds the other roots implicitly.
      await openKnowledge(win, 'Beta lab session');
      await tab('collections');
      await win.getByTestId('collections-view').getByText('beta-lab', { exact: true }).first().waitFor();
      await openKnowledge(win, 'Alpha lab session');
      await tab('sources');
      expect(await win.getByTestId('graph-index').isDisabled()).toBe(true);
      await tab('collections');
      await win.getByTestId('collection-new-name').fill('Shared practices');
      await win.getByTestId('collection-new-create').click();
      const card = win.getByTestId('collection-card').filter({ hasText: 'Shared practices' });
      const projects = card.getByLabel('Add project');
      await projects.selectOption({ label: 'beta-lab' });
      await card.getByTestId('collection-save').click();
      await card.getByLabel('Sharing for beta-lab', { exact: true }).waitFor();

      await tab('memory');
      await win.getByTestId('memory-add').click();
      const form = win.getByTestId('memory-add-form');
      await form.getByLabel('Title').fill(lesson);
      await form.getByRole('textbox').last().fill('Check the titanium grounding lead before calibrating the bench.');
      await form.getByTestId('memory-add-save').click();
      await memoryRow().waitFor();
      expect(await memoryRow().getByTestId('memory-state').innerText()).toBe('verified');
      await memoryRow().getByTestId('memory-promote').click();
      await memoryRow().getByTestId('memory-promote-target').selectOption({ label: 'Shared practices' });
      await memoryRow().getByTestId('memory-promote-confirm').click();
      await expect.poll(() => memoryRow().count()).toBe(2);

      await openKnowledge(win, 'Outside lab session');
      await tab('memory');
      await win.getByTestId('memory-add').waitFor();
      expect(await memoryRow().count()).toBe(0);
      await openKnowledge(win, 'Beta lab session');
      await tab('memory');
      await memoryRow().waitFor();
      expect(await memoryRow().innerText()).toContain('alpha-lab');
      const searchCollection = async () => {
        await tab('evidence');
        await win.getByTestId('evidence-scope').selectOption('collection');
        await win.getByTestId('evidence-query').fill('titanium grounding');
        await win.getByTestId('evidence-search').click();
      };
      await searchCollection();
      await win.getByTestId('evidence-row').filter({ hasText: lesson }).waitFor();
      await tab('memory');
      await memoryRow().getByTestId('memory-revoke').click();
      // Revocation is a retrieval contract, regardless of whether the audit view keeps a row.
      await searchCollection();
      await win.getByText(/No evidence matched/).waitFor();

      await openKnowledge(win, 'Alpha lab session');
      await tab('memory');
      const original = memoryRow().and(win.locator('[data-scope="project"]'));
      await original.getByTestId('memory-forget').click();
      await original.getByTestId('memory-forget-confirm').click();
      await memoryRow().waitFor({ state: 'detached' });

      await app!.close();
      app = null;
      const settingsFile = path.join(userData, 'settings.json');
      const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(settingsFile, JSON.stringify({ ...saved, uiMode: 'zen' }));
      win = await launchApp(userData);
      expect(await win.locator('html').getAttribute('data-ui')).toBe('zen');
      await openKnowledge(win, 'Alpha lab session');
      await tab('evidence');
      await win.getByTestId('evidence-query').fill('titanium grounding');
      await win.getByTestId('evidence-compile').click();
      const packet = win.getByTestId('evidence-packet');
      await packet.waitFor();
      expect(await packet.innerText()).not.toContain(lesson);
      await tab('collections');
      await win.getByTestId('collection-card').filter({ hasText: 'Shared practices' }).waitFor();
    } finally {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 90_000);
});
