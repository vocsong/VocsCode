/** Opt-in measurements; run with `node scripts/benchmark-knowledge.mjs`, not the CI timing gate. */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron as electron, type Page } from 'playwright-core';
import { expect, it } from 'vitest';
import type { ContextPacket, GraphIndexStatus, IntelligenceSearchResponse } from '../src/shared/intelligence';
import { KNOWLEDGE_DIR, serializeKnowledgeDocument, type KnowledgePageMeta } from '../src/shared/knowledge';
import { MCP_BUILTIN_IDS, type SessionMeta } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';
import { BENCHMARK_REVISION, REFRESH_TARGET, benchmarkWiki, retrievalCases } from './fixtures/knowledge-benchmark';
import { citationRank, distribution, evidenceCitations, rankGrep, type BenchCitation } from './fixtures/knowledge-benchmark-metrics';

const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const firstSession = 'knowledge_benchmark_a';
const secondSession = 'knowledge_benchmark_b';
const starts = 3;
const repeats = 5;
const pollMs = 250;
const elapsed = (from: number) => performance.now() - from;
const bytes = (s: string) => Buffer.byteLength(s);
const lookup = { query: 'TerminalManager', expectedPaths: ['src/main/terminal.ts'] };
type Probe = (typeof retrievalCases)[number];

function runGit(cwd: string, env: NodeJS.ProcessEnv, args: string[], allowed = [0]): string {
  const child = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status === null || !allowed.includes(child.status)) throw new Error(`git ${args[0]} exited ${child.status}: ${child.stderr}`);
  return child.stdout;
}

async function snapshot(tmp: string) {
  const project = path.join(tmp, 'VocsCode');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|SSH_)/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' });
  await fs.mkdir(project);
  runGit(project, env, ['init', '--quiet', '--template=']);
  // Fetch just the two committed revisions into a real independent repo. Do not use alternates,
  // worktree metadata, local private Markdown or a live session/transcript.
  runGit(project, env, ['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', root, BENCHMARK_REVISION, REFRESH_TARGET.revision]);
  runGit(project, env, ['checkout', '--quiet', '--detach', BENCHMARK_REVISION]);
  expect(runGit(project, env, ['rev-parse', 'HEAD']).trim()).toBe(BENCHMARK_REVISION);
  return { project, git: (args: string[], allowed?: number[]) => runGit(project, env, args, allowed) };
}

async function seedProfile(userData: string, project: string) {
  const settings = seedSettings(project, {
    defaultHarness: 'native', defaultPermissionMode: 'ask', agent: { enabled: false }, notifications: false,
    mcpDisabledBuiltins: MCP_BUILTIN_IDS, intelligence: { reflection: 'local' }
  });
  const sessions: SessionMeta[] = [firstSession, secondSession].map((id) => ({
    id, title: id, createdAt: Date.now(), updatedAt: Date.now(),
    config: { harness: 'native', projectRoot: project, permissionMode: 'ask' }, cwd: project,
    status: 'idle', harnessRef: {}, queued: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  }));
  await fs.mkdir(userData, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(userData, 'settings.json'), settings),
    fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions)),
    ...sessions.map(async ({ id }) => {
      const dir = path.join(userData, 'sessions', id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'transcript.jsonl'), '');
    })
  ]);
}

async function seedWiki(project: string) {
  for (const page of benchmarkWiki) {
    const meta: KnowledgePageMeta = {
      id: page.id, title: page.title, claim: page.claim, keywords: page.keywords,
      kind: 'decision', status: 'current', scope: 'repo', labels: ['benchmark'],
      sources: [{ type: 'doc', ref: page.path, revision: BENCHMARK_REVISION }],
      anchors: [], related: [], supersedes: [], contradicts: [], updatedBy: 'fixture:benchmark'
    };
    const file = path.join(project, KNOWLEDGE_DIR, `${page.id}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeKnowledgeDocument(meta, page.body));
  }
}

async function launch(userData: string) {
  const app = await electron.launch({
    executablePath: require('electron') as string, args: [path.join(root, 'out/main/index.js')],
    env: isolatedEnv(userData, { VOCS_CODE_E2E_UI: '1', VOCS_CODE_E2E_VISIBLE: '0' }), timeout: 60_000
  });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    return { app, win };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function select(win: Page, sessionId: string) {
  const row = win.getByTestId('session-row').filter({ hasText: sessionId });
  await row.waitFor({ timeout: 10_000 });
  if (!(await row.evaluate((item) => item.classList.contains('active')))) await row.click({ timeout: 10_000 });
}

const graph = (win: Page, sessionId = firstSession): Promise<GraphIndexStatus | undefined> =>
  win.evaluate(async (id) => (await window.harness.invoke('intelligence:view', { sessionId: id })).graph, sessionId);

const search = (win: Page, query: string, sessionId = firstSession): Promise<IntelligenceSearchResponse> => win.evaluate(
  (args) => window.harness.invoke('intelligence:search', args), { sessionId, query, limit: 12 }
);

async function ready(win: Page, revision: string, sessionId = firstSession) {
  const deadline = performance.now() + 270_000;
  for (;;) {
    const status = await graph(win, sessionId);
    if (!status?.installed) throw new Error('Bundled Graphify unavailable; run node scripts/graphify-runtime.mjs prepare');
    if (status.error) throw new Error(status.error);
    if (status.indexed && status.revision === revision && status.stale === false) return status;
    if (performance.now() >= deadline) throw new Error(`Graphify did not index ${revision} in time`);
    await sleep(pollMs);
  }
}

async function firstCitation(win: Page) {
  const begin = performance.now();
  await select(win, firstSession);
  const status = await ready(win, BENCHMARK_REVISION);
  const readyMs = elapsed(begin);
  const evidence = await search(win, lookup.query);
  expect(citationRank(evidenceCitations(evidence.results), lookup.expectedPaths)).not.toBeNull();
  return { readyMs, citedMs: elapsed(begin), status };
}

async function fileBytes(dir: string): Promise<number> {
  let total = 0;
  for (const file of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, file.name);
    if (file.isDirectory()) total += await fileBytes(target);
    else if (file.isFile()) total += (await fs.stat(target)).size;
  }
  return total;
}

type Arm = 'gitGrep' | 'emptyWiki' | 'curatedWiki';
type Sample = { ms: number; citations: BenchCitation[] };

it.runIf(process.env.VOCS_CODE_KNOWLEDGE_BENCH === '1')('benchmarks real desktop Graphify and Evidence on pinned Vocs Code', async () => {
  const output = process.env.VOCS_CODE_KNOWLEDGE_DESKTOP_OUT;
  if (!output) throw new Error('Set VOCS_CODE_KNOWLEDGE_DESKTOP_OUT or use node scripts/benchmark-knowledge.mjs');
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'vocs-knowledge-bench-'));
  try {
    const { project, git } = await snapshot(tmp);
    const paths = new Set(git(['ls-tree', '-rz', '--name-only', 'HEAD']).split('\0').filter(Boolean));
    for (const probe of retrievalCases) for (const file of probe.expectedPaths) expect(paths.has(file), file).toBe(true);
    for (const page of benchmarkWiki) expect(paths.has(page.path), page.path).toBe(true);
    const rows = new Map(retrievalCases.map((probe) => [probe.id, { gitGrep: [], emptyWiki: [], curatedWiki: [] } as Record<Arm, Sample[]>]));
    const startup = [];
    const packets: ContextPacket[] = [];
    let electronVersion: string | undefined;
    let graphBytes = 0;
    let graphSize: { nodes?: number; edges?: number; version?: string } = {};
    let refresh: { revision: string; retainedStaleIndex: boolean; changedPaths: number; citedMs: number } | undefined;
    for (let i = 0; i < starts; i++) {
      const userData = path.join(tmp, `profile-${i}`);
      await seedProfile(userData, project);
      const coldApp = await launch(userData);
      const cold = await firstCitation(coldApp.win).finally(() => coldApp.app.close());
      const warmApp = await launch(userData);
      try {
        const warm = await firstCitation(warmApp.win);
        expect(warm.status.indexedAt).toBe(cold.status.indexedAt);
        startup.push({ coldReadyMs: cold.readyMs, warmReadyMs: warm.readyMs, coldCitedMs: cold.citedMs, warmCitedMs: warm.citedMs });
        if (i !== starts - 1) continue;
        const { win, app } = warmApp;
        electronVersion = await app.evaluate(() => process.versions.electron);
        graphBytes = await fileBytes(path.join(userData, 'intelligence', 'graphs'));
        graphSize = { nodes: warm.status.nodes, edges: warm.status.edges, version: warm.status.version };
        const run = async (arm: Arm, probe: Probe) => {
          const t = performance.now();
          const citations = arm === 'gitGrep'
            ? rankGrep(git(['grep', '-I', '-n', '-z', '-F', '--no-color', ...(probe.kind === 'symbol' ? ['-w'] : ['-i']),
              ...probe.grepTerms.flatMap((term) => ['-e', term]), 'HEAD', '--'], [0, 1]), probe.grepTerms, probe.kind === 'symbol')
            : evidenceCitations((await search(win, probe.query)).results);
          return { ms: elapsed(t), citations };
        };
        // One unmeasured pass per arm, then rotate probe order and which comparator runs first.
        for (const probe of retrievalCases) { await run('gitGrep', probe); await run('emptyWiki', probe); }
        for (let repeat = 0; repeat < repeats; repeat++) {
          for (let j = 0; j < retrievalCases.length; j++) {
            const probe = retrievalCases[(j + repeat) % retrievalCases.length]!;
            for (const arm of (repeat + j) % 2 ? ['emptyWiki', 'gitGrep'] as const : ['gitGrep', 'emptyWiki'] as const) {
              rows.get(probe.id)![arm].push(await run(arm, probe));
            }
          }
        }
        await seedWiki(project);
        for (const probe of retrievalCases) await run('curatedWiki', probe);
        for (let repeat = 0; repeat < repeats; repeat++) {
          for (let j = retrievalCases.length - 1; j >= 0; j--) {
            const probe = retrievalCases[(j + repeat) % retrievalCases.length]!;
            rows.get(probe.id)!.curatedWiki.push(await run('curatedWiki', probe));
          }
        }
        for (const { query } of retrievalCases) {
          const packet = await win.evaluate((args) => window.harness.invoke('intelligence:compile', args), { sessionId: firstSession, query });
          expect(packet.usedTokens).toBeLessThanOrEqual(packet.budgetTokens);
          packets.push(packet);
        }
        await select(win, secondSession);
        expect(await graph(win, secondSession)).toMatchObject({ indexedAt: warm.status.indexedAt, indexing: false });

        const changedPaths = git(['diff', '--name-only', BENCHMARK_REVISION, REFRESH_TARGET.revision]).trim().split('\n').length;
        git(['checkout', '--quiet', '--detach', REFRESH_TARGET.revision]);
        const t = performance.now();
        // Move HEAD like a normal commit without touching the live repo; do not invoke Refresh.
        expect(await graph(win, secondSession)).toMatchObject({ revision: BENCHMARK_REVISION, indexed: true, stale: true });
        await ready(win, REFRESH_TARGET.revision, secondSession);
        const updated = await search(win, REFRESH_TARGET.query, secondSession);
        expect(updated.results.some((item) => item.provider === 'graph' && item.revision === REFRESH_TARGET.revision && item.freshness === 'fresh' &&
          citationRank(evidenceCitations([item]), [REFRESH_TARGET.file]) === 1)).toBe(true);
        refresh = { revision: REFRESH_TARGET.revision, retainedStaleIndex: true, changedPaths, citedMs: elapsed(t) };
      } finally {
        await warmApp.app.close();
      }
    }
    const arms: Arm[] = ['gitGrep', 'emptyWiki', 'curatedWiki'];
    const score = (arm: Arm, probe: Probe) => {
      const samples = rows.get(probe.id)![arm];
      const ranks = samples.map(({ citations }) => citationRank(citations, probe.expectedPaths, probe.expectedWikiId));
      // A fluctuating ranking is a result to report, not to silently pick the best repeat of.
      return { rank: ranks[0]!, stable: ranks.every((rank) => rank === ranks[0]), latencyMs: samples.map(({ ms }) => ms),
        top: samples[0]!.citations.slice(0, 3).map(({ ref, provider }) => ({ ref, provider })) };
    };
    const questions = retrievalCases.map((probe) => ({ ...probe, scores: Object.fromEntries(arms.map((arm) => [arm, score(arm, probe)])) }));
    const comparison = Object.fromEntries(arms.map((arm) => [arm, {
      latencyMs: distribution(retrievalCases.flatMap((probe) => rows.get(probe.id)![arm].map((sample) => sample.ms))),
      relevance: Object.fromEntries((['all', 'symbol', 'question'] as const).map((kind) => {
        const group = retrievalCases.filter((probe) => kind === 'all' || probe.kind === kind);
        const ranks = group.map((probe) => score(arm, probe).rank);
        return [kind, { n: group.length, hit1: ranks.filter((rank) => rank === 1).length, hit3: ranks.filter((rank) => rank !== null && rank <= 3).length,
          mrr3: Number((ranks.reduce<number>((sum, rank) => sum + (rank && rank <= 3 ? 1 / rank : 0), 0) / group.length).toFixed(3)) }];
      }))
    }]));
    expect(questions.some((item) => item.scores.emptyWiki!.top.some(({ provider }) => provider === 'graph'))).toBe(true);
    expect(questions.some((item) => item.scores.curatedWiki!.top.some(({ provider }) => provider === 'wiki'))).toBe(true);
    const report = {
      schema: 1, reference: BENCHMARK_REVISION, trackedPaths: paths.size, repeats, pollMs,
      environment: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length,
        ramGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), node: process.version, electron: electronVersion },
      graph: { ...graphSize, cacheBytes: graphBytes, warmArtifactUnchanged: true }, wikiFixturePages: benchmarkWiki.length,
      startup: { samples: startup, coldCitedMs: distribution(startup.map((s) => s.coldCitedMs)), warmCitedMs: distribution(startup.map((s) => s.warmCitedMs)) },
      refresh, comparison, questions,
      packet: { budgetTokens: packets[0]!.budgetTokens, approximateTokens: distribution(packets.map((p) => p.usedTokens)),
        bytes: distribution(packets.map((p) => bytes(p.text))), truncated: packets.filter((p) => p.truncated).length }
    };
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log('Desktop benchmark:', JSON.stringify({ startup: report.startup, refresh, comparison: report.comparison, packet: report.packet }));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}, 20 * 60_000);
