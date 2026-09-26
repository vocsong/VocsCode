/**
 * Mission UI through real Electron/bootstrap, registered IPC, stores and Git workspaces.
 * Historical plan/worker data is explicitly seeded, not a simulated successful provider run.
 * Missing configuration/runtime is a failure state; this suite never certifies live execution.
 * Requires a current `npm run build`; VOCS_CODE_E2E_UI=1 must execute all tests, not skip them.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { MissionProfile, MissionRecord } from '../src/shared/mission';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import { MissionStore } from '../src/main/mission/store';
import { createManagedPiOwnershipIntent, recordUnlaunchedManagedPiIntent } from '../src/main/harness/pi-ownership';
import { assertMissionRecord, implementationBlockers, reduceMission } from '../src/main/mission/state';
import { MissionDeliveryService } from '../src/main/mission/delivery';
import { parseTestReport } from '../src/main/mission/verification';
import { missionPlanMarkdown } from '../src/main/mission/context';
import { MissionWorkspaces, type MissionWorkspace } from '../src/main/mission/workspaces';
import { missionFixture } from './support/mission-fixture';
import { completedMissionFixture } from './support/mission-completed-fixture';
import { expectQuietWindow, isolatedEnv, openNewSession } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let tmp: string;
let win: Page | undefined;
const mainLog: string[] = [];
const rendererLog: string[] = [];

afterEach(async ({ task }) => {
  if (tmp) {
    // Keep the pre-shutdown UI, committed journal and host diagnostics. Cleanup/recovery can
    // change the very state that explains a failure, so collect these before closing Electron.
    const artifacts = path.join(root, 'tests', 'artifacts', `mission-${Date.now()}-${task.name.slice(0, 70).replace(/[^a-z0-9]+/gi, '-')}`);
    await fs.mkdir(artifacts, { recursive: true });
    const captures = await Promise.allSettled([
      fs.writeFile(path.join(artifacts, 'main.log'), mainLog.join('')),
      fs.writeFile(path.join(artifacts, 'renderer.log'), rendererLog.join('\n')),
      ...(win && !win.isClosed() ? [
        win.screenshot({ path: path.join(artifacts, 'window.png') }),
        win.locator('body').innerText().then((text) => fs.writeFile(path.join(artifacts, 'window.txt'), text)),
        win.content().then((html) => fs.writeFile(path.join(artifacts, 'window.html'), html)),
      ] : []),
      ...['missions', 'sessions', 'sessions.json', 'logs'].map(async (name) => {
        const source = path.join(tmp, 'userData', name);
        if (await fs.stat(source).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) await fs.cp(source, path.join(artifacts, name), { recursive: true });
      }),
    ]);
    await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ name: task.name, state: task.result?.state, errors: task.result?.errors, captureErrors: captures.filter((capture) => capture.status === 'rejected').map((capture) => String(capture.reason)) }, null, 2));
    console.info(`[Mission UI artifacts] ${artifacts}`);
  }
  await app?.close().catch(() => undefined);
  app = null;
  win = undefined;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

async function setup(configured = false) {
  mainLog.length = 0;
  rendererLog.length = 0;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-ui-'));
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  await fs.mkdir(project); await fs.mkdir(userData);
  git(project, ['init', '--initial-branch=main']);
  // Fixture-local identity only; the working repository and user's Git identity are untouched.
  git(project, ['config', 'user.name', 'Mission UI Test']);
  git(project, ['config', 'user.email', 'mission-ui@example.invalid']);
  git(project, ['config', 'commit.gpgsign', 'false']);
  git(project, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(project, 'result.txt'), 'source baseline\n');
  git(project, ['add', '.']); git(project, ['commit', '-m', 'Fixture baseline']);
  const settings = new SettingsStore(userData);
  await settings.load();
  await settings.update({ folders: [project], recentProjects: [project], onboardingDone: true, defaultHarness: 'native', defaultPermissionMode: 'ask', agent: { enabled: false }, ...(configured ? { mission: missionFixture().config } : {}) });
  const sessions = new SessionStore(userData);
  await sessions.load();
  const source: SessionMeta = { id: 'source', title: 'Original discussion', createdAt: 1, updatedAt: 1, cwd: project, status: 'idle', config: { projectRoot: project, harness: 'native', permissionMode: 'ask' }, harnessRef: {}, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 } };
  await sessions.upsert(source);
  await sessions.appendTranscript(source.id, { id: 'source-message', kind: 'user', ts: 1, text: 'Keep the source checkout unchanged.' });
  return { userData, project, sessions, source };
}

async function launch(userData: string): Promise<Page> {
  const packaged = process.env.HARNESS_E2E_EXE;
  app = await electron.launch({ executablePath: packaged || (require('electron') as string), args: packaged ? [] : [path.join(root, 'out', 'main', 'index.js')], env: isolatedEnv(userData), timeout: 60_000 });
  app.process().stderr?.on('data', (data: Buffer) => mainLog.push(data.toString()));
  app.process().stdout?.on('data', (data: Buffer) => mainLog.push(data.toString()));
  win = await app.firstWindow();
  win.on('console', (message) => rendererLog.push(`[${message.type()}] ${message.text()}`));
  win.on('pageerror', (error) => rendererLog.push(`[pageerror] ${error.message}`));
  await win.waitForSelector('.brand', { timeout: 60_000 });
  await expectQuietWindow(app);
  return win;
}

const seedWorkspace = (w: MissionWorkspace, ownerSessionId?: string): MissionRecord['workspaces'][number] => ({ id: w.id, role: w.role as 'lead' | 'worker' | 'integration', path: w.cwd, branch: w.branch, base: w.baseRevision, ...(ownerSessionId ? { ownerSessionId } : {}) });

async function seedMission(userData: string, project: string, sessions: SessionStore, source: SessionMeta, deliveryPolicy?: MissionRecord['deliveryPolicy']) {
  // No app process/writer exists yet. This lease is fixture setup, not a replacement for the
  // production quiescence or verification ports used by Electron after bootstrap.
  const workspaces = new MissionWorkspaces({ root: path.join(userData, 'mission-workspaces'), quiescence: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) } });
  const probe = await workspaces.probeBaseline(project);
  if (!probe.ok) throw new Error(probe.message);
  const baseline = probe.baseline;
  const integration = await workspaces.provision({ missionId: 'mission', baseline, role: 'integration' });
  const lead = await workspaces.provision({ missionId: 'mission', baseline, role: 'lead' });
  const worker = await workspaces.provision({ missionId: 'mission', baseline, role: 'worker', attemptId: 'attempt-one' });
  await fs.writeFile(path.join(lead.cwd, 'result.txt'), 'lead unaccepted edit\n');
  await fs.writeFile(path.join(worker.cwd, 'result.txt'), 'specialist unaccepted edit\n');
  const candidate = await workspaces.captureCandidate(worker.id, 'attempt-one');
  const profile: MissionProfile = { id: 'specialist', revision: 1, name: 'Seeded investigator', purpose: 'UI inspection fixture', instructions: 'Historical fixture, not a live provider run.', tierId: 5, contextRefs: [], requestedTools: [], sourceAccess: 'read_only', resultExpectations: 'Report the finding to the lead.' };
  const criterion = { id: 'criterion-one', description: 'Preserve the source checkout', required: true, evidenceKinds: ['behavior' as const] };
  const fixture = missionFixture({ projectRoot: project, sourceCwd: project, originSessionId: source.id, sourceCutoffId: 'source-message', title: 'Seeded Mission', objective: 'Inspect the seeded Mission flow', requestedPermissionMode: source.config.permissionMode, status: 'awaiting_execution_approval', planRevision: 1, baseline: baseline.revision, acceptedRevision: baseline.revision,
    ...(deliveryPolicy ? { deliveryPolicy } : {}),
    pendingProposal: { id: 'proposal-one', planRevision: 1, specificationRevision: 1, assistantMessageId: 'proposal-message', requestedAt: 2 },
    profiles: [profile], workspaces: [seedWorkspace(integration), seedWorkspace(lead, 'lead'), seedWorkspace(worker, 'worker')],
    operations: [{ id: 'baseline-operation', idempotencyKey: 'baseline-operation', kind: 'dispatch', expectedRevision: 0, actor: 'fixture', state: 'succeeded', payload: { infrastructure: 'baseline', baseline, leadWorkspaceId: lead.id, integrationWorkspaceId: integration.id, leadSessionId: 'lead' } }],
    candidates: [{ id: candidate.id, attemptId: 'attempt-one', taskId: 'task-one', taskRevision: 1, specificationRevision: 1, sourceRevision: baseline.revision, revision: candidate.revision, changedPaths: [...candidate.changedPaths], capturedAt: Date.parse(candidate.createdAt) }],
    tasks: [{ id: 'task-one', revision: 1, specificationRevision: 1, objective: 'Inspect a bounded area', scope: 'UI fixture only', ownedPaths: ['result.txt'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: [], criteria: [criterion], verificationIds: [], assignment: { kind: 'worker', profileId: profile.id, profileRevision: 1 }, required: true, status: 'candidate_ready', currentAttemptId: 'attempt-one' }]
  });
  // This UI-only historical fixture never started a provider process. Use the supported
  // ownership shape and retain that true pre-launch fact, not fabricated process teardown.
  fixture.leadPreset.harnessId = 'pi';
  fixture.config.presets[0].harnessId = 'pi';
  const settings = new SettingsStore(userData); await settings.load();
  await settings.update({ mission: fixture.config });
  fixture.plan = { ...fixture.plan, scope: 'A seeded plan awaiting explicit approval.', criteria: [criterion] };
  fixture.attempts = [{ id: 'attempt-one', taskId: 'task-one', taskRevision: 1, specificationRevision: 1, generation: 1, sessionId: 'worker', profile, tierId: 5, preset: fixture.leadPreset, selectionReason: 'Explicit fixture selection', sourceRevision: baseline.revision, workspaceId: worker.id, continuationOwner: 'mission', status: 'terminal', outcome: 'submitted', terminalTurnId: 'worker-turn', repairTurns: 0, requestedAt: 1, endedAt: 2, result: { taskId: 'task-one', taskRevision: 1, attemptId: 'attempt-one', specificationRevision: 1, status: 'candidate', summary: 'Seeded candidate; not integrated or verified.', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } }];
  const store = new MissionStore<MissionRecord>(userData, { validate: assertMissionRecord });
  await store.create(fixture, { idempotencyKey: 'ui-fixture', expectedRevision: 0, actor: 'fixture', kind: 'fixture.seed' });
  const meta = (id: 'lead' | 'worker', cwd: string, title: string): SessionMeta => ({ ...source, id, title, createdAt: 2, updatedAt: 2, cwd, config: { ...source.config, harness: fixture.leadPreset.harnessId, model: fixture.leadPreset.model }, mission: { missionId: fixture.id, role: id, generation: 1, ...(id === 'worker' ? { attemptId: 'attempt-one' } : {}), sourceAccess: 'read_only', requestedTools: [], reasoningDefault: true } });
  await sessions.upsert(meta('lead', lead.cwd, fixture.title));
  await sessions.upsert(meta('worker', worker.cwd, 'Worker should not be a session row'));
  const leadItems: TranscriptItem[] = [{ id: 'proposal-message', kind: 'assistant', ts: 2, text: 'Proceed with execution? Inspect `result.txt` in my tool workspace.' }];
  for (const item of leadItems) await sessions.appendTranscript('lead', item);
  await sessions.appendTranscript('worker', { id: 'worker-finding', kind: 'assistant', ts: 2, text: 'MissionSearchNeedle: a seeded specialist finding.' });
  for (const sessionId of ['lead', 'worker']) {
    const intent = await createManagedPiOwnershipIntent(sessions.sessionDir(sessionId), { sessionId, missionId: fixture.id, generation: 1 });
    await recordUnlaunchedManagedPiIntent(intent);
  }
  const sourceBytes = await fs.readFile(path.join(project, 'result.txt'));
  return { lead, worker, integration, sourceBytes };
}

async function persisted(userData: string, id = 'mission'): Promise<MissionRecord> {
  // Read-only observation of the committed journal; the running app remains its sole writer.
  const journal = await fs.readFile(path.join(userData, 'missions', id, 'journal.jsonl'), 'utf8');
  const complete = journal.slice(0, journal.lastIndexOf('\n')).split('\n');
  return (JSON.parse(complete.at(-1)!) as { payload: MissionRecord }).payload;
}

describe.runIf(enabled)('electron e2e: Mission session flow (no live provider)', () => {
  it('submits a genuine completed-conversation question without reopening execution or inventing an answer when the exact model is unavailable', async () => {
    const { userData, project, sessions, source } = await setup(true);
    const record = completedMissionFixture(project);
    record.title = 'Completed question fixture';
    const settings = new SettingsStore(userData); await settings.load();
    await settings.update({ mission: record.config, mcpDisabledBuiltins: ['gitnexus', 'vocs-memory', 'cua-driver'] });
    const store = new MissionStore<MissionRecord>(userData, { validate: assertMissionRecord });
    await store.create(record, { idempotencyKey: 'completed-question-ui', expectedRevision: 0, actor: 'fixture', kind: 'fixture.seed' });
    for (const id of ['lead', 'worker'] as const) {
      await sessions.upsert({ ...source, id, title: id === 'lead' ? record.title : 'Retained question fixture worker', config: { ...source.config, harness: 'pi', model: record.leadPreset.model },
        mission: { missionId: record.id, role: id, generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: true, ...(id === 'worker' ? { attemptId: 'retained-attempt' } : {}) } });
      const intent = await createManagedPiOwnershipIntent(sessions.sessionDir(id), { sessionId: id, missionId: record.id, generation: 1 }); await recordUnlaunchedManagedPiIntent(intent);
    }
    await sessions.appendTranscript('lead', { id: 'completed-history', kind: 'assistant', ts: 1, text: 'Retained original conversation.' });
    const win = await launch(userData);
    await win.getByTestId('session-row').filter({ hasText: record.title }).click();
    await win.getByTestId('mission-question-scope').waitFor();
    const report = win.locator('.transcript').getByTestId('mission-completion-report'); await report.waitFor();
    const reportBefore = await report.innerText(), before = await persisted(userData);
    await win.getByPlaceholder('Ask about the completed Mission… (read-only answer)').fill('Which checks ran and what remains unknown?');
    await win.getByRole('button', { name: 'Ask lead', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).operations.filter((op) => op.payload.questionId).length).toBe(1);
    // This preset deliberately has no installed model. Startup may probe a runtime, but the
    // host readiness boundary must reject it before any billable model prompt.
    await expect.poll(async () => (await persisted(userData)).operations.find((op) => op.payload.questionId)?.state, { timeout: 60_000 }).toBe('failed');
    const after = await persisted(userData), answer = after.operations.find((op) => op.payload.questionId)!;
    expect(answer.payload.dispatchStartedAt).toBeUndefined(); expect(answer.payload.answerMessageIds).toEqual([]);
    expect(after.mailbox.at(-1)).toMatchObject({ kind: 'user', text: 'Which checks ran and what remains unknown?', userAction: { kind: 'question' } });
    for (const field of ['status', 'phase', 'completionReport', 'progress', 'plan', 'tasks', 'evidence', 'delivery', 'acceptedRevision', 'config', 'specificationRevision', 'planRevision'] as const) expect(after[field]).toEqual(before[field]);
    expect(await report.innerText()).toBe(reportBefore); expect(git(project, ['status', '--porcelain=v1'])).toBe('');
    expect(await win.getByTestId('session-row').count()).toBe(2); // source + same lead, never a Q&A Mission
    await app!.close(); app = null;
    const rebooted = await launch(userData); await rebooted.getByTestId('session-row').filter({ hasText: record.title }).click();
    await rebooted.getByTestId('mission-question-scope').waitFor();
    const restored = await persisted(userData);
    expect(restored.operations.filter((op) => op.payload.questionId)).toHaveLength(1); expect(restored.status).toBe('completed'); expect(restored.completionReport).toEqual(before.completionReport);
    expect(await rebooted.locator('.transcript').getByTestId('mission-completion-report').innerText()).toBe(reportBefore);
  }, 120_000);

  it('shows the host completion answer without model prose, keeps actual local identity in the panel, and survives app restart', async () => {
    const { userData, project, sessions, source } = await setup(true);
    // Historical task/turn fixture only. Its count-bearing check and local delivery below are
    // real, not a model claim, live-provider demonstration or manually invented commit ID.
    const workspaces = new MissionWorkspaces({ root: path.join(userData, 'mission-workspaces'), quiescence: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) } });
    const probe = await workspaces.probeBaseline(project); if (!probe.ok) throw new Error(probe.message);
    const baseline = probe.baseline, revision = baseline.revision;
    const integration = await workspaces.provision({ missionId: 'mission', baseline, role: 'integration' });
    const lead = await workspaces.provision({ missionId: 'mission', baseline, role: 'lead' });
    const record = missionFixture({ projectRoot: project, sourceCwd: project, originSessionId: source.id, title: 'Completed report fixture', objective: 'Retain the checked source baseline', entryMode: 'autonomous', phase: 'delivering', status: 'running', baseline: revision, acceptedRevision: revision, planRevision: 1,
      executionAuthorization: { kind: 'autonomous_launch', sourceUserActionId: 'user-launch', specificationRevision: 1, recordedAt: 1 }, workspaces: [seedWorkspace(integration), seedWorkspace(lead, 'lead')] });
    record.leadPreset.harnessId = 'pi'; record.config.presets[0].harnessId = 'pi';
    const checkScript = "require('node:test')('seeded baseline check',()=>require('node:assert').strictEqual(require('node:fs').readFileSync('result.txt','utf8'),'source baseline\\n'))";
    const check = { id: 'baseline-check', name: 'Baseline content test', kind: 'test' as const, command: `node -e "${checkScript}"`, criterionIds: ['baseline'], required: true, heavy: false, timeoutMs: 10_000, testReport: { format: 'node-tap' as const, minimumTests: 1, maximumSkipped: 0 } };
    record.deliveryPolicy = { ...record.deliveryPolicy, requireIndependentReview: false, checks: [check] };
    record.plan.criteria = [{ id: 'baseline', description: 'The baseline remains intact', required: true, evidenceKinds: ['test'] }];
    record.tasks = [{ id: 'inspect', revision: 1, specificationRevision: 1, objective: 'Inspect the unchanged baseline', scope: 'result.txt', ownedPaths: ['result.txt'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: ['read'], criteria: [], verificationIds: [check.id], assignment: { kind: 'lead' }, status: 'accepted', currentAttemptId: 'inspected', required: true }];
    record.attempts = [{ id: 'inspected', taskId: 'inspect', taskRevision: 1, specificationRevision: 1, generation: 1, sessionId: 'lead', tierId: 5, preset: record.leadPreset, selectionReason: 'UI historical fixture', sourceRevision: revision, workspaceId: lead.id, continuationOwner: 'mission', status: 'terminal', outcome: 'submitted', terminalTurnId: 'seeded-turn', repairTurns: 0, requestedAt: 1, endedAt: 2,
      result: { taskId: 'inspect', taskRevision: 1, attemptId: 'inspected', specificationRevision: 1, status: 'candidate', summary: 'Historical UI fixture; no source edits.', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } }];
    record.candidates = [{ id: 'unchanged', attemptId: 'inspected', taskId: 'inspect', taskRevision: 1, specificationRevision: 1, sourceRevision: revision, revision, changedPaths: [], capturedAt: 2 }];
    record.operations = [{ id: 'delivery', idempotencyKey: 'delivery', kind: 'deliver', expectedRevision: 0, actor: 'host', state: 'in_flight', payload: { commitMessage: 'test: retain verified baseline' } }];
    const store = new MissionStore<MissionRecord>(userData, { validate: assertMissionRecord });
    await store.create(record, { idempotencyKey: 'completion-ui-fixture', expectedRevision: 0, actor: 'fixture', kind: 'fixture.seed' });
    const result = spawnSync(process.execPath, ['-e', checkScript], { cwd: integration.cwd, windowsHide: true, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const counts = parseTestReport('node-tap', result.stdout); expect(counts).toEqual({ executed: 1, failed: 0, skipped: 0 });
    const artifactId = await store.writeArtifact(record.id, Buffer.from(result.stdout));
    let current = store.get(record.id)!;
    current = await store.transact(record.id, { idempotencyKey: 'actual-check', expectedRevision: current.revision, actor: 'host', kind: 'fixture.check' }, (state) => reduceMission(state, { kind: 'host' }, { kind: 'host.evidence.capture', evidence: {
      id: 'actual-check', criterionIds: ['baseline'], specificationRevision: 1, sourceRevision: revision, checkId: check.id, kind: 'test', commandOrFlow: check.command, cwd: integration.cwd, environmentRef: 'UI fixture host Node', provenance: 'host_executed', result: 'passed', exitCode: result.status!, executedTests: counts.executed, skippedTests: counts.skipped, artifactIds: [artifactId], startedAt: 3, endedAt: 4
    } }));
    const delivery = new MissionDeliveryService({ root: path.join(userData, 'mission-delivery'), contentIdentity: (cwd) => workspaces.contentIdentity(cwd), authorize: async () => undefined, isQuiescent: async () => true,
      implementationBlockers: (state) => implementationBlockers(state, { quiescent: true, deliveryOperationId: 'delivery' }) });
    const receipt = await delivery.deliver({ mission: current, operationId: 'delivery', commitMessage: 'test: retain verified baseline' });
    expect(receipt.commitSha).toBe(git(project, ['rev-parse', `${receipt.commitSha}^{commit}`]));
    const completed = await store.transact(record.id, { idempotencyKey: 'host-completion', expectedRevision: current.revision, actor: 'host', kind: 'fixture.complete' }, (state) => {
      state = reduceMission(state, { kind: 'host' }, { kind: 'host.delivery.record', delivery: receipt });
      state = reduceMission(state, { kind: 'host' }, { kind: 'host.operation.transition', operationId: 'delivery', expectedState: 'in_flight', state: 'succeeded' });
      return reduceMission(state, { kind: 'host' }, { kind: 'host.complete', quiescent: true });
    });
    expect(completed.completionReport?.narrative).toBeUndefined();
    await sessions.upsert({ ...source, id: 'lead', title: record.title, cwd: lead.cwd, config: { ...source.config, harness: 'pi' }, mission: { missionId: record.id, role: 'lead', generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: true } });
    await sessions.appendTranscript('lead', { id: 'finish-tool', kind: 'tool', ts: 3, name: 'mission_finish_request', input: { commitMessage: 'test: retain verified baseline' }, status: 'done' });
    await sessions.appendTranscript('lead', { id: 'seeded-turn', kind: 'turn', ts: 4, status: 'completed', durationMs: 1000 });
    const intent = await createManagedPiOwnershipIntent(sessions.sessionDir('lead'), { sessionId: 'lead', missionId: record.id, generation: 1 }); await recordUnlaunchedManagedPiIntent(intent);
    for (let boot = 0; boot < 2; boot++) {
      const win = await launch(userData);
      await win.getByTestId('session-row').filter({ hasText: record.title }).click();
      const answer = win.locator('.transcript').getByTestId('mission-completion-report'); await answer.waitFor();
      expect(await answer.innerText()).toContain(receipt.commitSha!);
      expect(await answer.innerText()).toContain('1 tests executed · 0 skipped');
      expect(await answer.evaluate((element) => !!element.closest('.work-group'))).toBe(false);
      expect(await win.locator('.work-head').getAttribute('aria-expanded')).toBe('false');
      await win.locator('.panel-top').getByRole('button', { name: 'Mission', exact: true }).click();
      expect(await win.getByTestId('mission-panel').getByTestId('mission-delivery-identity').innerText()).toContain(receipt.commitSha!);
      expect((await persisted(userData)).completionReport).toEqual(completed.completionReport);
      expect(git(project, ['status', '--porcelain=v1'])).toBe('');
      await app!.close(); app = null;
    }
  }, 180_000);
  it('exports the current structured plan through the panel and desktop chooser without granting workspace or plan authority', async () => {
    const { userData, project, sessions, source } = await setup(true);
    const work = await seedMission(userData, project, sessions, source, { ...missionFixture().deliveryPolicy,
      checks: [{ id: 'export-check', name: 'Source preservation', kind: 'test', command: 'node --test', criterionIds: ['criterion-one'], required: true, heavy: true, timeoutMs: 30_000, testReport: { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 } }],
      holdConditions: ['Human review remains required'] });
    const win = await launch(userData);
    await win.getByTestId('mission-header').waitFor();
    await win.locator('.panel-top').getByRole('button', { name: 'Mission', exact: true }).click();
    const panel = win.getByTestId('mission-panel');
    const button = panel.getByRole('button', { name: 'Export plan.md', exact: true });
    await button.waitFor();
    await expect.poll(async () => (await persisted(userData)).status).toBe('paused');
    await expect.poll(async () => (await persisted(userData)).operations.every((operation) => ['succeeded', 'failed'].includes(operation.state))).toBe(true);
    const before = await persisted(userData);
    const destination = path.join(tmp, 'plan.md');
    const ownedDestination = path.join(work.worker.cwd, 'result.txt');
    // Only the OS chooser result is scripted. UI → preload → registered handlers → real
    // DesktopBridge and filesystem remain intact; no Mission state or IPC response is mocked.
    await app!.evaluate(({ dialog }, choices) => {
      const observed = globalThis as typeof globalThis & { missionExportDialogs: Electron.SaveDialogOptions[] };
      observed.missionExportDialogs = [];
      dialog.showSaveDialog = async (...args: unknown[]) => {
        observed.missionExportDialogs.push(args.at(-1) as Electron.SaveDialogOptions);
        const choice = choices.shift();
        if (!choice) throw new Error('Unexpected additional Save As dialog');
        return choice;
      };
    }, [{ canceled: true, filePath: destination }, { canceled: false, filePath: destination }, { canceled: false, filePath: ownedDestination }, { canceled: false, filePath: destination }]);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await button.click();
    await panel.getByText('Plan export canceled.', { exact: true }).waitFor();
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await persisted(userData)).toEqual(before);
    await button.click();
    await panel.getByText('Plan exported. Editing it does not change the Mission.', { exact: true }).waitFor();
    const text = await fs.readFile(destination, 'utf8');
    expect(text).toBe(missionPlanMarkdown(before));
    for (const expected of ['Specification 1 · Plan 1', 'A seeded plan awaiting explicit approval', 'Seeded investigator', '## Tasks and dependencies', '## Checks', 'Source preservation', 'Minimum executed tests: 1', 'Maximum skipped tests: 0', 'Human review remains required', 'Independent review required: yes']) expect(text).toContain(expected);
    await button.click();
    await panel.getByRole('alert').filter({ hasText: 'Mission owns this session/workspace' }).waitFor();
    expect(await fs.readFile(ownedDestination, 'utf8')).toBe('specialist unaccepted edit\n');
    expect(await panel.getByText('Plan exported. Editing it does not change the Mission.', { exact: true }).count()).toBe(0);
    await fs.writeFile(destination, '# Forged plan approval');
    await button.click();
    await panel.getByText('Plan exported. Editing it does not change the Mission.', { exact: true }).waitFor();
    expect(await fs.readFile(destination, 'utf8')).toBe(text);
    const dialogs = await app!.evaluate(() => (globalThis as typeof globalThis & { missionExportDialogs: Electron.SaveDialogOptions[] }).missionExportDialogs);
    expect(dialogs).toHaveLength(4);
    for (const options of dialogs) { expect(path.basename(options.defaultPath!)).toBe('plan.md'); expect(options.filters).toEqual([{ name: 'Markdown', extensions: ['md'] }]); }
    expect(await persisted(userData)).toEqual(before);
    expect(before.executionAuthorization).toBeUndefined();
    expect(await fs.readFile(path.join(project, 'result.txt'))).toEqual(work.sourceBytes);
    expect(await fs.readFile(path.join(work.lead.cwd, 'result.txt'), 'utf8')).toBe('lead unaccepted edit\n');
    for (const cwd of [project, work.lead.cwd, work.worker.cwd, work.integration.cwd]) await expect(fs.stat(path.join(cwd, 'plan.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
  }, 120_000);

  it('offers Mission creation, blocks missing T5 configuration, and preserves normal session controls', async () => {
    const { userData, project, source } = await setup();
    const win = await launch(userData);
    await openNewSession(win);
    expect(await win.getByRole('button', { name: 'Normal session', exact: true }).getAttribute('aria-pressed')).toBe('true');
    await win.getByRole('button', { name: 'Mission', exact: true }).click();
    await win.getByLabel('Mission mode', { exact: true }).selectOption('interactive_plan');
    await win.getByLabel('Mission objective', { exact: true }).fill('Plan a bounded change');
    expect(await win.getByRole('button', { name: 'Start Mission', exact: true }).isDisabled()).toBe(true);
    await win.getByRole('alert').filter({ hasText: 'No lower-tier fallback' }).waitFor();
    await win.getByRole('button', { name: 'Cancel', exact: true }).click();
    await win.locator('.composer textarea').fill('/mission plan Plan a bounded change');
    await win.locator('.composer textarea').press('Enter');
    await win.getByRole('alert').filter({ hasText: /Configure an enabled T5/ }).waitFor();
    expect(await win.getByTestId('session-row').count()).toBe(1);
    expect(await win.locator('.composer textarea').inputValue()).toBe('/mission plan Plan a bounded change');
    expect(await win.getByTestId('session-title').innerText()).toBe(source.title);
    await win.getByRole('button', { name: 'Goal', exact: true }).click();
    expect(await win.getByRole('button', { name: 'Set goal', exact: true }).count()).toBe(1);
    expect(await win.getByTestId('panel-bottom-subagents').count()).toBe(1);
    const diskSessions: SessionMeta[] = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8'));
    expect(diskSessions).toHaveLength(1);
    expect(diskSessions[0].config).toEqual(source.config);
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
  }, 120_000);

  it('creates a linked Plan together Mission and reports unavailable execution without changing the source', async () => {
    const { userData, project, source } = await setup(true);
    const win = await launch(userData);
    await win.locator('.composer textarea').fill('/mission');
    await win.locator('.composer textarea').press('Enter');
    await win.getByLabel('Mission mode', { exact: true }).selectOption('interactive_plan');
    await win.getByLabel('Mission objective', { exact: true }).fill('Plan the linked change');
    await win.getByRole('button', { name: 'Start Mission', exact: true }).click();
    await win.getByTestId('mission-header').waitFor();
    await expect.poll(() => win.getByTestId('session-title').innerText()).toBe('Plan the linked change');
    const ids = await fs.readdir(path.join(userData, 'missions'));
    expect(ids).toHaveLength(1);
    await expect.poll(async () => (await persisted(userData, ids[0])).status, { timeout: 30_000 }).toBe('blocked');
    const mission = await persisted(userData, ids[0]);
    expect(mission).toMatchObject({ originSessionId: source.id, sourceCutoffId: 'source-message', entryMode: 'interactive_plan', requestedPermissionMode: 'ask' });
    expect(mission.sourceSnapshotId).toBeTruthy();
    expect(mission.executionAuthorization).toBeUndefined();
    expect(mission.evidence).toEqual([]);
    expect(mission.delivery).toBeUndefined();
    expect(mission.blockers.some((b) => !b.resolvedAt)).toBe(true);
    expect(await win.getByTestId('session-row').count()).toBe(2);
    await win.getByRole('button', { name: 'Source discussion: Original discussion', exact: true }).click();
    await expect.poll(() => win.getByTestId('session-title').innerText()).toBe(source.title);
    expect(await win.getByRole('button', { name: 'Mission: Plan the linked change', exact: true }).count()).toBe(1);
    const diskSessions: SessionMeta[] = JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8'));
    expect(diskSessions.find((s) => s.id === source.id)?.config).toEqual(source.config);
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
    expect(await fs.readFile(path.join(project, 'result.txt'), 'utf8')).toBe('source baseline\n');
  }, 120_000);

  it('keeps bare-command image drafts visible, then retains the exact attachments when an objective is submitted', async () => {
    const { userData, project, source } = await setup(true);
    const win = await launch(userData);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVSUAAAAASUVORK5CYII=', 'base64');
    await win.locator('.composer input[type=file]').setInputFiles({ name: 'new-context.png', mimeType: 'image/png', buffer: bytes });
    await win.getByAltText('new-context.png', { exact: true }).waitFor();
    await win.locator('.composer textarea').fill('/mission');
    await win.locator('.composer textarea').press('Enter');
    await win.getByRole('alert').filter({ hasText: 'cannot take images' }).waitFor();
    expect(await win.locator('.composer textarea').inputValue()).toBe('/mission');
    expect(await win.getByAltText('new-context.png', { exact: true }).count()).toBe(1);
    expect(await win.getByLabel('Mission objective', { exact: true }).count()).toBe(0);
    const command = '/mission plan Implement this visual requirement';
    await win.locator('.composer textarea').fill(command);
    await win.locator('.composer textarea').press('Enter');
    await win.getByTestId('mission-header').waitFor();
    const ids = await fs.readdir(path.join(userData, 'missions'));
    expect(ids).toHaveLength(1);
    const mission = await persisted(userData, ids[0]);
    expect(mission).toMatchObject({ originSessionId: source.id, sourceCutoffId: 'source-message', entryMode: 'interactive_plan' });
    const retained = JSON.parse(await fs.readFile(path.join(userData, 'missions', mission.id, 'source', mission.sourceSnapshotId!), 'utf8'));
    expect(retained).toMatchObject({ originSessionId: source.id, cutoffId: 'source-message', submittedCommand: command, images: [{ mimeType: 'image/png', data: bytes.toString('base64'), name: 'new-context.png' }] });
    expect(retained.items).toEqual([{ id: 'source-message', kind: 'user', ts: 1, text: 'Keep the source checkout unchanged.' }]);
    expect((await fs.readFile(path.join(userData, 'missions', mission.id, 'journal.jsonl'), 'utf8')).includes(bytes.toString('base64'))).toBe(false);
    expect(mission.executionAuthorization).toBeUndefined();
    await win.getByRole('button', { name: 'Source discussion: Original discussion', exact: true }).click();
    expect(await win.locator('.composer textarea').inputValue()).toBe('');
    expect(await win.getByAltText('new-context.png', { exact: true }).count()).toBe(0);
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
    expect(await fs.readFile(path.join(project, 'result.txt'), 'utf8')).toBe('source baseline\n');
  }, 120_000);

  it('reduces publication only through explicit Delivery controls and retains the user ceiling across real Electron restarts', async () => {
    const { userData, project, sessions, source } = await setup(true);
    const deliveryPolicy: MissionRecord['deliveryPolicy'] = { ...missionFixture().deliveryPolicy, endpoint: 'merge_pr', targetBranch: 'develop', remote: 'origin', targetHead: git(project, ['rev-parse', 'HEAD']), allowPush: true, allowMerge: true, fallback: false, holdConditions: ['Human review remains required'], holdIsEndpoint: true };
    await seedMission(userData, project, sessions, source, deliveryPolicy);
    let win = await launch(userData);
    await win.getByTestId('mission-header').waitFor();
    await win.locator('.panel-top').getByRole('button', { name: 'Mission', exact: true }).click();
    await win.getByTestId('mission-panel').getByRole('button', { name: 'Open PR only', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).publicationRestrictions?.length).toBe(1);
    const first = (await persisted(userData)).publicationRestrictions![0];
    expect(first).toMatchObject({ previousEndpoint: 'merge_pr', endpoint: 'open_pr', priorRemoteOperationIds: [] });
    expect((await persisted(userData)).deliveryPolicy).toMatchObject({ endpoint: 'open_pr', allowPush: true, allowMerge: false, requireIndependentReview: true, holdConditions: deliveryPolicy.holdConditions });
    await app!.close(); app = null;
    win = await launch(userData);
    await win.getByTestId('session-row').filter({ hasText: 'Seeded Mission' }).click();
    await win.locator('.panel-top').getByRole('button', { name: 'Mission', exact: true }).click();
    await win.getByTestId('mission-panel').getByText(/User publication limit: open pr/).waitFor();
    expect(await win.getByRole('button', { name: 'Open PR only', exact: true }).count()).toBe(0);
    await win.getByRole('button', { name: 'Keep Mission local', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).publicationRestrictions?.length).toBe(2);
    const restricted = await persisted(userData);
    expect(restricted.publicationRestrictions![0]).toEqual(first);
    expect(restricted.deliveryPolicy).toMatchObject({ endpoint: 'local_commit', allowPush: false, allowMerge: false, requireIndependentReview: true, holdConditions: deliveryPolicy.holdConditions });
    expect(restricted.delivery).toBeUndefined();
    await app!.close(); app = null;
    win = await launch(userData);
    await win.getByTestId('session-row').filter({ hasText: 'Seeded Mission' }).click();
    await win.locator('.panel-top').getByRole('button', { name: 'Mission', exact: true }).click();
    await win.getByTestId('mission-panel').getByText(/User publication limit: local commit/).waitFor();
    expect(await win.getByRole('button', { name: /Keep Mission local|Open PR only/ }).count()).toBe(0);
    await win.getByTestId('mission-panel').getByText('Human review remains required', { exact: true }).waitFor();
    expect((await persisted(userData)).publicationRestrictions).toEqual(restricted.publicationRestrictions);
    expect(git(project, ['branch', '--list', '*delivery*'])).toBe('');
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
  }, 180_000);

  it('recovers a seeded plan, gates Proceed, inspects workers/workspaces through the lead and retains the whole Mission on archive/restart', async () => {
    const { userData, project, sessions, source } = await setup(true);
    const work = await seedMission(userData, project, sessions, source);
    let win = await launch(userData);
    await win.getByTestId('mission-header').waitFor();
    expect(await win.getByTestId('session-row').count()).toBe(2);
    expect(await win.getByTestId('session-row').filter({ hasText: 'Worker should not' }).count()).toBe(0);
    await win.locator('.panel-top').getByRole('button', { name: 'Mission', exact: true }).click();
    const panel = win.getByTestId('mission-panel');
    await panel.waitFor();
    expect((await persisted(userData)).status).toBe('paused');
    expect((await persisted(userData)).executionAuthorization).toBeUndefined();
    expect(await panel.getByRole('button', { name: 'Proceed', exact: true }).isDisabled()).toBe(true);
    await panel.getByText(/Billing coverage: partial/).waitFor();
    await panel.getByText('No verification evidence recorded. Not verified.', { exact: true }).waitFor();
    await win.getByRole('button', { name: 'Resume Mission', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).status).toBe('awaiting_execution_approval');
    await expect.poll(() => panel.getByRole('button', { name: 'Proceed', exact: true }).isEnabled()).toBe(true);
    expect((await persisted(userData)).executionAuthorization).toBeUndefined();

    await win.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await win.getByPlaceholder('Search titles, goals and full transcripts…').fill('MissionSearchNeedle');
    await win.getByRole('button', { name: /MissionSearchNeedle/ }).click();
    const inspector = win.getByTestId('mission-inspector');
    await inspector.getByText('MissionSearchNeedle: a seeded specialist finding.', { exact: true }).waitFor();
    expect(await win.getByTestId('session-title').innerText()).toBe('Seeded Mission');
    expect(await inspector.locator('textarea, input').count()).toBe(0);
    expect(await inspector.getByRole('button', { name: /steer|retry|publish/i }).count()).toBe(0);
    await inspector.getByRole('button', { name: 'Ask lead about this', exact: true }).click();
    await expect.poll(() => win.locator('.composer textarea').inputValue()).toContain('task task-one, attempt attempt-one');
    await win.locator('.composer textarea').fill('');
    await inspector.getByRole('button', { name: 'Result', exact: true }).click();
    await inspector.getByText('Seeded candidate; not integrated or verified.', { exact: true }).waitFor();
    await inspector.getByRole('button', { name: 'Unaccepted workspace diff', exact: true }).click();
    await inspector.getByText(/specialist unaccepted edit/).waitFor();

    await win.getByRole('button', { name: 'Mission result', exact: true }).click();
    expect(await win.getByLabel('Mission workspace', { exact: true }).inputValue()).toBe('');
    expect(await win.getByTestId('mission-changes').getByText(/specialist unaccepted edit/).count()).toBe(0);
    expect(await win.getByRole('button', { name: 'Commit all', exact: true }).count()).toBe(0);
    expect(await win.getByTestId('panel-bottom-subagents').count()).toBe(0);
    await win.getByLabel('Mission workspace', { exact: true }).selectOption(work.worker.id);
    await win.getByTestId('mission-changes').getByText(/specialist unaccepted edit/).waitFor();
    await win.locator('.transcript .file-ref').click();
    await expect.poll(() => win.getByLabel('Mission workspace', { exact: true }).inputValue()).toBe(work.lead.id);
    await expect.poll(() => win.locator('.file-preview pre').innerText()).toBe('lead unaccepted edit\n');
    await win.getByRole('button', { name: 'Mission result', exact: true }).click();
    expect(await win.getByLabel('Mission workspace', { exact: true }).inputValue()).toBe('');
    await win.getByRole('button', { name: 'Source discussion: Original discussion', exact: true }).click();
    await win.getByRole('button', { name: 'Mission: Seeded Mission', exact: true }).click();

    // This is a real authorization transition, not evidence of a successful model run. The
    // fixture provider does not exist, so actual dispatch must block rather than claim completion.
    await panel.getByRole('button', { name: 'Proceed', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).executionAuthorization?.kind).toBe('approved_plan');
    await expect.poll(async () => (await persisted(userData)).status, { timeout: 30_000 }).toBe('blocked');
    const blocked = await persisted(userData);
    expect(blocked.executionAuthorization?.specificationRevision).toBe(1);
    expect(blocked.evidence).toEqual([]);
    expect(blocked.delivery).toBeUndefined();
    expect(blocked.blockers.some((b) => !b.resolvedAt)).toBe(true);
    await win.getByRole('button', { name: 'Pause Mission', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).status).toBe('paused');
    await expect.poll(async () => (await persisted(userData)).operations.every((operation) => ['succeeded', 'failed'].includes(operation.state))).toBe(true);
    const priorOperations = (await persisted(userData)).operations;
    await app!.close(); app = null;
    win = await launch(userData);
    await win.getByTestId('session-row').filter({ hasText: 'Seeded Mission' }).click();
    await win.getByTestId('mission-header').getByText('paused', { exact: true }).waitFor();
    await expect.poll(async () => (await persisted(userData)).operations.every((operation) => ['succeeded', 'failed'].includes(operation.state))).toBe(true);
    const recoveredOperations = (await persisted(userData)).operations;
    const withoutOwnershipObservation = (operation: MissionRecord['operations'][number]) => {
      const { externalQuiescenceReceipt: _receipt, ...payload } = operation.payload;
      return { ...operation, payload };
    };
    expect(recoveredOperations.filter((operation) => priorOperations.some((prior) => prior.id === operation.id)).map(withoutOwnershipObservation)).toEqual(priorOperations.map(withoutOwnershipObservation));
    const recoveredDispatch = recoveredOperations.find((operation) => operation.kind === 'dispatch' && operation.payload.sessionId === 'lead')!;
    expect(JSON.parse(String(recoveredDispatch.payload.externalQuiescenceReceipt))).toMatchObject({
      kind: 'bounded-process-ownership', admission: 'held', dispatches: [expect.objectContaining({ operationId: recoveredDispatch.id, sessionId: 'lead', harnessId: 'pi' })],
    });
    // Restart records one new ownership reconciliation, never another dispatch/check/delivery.
    expect(recoveredOperations.filter((operation) => !priorOperations.some((prior) => prior.id === operation.id))).toEqual([
      expect.objectContaining({ kind: 'interrupt', state: 'succeeded' }),
    ]);
    expect((await persisted(userData)).executionAuthorization?.kind).toBe('approved_plan');
    await win.locator('.header').getByRole('button', { name: 'Archive session', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).archived).toBe(true);
    await expect.poll(() => win.getByTestId('session-title').innerText()).toBe('Original discussion');
    await win.getByRole('button', { name: 'Archived', exact: true }).click();
    expect(await win.getByTestId('session-row').count()).toBe(1);
    await win.getByTestId('session-row').click();
    await win.getByText('Archived Mission — read-only. Restore the Mission before messaging the principal engineer.', { exact: true }).waitFor();
    expect(await win.locator('.composer textarea').count()).toBe(0);
    expect(await win.getByRole('button', { name: 'Resume Mission', exact: true }).isDisabled()).toBe(true);
    expect(await fs.readFile(path.join(project, 'result.txt'))).toEqual(work.sourceBytes);
    expect(await fs.readFile(path.join(work.worker.cwd, 'result.txt'), 'utf8')).toBe('specialist unaccepted edit\n');
    expect(await fs.readFile(path.join(work.lead.cwd, 'result.txt'), 'utf8')).toBe('lead unaccepted edit\n');
    await app!.close(); app = null;
    win = await launch(userData);
    await win.getByRole('button', { name: 'Archived', exact: true }).click();
    const archivedMission = win.getByTestId('session-row').filter({ hasText: 'Seeded Mission' });
    // Row actions are revealed by hover/selection, just as in the ordinary session sidebar.
    await archivedMission.hover();
    await archivedMission.getByRole('button', { name: 'Restore session', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).archived).toBe(false);
    await win.getByRole('button', { name: 'Show active', exact: true }).click();
    await win.getByTestId('session-row').filter({ hasText: 'Seeded Mission' }).click();
    await win.getByRole('button', { name: 'Stop Mission', exact: true }).click();
    await expect.poll(async () => (await persisted(userData)).status).toBe('stopped');
    expect((await persisted(userData)).operations.filter((o) => ['intent_recorded', 'in_flight', 'reconciling'].includes(o.state))).toEqual([]);
    expect(git(project, ['status', '--porcelain=v1'])).toBe('');
  }, 240_000);
});
