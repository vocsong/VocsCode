/** Opt-in LIVE Mission demonstrations (spec 22.5). No adapter, provider, capability, Git,
 * verification or model-tool mocks. The driver acts only as the user; models own the work.
 * Artifacts are deliberately retained outside the checkout on success AND failure.
 *
 * Metadata only (no model prompt): VOCS_CODE_MISSION_METADATA=1 npx vitest run ... -t metadata
 * Live: VOCS_CODE_MISSION_LIVE=1 VOCS_CODE_MISSION_LIVE_PROVIDER=<actual provider>
 *       VOCS_CODE_MISSION_LIVE_MODEL=<actual model> npx vitest run tests/mission-live.integration.test.ts
 * Paid runs require VOCS_CODE_MISSION_LIVE_ONLY=A|B|C (never implicitly run the other demos).
 * Optional ..._MAX_TOKENS, ..._MAX_BUDGET_USD, ..._DEADLINE_MS; ..._RUNTIME_DIR, ..._PI.
 * Missing requested runtime/auth/model fails. No offline fallback and no automatic retries.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { listPiModels } from '../src/main/harness/pi';
import { inspectManagedPiOwnership } from '../src/main/harness/pi-ownership';
import { MissionRuntime } from '../src/main/mission/runtime';
import { RuntimeResolver, runCapture } from '../src/main/runtime';
import { SessionManager, type SessionActivity } from '../src/main/session-manager';
import { SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import { TerminalManager } from '../src/main/terminal';
import { writeJson } from '../src/main/util/fs';
import { createDefaultMissionConfig, MISSION_LIMIT_MAXIMUMS, type ExecutionPreset } from '../src/shared/mission-config';
import type { MissionRecord, MissionSource, MissionUserControl } from '../src/shared/mission';
import type { ModelInfo, SessionEventEnvelope, SessionMeta, TranscriptItem, UsageTotals } from '../src/shared/types';

const live = process.env.VOCS_CODE_MISSION_LIVE === '1';
const metadata = process.env.VOCS_CODE_MISSION_METADATA === '1';
const childHost = process.env.VOCS_CODE_MISSION_LIVE_CHILD === '1';
const selected = process.env.VOCS_CODE_MISSION_LIVE_ONLY;
function validateSelection(value: string | undefined, paid: boolean): void {
  if (value !== undefined && !['A', 'B', 'C'].includes(value) || paid && value === undefined) throw new Error('VOCS_CODE_MISSION_LIVE_ONLY must explicitly select A, B or C for a paid run; no implicit multi-demo execution.');
}
const appRoot = path.resolve(__dirname, '..');
interface DriverBounds { maxTokens: number; maxBudgetUsd: number; deadlineMs: number; maxTurns: number; maxToolCalls: number }
const DEFAULT_BOUNDS: Readonly<DriverBounds> = { maxTokens: 2_000_000, maxBudgetUsd: 12, deadlineMs: 8 * 60_000, maxTurns: 36, maxToolCalls: 160 };
// Leave room for Vitest's cleanup allowance without overflowing Node's signed timer range.
const MAX_DEADLINE_MS = 2_147_483_647 - 120_000;
function driverBounds(env: NodeJS.ProcessEnv): DriverBounds {
  const positive = (key: string, fallback: number, maximum: number, integer = true): number => {
    if (env[key] === undefined) return fallback;
    const value = Number(env[key]);
    if (!env[key]!.trim() || !Number.isFinite(value) || value <= 0 || value > maximum || integer && !Number.isSafeInteger(value)) {
      throw new Error(`${key} must be a finite positive ${integer ? 'integer' : 'number'} no greater than ${maximum}.`);
    }
    return value;
  };
  return { ...DEFAULT_BOUNDS,
    maxTokens: positive('VOCS_CODE_MISSION_LIVE_MAX_TOKENS', DEFAULT_BOUNDS.maxTokens, MISSION_LIMIT_MAXIMUMS.maxTokens),
    maxBudgetUsd: positive('VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD', DEFAULT_BOUNDS.maxBudgetUsd, MISSION_LIMIT_MAXIMUMS.maxBudgetUsd, false),
    deadlineMs: positive('VOCS_CODE_MISSION_LIVE_DEADLINE_MS', DEFAULT_BOUNDS.deadlineMs, MAX_DEADLINE_MS),
  };
}
// These are stop-on-observation thresholds, NOT hard provider billing caps. Source discussion,
// cache reads and all Mission participants count; in-flight usage can lag and overshoot.
const bounds = driverBounds(process.env);
type DriverRun = { bounds: DriverBounds; startedAt: number; deadlineAt: number };
async function retainDriverRun(root: string, limits = bounds, now = Date.now()): Promise<DriverRun> {
  const file = path.join(root, 'driver-bounds.json');
  const previous = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (previous !== undefined) {
    const run = JSON.parse(previous) as DriverRun;
    expect(run.bounds, 'A restart cannot silently change the approved driver bounds').toEqual(limits);
    if (!Number.isSafeInteger(run.startedAt) || run.startedAt <= 0 || run.deadlineAt !== run.startedAt + limits.deadlineMs) throw new Error('Invalid retained driver deadline.');
    return run;
  }
  const run = { bounds: limits, startedAt: now, deadlineAt: now + limits.deadlineMs };
  await fs.writeFile(file, JSON.stringify(run, null, 2), { flag: 'wx' });
  return run;
}
function assertDriverDeadline(run: DriverRun, now = Date.now()): void {
  if (now >= run.deadlineAt) throw new Error(`Driver whole-demo deadline ${run.bounds.deadlineMs} ms reached (includes source discussion and any host restart).`);
}
function assertRecoveryIdentity(actualId: string | undefined, resumeId: string | undefined): void {
  if (resumeId && actualId !== resumeId) throw new Error('Recovery must reopen the exact retained Mission; refusing an automatic whole-Mission retry.');
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pending = (r: MissionRecord) => r.operations.filter((o) => !['succeeded', 'failed'].includes(o.state));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
let runRoot: string;
let catalog: ModelInfo[];
let preset: ExecutionPreset;
let runtimeVersion: string;
let runtimeBinary: string;

function resolver(settings: SettingsStore): RuntimeResolver {
  const installed = process.env.VOCS_CODE_MISSION_LIVE_RUNTIME_DIR
    ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'Vocs Code (Dev)', 'runtime') : path.join(os.homedir(), '.local'));
  return new RuntimeResolver({ appRoot, resourcesDir: path.join(appRoot, 'resources'), appRuntimeDir: installed }, () => settings.get());
}

async function preflight(): Promise<void> {
  validateSelection(selected, live);
  runRoot = process.env.VOCS_CODE_MISSION_LIVE_ROOT ?? await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-live-'));
  await fs.mkdir(runRoot, { recursive: true });
  const metadataFile = path.join(runRoot, childHost ? `metadata-host-${process.pid}.json` : 'metadata.json');
  if (existsSync(metadataFile)) throw new Error('This artifact root already has metadata; use a fresh root, never overwrite a historical run.');
  const settings = new SettingsStore(path.join(runRoot, 'metadata')); await settings.load();
  if (process.env.VOCS_CODE_MISSION_LIVE_PI) await settings.update({ binaries: { ...settings.get().binaries, pi: process.env.VOCS_CODE_MISSION_LIVE_PI } });
  const runtime = resolver(settings);
  const bin = runtime.resolve('pi');
  if (!bin) throw new Error('Requested live Mission runtime Pi is unavailable. Configure VOCS_CODE_MISSION_LIVE_PI or RUNTIME_DIR.');
  runtimeBinary = bin.path;
  const version = await runCapture(bin.path, ['--version'], { timeoutMs: 20_000 });
  if (version.code !== 0 || version.timedOut) throw new Error('Installed Pi version probe failed.');
  runtimeVersion = version.stdout.trim();
  // This production helper asks get_available_models; it neither prompts nor opens/copies auth.
  catalog = await listPiModels(bin.path);
  const provider = process.env.VOCS_CODE_MISSION_LIVE_PROVIDER ?? process.env.PI_PROVIDER;
  const model = process.env.VOCS_CODE_MISSION_LIVE_MODEL ?? process.env.PI_MODEL;
  await fs.writeFile(metadataFile, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, arch: process.arch,
    release: os.release(), node: process.version, runtime: { binary: bin.path, source: bin.source, version: runtimeVersion },
    requested: { provider, model }, bounds, boundsScope: 'Per demonstration: ordinary source discussion plus all Mission participants and restarts; observed thresholds, not billing guarantees.',
    availableModels: catalog.filter((m) => m.provider === provider).map(({ provider, id, displayName, supportedEfforts }) => ({ provider, id, displayName, supportedEfforts })),
  }, null, 2), { flag: 'wx' });
  console.log(`Mission live artifacts: ${runRoot}`);
  console.log(JSON.stringify({ runtimeVersion, platform: process.platform, requested: { provider, model }, bounds, availableModels: catalog.filter((m) => m.provider === provider).map((m) => `${m.provider}/${m.id}`) }));
  if (!provider || !model || !catalog.some((m) => m.provider === provider && m.id === model)) throw new Error('Explicit selected provider/model is absent from the real Pi available-model response; no aliases or fallback are permitted.');
  preset = { id: 'live-principal', revision: 1, name: `Live T5 · ${provider}/${model}`, enabled: true, harnessId: 'pi',
    model: { provider, model, connectionId: provider }, reasoning: { kind: 'default' }, guidance: 'Explicit user-selected model on the existing Pi provider connection. Default reasoning is observed, not inferred from tier.' };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }).trim();
}

async function snapshotSource(cwd: string) {
  const hash = createHash('sha256');
  const visit = async (dir: string): Promise<void> => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (dir === cwd && entry.name === '.git') continue;
      const file = path.join(dir, entry.name); hash.update(path.relative(cwd, file));
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) hash.update(await fs.readFile(file));
      else throw new Error('Unexpected non-regular source entry in isolated live fixture.');
    }
  };
  await visit(cwd);
  return { head: git(cwd, 'rev-parse', 'HEAD'), index: git(cwd, 'ls-files', '--stage'), status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'), treeSha256: hash.digest('hex') };
}

const protocolBrief = `Use only Mission-owned coordination, implementation, review, checks and delivery. Read actual tool payload schemas; do not invent fields or IDs. Mutations require the latest revision and a new idempotency key (retry only a genuinely stale revision, never silently repeat effects). Claims, delegations, verification, integration and finish requests QUEUE work: call mission_yield and END THE TURN so the host can switch runtimes or run the operation. Never poll repeatedly. After claiming, wait for the writable assigned-task continuation. Submit mission_report before ending an assigned task. Let the host capture a candidate, then request its check, create an independent read-only reviewer scoped to its candidateId, accept, and integrate. Candidate review workers should call mission_review_submit AND mission_report before ending. Final checks must bind the accepted combined revision. Do not print GOAL_COMPLETE as evidence. No shell testing or Git delivery; use the host services. No dependencies, network, publication, credentials inspection, or global configuration changes.`;

async function fixture(root: string, demo: 'A' | 'B' | 'C'): Promise<string> {
  const project = path.join(root, 'project'); await fs.mkdir(path.join(project, '.vocs-code'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: `mission-live-${demo.toLowerCase()}`, private: true, scripts: { test: 'node --test --test-reporter=tap *.test.cjs' } }, null, 2));
  await fs.writeFile(path.join(project, 'AGENTS.md'), `# Disposable live Mission project\nUse dependency-free Node.js CommonJS and node:test. Implement only the requested behavior.\nBefore a Mission exists, an ordinary plan-mode source session only reads and discusses; no implementation, commands or Mission tools. The following execution protocol applies after Mission creation.\nDelivery is a verified local commit through Mission; never push, publish, open PRs, or merge.\nAll implementation gets independent review and counted TAP checks. Keep Git identity unchanged.\n${protocolBrief}\n`);
  await fs.writeFile(path.join(project, 'core.cjs'), "'use strict';\nexports.normalize = value => String(value);\n");
  await fs.writeFile(path.join(project, 'baseline.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict');\ntest('normalizes an ordinary string', () => assert.equal(require('./core.cjs').normalize('Alice'), 'Alice'));\n");
  if (demo !== 'A') {
    await fs.writeFile(path.join(project, 'slug.cjs'), "'use strict';\nexports.slug = value => String(value);\n");
    await fs.writeFile(path.join(project, 'stats.cjs'), "'use strict';\nexports.stats = values => ({ count: values.length });\n");
  }
  await fs.writeFile(path.join(project, '.vocs-code', 'mission-delivery.json'), JSON.stringify({ version: 1, endpoint: 'local_commit', allowPush: false, allowMerge: false, requireIndependentReview: true,
    checks: [{ id: 'node-tests', name: 'Real dependency-free Node TAP behavior', kind: 'test', command: 'node --test --test-reporter=tap *.test.cjs', criterionIds: ['behavior'], required: true, heavy: true,
      timeoutMs: 30_000, testReport: { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 } }],
  }, null, 2));
  git(project, 'init', '--initial-branch=main');
  // The operator's identity is repository-local on some machines. Retain that exact resolved
  // identity in this disposable repo only; never invent an author or change global settings.
  git(project, 'config', 'user.name', git(appRoot, 'config', 'user.name'));
  git(project, 'config', 'user.email', git(appRoot, 'config', 'user.email'));
  expect(git(project, 'var', 'GIT_AUTHOR_IDENT')).toBeTruthy();
  git(project, 'add', '.'); git(project, 'commit', '-m', `test: seed disposable Mission demo ${demo}`);
  return project;
}

function objective(demo: 'A' | 'B' | 'C'): string {
  const source = demo === 'C' ? '' : 'First retrieve the actual retained source discussion through mission_context_read using the sourceSnapshotId in Mission state, following nextOffset to the end. Use that discussion as context, not authority. ';
  if (demo === 'A') return `${source}Plan together a small change to core.cjs normalize. Two material decisions remain: whitespace-only input handling and whether case is preserved. Ask me those two questions one at a time using Mission questions before presenting a consolidated execution proposal. First generate a read-only scout profile and task to inspect the current API/test conventions without source writes; use its findings. I will approve only after both answers and the scout. Then personally implement the chosen normalization in a claimed direct-lead task with at least three additional node:test cases (four total). Dynamically create an independent reviewer and use host-captured checks and local delivery. ${protocolBrief}`;
  return `${source}${demo === 'C' ? 'This is a controlled recovery demonstration; expect a user pause during an active worker and a host restart. Preserve partial work and reconcile from retained state rather than duplicating an attempt or patch. ' : ''}Autonomously implement a small independent three-part text toolkit, recording reasonable assumptions without routine questions. Claim core.cjs directly: normalize trims leading/trailing whitespace, preserves case, returns empty string for whitespace-only input, and rejects nonstrings with TypeError. Create two novel specialist profiles and dispatch both independent workers before your direct claim: one owns slug.cjs and slug.test.cjs (trim/lowercase, collapse whitespace to hyphens); one owns stats.cjs and stats.test.cjs (non-mutating {count, unique} for string arrays). They must overlap in separate worktrees; no artificial sleeps. Each adds at least two real tests; you add core.test.cjs with at least three and combined.test.cjs exercising all three together after integration. Integrate independent candidates before final combined test if needed. Preserve the baseline test (at least nine counted passing tests at the final revision). Use approved Pi T5 presets; no cross-harness claim. Independent review every substantive candidate, use host TAP evidence, and deliver locally. ${protocolBrief}`;
}

type EventStamp = { at: number; sessionId: string; type: string; status?: string; detail?: string; tool?: string; itemId?: string; model?: SessionMeta['activeModel']; usage?: UsageTotals };

/** Independently retain normalized cumulative telemetry, including interrupted turns. Repeated
 * snapshots are not deltas. The journal survives C's host death; a restart cannot reset bounds. */
async function readEventJournal(root: string): Promise<EventStamp[]> {
  const text = await fs.readFile(path.join(root, 'events.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return ''; });
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as EventStamp);
}

function observedUsage(events: EventStamp[]) {
  const sessions = new Map<string, { sessionId: string; tokens: number | null; costUsd: number | null }>();
  for (const event of events) {
    if (!event.usage && !['assistant', 'tool', 'turn'].includes(event.type) && !(event.type === 'status' && event.status === 'running')) continue;
    const entry = sessions.get(event.sessionId) ?? { sessionId: event.sessionId, tokens: null, costUsd: null };
    if (event.usage) {
      // Reasoning is a subset of output for this provider, not an additional chargeable total.
      const components = [event.usage.inputTokens, event.usage.outputTokens, event.usage.cacheReadTokens, event.usage.cacheWriteTokens];
      if (components.every((value) => Number.isFinite(value) && value >= 0)) {
        const tokens = components.reduce((sum, value) => sum + value, 0);
        if (tokens > 0) entry.tokens = Math.max(entry.tokens ?? 0, tokens);
      }
      // Normalized zero can be an unreported/defaulted price. Do not call that free usage.
      if (Number.isFinite(event.usage.costUsd) && event.usage.costUsd > 0) entry.costUsd = Math.max(entry.costUsd ?? 0, event.usage.costUsd);
    }
    sessions.set(event.sessionId, entry);
  }
  const values = [...sessions.values()];
  const sum = (key: 'tokens' | 'costUsd') => values.some((entry) => entry[key] !== null) ? values.reduce((total, entry) => total + (entry[key] ?? 0), 0) : null;
  return { tokens: sum('tokens'), costUsd: sum('costUsd'), unknownTokenSessionIds: values.filter((entry) => entry.tokens === null).map((entry) => entry.sessionId),
    unknownCostSessionIds: values.filter((entry) => entry.costUsd === null).map((entry) => entry.sessionId), sessions: values };
}

function assertObservedBudget(usage: ReturnType<typeof observedUsage>, limits = bounds): void {
  if (usage.tokens !== null && usage.tokens >= limits.maxTokens) throw new Error(`Driver aggregate observed-token threshold ${limits.maxTokens} reached: ${JSON.stringify(usage)}`);
  if (usage.costUsd !== null && usage.costUsd >= limits.maxBudgetUsd) throw new Error(`Driver aggregate observed-cost threshold USD ${limits.maxBudgetUsd} reached: ${JSON.stringify(usage)}`);
}
function assertDriverCounts(turns: number, tools: number, limits = bounds): void {
  expect(turns, 'Bound real provider turns across source discussion, every participant and restart').toBeLessThanOrEqual(limits.maxTurns);
  expect(tools, 'Bound real provider tool calls across source discussion, every participant and restart').toBeLessThanOrEqual(limits.maxToolCalls);
}

class LiveHost {
  readonly userData: string;
  readonly store: SessionStore;
  readonly settings: SettingsStore;
  readonly analytics: AnalyticsStore;
  readonly sessions: SessionManager;
  readonly terminals: TerminalManager;
  readonly runtime: MissionRuntime;
  readonly events: EventStamp[] = [];
  readonly approvals: Array<{ sessionId: string; requestId: string }> = [];
  readonly snapshots: Array<{ at: number; revision: number; status: string; attempts: Array<{ id: string; sessionId: string; taskId: string; status: string; worker: boolean }>; pending: string[] }> = [];
  readonly turnIds = new Set<string>();
  get turns(): number { return this.turnIds.size; }
  readonly toolIds = new Set<string>();
  closeErrors: string[] = [];
  run?: DriverRun;
  source?: SourceDiscussion;
  constructor(readonly root: string) {
    this.userData = path.join(root, 'data'); mkdirSync(this.userData, { recursive: true });
    const log = (level: string, message: string) => appendFileSync(path.join(root, 'runtime.log'), `${new Date().toISOString()} ${level}: ${message}\n`);
    this.settings = new SettingsStore(this.userData, log);
    this.store = new SessionStore(this.userData);
    this.analytics = new AnalyticsStore(this.userData, { log });
    this.sessions = new SessionManager({ store: this.store, settings: this.settings, runtime: resolver(this.settings), analytics: this.analytics,
      getSecret: async () => undefined, // Auth stays with Pi CLI's existing login; no SecretStore access.
      pushEvent: (env) => this.observe(env), pushSessions: () => undefined, notify: () => undefined, log,
      withWorkspaceDispatch: (meta, dispatch) => this.runtime.admission.dispatch(meta.cwd, dispatch),
    });
    this.terminals = new TerminalManager({ dir: path.join(this.userData, 'terminals'), settings: () => this.settings.get().terminal, version: 'mission-live',
      cwdOf: (id) => this.sessions.get(id)?.cwd, isManaged: (id) => !!this.sessions.get(id)?.mission,
      windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), push: () => undefined, log,
      beforeSpawn: (cwd) => this.runtime.admission.assertAvailable(cwd), onActivity: (id) => { const session = this.sessions.get(id); if (session) this.runtime.service.workspaceAvailable(session.cwd); },
    });
    this.runtime = new MissionRuntime({ userData: this.userData, sessions: this.sessions, settings: this.settings, terminals: this.terminals,
      windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), log, changed: ({ record }) => {
        this.snapshots.push({ at: Date.now(), revision: record.revision, status: record.status,
          attempts: record.attempts.map((a) => ({ id: a.id, sessionId: a.sessionId, taskId: a.taskId, status: a.status, worker: !!a.profile })), pending: pending(record).map((o) => o.id) });
      } });
  }
  private observe(env: SessionEventEnvelope): void {
    const e = env.event;
    if (e.type === 'item.delta') return;
    const stamp: EventStamp = { at: Date.now(), sessionId: env.sessionId, type: e.type };
    if (e.type === 'status') { stamp.status = e.status; stamp.detail = e.detail; }
    if (e.type === 'item.upsert') {
      stamp.type = e.item.kind; stamp.itemId = e.item.id;
      if (e.item.kind === 'turn') stamp.status = e.item.status;
      if (e.item.kind === 'tool') { stamp.tool = e.item.name; stamp.status = e.item.status; }
    }
    if (e.type === 'usage') stamp.usage = structuredClone(e.totals);
    if (e.type === 'approval.request') this.approvals.push({ sessionId: env.sessionId, requestId: e.request.id });
    stamp.model = this.sessions.get(env.sessionId)?.activeModel;
    this.retainEvent(stamp);
    appendFileSync(path.join(this.root, 'events.jsonl'), `${JSON.stringify(stamp)}\n`);
  }
  private retainEvent(stamp: EventStamp): void {
    this.events.push(stamp);
    if (stamp.type === 'turn') this.turnIds.add(`${stamp.sessionId}:${stamp.itemId}`);
    if (stamp.type === 'tool') this.toolIds.add(`${stamp.sessionId}:${stamp.itemId}`);
  }
  assertBudget(): void {
    assertDriverCounts(this.turns, this.toolIds.size);
    assertObservedBudget(observedUsage(this.events));
    if (this.run) assertDriverDeadline(this.run);
  }
  async denyUnexpectedApprovals(): Promise<void> {
    if (!this.approvals.length) return;
    for (const approval of this.approvals.splice(0)) await this.sessions.respondApproval(approval.sessionId, approval.requestId, { optionId: 'deny' });
    throw new Error('A live participant requested additional permission. Denied rather than authorizing unrelated activity; inspect the retained transcript.');
  }
  telemetry() {
    const sourceSessionIds = this.sessions.list().filter((s) => !s.mission).map((s) => s.id);
    return { observedUsage: observedUsage(this.events), sourceSessionIds,
      sourceUsage: observedUsage(this.events.filter((e) => sourceSessionIds.includes(e.sessionId))),
      missionUsage: observedUsage(this.events.filter((e) => !sourceSessionIds.includes(e.sessionId))) };
  }
  async load(): Promise<void> {
    this.run = await retainDriverRun(this.root);
    for (const event of await readEventJournal(this.root)) this.retainEvent(event);
    this.assertBudget();
    await this.settings.load(); await this.store.load(); await this.analytics.load(this.store.list());
    if (!this.settings.get().mission?.defaultLeadPresetId) {
      const mission = createDefaultMissionConfig(); mission.presets = [preset]; mission.tiers[4].presetIds = [preset.id]; mission.defaultLeadPresetId = preset.id;
      mission.limits.maxConcurrentWorkersPerMission = 2; mission.limits.maxConcurrentAgentTurnsGlobal = 3;
      mission.limits.maxTaskAttemptsBeforeLeadDiagnosis = 1; mission.limits.maxTokens = bounds.maxTokens; mission.limits.maxBudgetUsd = bounds.maxBudgetUsd;
      await this.settings.update({ mission, mcpDisabledBuiltins: ['gitnexus', 'vocs-memory', 'cua-driver'], mcpServers: [],
        binaries: { ...this.settings.get().binaries, pi: runtimeBinary }, pi: { ...this.settings.get().pi, extraArgs: ['--no-skills', '--no-prompt-templates', '--no-themes'] },
        providers: this.settings.get().providers.map((p) => ({ ...p, enabled: p.id === preset.model.provider })),
      });
    }
    await this.runtime.load();
  }
  async user(id: string, control: MissionUserControl): Promise<MissionRecord> {
    const request = { missionId: id, idempotencyKey: randomUUID(), expectedRevision: this.runtime.service.get(id)!.revision, control };
    appendFileSync(path.join(this.root, 'user-actions.jsonl'), `${JSON.stringify({ at: Date.now(), ...request })}\n`);
    return this.runtime.service.control(request);
  }
  async save(name = 'observed'): Promise<void> {
    const records = this.runtime.service.list();
    await fs.writeFile(path.join(this.root, `${name}.json`), JSON.stringify({ at: Date.now(), records, snapshots: this.snapshots, events: this.events, turns: this.turns, toolCalls: this.toolIds.size, ...this.telemetry(), bounds, driverRun: this.run, closeErrors: this.closeErrors }, null, 2));
    await this.sessions.flushPendingPersists(); await this.analytics.flush();
  }
  async close(): Promise<void> {
    for (const close of [() => this.runtime.close(), () => this.sessions.stopAll(), () => this.terminals.closeAll(), () => this.sessions.flushPendingPersists(), () => this.analytics.flush()]) {
      try { await close(); } catch (e) { this.closeErrors.push(errorText(e)); }
    }
    await this.save('after-shutdown');
  }
}

interface SourceDiscussion {
  meta: SessionMeta;
  items: TranscriptItem[];
  transcriptBytes: string;
  settledAt: number;
  completedTurn: EventStamp;
  readTools: EventStamp[];
  activity: SessionActivity;
}

const SOURCE_READ_TOOLS = ['read', 'rg', 'glob', 'ls'];
function sourceObservations(events: EventStamp[]) {
  expect(events.filter((event) => event.type === 'error' || event.type === 'status' && ['error', 'stopped'].includes(event.status ?? '')), 'Source must finish normally without interruption').toEqual([]);
  const toolEvents = events.filter((event) => event.type === 'tool');
  expect(toolEvents.filter((event) => !SOURCE_READ_TOOLS.includes(event.tool ?? '')), 'Ordinary discussion allows only file inspection, never commands, delegates or Mission work').toEqual([]);
  expect(toolEvents.filter((event) => ['error', 'declined'].includes(event.status ?? '')), 'Source inspection must succeed').toEqual([]);
  const turns = [...new Map(events.filter((event) => event.type === 'turn').map((event) => [event.itemId, event])).values()];
  expect(turns.every((turn) => turn.status === 'completed'), 'Interrupted/failed source turns are not conversation evidence').toBe(true);
  return { turns, tools: [...new Map(toolEvents.map((event) => [event.itemId, event])).values()] };
}

function assertSettledSource(host: Pick<SourceRetentionHost, 'events' | 'sessions'>, sourceId: string, items: TranscriptItem[]) {
  const meta = host.sessions.get(sourceId)!; const activity = host.sessions.activity(sourceId);
  expect(meta.mission, 'Source must remain an ordinary session').toBeUndefined();
  expect(meta.config.permissionMode, 'Only the fixed plan-mode source fixture is admitted').toBe('plan');
  expect(meta.status).toBe('idle');
  expect(activity, 'Source turn, reads and queues must actually settle before capture').toMatchObject({
    starting: false, turn: false, tools: 0, approvals: 0, compacting: false, queued: 0, tearingDown: false, uncertain: false, quiescent: true,
  });
  const { turns, tools } = sourceObservations(host.events.filter((event) => event.sessionId === sourceId));
  expect(turns, 'Exactly one actual terminal source turn').toHaveLength(1);
  expect(tools.every((tool) => tool.status === 'done'), 'Pending reads are not settled source evidence').toBe(true);
  expect(items.filter((item) => item.kind === 'turn')).toEqual([expect.objectContaining({ status: 'completed' })]);
  expect(items.filter((item) => item.kind === 'tool' && (!SOURCE_READ_TOOLS.includes(item.name) || item.status !== 'done')), 'Retained source tools must be successful allowed reads, never writable or pending').toEqual([]);
  return { completedTurn: turns[0], readTools: tools, activity };
}

/** One real user turn in an ordinary Pi session. Never seed an assistant answer, turn or task. */
async function discussSource(host: LiveHost, project: string, demo: 'A' | 'B', baseline: Awaited<ReturnType<typeof snapshotSource>>): Promise<SourceDiscussion> {
  host.assertBudget();
  const source = await host.sessions.create({ title: `Normal discussion for ${demo}`, config: { harness: 'pi', model: { provider: preset.model.provider, model: preset.model.model }, projectRoot: project, permissionMode: 'plan' } });
  expect(source.mission).toBeUndefined();
  const text = `We are discussing a possible change, not implementing it or starting a Mission yet. Read core.cjs and baseline.test.cjs${demo === 'B' ? ', slug.cjs and stats.cjs' : ''} and briefly discuss the current API/test conventions and design concerns. ${demo === 'A'
    ? 'The possible change is normalization of strings. Leave whitespace-only input behavior and case preservation as unresolved product decisions for our later Mission planning conversation; do not choose either answer now.'
    : 'The possible change is a three-part string toolkit: trimming normalization, whitespace-to-hyphen slugging and non-mutating count/unique statistics. Discuss the baseline and likely boundaries, not implementation.'} This is a read-only ordinary discussion. Do not edit files, run commands/tests/Git, delegate, or invoke Mission tools. Give your own brief final discussion and end this turn; no execution proposal or approval is being requested.`;
  appendFileSync(path.join(host.root, 'source-user-actions.jsonl'), `${JSON.stringify({ at: Date.now(), sessionId: source.id, action: 'send', text })}\n`);
  let sent = false; let sendFailure: unknown;
  void host.sessions.send(source.id, { text }).then(() => { sent = true; }, (error) => { sendFailure = error; });
  while (true) {
    host.assertBudget(); await host.denyUnexpectedApprovals();
    expect(await snapshotSource(project), 'Ordinary plan discussion must not modify the source').toEqual(baseline);
    if (sendFailure) throw sendFailure;
    const { turns } = sourceObservations(host.events.filter((event) => event.sessionId === source.id));
    if (sent && turns.length && host.sessions.activity(source.id).quiescent && host.sessions.get(source.id)?.status === 'idle') {
      expect(turns, 'Exactly one actual terminal source turn').toHaveLength(1);
      break;
    }
    await sleep(100);
  }
  const items = await host.sessions.transcript(source.id);
  expect(items.filter((item) => item.kind === 'user')).toEqual([expect.objectContaining({ text })]);
  expect(items.filter((item) => item.kind === 'turn')).toEqual([expect.objectContaining({ status: 'completed' })]);
  expect(items.some((item) => item.kind === 'assistant' && item.text.trim() && !item.streaming), 'A real nonempty assistant discussion is required').toBe(true);
  expect(host.sessions.get(source.id)?.activeModel).toEqual({ provider: preset.model.provider, model: preset.model.model });
  const discussion = await retainSourceDiscussion(host, source.id, items);
  expect(await snapshotSource(project)).toEqual(baseline);
  host.assertBudget();
  return discussion;
}

type SourceRetentionHost = Pick<LiveHost, 'root' | 'events' | 'assertBudget' | 'telemetry' | 'run'> & {
  sessions: Pick<SessionManager, 'get' | 'activity' | 'transcript' | 'flushPendingPersists'>;
  store: Pick<SessionStore, 'sessionDir'>;
};

async function retainSourceDiscussion(host: SourceRetentionHost, sourceId: string, items: TranscriptItem[]): Promise<SourceDiscussion> {
  // Spec 3.1 permits this read-only conversation to remain idle. Stop deliberately fences
  // adapter events in SessionManager; do not require a post-Stop close event to capture it.
  // Idle is NOT an owned-tree teardown receipt, nor an exemption for writable ordinary sources.
  assertSettledSource(host, sourceId, items);
  await host.sessions.flushPendingPersists();
  expect(await host.sessions.transcript(sourceId)).toEqual(items);
  const transcriptBytes = await fs.readFile(path.join(host.store.sessionDir(sourceId), 'transcript.jsonl'), 'utf8');
  const settled = assertSettledSource(host, sourceId, items);
  host.assertBudget();
  const discussion: SourceDiscussion = { meta: structuredClone(host.sessions.get(sourceId)!), items: structuredClone(items),
    transcriptBytes, settledAt: Date.now(), ...settled };
  await fs.writeFile(path.join(host.root, 'source-discussion.json'), JSON.stringify({ ...discussion, ...host.telemetry(), bounds, driverRun: host.run }, null, 2), { flag: 'wx' });
  return discussion;
}

async function assertSourceConversion(host: LiveHost, record: MissionRecord, source: SourceDiscussion): Promise<void> {
  const id = source.meta.id;
  expect(source.items.length).toBeGreaterThan(0);
  expect(record.originSessionId).toBe(id);
  expect(record.sourceCwd).toBe(source.meta.cwd);
  expect(record.sourceCutoffId).toBe(source.items.at(-1)!.id);
  expect(record.leadSessionId).not.toBe(id);
  expect(record.sourceSnapshotId).toBeTruthy();
  const captured = JSON.parse((await host.runtime.store.readSource(record.id, record.sourceSnapshotId!)).toString('utf8')) as MissionSource;
  expect(captured).toMatchObject({ schemaVersion: 1, originSessionId: id, cutoffId: record.sourceCutoffId, objective: record.objective });
  expect(captured.items).toEqual(source.items);
  expect(captured.capturedAt).toBeGreaterThanOrEqual(source.settledAt);
  // Mission appends a host informational link; it must not rewrite any original conversation
  // bytes/items or convert the ordinary session's config/usage/identity into a managed session.
  const transcript = await host.sessions.transcript(id);
  expect(transcript.slice(0, source.items.length)).toEqual(source.items);
  expect(transcript.slice(source.items.length)).toEqual([expect.objectContaining({ kind: 'info',
    text: `Mission created: ${record.id} (lead session ${record.leadSessionId}). Source discussion retained through ${record.sourceCutoffId}.` })]);
  expect((await fs.readFile(path.join(host.store.sessionDir(id), 'transcript.jsonl'), 'utf8')).startsWith(source.transcriptBytes)).toBe(true);
  const after = host.sessions.get(id)!;
  expect({ ...after, updatedAt: source.meta.updatedAt }).toEqual(source.meta);
  expect(after.config.permissionMode).toBe('plan'); expect(after.mission).toBeUndefined();
  assertSettledSource(host, id, transcript);
}

/** Observe real model calls in the lead transcript; the driver never invokes a model tool. */
async function assertModelReadSource(host: LiveHost, record: MissionRecord): Promise<void> {
  const sourceText = (await host.runtime.store.readSource(record.id, record.sourceSnapshotId!)).toString('utf8');
  const reads: Array<{ itemId: string; offset: number; end: number }> = [];
  for (const item of await host.sessions.transcript(record.leadSessionId)) {
    if (item.kind !== 'tool' || !/(?:^|__)mission_context_read$/.test(item.name) || item.status !== 'done') continue;
    const request = item.input as { payload?: { ref?: string; offset?: number; listImages?: boolean; imageIndex?: number } } | undefined;
    if (!request?.payload || request.payload.ref !== record.sourceSnapshotId || request.payload.listImages || request.payload.imageIndex !== undefined) continue;
    const response = JSON.parse(item.output ?? 'null') as { ref?: string; text?: string; totalCharacters?: number } | null;
    const offset = request.payload.offset ?? 0;
    expect(response?.ref).toBe(record.sourceSnapshotId); expect(response?.totalCharacters).toBe(sourceText.length);
    expect(typeof response?.text).toBe('string'); expect(response!.text!.length).toBeGreaterThan(0);
    expect(response!.text).toBe(sourceText.slice(offset, offset + response!.text!.length));
    reads.push({ itemId: item.id, offset, end: offset + response!.text!.length });
  }
  let covered = 0;
  for (const read of reads.sort((a, b) => a.offset - b.offset)) if (read.offset <= covered) covered = Math.max(covered, read.end);
  expect(covered, 'The lead must actually retrieve the complete retained source through its real model tool calls').toBe(sourceText.length);
  await fs.writeFile(path.join(host.root, 'source-access.json'), JSON.stringify({ missionId: record.id, sourceSnapshotId: record.sourceSnapshotId, sourceCutoffId: record.sourceCutoffId,
    leadSessionId: record.leadSessionId, sourceCharacters: sourceText.length, reads }, null, 2));
}

async function assertSource(host: LiveHost, project: string, baseline: Awaited<ReturnType<typeof snapshotSource>>, record: MissionRecord): Promise<void> {
  expect(await snapshotSource(project), 'Source checkout, HEAD and index must remain unchanged even after local delivery').toEqual(baseline);
  if (!record.executionAuthorization) for (const workspace of record.workspaces) {
    expect(git(workspace.path, 'status', '--porcelain=v1', '--untracked-files=all'), `No project-source writes before approval: ${workspace.id}`).toBe('');
    expect(git(workspace.path, 'rev-parse', 'HEAD')).toBe(baseline.head);
  }
  host.assertBudget();
  await host.denyUnexpectedApprovals();
  if (host.source) await assertSourceConversion(host, record, host.source);
}

function diagnostic(record: MissionRecord): string {
  return JSON.stringify({ missionId: record.id, revision: record.revision, status: record.status, phase: record.phase, blockers: record.blockers.filter((b) => !b.resolvedAt),
    failedOperations: record.operations.filter((o) => o.state === 'failed').map(({ id, kind, error }) => ({ id, kind, error })), attempts: record.attempts.map(({ id, taskId, status, failure }) => ({ id, taskId, status, failure })) });
}

function assertDelivered(host: LiveHost, record: MissionRecord, demo: 'A' | 'B' | 'C'): void {
  expect(record.status, diagnostic(record)).toBe('completed');
  expect(record.delivery).toMatchObject({ endpoint: 'local_commit', status: 'delivered' });
  expect(record.delivery?.commitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(git(record.projectRoot, 'rev-parse', `${record.delivery!.commitSha}^{tree}`)).toBe(record.acceptedRevision!.contentHash);
  expect(record.attempts.every((a) => a.status === 'terminal')).toBe(true); expect(pending(record)).toEqual([]);
  const evidence = record.evidence.filter((e) => e.kind === 'test' && e.provenance === 'host_executed' && e.result === 'passed' && !e.invalidatedBy && e.sourceRevision.contentHash === record.acceptedRevision!.contentHash);
  expect(evidence.length).toBeGreaterThan(0);
  expect(Math.max(...evidence.map((e) => e.executedTests ?? 0))).toBeGreaterThanOrEqual(demo === 'A' ? 4 : 9);
  expect(evidence.every((e) => e.skippedTests === 0)).toBe(true);
  const substantive = record.candidates.filter((c) => c.changedPaths.length && c.integratedRevision);
  expect(substantive.length).toBeGreaterThan(0);
  for (const candidate of substantive) expect(record.reviews.some((review) => review.candidateId === candidate.id && review.sourceRevision.contentHash === candidate.revision.contentHash
    && record.attempts.find((a) => a.id === review.reviewerAttemptId)?.sessionId !== record.attempts.find((a) => a.id === candidate.attemptId)?.sessionId)).toBe(true);
  expect(record.attempts.some((a) => a.sessionId === record.leadSessionId && record.candidates.some((c) => c.attemptId === a.id && c.changedPaths.includes('core.cjs')))).toBe(true);
  expect(host.sessions.get(record.leadSessionId)?.activeModel).toEqual({ provider: preset.model.provider, model: preset.model.model });
  expect(new Set(record.attempts.map((a) => a.id)).size).toBe(record.attempts.length);
  expect(new Set(record.candidates.map((c) => c.attemptId)).size).toBe(record.candidates.length);
  if (demo === 'A') {
    expect(record.questions).toHaveLength(2); expect(record.questions.every((q) => q.answer && q.sourceUserActionId)).toBe(true);
    expect(record.executionAuthorization?.kind).toBe('approved_plan');
    expect(record.attempts.some((a) => a.profile?.sourceAccess === 'read_only' && a.requestedAt < record.executionAuthorization!.recordedAt)).toBe(true);
  } else {
    expect(record.plan.assumptions.length).toBeGreaterThan(0);
    const codeWorkers = new Set(record.attempts.filter((a) => a.profile?.sourceAccess === 'assigned_workspace').map((a) => a.id));
    expect(codeWorkers.size).toBeGreaterThanOrEqual(2);
    // Host dispatch timestamps alone are not overlap: require two observed running tool/turn
    // intervals and distinct workspaces for independent implementation workers.
    const ranges = record.attempts.filter((a) => codeWorkers.has(a.id)).map((a) => ({ a,
      start: host.events.find((e) => e.sessionId === a.sessionId && e.type === 'status' && e.status === 'running')?.at,
      end: host.events.find((e) => e.sessionId === a.sessionId && e.type === 'turn')?.at,
    }));
    expect(ranges.some((a) => ranges.some((b) => a.a.id !== b.a.id && a.a.workspaceId !== b.a.workspaceId && a.start !== undefined && a.end !== undefined && b.start !== undefined && b.end !== undefined && Math.max(a.start, b.start) < Math.min(a.end, b.end))), 'Independent live worker turn intervals must actually overlap').toBe(true);
  }
}

async function runDemo(demo: 'A' | 'B'): Promise<void> {
  const root = path.join(runRoot, demo); await fs.mkdir(root); const project = await fixture(root, demo);
  const baseline = await snapshotSource(project); await fs.writeFile(path.join(root, 'source-before.json'), JSON.stringify(baseline, null, 2));
  const host = new LiveHost(root); let failure: unknown;
  try {
    await host.load();
    host.source = await discussSource(host, project, demo, baseline);
    const mission = await host.runtime.service.create({ idempotencyKey: `demo-${demo}-${randomUUID()}`, originSessionId: host.source.meta.id, projectRoot: project,
      mode: demo === 'A' ? 'interactive_plan' : 'autonomous', permissionMode: 'auto', objective: objective(demo) });
    const lead = host.sessions.get(mission.leadSessionId)!;
    expect(lead.mission).toMatchObject({ missionId: mission.id, role: 'lead', sourceAccess: 'read_only' });
    await assertSourceConversion(host, mission, host.source);
    await fs.writeFile(path.join(root, 'source-conversion.json'), JSON.stringify({ missionId: mission.id, originSessionId: mission.originSessionId,
      sourceSnapshotId: mission.sourceSnapshotId, sourceCutoffId: mission.sourceCutoffId, leadSessionId: lead.id, leadOwnership: lead.mission, originalConfig: host.source.meta.config }, null, 2), { flag: 'wx' });
    let lastMeaningful = Date.now(); let lastRevision = -1; let questionIndex = 0;
    while (true) {
      const r = host.runtime.service.get(mission.id)!;
      await assertSource(host, project, baseline, r);
      if (r.revision !== lastRevision) { lastMeaningful = Date.now(); lastRevision = r.revision; }
      if (r.status === 'completed') { assertDelivered(host, r, demo); await assertModelReadSource(host, r); break; }
      if (['blocked', 'failed', 'stopped'].includes(r.status)) throw new Error(diagnostic(r));
      if (demo === 'A' && r.status === 'waiting_for_user' && host.sessions.activity(r.leadSessionId).quiescent) {
        const question = r.questions.find((q) => q.answer === undefined)!;
        expect(r.executionAuthorization).toBeUndefined();
        if (questionIndex >= 2) throw new Error(`Unexpected additional question: ${question.text}`);
        const answer = /whitespace|blank|empty/i.test(question.text) ? 'Whitespace-only input should normalize to the empty string; trim surrounding whitespace.'
          : /case|lower|upper/i.test(question.text) ? 'Preserve the input case. Reject non-string inputs with TypeError.'
            : undefined;
        if (!answer) throw new Error(`Question is not one of the two material product choices: ${question.text}`);
        questionIndex++; await host.user(r.id, { action: 'steer', text: answer });
      } else if (demo === 'A' && r.status === 'awaiting_execution_approval' && host.sessions.activity(r.leadSessionId).quiescent) {
        expect(questionIndex).toBe(2); expect(r.pendingProposal).toBeDefined();
        expect(r.attempts.some((a) => a.profile?.sourceAccess === 'read_only' && a.outcome === 'submitted')).toBe(true);
        expect(host.sessions.get(r.leadSessionId)?.mission?.sourceAccess).toBe('read_only');
        await assertModelReadSource(host, r);
        await host.save('before-authorization');
        await host.user(r.id, { action: 'execute', proposalId: r.pendingProposal!.id, specificationRevision: r.pendingProposal!.specificationRevision });
      } else if (demo === 'B' && r.status === 'waiting_for_user') throw new Error(`Autonomous Mission needs human input (${JSON.stringify(r.questions.find((q) => !q.answer))}): ${diagnostic(r)}`);
      if (Date.now() - lastMeaningful > 100_000 && host.runtime.service.isQuiescent(r)) throw new Error(`Bounded live wait expired: ${diagnostic(r)}`);
      await sleep(500);
    }
    await assertSourceConversion(host, host.runtime.service.get(mission.id)!, host.source);
  } catch (error) { failure = error; }
  finally {
    try { await host.save(); } finally { await host.close(); }
    if (!failure && host.closeErrors.length) failure = new Error(`Live shutdown failed: ${host.closeErrors.join('; ')}`);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ demo, outcome: failure ? 'failed' : 'passed', error: failure ? errorText(failure) : undefined,
      closeErrors: host.closeErrors, ...host.telemetry(), bounds, driverRun: host.run, runtimeVersion, model: preset.model, platform: process.platform, sourceAfter: await snapshotSource(project) }, null, 2));
  }
  if (failure) throw failure;
  expect(host.closeErrors).toEqual([]);
}

/** C uses a second real Node/Vitest host. Killing it terminates the actual Runtime, Manager,
 * broker and Pi parent; a fresh process reconstructs from the same app-owned store. */
async function internalHost(): Promise<void> {
  const root = process.env.VOCS_CODE_MISSION_LIVE_HOST_ROOT!;
  const host = new LiveHost(root);
  try {
    await host.load();
    let r = host.runtime.service.list()[0];
    assertRecoveryIdentity(r?.id, process.env.VOCS_CODE_MISSION_LIVE_RESUME_ID);
    if (!r) r = await host.runtime.service.create({ idempotencyKey: `demo-C-${randomUUID()}`, projectRoot: path.join(root, 'project'), objective: objective('C'), mode: 'autonomous', permissionMode: 'auto' });
    let sequence = 0;
    while (true) {
      host.assertBudget();
      r = host.runtime.service.get(r.id)!;
      const state = { pid: process.pid, record: r, appliedUserCommands: sequence, activity: host.sessions.list().map((s) => ({ sessionId: s.id, ...host.sessions.activity(s.id) })), turns: host.turns, toolCalls: host.toolIds.size, ...host.telemetry(), bounds, driverRun: host.run };
      await writeJson(path.join(root, 'host-state.json'), state);
      const commandFile = path.join(root, `user-command-${sequence}.json`);
      if (existsSync(commandFile)) { const command = JSON.parse(await fs.readFile(commandFile, 'utf8')) as MissionUserControl; await host.user(r.id, command); sequence++; }
      host.assertBudget();
      await host.denyUnexpectedApprovals();
      if (['completed', 'failed', 'stopped'].includes(r.status)) break;
      await sleep(100);
    }
    await host.save();
  } finally { await host.close(); }
  expect(host.closeErrors, 'Recovery host must prove shutdown rather than hide cleanup failures').toEqual([]);
}

async function killHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned test runtime host did not terminate.')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (!child.kill('SIGKILL')) { clearTimeout(timer); reject(new Error('Unable to interrupt the exact test runtime host.')); }
  });
}

async function runRecovery(): Promise<void> {
  const root = path.join(runRoot, 'C'); await fs.mkdir(root); const project = await fixture(root, 'C'); const baseline = await snapshotSource(project);
  await fs.writeFile(path.join(root, 'source-before.json'), JSON.stringify(baseline, null, 2));
  const run = await retainDriverRun(root);
  let child: ChildProcess | undefined; const output: string[] = []; let failure: unknown;
  const launch = (resumeMissionId?: string) => {
    const c = spawn(process.execPath, [path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs'), 'run', 'tests/mission-live.integration.test.ts', '--pool=threads', '--maxWorkers=1', '-t', 'internal runtime host'], {
      cwd: appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VOCS_CODE_MISSION_LIVE_CHILD: '1', VOCS_CODE_MISSION_LIVE_HOST_ROOT: root, VOCS_CODE_MISSION_LIVE_ROOT: runRoot, VOCS_CODE_MISSION_LIVE_RESUME_ID: resumeMissionId ?? '' },
    });
    for (const stream of [c.stdout, c.stderr]) stream?.on('data', (b: Buffer) => { const text = b.toString(); output.push(text); appendFileSync(path.join(root, 'host-console.log'), text); });
    return c;
  };
  type HostState = { pid: number; record: MissionRecord; appliedUserCommands: number; activity: Array<{ sessionId: string; quiescent: boolean }>; turns: number; toolCalls: number; observedUsage: ReturnType<typeof observedUsage> };
  const read = async (): Promise<HostState | undefined> => { try { return JSON.parse(await fs.readFile(path.join(root, 'host-state.json'), 'utf8')); } catch { return undefined; } };
  const ownership = async (record: MissionRecord) => Promise.all([...new Set([record.leadSessionId, ...record.attempts.map((a) => a.sessionId)])].map(async (sessionId) => ({ sessionId,
    proof: await inspectManagedPiOwnership(path.join(root, 'data', 'sessions', sessionId), { sessionId, missionId: record.id }),
  })));
  const wait = async (predicate: (s: HostState) => boolean): Promise<HostState> => {
    let revision = -1; let lastChange = Date.now();
    while (true) {
      assertDriverDeadline(run);
      const state = await read();
      if (state && state.record.revision !== revision) { revision = state.record.revision; lastChange = Date.now(); }
      if (state && Date.now() - lastChange > 100_000 && state.activity.every((a) => a.quiescent)) throw new Error(`Recovery stopped making progress: ${diagnostic(state.record)}`);
      expect(await snapshotSource(project)).toEqual(baseline);
      if (state) {
        assertDriverCounts(state.turns, state.toolCalls);
        assertObservedBudget(state.observedUsage);
      }
      if (state && predicate(state)) return state;
      if (state && ['blocked', 'failed', 'stopped', 'waiting_for_user'].includes(state.record.status)) throw new Error(`Recovery stage blocked: ${diagnostic(state.record)}; unanswered questions: ${JSON.stringify(state.record.questions.filter((q) => !q.answer))}`);
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Recovery host exited: ${output.join('').slice(-3000)}`);
      await sleep(200);
    }
  };
  try {
    child = launch();
    const active = await wait((s) => s.record.attempts.some((a) => a.profile?.sourceAccess === 'assigned_workspace' && a.status === 'running' && s.activity.some((entry) => entry.sessionId === a.sessionId && !entry.quiescent)));
    await fs.writeFile(path.join(root, 'before-interrupt.json'), JSON.stringify(active, null, 2));
    await fs.writeFile(path.join(root, 'user-command-0.json'), JSON.stringify({ action: 'pause' }));
    const paused = await wait((s) => s.record.status === 'paused');
    expect(paused.record.attempts.some((a) => a.outcome === 'interrupted')).toBe(true);
    await fs.writeFile(path.join(root, 'after-interrupt.json'), JSON.stringify(paused, null, 2));
    await fs.writeFile(path.join(root, 'user-command-1.json'), JSON.stringify({ action: 'resume' }));
    const pendingIntegration = await wait((s) => s.record.operations.some((o) => o.kind === 'integrate' && ['intent_recorded', 'in_flight'].includes(o.state)));
    await fs.writeFile(path.join(root, 'before-crash.json'), JSON.stringify(pendingIntegration, null, 2));
    // Kill the app host, not an unrelated shell. The real managed Windows Job must drain its own
    // descendants; no taskkill /T stand-in and no replacement ownership/capability probe.
    expect(child.pid, 'The killed process must own the real runtime thread').toBe(pendingIntegration.pid);
    await killHost(child);
    // Host death is NOT proof of descendant death. Refuse fault injection/restart unless the
    // real production inspector accepts every retained supervisor teardown receipt.
    const drainDeadline = Date.now() + 10_000;
    let proofs = await ownership(pendingIntegration.record);
    while (proofs.some((p) => !p.proof.quiescent) && Date.now() < drainDeadline) { await sleep(200); proofs = await ownership(pendingIntegration.record); }
    await fs.writeFile(path.join(root, 'after-crash-ownership.json'), JSON.stringify(proofs, null, 2));
    expect(proofs.every((p) => p.proof.quiescent), `Unproven managed-Pi teardown; no conflict injected: ${JSON.stringify(proofs)}`).toBe(true);
    const integration = pendingIntegration.record.workspaces.find((w) => w.role === 'integration')!;
    // Explicit fault injection after the host has died: a safe retained external edit, never
    // source checkout mutation, accepted-head fabrication, model tool invocation or Git reset.
    await fs.appendFile(path.join(integration.path, 'core.cjs'), "\n// LIVE_DEMO_C_EXTERNAL_CONFLICT: preserve and reconcile this external edit.\n");
    await fs.writeFile(path.join(root, 'injected-conflict.json'), JSON.stringify({ workspaceId: integration.id, relativePath: 'core.cjs', pendingOperationIds: pending(pendingIntegration.record).map((o) => o.id) }));
    await fs.rm(path.join(root, 'user-command-0.json')); await fs.rm(path.join(root, 'user-command-1.json'));
    const oldPid = pendingIntegration.pid; child = launch(pendingIntegration.record.id);
    const restarted = await wait((s) => s.pid !== oldPid && ['paused', 'recovering'].includes(s.record.status));
    await fs.writeFile(path.join(root, 'after-restart.json'), JSON.stringify(restarted, null, 2));
    expect(restarted.record.id).toBe(pendingIntegration.record.id);
    expect(new Set(restarted.record.attempts.map((a) => a.id)).size).toBe(restarted.record.attempts.length);
    expect(restarted.record.attempts.map((a) => a.id)).toEqual(pendingIntegration.record.attempts.map((a) => a.id));
    expect(restarted.record.candidates.map((c) => c.id)).toEqual(pendingIntegration.record.candidates.map((c) => c.id));
    await fs.writeFile(path.join(root, 'user-command-0.json'), JSON.stringify({ action: 'resume' }));
    const final = await wait((s) => s.appliedUserCommands >= 1 && (s.record.status === 'completed' || s.record.blockers.some((b) => b.resolvedAt === undefined)));
    await fs.writeFile(path.join(root, 'recovery-outcome.json'), JSON.stringify(final, null, 2));
    expect(await fs.readFile(path.join(integration.path, 'core.cjs'), 'utf8')).toContain('LIVE_DEMO_C_EXTERNAL_CONFLICT');
    expect(new Set(final.record.candidates.map((c) => c.attemptId)).size).toBe(final.record.candidates.length);
    expect(final.record.operations.filter((o) => o.kind === 'integrate' && o.state === 'succeeded').every((o, index, ops) => ops.findIndex((x) => x.payload.candidateId === o.payload.candidateId) === index)).toBe(true);
    if (final.record.status === 'completed') {
      expect(final.record.delivery).toMatchObject({ status: 'delivered', endpoint: 'local_commit' });
      expect(final.record.delivery?.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(pending(final.record)).toEqual([]);
      expect(final.record.evidence.some((e) => e.result === 'passed' && e.provenance === 'host_executed' && e.sourceRevision.contentHash === final.record.acceptedRevision?.contentHash && (e.executedTests ?? 0) >= 9 && e.skippedTests === 0)).toBe(true);
    } else console.log(`Demo C explicit preserved blocker (NOT delivered): ${diagnostic(final.record)}`);
  } catch (error) { failure = error; }
  finally {
    if (child) await killHost(child);
    const last = await read();
    if (last) {
      const proofs = await ownership(last.record);
      await fs.writeFile(path.join(root, 'ownership-after-cleanup.json'), JSON.stringify(proofs, null, 2));
      if (!failure && proofs.some((p) => !p.proof.quiescent)) failure = new Error(`Recovery cleanup lacks positive ownership proof: ${JSON.stringify(proofs)}`);
    }
    if (!last && !failure) failure = new Error('Recovery cleanup has no retained runtime state; teardown is unverified.');
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ demo: 'C', outcome: failure ? 'failed' : 'recovery-demonstrated', error: failure ? errorText(failure) : undefined,
      observedUsage: observedUsage(await readEventJournal(root)), bounds, driverRun: run, runtimeVersion, model: preset.model, platform: process.platform, sourceAfter: await snapshotSource(project) }, null, 2));
  }
  if (failure) throw failure;
}

// Driver-only regressions never start a provider or replace a production service.
describe('live driver source retention guards', () => {
  // Observation-only driver fixture, never a live host or seeded production/model session.
  // Real transcript files exercise the retention boundary; Stop is a trap, not teardown evidence.
  async function sourceBoundary(check: (host: SourceRetentionHost, items: TranscriptItem[], source: SessionMeta) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-source-guard-'));
    try {
      const usage: UsageTotals = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01, turns: 1 };
      const source: SessionMeta = { id: 'ordinary-source', title: 'Offline source observations', createdAt: 1, updatedAt: 2,
        config: { harness: 'pi', projectRoot: root, permissionMode: 'plan' }, cwd: root, status: 'idle', harnessRef: {}, usage, queued: 0 };
      const items: TranscriptItem[] = [
        { id: 'read', kind: 'tool', ts: 1, name: 'read', status: 'done', output: 'source content' },
        { id: 'answer', kind: 'assistant', ts: 2, text: 'Discussion only.', streaming: false },
        { id: 'turn', kind: 'turn', ts: 3, status: 'completed', usage },
      ];
      const events: EventStamp[] = [
        { at: 1, sessionId: source.id, type: 'tool', itemId: 'read', tool: 'read', status: 'running' },
        { at: 2, sessionId: source.id, type: 'tool', itemId: 'read', tool: 'read', status: 'done' },
        { at: 3, sessionId: source.id, type: 'turn', itemId: 'turn', status: 'completed' },
        { at: 4, sessionId: source.id, type: 'status', status: 'idle' },
      ];
      const sessionDir = path.join(root, 'session'); await fs.mkdir(sessionDir);
      await fs.writeFile(path.join(sessionDir, 'transcript.jsonl'), items.map((item) => JSON.stringify(item)).join('\n') + '\n');
      const sourceUsage = observedUsage([{ at: 4, sessionId: source.id, type: 'usage', usage }]);
      const host: SourceRetentionHost & { sessions: Pick<SessionManager, 'stop'> } = { root, events, assertBudget: () => undefined,
        telemetry: () => ({ observedUsage: sourceUsage, sourceSessionIds: [source.id], sourceUsage, missionUsage: observedUsage([]) }),
        store: { sessionDir: () => sessionDir }, sessions: {
          get: () => source, transcript: async () => structuredClone(items), flushPendingPersists: async () => undefined,
          activity: () => ({ active: true, starting: false, turn: false, tools: 0, approvals: 0, compacting: false, queued: 0, tearingDown: false, uncertain: false, quiescent: true }),
          stop: async () => { throw new Error('Read-only source retention must not request Stop.'); },
        } };
      await check(host, items, source);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  it('retains the completed plan discussion without Stop or a closed ordinary runtime', async () => {
    await sourceBoundary(async (host, items, source) => {
      const retained = await retainSourceDiscussion(host, source.id, items);
      expect(retained.meta).toEqual(source); expect(retained.items).toEqual(items);
      expect(host.sessions.activity(source.id)).toMatchObject({ active: true, quiescent: true });
      expect(host.events.some((event) => event.status === 'stopped')).toBe(false);
      expect(retained.transcriptBytes).toBe(await fs.readFile(path.join(host.store.sessionDir(source.id), 'transcript.jsonl'), 'utf8'));
      const artifact = JSON.parse(await fs.readFile(path.join(host.root, 'source-discussion.json'), 'utf8'));
      expect(artifact).toMatchObject({ meta: source, items, completedTurn: { itemId: 'turn', status: 'completed' },
        readTools: [{ itemId: 'read', tool: 'read', status: 'done' }], activity: { active: true, quiescent: true },
        sourceUsage: { tokens: 16, costUsd: 0.01 }, missionUsage: { tokens: null, costUsd: null } });
      expect(retained.settledAt).toBeGreaterThanOrEqual(retained.completedTurn.at);
      expect(artifact).not.toHaveProperty('stopped'); expect(artifact).not.toHaveProperty('stopRequestedAt');
      expect(existsSync(path.join(host.root, 'source-user-actions.jsonl'))).toBe(false);
    });
  });
  it('refuses writable tools even if idle metadata and an eventual read result appear safe', async () => {
    await sourceBoundary(async (host, items, source) => {
      for (const tool of ['write', 'edit', 'bash', 'subagent', 'mission_task_claim']) {
        host.events[0].tool = tool;
        await expect(retainSourceDiscussion(host, source.id, items)).rejects.toThrow('only file inspection');
      }
      host.events[0].tool = 'read';
      for (const name of ['write', 'edit', 'bash']) {
        items[0] = { id: 'read', kind: 'tool', ts: 1, name, status: 'done' };
        await expect(retainSourceDiscussion(host, source.id, items)).rejects.toThrow('never writable or pending');
      }
      expect(existsSync(path.join(host.root, 'source-discussion.json'))).toBe(false);
    });
  });
  it('refuses pending or failed reads rather than trusting an idle status or old successful upsert', async () => {
    await sourceBoundary(async (host, items, source) => {
      host.events.push({ ...host.events[1], at: 5, status: 'running' });
      await expect(retainSourceDiscussion(host, source.id, items)).rejects.toThrow('Pending reads');
      host.events.pop();
      for (const status of ['error', 'declined']) {
        host.events[1].status = status;
        await expect(retainSourceDiscussion(host, source.id, items)).rejects.toThrow('inspection must succeed');
      }
      host.events[1].status = 'done';
      items[0] = { id: 'read', kind: 'tool', ts: 1, name: 'read', status: 'running' };
      await expect(retainSourceDiscussion(host, source.id, items)).rejects.toThrow('never writable or pending');
      expect(existsSync(path.join(host.root, 'source-discussion.json'))).toBe(false);
    });
  });
  it('requires the actual completed turn and settled plan-only activity, never idle alone', async () => {
    await sourceBoundary(async (host, items, source) => {
      const retain = () => retainSourceDiscussion(host, source.id, items);
      source.config.permissionMode = 'auto'; await expect(retain()).rejects.toThrow('fixed plan-mode'); source.config.permissionMode = 'plan';
      const turn = host.events.splice(2, 1)[0]; await expect(retain()).rejects.toThrow('Exactly one actual terminal source turn'); host.events.push(turn);
      turn.status = 'interrupted'; await expect(retain()).rejects.toThrow('Interrupted/failed source turns'); turn.status = 'completed';
      const idle = host.sessions.activity(source.id);
      for (const patch of [{ tools: 1 }, { turn: true }, { queued: 1 }, { uncertain: true }]) {
        host.sessions.activity = () => ({ ...idle, ...patch });
        await expect(retain()).rejects.toThrow('must actually settle');
      }
      expect(existsSync(path.join(host.root, 'source-discussion.json'))).toBe(false);
    });
  });
});

describe('live driver parameter guards', () => {
  it('retains the approved defaults and requires an explicit paid demo selection', () => {
    expect(driverBounds({})).toEqual({ maxTokens: 2_000_000, maxBudgetUsd: 12, deadlineMs: 480_000, maxTurns: 36, maxToolCalls: 160 });
    expect(() => validateSelection(undefined, false)).not.toThrow();
    expect(() => validateSelection(undefined, true)).toThrow('explicitly select');
    for (const value of ['', 'D', 'A,B', 'all']) expect(() => validateSelection(value, false)).toThrow('explicitly select');
    for (const value of ['A', 'B', 'C']) expect(() => validateSelection(value, true)).not.toThrow();
  });
  it.each([6_000_000, 8_000_000])('accepts the explicit %i-token / USD 20 / 20-minute proposal without raising turns/tools', (maxTokens) => {
    expect(driverBounds({ VOCS_CODE_MISSION_LIVE_MAX_TOKENS: String(maxTokens), VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD: '20', VOCS_CODE_MISSION_LIVE_DEADLINE_MS: '1200000' }))
      .toEqual({ maxTokens, maxBudgetUsd: 20, deadlineMs: 1_200_000, maxTurns: 36, maxToolCalls: 160 });
  });
  it.each(['VOCS_CODE_MISSION_LIVE_MAX_TOKENS', 'VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD', 'VOCS_CODE_MISSION_LIVE_DEADLINE_MS'])('rejects invalid or unbounded %s values', (key) => {
    for (const value of ['', ' ', '0', '-1', 'NaN', 'Infinity', '-Infinity', '1e309', 'unlimited', '8M']) expect(() => driverBounds({ [key]: value }), value).toThrow(key);
  });
  it('rejects fractional integer caps, production cap overflow and timer overflow while allowing cents', () => {
    for (const key of ['VOCS_CODE_MISSION_LIVE_MAX_TOKENS', 'VOCS_CODE_MISSION_LIVE_DEADLINE_MS']) expect(() => driverBounds({ [key]: '1.5' })).toThrow(key);
    expect(() => driverBounds({ VOCS_CODE_MISSION_LIVE_MAX_TOKENS: String(MISSION_LIMIT_MAXIMUMS.maxTokens + 1) })).toThrow('MAX_TOKENS');
    expect(() => driverBounds({ VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD: String(MISSION_LIMIT_MAXIMUMS.maxBudgetUsd + 1) })).toThrow('MAX_BUDGET_USD');
    expect(() => driverBounds({ VOCS_CODE_MISSION_LIVE_DEADLINE_MS: String(MAX_DEADLINE_MS + 1) })).toThrow('DEADLINE_MS');
    expect(driverBounds({ VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD: '0.25' }).maxBudgetUsd).toBe(0.25);
  });
  it('retains one whole-demo deadline across source, conversion and a real journal reload', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-deadline-'));
    try {
      const first = await retainDriverRun(root, DEFAULT_BOUNDS, 1_000);
      expect(await retainDriverRun(root, DEFAULT_BOUNDS, 400_000)).toEqual(first);
      expect(() => assertDriverDeadline(first, 480_999)).not.toThrow();
      expect(() => assertDriverDeadline(first, 481_000)).toThrow('whole-demo deadline');
      await expect(retainDriverRun(root, { ...DEFAULT_BOUNDS, maxTokens: 8_000_000 }, 400_000)).rejects.toThrow('cannot silently change');
      expect(JSON.parse(await fs.readFile(path.join(root, 'driver-bounds.json'), 'utf8'))).toEqual(first);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('refuses to create a replacement Mission when the requested recovery identity is missing or different', () => {
    expect(() => assertRecoveryIdentity(undefined, undefined)).not.toThrow(); // Only the initial C launch can create.
    expect(() => assertRecoveryIdentity('retained', 'retained')).not.toThrow();
    expect(() => assertRecoveryIdentity(undefined, 'retained')).toThrow('refusing an automatic whole-Mission retry');
    expect(() => assertRecoveryIdentity('different', 'retained')).toThrow('refusing an automatic whole-Mission retry');
  });
  it('does not raise the 36-turn and 160-tool caps when token/cost/deadline overrides increase', () => {
    const limits = driverBounds({ VOCS_CODE_MISSION_LIVE_MAX_TOKENS: '8000000', VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD: '20', VOCS_CODE_MISSION_LIVE_DEADLINE_MS: '1200000' });
    expect(() => assertDriverCounts(36, 160, limits)).not.toThrow();
    expect(() => assertDriverCounts(37, 160, limits)).toThrow();
    expect(() => assertDriverCounts(36, 161, limits)).toThrow();
  });
});

describe('live driver telemetry guards', () => {
  const sample = (sessionId: string, tokens: number, costUsd: number): EventStamp => ({ at: Date.now(), sessionId, type: 'usage',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: tokens, cacheWriteTokens: 0, reasoningTokens: 100, costUsd, turns: 0 } });
  it('stops on aggregate cache-inclusive tokens even when each live participant is below the bound', () => {
    const usage = observedUsage([sample('lead', 1_000_000, 2), sample('worker', 1_000_000, 2)]);
    expect(usage.tokens).toBe(DEFAULT_BOUNDS.maxTokens);
    expect(() => assertObservedBudget(usage, DEFAULT_BOUNDS)).toThrow('aggregate observed-token threshold');
  });
  it('stops on aggregate observed cost independently of tokens', () => {
    const usage = observedUsage([sample('lead', 10, 6), sample('worker', 20, 6)]);
    expect(usage.costUsd).toBe(DEFAULT_BOUNDS.maxBudgetUsd);
    expect(() => assertObservedBudget(usage, DEFAULT_BOUNDS)).toThrow('aggregate observed-cost threshold');
  });
  it('does not double-count cumulative snapshots or turn reasoning into extra tokens', () => {
    const usage = observedUsage([sample('lead', 100, 1), sample('lead', 100, 1), sample('lead', 200, 2), sample('worker', 300, 3)]);
    expect(usage).toMatchObject({ tokens: 500, costUsd: 5, unknownTokenSessionIds: [], unknownCostSessionIds: [] });
    expect(() => assertObservedBudget(usage, DEFAULT_BOUNDS)).not.toThrow();
  });
  it.each([2_000_000, 6_000_000, 8_000_000])('counts ordinary source spend against the effective %i-token cap, with unknown Mission telemetry retained', (maxTokens) => {
    const limits = driverBounds({ VOCS_CODE_MISSION_LIVE_MAX_TOKENS: String(maxTokens), VOCS_CODE_MISSION_LIVE_MAX_BUDGET_USD: '20' });
    const known = [sample('ordinary-source', 100_000, 1), sample('lead', maxTokens - 100_001, 2)];
    const partial = observedUsage([...known, { at: Date.now(), sessionId: 'unreported-worker', type: 'status', status: 'running' }]);
    expect(partial).toMatchObject({ tokens: maxTokens - 1, costUsd: 3, unknownTokenSessionIds: ['unreported-worker'], unknownCostSessionIds: ['unreported-worker'] });
    expect(() => assertObservedBudget(partial, limits)).not.toThrow();
    expect(() => assertObservedBudget(observedUsage([...known, sample('lead', maxTokens - 100_000, 2)]), limits)).toThrow('aggregate observed-token threshold');
    expect(() => assertObservedBudget(observedUsage([sample('ordinary-source', 10, 1), sample('lead', 10, 19)]), limits)).toThrow('aggregate observed-cost threshold');
  });
  it('retains unknown usage and cost rather than fabricating zero', () => {
    const events: EventStamp[] = [{ at: Date.now(), sessionId: 'unreported', type: 'status', status: 'running' }];
    expect(observedUsage(events)).toMatchObject({ tokens: null, costUsd: null, unknownTokenSessionIds: ['unreported'], unknownCostSessionIds: ['unreported'] });
    expect(observedUsage([sample('unpriced', 50, 0)])).toMatchObject({ tokens: 50, costUsd: null, unknownCostSessionIds: ['unpriced'] });
    expect(observedUsage([...events, sample('known', 20, 1)])).toMatchObject({ tokens: 20, costUsd: 1, unknownCostSessionIds: ['unreported'] });
  });
  it('enforces the same aggregate after reloading the real append-only host journal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-budget-'));
    try {
      await fs.writeFile(path.join(root, 'events.jsonl'), [sample('lead', 1_500_000, 3), sample('worker', 500_000, 2)].map((event) => JSON.stringify(event)).join('\n') + '\n');
      const usage = observedUsage(await readEventJournal(root));
      expect(() => assertObservedBudget(usage, DEFAULT_BOUNDS)).toThrow('aggregate observed-token threshold');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe.skipIf(!live && !metadata)('live Mission demonstration', () => {
  beforeAll(preflight, 60_000);
  it('metadata: real available Pi models without provider spend', () => { expect(catalog.some((m) => m.id === preset.model.model && m.provider === preset.model.provider)).toBe(true); });
  if (childHost) it.skipIf(!live)('internal runtime host', internalHost, bounds.deadlineMs + 60_000);
  else {
    for (const demo of ['A', 'B'] as const) it.skipIf(!live || !!selected && selected !== demo)(`Demo ${demo}: genuine source conversation, model-owned planning, work, independent review, TAP and local delivery`, () => runDemo(demo), bounds.deadlineMs + 120_000);
    it.skipIf(!live || !!selected && selected !== 'C')('Demo C: interruption, integration conflict and real host-process restart', runRecovery, bounds.deadlineMs + 120_000);
  }
  afterAll(() => { if (runRoot) console.log(`Retained live Mission evidence: ${runRoot}`); });
});
