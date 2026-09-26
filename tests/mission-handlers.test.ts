/** Mission's privileged transport boundary, not renderer visibility: registered handlers with
 * mocked mutation ports and real filesystem aliases. No harness or user repository is touched. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandlerRegistry, type HandlerDeps, type SaveDialogOptions } from '../src/main/handlers';
import type { CreateMissionRequest, MissionControlRequest, MissionRecord } from '../src/shared/mission';
import { MISSION_NOT_LINKED_MESSAGE } from '../src/shared/mission-command';
import { isMissionRevisionConflict, missionRevisionConflictMessage } from '../src/shared/mission-errors';
import type { SessionMeta, UserInput } from '../src/shared/types';
import { SettingsStore } from '../src/main/settings';
import { missionDeliveryBranch } from '../src/main/mission/delivery';
import type { TargetObservation } from '../src/main/mission/workspaces';
import { missionFixture } from './support/mission-fixture';
import * as git from '../src/main/git';
import { RemoteHost, REMOTE_CHANNELS, REMOTE_READ_CHANNELS, REMOTE_WRITE_CHANNELS } from '../src/main/remote/host';
import { memoryVault, RelayClient } from '../relay/src/web-client';
import { WebSocket } from 'ws';
import { ENROLL, FakeRelay } from './fake-relay';

const agentBridge = vi.hoisted(() => ({ invoke: undefined as undefined | ((channel: string, req: unknown) => Promise<unknown>) }));
vi.mock('../src/main/agents', () => ({ Vesta: class {
  constructor(deps: { invoke: (channel: string, req: unknown) => Promise<unknown> }) { agentBridge.invoke = deps.invoke; }
  async dispose() {}
} }));

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-handler-'));
  dirs.push(dir);
  const root = path.join(dir, 'project');
  const leadPath = path.join(dir, 'lead');
  const workerPath = path.join(dir, 'worker');
  const integrationPath = path.join(dir, 'integration');
  const verificationPath = path.join(dir, 'verification');
  await Promise.all([root, leadPath, workerPath, integrationPath, verificationPath].map((p) => fs.mkdir(p)));
  expect(spawnSync('git', ['init', root], { encoding: 'utf8' }).status).toBe(0);
  const settings = new SettingsStore(path.join(dir, 'settings'));
  await settings.load();
  await settings.update({ folders: [root] });
  const meta = (id: string, cwd: string): SessionMeta => ({
    id, title: id, cwd, createdAt: 1, updatedAt: 1, status: 'idle', harnessRef: {},
    config: { harness: 'pi', projectRoot: root, permissionMode: 'ask', model: { provider: 'fixture', model: 'small' } },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  });
  const source = meta('source', root);
  const lead = meta('lead', leadPath);
  const worker = meta('worker', workerPath);
  lead.mission = { missionId: 'mission', role: 'lead', generation: 1, sourceAccess: 'assigned_workspace', requestedTools: [], reasoningDefault: true };
  worker.mission = { ...lead.mission, role: 'worker', attemptId: 'attempt' };
  const live = [source, lead, worker];
  let record = missionFixture({
    projectRoot: root, sourceCwd: root, leadSessionId: lead.id, entryMode: 'autonomous', phase: 'executing',
    executionAuthorization: { kind: 'autonomous_launch', sourceUserActionId: 'launch', specificationRevision: 1, recordedAt: 1 },
    workspaces: [
      { id: 'lead-workspace', role: 'lead', path: leadPath, branch: 'mission/lead', ownerSessionId: lead.id },
      { id: 'worker-workspace', role: 'worker', path: workerPath, branch: 'mission/worker', ownerSessionId: worker.id },
      { id: 'integration-workspace', role: 'integration', path: integrationPath, branch: 'mission/integration' },
      { id: 'verification-workspace', role: 'verification', path: verificationPath, branch: 'mission/verification' }
    ].map((w) => ({ ...w, base: { baseCommitSha: 'base', contentHash: 'tree' } })) as MissionRecord['workspaces']
  });
  const missions = {
    get: vi.fn((id: string) => id === record.id ? record : undefined),
    list: vi.fn(() => [record]),
    create: vi.fn(async (_req: CreateMissionRequest) => ({ ...record, id: 'new-mission', leadSessionId: 'new-lead' })),
    control: vi.fn(async (req: MissionControlRequest) => {
      record = { ...record, revision: record.revision + 1 };
      if (req.control.action === 'pause') record.status = 'paused';
      if (req.control.action === 'continue_planning') { record.phase = 'planning'; record.pendingProposal = undefined; }
      return record;
    }),
    sendUser: vi.fn(async (_id: string, _input: UserInput, _key?: string) => record),
    archive: vi.fn(async (_id: string, archived: boolean) => { record = { ...record, archived }; })
  };
  const sessions = {
    get: vi.fn((id: string) => live.find((s) => s.id === id)), list: vi.fn(() => live),
    create: vi.fn(async () => source), send: vi.fn(async () => undefined),
    interrupt: vi.fn(), stop: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), setArchived: vi.fn(async () => source),
    editAndResend: vi.fn(), setModel: vi.fn(), setEffort: vi.fn(), setPermissionMode: vi.fn(), compact: vi.fn(),
    clearTranscript: vi.fn(), fork: vi.fn(), moveTo: vi.fn(), goal: vi.fn(), subagentCommand: vi.fn(),
    respondApproval: vi.fn()
  };
  const terminals = {
    list: vi.fn(() => [] as Array<{ id: string; sessionId: string; cwd: string }>), closeForSession: vi.fn(async (_id: string) => undefined),
    create: vi.fn((sessionId: string) => ({ id: `t-${sessionId}`, sessionId, cwd: live.find((s) => s.id === sessionId)!.cwd })),
    input: vi.fn(), resize: vi.fn(), attach: vi.fn(), restart: vi.fn()
  };
  const desktop = {
    userDataPath: () => dir, documentsPath: () => dir,
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [root] })),
    showSaveDialog: vi.fn(async (_opts: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true }))
  };
  const deps = {
    settings, sessions, terminals, missions, desktop,
    secrets: {}, analytics: {}, search: {}, runtime: { resolve: () => null },
    log: vi.fn(), push: vi.fn()
  } as unknown as HandlerDeps;
  return { registry: createHandlerRegistry(deps), deps, settings, sessions, terminals, missions, desktop, source, lead, worker, live, root, dir, leadPath, workerPath, integrationPath, verificationPath, meta, record: () => record, patch: (p: Partial<MissionRecord>) => { record = { ...record, ...p }; } };
}

const command = (sessionId: string, text: string, idempotencyKey = 'command-1') => ({ sessionId, text, idempotencyKey });

describe('Mission user IPC', () => {
  it('rejects images on dialog/status/control commands visibly before any state change or approval', async () => {
    const r = await rig();
    const images = [{ mimeType: 'image/png', data: 'aW1hZ2U=', name: 'material.png' }];
    r.patch({ pendingProposal: { id: 'proposal', specificationRevision: 1, planRevision: 0, assistantMessageId: 'assistant', requestedAt: 1 } });
    for (const text of ['/mission', '/mission status', '/mission execute', '/mission pause', '/mission resume', '/mission stop']) {
      await expect(r.registry.invoke('missions:command', { ...command('lead', text), images })).rejects.toThrow(/images.*objective|attachments/i);
    }
    expect(r.missions.create).not.toHaveBeenCalled(); expect(r.missions.control).not.toHaveBeenCalled(); expect(r.missions.sendUser).not.toHaveBeenCalled();
    for (const image of [{ mimeType: 'image/png', data: '', name: 'empty.png' }, { ...images[0], path: '/forged/path' }]) {
      await expect(r.registry.invoke('missions:command', { ...command('source', '/mission Inspect'), images: [image] })).rejects.toThrow();
    }
    expect(r.missions.create).not.toHaveBeenCalled();
  });

  it('forwards command launch images with the actual source and submitted command, including an explicit sibling', async () => {
    const r = await rig(), images = [{ mimeType: 'image/png', data: 'aW1hZ2U=', name: 'current.png' }];
    for (const [id, text] of [['source', '  /mission plan Inspect this design  '], ['lead', '/mission start -- inspect a sibling design']]) {
      await r.registry.invoke('missions:command', { ...command(id, text, `image-${id}`), images });
      expect(r.missions.create).toHaveBeenLastCalledWith(expect.objectContaining({ originSessionId: id, submittedCommand: text, images, idempotencyKey: `image-${id}` }));
    }
    expect(r.missions.create).toHaveBeenCalledTimes(2); expect(r.sessions.send).not.toHaveBeenCalled();
    await expect(agentBridge.invoke!('missions:command', { ...command('source', '/mission Inspect'), images })).rejects.toThrow(/agent tool/);
    expect(r.missions.create).toHaveBeenCalledTimes(2);
  });

  it('validates reads and returns persisted records without invoking a harness', async () => {
    const r = await rig();
    expect(await r.registry.invoke('missions:list', undefined)).toEqual([r.record()]);
    expect(await r.registry.invoke('missions:get', { missionId: 'mission' })).toEqual(r.record());
    expect(await r.registry.invoke('missions:get', { missionId: 'missing' })).toBeNull();
    await expect(r.registry.invoke('missions:get', { missionId: '../secret' })).rejects.toThrow();
    expect(r.sessions.send).not.toHaveBeenCalled();
  });

  it('exports the latest authoritative plan without a write, chooser, model turn or control transition', async () => {
    const r = await rig();
    const file = path.join(r.root, 'plan.md');
    await fs.writeFile(file, 'Existing source plan must survive');
    const before = structuredClone(r.record());
    const first = await r.registry.invoke('missions:exportPlan', { missionId: 'mission' }) as { markdown: string; suggestedName: string };
    expect(first.suggestedName).toBe('plan.md');
    expect(first.markdown).toContain('Specification 1 · Plan 0');
    r.patch({ revision: 8, planRevision: 4, specificationRevision: 3, plan: { ...r.record().plan, scope: 'The current committed scope' } });
    const latest = structuredClone(r.record());
    const exported = await r.registry.invoke('missions:exportPlan', { missionId: 'mission' }) as { markdown: string; suggestedName: string };
    expect(exported).toEqual({ suggestedName: 'plan.md', markdown: expect.stringContaining('The current committed scope') });
    expect(exported.markdown).toContain('Specification 3 · Plan 4');
    expect(exported.markdown).not.toBe(first.markdown);
    expect(r.record()).toEqual(latest);
    expect(before.plan.scope).not.toBe(latest.plan.scope);
    for (const req of [{ missionId: 'missing' }, { missionId: '../secret' }, { missionId: 'mission', path: file }, { missionId: 'mission', record: before }, { missionId: 'mission', expectedRevision: 1 }]) {
      await expect(r.registry.invoke('missions:exportPlan', req)).rejects.toThrow();
    }
    await expect(agentBridge.invoke!('missions:exportPlan', { missionId: 'mission' })).rejects.toThrow(/agent tool/);
    r.patch({ plan: { ...latest.plan, exclusions: Array.from({ length: 20 }, () => 'é'.repeat(50_000)) } });
    await expect(r.registry.invoke('missions:exportPlan', { missionId: 'mission' })).rejects.toThrow('1 MiB limit');
    expect(r.desktop.showSaveDialog).not.toHaveBeenCalled();
    expect(r.missions.create).not.toHaveBeenCalled(); expect(r.missions.control).not.toHaveBeenCalled(); expect(r.sessions.send).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('Existing source plan must survive');
    expect(await fs.readdir(r.leadPath)).toEqual([]);
  });

  it('saves exported text only to the genuine desktop chooser result and treats cancellation as no write', async () => {
    const r = await rig();
    const exported = await r.registry.invoke('missions:exportPlan', { missionId: 'mission' }) as { markdown: string; suggestedName: string };
    const request = { content: exported.markdown, suggestedName: exported.suggestedName };
    const file = path.join(r.dir, 'chosen-plan.md');
    r.desktop.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: file });
    expect(await r.registry.invoke('app:fileSaveAs', request)).toEqual({ path: null });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(r.desktop.showSaveDialog).toHaveBeenCalledExactlyOnceWith({ defaultPath: path.join(r.dir, 'plan.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
    r.desktop.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: file });
    expect(await r.registry.invoke('app:fileSaveAs', request)).toEqual({ path: file });
    expect(await fs.readFile(file, 'utf8')).toBe(exported.markdown);
    expect(await fs.readdir(r.root)).toEqual(['.git']);
    const authoritative = structuredClone(r.record());
    await fs.writeFile(file, '# Edited export is not authority');
    expect(r.record()).toEqual(authoritative);
    const again = await r.registry.invoke('missions:exportPlan', { missionId: 'mission' }) as { markdown: string };
    expect(again.markdown).toBe(exported.markdown);
    const calls = r.desktop.showSaveDialog.mock.calls.length;
    for (const req of [{ ...request, path: file }, { ...request, suggestedName: '../escape.md' }, { ...request, suggestedName: 'C:\\escape.md' }, { ...request, content: 'x'.repeat(1_048_577) }, { ...request, content: 'é'.repeat(600_000) }]) {
      await expect(r.registry.invoke('app:fileSaveAs', req)).rejects.toThrow();
    }
    await expect(agentBridge.invoke!('app:fileSaveAs', request)).rejects.toThrow(/agent tool/);
    expect(r.desktop.showSaveDialog).toHaveBeenCalledTimes(calls);
    expect(r.missions.control).not.toHaveBeenCalled(); expect(r.sessions.send).not.toHaveBeenCalled();
  });

  it('refuses export saves into retained owned workspaces, filesystem aliases and unresolved session ownership', async () => {
    const r = await rig();
    const alias = path.join(r.dir, 'worker-alias');
    await fs.symlink(r.workerPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const request = { content: '# Read-only export', suggestedName: 'plan.md' };
    r.patch({ status: 'recovering', blockers: [{ id: 'uncertain', kind: 'unknown', message: 'Writer ownership unresolved' }] });
    for (const dir of [r.leadPath, r.workerPath, r.integrationPath, r.verificationPath, alias]) {
      const file = path.join(dir, 'plan.md');
      await fs.writeFile(file, 'Retained work');
      r.desktop.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: file });
      await expect(r.registry.invoke('app:fileSaveAs', request)).rejects.toThrow(/Mission/);
      expect(await fs.readFile(file, 'utf8')).toBe('Retained work');
      const absent = path.join(dir, 'new-plan.md');
      r.desktop.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: absent });
      await expect(r.registry.invoke('app:fileSaveAs', request)).rejects.toThrow(/Mission/);
      await expect(fs.stat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    r.missions.list.mockReturnValue([]); // The independent session fence survives a missing/corrupt journal.
    r.worker.worktreeBranch = 'mission/worker';
    r.desktop.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path.join(alias, 'plan.md') });
    await expect(r.registry.invoke('app:fileSaveAs', request)).rejects.toThrow(/Mission/);
    expect(await fs.readFile(path.join(r.workerPath, 'plan.md'), 'utf8')).toBe('Retained work');
  });

  it('launches from the actual source without changing its model, permissions, cwd, or running turn', async () => {
    const r = await rig();
    r.source.status = 'running';
    const before = structuredClone(r.source);
    const text = '  /mission plan Build the exporter  ';
    expect(await r.registry.invoke('missions:command', command('source', text))).toMatchObject({ kind: 'created', mission: { id: 'new-mission' }, sessionId: 'new-lead' });
    expect(r.missions.create).toHaveBeenCalledExactlyOnceWith({
      projectRoot: r.root, originSessionId: 'source', objective: 'Build the exporter', mode: 'interactive_plan',
      permissionMode: 'ask', submittedCommand: text, idempotencyKey: 'command-1'
    });
    expect(r.source).toEqual(before);
    expect(r.sessions.interrupt).not.toHaveBeenCalled();
    expect(r.sessions.send).not.toHaveBeenCalled();
  });

  it('uses exact parsing and rejects invalid controls before any service mutation', async () => {
    const r = await rig();
    for (const text of ['/missionary', '/mission execute now', '/mission pause extra', '/mission --yes', '/mission plan', '/mission start']) {
      await expect(r.registry.invoke('missions:command', command('source', text))).rejects.toThrow();
    }
    for (const req of [command('missing', '/mission hi'), { ...command('source', '/mission hi'), projectRoot: r.root }, { ...command('source', '/mission hi'), actor: 'user' }]) {
      await expect(r.registry.invoke('missions:command', req)).rejects.toThrow();
    }
    expect(r.missions.create).not.toHaveBeenCalled();
    expect(r.missions.control).not.toHaveBeenCalled();
  });

  it('shows creation/status without a model turn and steers an active lead rather than nesting', async () => {
    const r = await rig();
    expect(await r.registry.invoke('missions:command', command('source', '/mission'))).toEqual({ kind: 'show' });
    expect(await r.registry.invoke('missions:command', command('lead', '/mission'))).toMatchObject({ kind: 'show', mission: { id: 'mission' } });
    expect(await r.registry.invoke('missions:command', command('lead', '/mission status'))).toMatchObject({ kind: 'status', mission: { id: 'mission' } });
    await r.registry.invoke('missions:command', command('lead', '/mission Add CSV export'));
    expect(r.missions.sendUser).toHaveBeenCalledExactlyOnceWith('lead', { text: '/mission Add CSV export' }, 'command-1:steer');
    expect(r.missions.create).not.toHaveBeenCalled();
    expect(r.sessions.send).not.toHaveBeenCalled();
  });

  it('answers /mission status in a session without a Mission with a visible message, not silence', async () => {
    const r = await rig();
    expect(await r.registry.invoke('missions:command', command('source', '/mission status'))).toEqual({ kind: 'status', message: MISSION_NOT_LINKED_MESSAGE });
    expect(await r.registry.invoke('missions:command', command('lead', '/mission status'))).toEqual({ kind: 'status', mission: r.record(), sessionId: 'lead' });
    expect(r.missions.create).not.toHaveBeenCalled(); expect(r.missions.control).not.toHaveBeenCalled(); expect(r.missions.sendUser).not.toHaveBeenCalled();
  });

  it('refuses a stale control with the recognised revision conflict, so the UI can bind the newer record', async () => {
    const r = await rig();
    r.patch({ status: 'running' });
    const stale = r.registry.invoke('missions:control', { missionId: 'mission', expectedRevision: 0, idempotencyKey: 'stale-pause', control: { action: 'pause' } });
    await expect(stale).rejects.toThrow(missionRevisionConflictMessage(0, 1));
    expect(isMissionRevisionConflict(await stale.catch((error: unknown) => error))).toBe(true);
    expect(r.missions.control).not.toHaveBeenCalled();
    // A fresh request bound to the current revision goes through.
    await r.registry.invoke('missions:control', { missionId: 'mission', expectedRevision: 1, idempotencyKey: 'fresh-pause', control: { action: 'pause' } });
    expect(r.missions.control).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedRevision: 1, idempotencyKey: 'fresh-pause' }));
  });

  it('keeps the launch dialog permission choice for a linked launch; a typed /mission keeps the source mode', async () => {
    const r = await rig();
    r.source.config = { ...r.source.config, permissionMode: 'full-auto' };
    await r.registry.invoke('missions:create', { idempotencyKey: 'dialog', projectRoot: r.root, originSessionId: 'source', objective: 'Ship it', mode: 'autonomous', permissionMode: 'plan' });
    expect(r.missions.create).toHaveBeenLastCalledWith(expect.objectContaining({ originSessionId: 'source', projectRoot: r.root, permissionMode: 'plan' }));
    await r.registry.invoke('missions:command', command('source', '/mission Ship it', 'typed'));
    expect(r.missions.create).toHaveBeenLastCalledWith(expect.objectContaining({ originSessionId: 'source', permissionMode: 'full-auto', submittedCommand: '/mission Ship it' }));
    expect(r.missions.create).toHaveBeenCalledTimes(2);
    expect(r.source.config.permissionMode).toBe('full-auto');
  });

  it('pauses before returning to planning, then steers, while explicit start creates a sibling', async () => {
    const r = await rig();
    await r.registry.invoke('missions:command', command('lead', '/mission plan Revise the design'));
    expect(r.missions.control.mock.calls.map(([req]) => req.control.action)).toEqual(['pause', 'continue_planning']);
    expect(r.missions.control.mock.calls.map(([req]) => req.expectedRevision)).toEqual([1, 2]);
    expect(r.missions.sendUser).toHaveBeenCalledExactlyOnceWith('lead', { text: '/mission plan Revise the design' }, 'command-1:steer');
    await r.registry.invoke('missions:command', command('lead', '/mission start -- execute a separate task', 'sibling'));
    expect(r.missions.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ originSessionId: 'lead', objective: 'execute a separate task', mode: 'autonomous', projectRoot: r.root, submittedCommand: '/mission start -- execute a separate task' }));
  });

  it('rejects stale or fabricated approval inputs and never approves an absent proposal', async () => {
    const r = await rig();
    await expect(r.registry.invoke('missions:command', command('lead', '/mission execute'))).rejects.toThrow(/proposal|plan/i);
    r.patch({ pendingProposal: { id: 'proposal', specificationRevision: 1, planRevision: 0, assistantMessageId: 'assistant', requestedAt: 1 } });
    const req = { missionId: 'mission', expectedRevision: 1, idempotencyKey: 'approve', control: { action: 'execute', proposalId: 'old', specificationRevision: 1 } };
    await expect(r.registry.invoke('missions:control', req)).rejects.toThrow(/stale|proposal/i);
    await expect(r.registry.invoke('missions:control', { ...req, expectedRevision: 0 })).rejects.toThrow(/stale|revision/i);
    await expect(r.registry.invoke('missions:control', { ...req, actor: 'user' })).rejects.toThrow();
    expect(r.missions.control).not.toHaveBeenCalled();
    await r.registry.invoke('missions:command', command('lead', '/mission execute'));
    expect(r.missions.control).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ control: { action: 'execute', proposalId: 'proposal', specificationRevision: 1 }, submittedCommand: '/mission execute' }));
  });

  it('accepts only an explicit user publication reduction, never model/user-role forgery or extra endpoint authority', async () => {
    const r = await rig();
    const request = { missionId: 'mission', expectedRevision: 1, idempotencyKey: 'local-only', control: { action: 'narrow_delivery', endpoint: 'local_commit' } };
    for (const invalid of [
      { ...request, expectedRevision: 0 }, { ...request, actor: 'user' },
      ...['merge_pr', 'custom'].map((endpoint) => ({ ...request, control: { ...request.control, endpoint } })),
      ...['remote', 'targetBranch', 'url', 'allowPush', 'allowMerge', 'checks', 'requireIndependentReview', 'holdConditions', 'holdIsEndpoint', 'sourceUserActionId'].map((field) => ({ ...request, control: { ...request.control, [field]: 'forged' } })),
    ]) await expect(r.registry.invoke('missions:control', invalid)).rejects.toThrow();
    await expect(agentBridge.invoke!('missions:control', request)).rejects.toThrow(/agent tool/);
    await expect(agentBridge.invoke!('missions:control', { ...request, actor: 'user' })).rejects.toThrow(/agent tool/);
    expect(r.missions.control).not.toHaveBeenCalled();
    await r.registry.invoke('missions:control', request);
    expect(r.missions.control).toHaveBeenCalledExactlyOnceWith(request);
    await r.registry.invoke('missions:control', { ...request, expectedRevision: r.record().revision, idempotencyKey: 'no-merge', control: { action: 'narrow_delivery', endpoint: 'open_pr' } });
    expect(r.missions.control).toHaveBeenCalledTimes(2);
  });

  it('rejects spoofed source projects and unknown/nonexistent direct-launch roots before creation', async () => {
    const r = await rig();
    const request = { idempotencyKey: 'launch', projectRoot: r.root, objective: 'Ship', mode: 'autonomous', permissionMode: 'ask' };
    for (const req of [
      { ...request, originSessionId: 'missing' },
      { ...request, originSessionId: 'source', projectRoot: r.workerPath },
      { ...request, projectRoot: r.workerPath },
      { ...request, projectRoot: path.join(r.root, 'missing') },
      { ...request, sourceCwd: r.workerPath },
      { ...request, mission: { role: 'lead' } },
      { ...request, objective: 9 }
    ]) await expect(r.registry.invoke('missions:create', req)).rejects.toThrow();
    expect(r.missions.create).not.toHaveBeenCalled();
    await r.registry.invoke('missions:create', request);
    expect(r.missions.create).toHaveBeenCalledTimes(1);
    await r.settings.update({ folders: [] });
    r.live.splice(0);
    await expect(r.registry.invoke('missions:create', request)).rejects.toThrow(/folder|project/i);
    await r.registry.invoke('app:pickFolder', {});
    await r.registry.invoke('missions:create', request);
    expect(r.missions.create).toHaveBeenCalledTimes(2);
  });

  it('routes user chat to the lead and rejects worker chat and a second goal loop before runtime', async () => {
    const r = await rig();
    await r.registry.invoke('sessions:send', { id: 'lead', input: { text: 'Keep the API stable', mode: 'steer' } });
    expect(r.missions.sendUser).toHaveBeenCalledExactlyOnceWith('lead', { text: 'Keep the API stable', mode: 'steer' }, undefined);
    for (const id of ['lead', 'worker']) {
      await expect(r.registry.invoke('sessions:send', { id, input: { text: '/goal do more' } })).rejects.toThrow(/Mission/);
      await expect(r.registry.invoke('sessions:goal', { id, action: 'set', objective: 'more' })).rejects.toThrow(/Mission/);
    }
    await expect(r.registry.invoke('sessions:send', { id: 'worker', input: { text: 'implement' } })).rejects.toThrow(/lead|worker/i);
    await expect(r.registry.invoke('missions:command', command('worker', '/mission start -- bypass'))).rejects.toThrow(/lead|worker/i);
    await r.registry.invoke('sessions:send', { id: 'source', input: { text: '/goal ordinary compatibility' } });
    expect(r.sessions.send).toHaveBeenCalledExactlyOnceWith('source', { text: '/goal ordinary compatibility' });
    expect(r.sessions.goal).not.toHaveBeenCalled();
  });

  it('never turns a model-originated registry call into user authorization', async () => {
    const r = await rig();
    await expect(agentBridge.invoke!('missions:command', command('source', '/mission implement'))).rejects.toThrow(/agent tool/);
    await expect(agentBridge.invoke!('sessions:send', { id: 'lead', input: { text: 'yes' } })).rejects.toThrow(/agent tool/);
    await expect(agentBridge.invoke!('sessions:archive', { id: 'lead', archived: true })).rejects.toThrow(/agent tool/);
    expect(r.missions.sendUser).not.toHaveBeenCalled();
    expect(r.missions.create).not.toHaveBeenCalled();
    expect(r.missions.archive).not.toHaveBeenCalled();
  });

  it('archives the whole Mission through its owner, closes only owned terminals and preserves worktrees', async () => {
    const r = await rig();
    await r.registry.invoke('sessions:archive', { id: 'lead', archived: true, removeWorktree: true, forceWorktree: true });
    expect(r.missions.archive).toHaveBeenCalledExactlyOnceWith('mission', true);
    expect(r.terminals.closeForSession.mock.calls.map(([id]) => id).sort()).toEqual(['lead', 'worker']);
    expect(r.sessions.setArchived).not.toHaveBeenCalled();
    expect(r.sessions.delete).not.toHaveBeenCalled();
    await expect(r.registry.invoke('sessions:archive', { id: 'worker', archived: true })).rejects.toThrow(/Mission|lead/);
    await r.registry.invoke('sessions:archive', { id: 'source', archived: true });
    expect(r.sessions.setArchived).toHaveBeenCalledExactlyOnceWith('source', true, undefined, undefined);
  });
});

const mutations: Array<[string, Record<string, unknown>]> = [
  ['sessions:delete', { removeWorktree: true }], ['sessions:editAndResend', { userItemId: 'u', input: { text: 'retry' } }],
  ['sessions:interrupt', {}], ['sessions:stop', {}], ['sessions:setModel', { model: { provider: 'p', model: 'm' } }],
  ['sessions:setEffort', { effort: 'high' }], ['sessions:setPermissionMode', { mode: 'full-auto' }],
  ['sessions:compact', {}], ['sessions:clearTranscript', {}], ['sessions:fork', {}], ['sessions:moveTo', { cwd: '/tmp' }],
  ['subagents:stop', { runId: 'run' }], ['subagents:steer', { runId: 'run', message: 'bypass' }]
];

describe('Mission resource ownership at generic handlers', () => {
  it('refuses lifecycle/model/permission/native-child controls for owned sessions and ordinary aliases', async () => {
    const r = await rig();
    const aliasPath = path.join(r.dir, 'alias');
    await fs.symlink(r.workerPath, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
    r.live.push(r.meta('alias', aliasPath));
    for (const id of ['lead', 'worker', 'alias']) for (const [channel, extra] of mutations) {
      await expect(r.registry.invoke(channel, { id, ...extra }), `${channel} ${id}`).rejects.toThrow(/Mission/);
    }
    for (const [name, fn] of Object.entries(r.sessions)) if (!['get', 'list'].includes(name)) expect(fn, name).not.toHaveBeenCalled();
    expect(r.terminals.closeForSession).not.toHaveBeenCalled();
    await expect(r.registry.invoke('sessions:moveTo', { id: 'source', cwd: aliasPath })).rejects.toThrow(/Mission/);
    await expect(r.registry.invoke('sessions:create', { config: { ...r.source.config, projectRoot: aliasPath } })).rejects.toThrow(/Mission/);
    await expect(r.registry.invoke('folders:remove', { root: r.root })).rejects.toThrow(/Mission/);
  });

  it('denies git mutations by managed path, alias, branch or worktree target, without forbidding ordinary commits', async () => {
    const r = await rig();
    const revert = vi.spyOn(git, 'gitRevertFile').mockResolvedValue({ ok: true });
    const commit = vi.spyOn(git, 'gitCommit').mockResolvedValue({ ok: false, output: 'ordinary boundary reached' });
    const stage = vi.spyOn(git, 'gitStageAll').mockResolvedValue({ ok: true });
    const checkout = vi.spyOn(git, 'gitCheckout').mockResolvedValue({ ok: true });
    const remove = vi.spyOn(git, 'removeWorktree').mockResolvedValue();
    const deleteBranch = vi.spyOn(git, 'gitDeleteBranch').mockResolvedValue({ ok: true });
    const updateBranch = vi.spyOn(git, 'gitUpdateBranch').mockResolvedValue({ ok: true });
    const prune = vi.spyOn(git, 'gitPruneWorktrees').mockResolvedValue({ ok: true, output: '' });
    for (const [index, cwd] of [r.leadPath, r.workerPath, r.integrationPath, r.verificationPath].entries()) {
      const alias = path.join(r.dir, `alias-${index}`);
      await fs.symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
      r.live.push(r.meta(`alias-${index}`, alias));
      for (const [channel, extra] of [['git:revert', { path: 'file' }], ['git:stageAll', {}], ['git:commit', { message: 'bypass' }], ['git:checkout', { branch: 'main' }]] as const) {
        await expect(r.registry.invoke(channel, { sessionId: `alias-${index}`, ...extra })).rejects.toThrow(/Mission/);
      }
      await expect(r.registry.invoke('git:removeWorktree', { sessionId: 'source', path: alias })).rejects.toThrow(/Mission/);
    }
    for (const channel of ['git:checkout', 'git:deleteBranch', 'git:updateBranch']) {
      await expect(r.registry.invoke(channel, { sessionId: 'source', branch: 'mission/worker' })).rejects.toThrow(/Mission/);
    }
    await expect(r.registry.invoke('git:pruneWorktrees', { sessionId: 'source' })).rejects.toThrow(/Mission/);
    for (const fn of [revert, commit, stage, checkout, remove, deleteBranch, updateBranch, prune]) expect(fn).not.toHaveBeenCalled();
    await r.registry.invoke('git:commit', { sessionId: 'source', message: 'ordinary' });
    expect(commit).toHaveBeenCalledExactlyOnceWith(r.root, 'ordinary');
  });

  it('denies worker/integration interactive terminals and aliases but allows the actual assigned lead workspace', async () => {
    const r = await rig();
    r.live.push(r.meta('integration-alias', r.integrationPath));
    for (const sessionId of ['worker', 'integration-alias']) await expect(r.registry.invoke('terminal:create', { sessionId })).rejects.toThrow(/Mission|worker|integration/);
    r.terminals.list.mockReturnValue([{ id: 'hidden', sessionId: 'source', cwd: r.integrationPath }]);
    for (const channel of ['terminal:input', 'terminal:attach', 'terminal:restart']) await expect(r.registry.invoke(channel, { terminalId: 'hidden', data: 'rm file', cols: 80, rows: 24 })).rejects.toThrow(/Mission/);
    await expect(r.registry.invoke('app:openTerminal', { cwd: r.integrationPath })).rejects.toThrow(/Mission/);
    expect(r.terminals.input).not.toHaveBeenCalled();
    expect(r.terminals.attach).not.toHaveBeenCalled();
    expect(r.terminals.restart).not.toHaveBeenCalled();
    expect(r.terminals.create).not.toHaveBeenCalled();
    await r.registry.invoke('terminal:create', { sessionId: 'lead' });
    await r.registry.invoke('terminal:create', { sessionId: 'source' });
    expect(r.terminals.create.mock.calls).toHaveLength(2);
  });

  it('protects the exact delivery branch execution pushes after an approved-target integration', async () => {
    const r = await rig();
    const deleteBranch = vi.spyOn(git, 'gitDeleteBranch').mockResolvedValue({ ok: true });
    const checkout = vi.spyOn(git, 'gitCheckout').mockResolvedValue({ ok: true });
    const observation: TargetObservation = { id: 'o_target', missionId: 'mission', operationId: 'refresh-target', remote: 'origin', targetBranch: 'develop', remoteUrl: 'https://github.com/owner/repo.git',
      commitSha: 'c'.repeat(40), contentHash: 'd'.repeat(40), createdAt: '2026-09-25T00:00:00.000Z', hostHash: 'host' };
    const earlier = { baseCommitSha: 'a'.repeat(40), contentHash: 'e'.repeat(40) };
    r.patch({
      acceptedRevision: { baseCommitSha: 'a'.repeat(40), contentHash: 'b'.repeat(40) },
      operations: [
        { id: 'refresh-target', idempotencyKey: 'refresh-target', kind: 'integrate', actor: 'host', expectedRevision: 1, state: 'succeeded', payload: { target: 'approved', observationId: observation.id, targetObservation: observation } },
        { id: 'deliver-earlier', idempotencyKey: 'deliver-earlier', kind: 'deliver', actor: 'lead:lead:1', expectedRevision: 2, state: 'failed', error: 'held', payload: { expectedAccepted: earlier } }
      ]
    });
    const pushed = missionDeliveryBranch(r.record(), observation);
    const earlierPush = missionDeliveryBranch({ ...r.record(), acceptedRevision: earlier }, observation);
    expect(pushed).toMatch(/^mission\/mission-delivery-[0-9a-f]{16}$/);
    expect(earlierPush).not.toBe(pushed);
    for (const branch of [pushed, `refs/heads/${pushed}`, earlierPush, 'mission/mission-delivery']) {
      await expect(r.registry.invoke('git:deleteBranch', { sessionId: 'source', branch }), branch).rejects.toThrow(/Mission/);
    }
    await expect(r.registry.invoke('git:checkout', { sessionId: 'source', branch: pushed })).rejects.toThrow(/Mission/);
    expect(deleteBranch).not.toHaveBeenCalled(); expect(checkout).not.toHaveBeenCalled();
    await r.registry.invoke('git:deleteBranch', { sessionId: 'source', branch: 'feature/ordinary' });
    expect(deleteBranch).toHaveBeenCalledOnce();
  });

  it('selects only the owning lead’s retained workspaces and defaults Files to integration', async () => {
    const r = await rig();
    await fs.writeFile(path.join(r.integrationPath, 'result.txt'), 'integrated');
    await fs.writeFile(path.join(r.leadPath, 'lead.txt'), 'lead work');
    await fs.writeFile(path.join(r.workerPath, 'worker.txt'), 'candidate');
    expect(await r.registry.invoke('fs:read', { sessionId: 'lead', path: 'result.txt' })).toEqual({ content: 'integrated', truncated: false });
    expect(await r.registry.invoke('fs:read', { sessionId: 'lead', missionWorkspaceId: 'lead-workspace', path: 'lead.txt' })).toEqual({ content: 'lead work', truncated: false });
    expect(await r.registry.invoke('fs:search', { sessionId: 'lead', missionWorkspaceId: 'worker-workspace', query: 'worker' })).toEqual(['worker.txt']);
    expect(await r.registry.invoke('fs:list', { sessionId: 'lead' })).toEqual([expect.objectContaining({ name: 'result.txt' })]);
    for (const sessionId of ['source', 'worker']) await expect(r.registry.invoke('fs:read', { sessionId, missionWorkspaceId: 'worker-workspace', path: 'worker.txt' })).rejects.toThrow(/owning Mission lead/);
    await expect(r.registry.invoke('fs:list', { sessionId: 'lead', missionWorkspaceId: 'foreign' })).rejects.toThrow(/unavailable/);
    r.patch({ workspaces: r.record().workspaces.map((w) => w.role === 'worker' ? { ...w, cleanedAt: 2 } : w) });
    await expect(r.registry.invoke('fs:list', { sessionId: 'lead', missionWorkspaceId: 'worker-workspace' })).rejects.toThrow(/cleaned/);
    expect(await r.registry.invoke('fs:read', { sessionId: 'lead', path: '../worker/worker.txt' })).toEqual({ content: '', truncated: false });
  });

  it('compares immutable baseline to accepted tree in integration, not lead edits or the live index', async () => {
    const r = await rig();
    const gitAt = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: r.integrationPath, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    gitAt('init');
    await fs.writeFile(path.join(r.integrationPath, 'result.txt'), 'baseline\n');
    gitAt('add', 'result.txt');
    const baseline = gitAt('write-tree');
    await fs.writeFile(path.join(r.integrationPath, 'result.txt'), 'accepted result\n');
    gitAt('add', 'result.txt');
    const accepted = gitAt('write-tree');
    await fs.writeFile(path.join(r.integrationPath, 'result.txt'), 'unaccepted edit\n');
    r.patch({ baseline: { baseCommitSha: 'a'.repeat(40), contentHash: baseline }, acceptedRevision: { baseCommitSha: 'a'.repeat(40), contentHash: accepted } });
    const diff = await r.registry.invoke('git:diff', { sessionId: 'lead', staged: true }) as { diff: string; error?: string };
    expect(diff.error).toBeUndefined();
    expect(diff.diff).toContain('-baseline');
    expect(diff.diff).toContain('+accepted result');
    expect(diff.diff).not.toContain('unaccepted edit');
    await expect(r.registry.invoke('git:diff', { sessionId: 'lead', path: '../lead/secret' })).rejects.toThrow(/outside/);
    const spy = vi.spyOn(git, 'gitDiff').mockResolvedValue({ diff: 'worker diff' });
    expect(await r.registry.invoke('git:diff', { sessionId: 'lead', missionWorkspaceId: 'worker-workspace', path: 'worker.txt' })).toEqual({ diff: 'worker diff' });
    expect(spy).toHaveBeenCalledExactlyOnceWith(r.workerPath, 'worker.txt', undefined);
    await fs.symlink(r.workerPath, path.join(r.integrationPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(r.registry.invoke('git:diff', { sessionId: 'lead', path: 'escape/worker.txt' })).rejects.toThrow(/outside/);
    r.patch({ acceptedRevision: { baseCommitSha: 'a'.repeat(40), contentHash: '--output=unsafe' } });
    await expect(r.registry.invoke('git:diff', { sessionId: 'lead' })).rejects.toThrow(/identity/);
  });
});

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, realpath'), { code: 'EPERM' });

describe('Mission guard cost for ordinary use', () => {
  it('runs no resource check, not even a realpath, while no Mission or Mission-owned session exists', async () => {
    const r = await rig();
    r.missions.list.mockReturnValue([]);
    r.live.splice(0, r.live.length, r.source);
    const terminal = { id: 't-source', sessionId: 'source', cwd: r.root };
    r.terminals.list.mockReturnValue([terminal]);
    // A path the OS refuses to resolve (EPERM on a network share) must not matter to ordinary work.
    const realpath = vi.spyOn(fs, 'realpath').mockRejectedValue(eperm());
    await r.registry.invoke('sessions:send', { id: 'source', input: { text: 'hello' } });
    await r.registry.invoke('sessions:create', { config: { ...r.source.config } });
    await r.registry.invoke('sessions:interrupt', { id: 'source' });
    await r.registry.invoke('terminal:create', { sessionId: 'source' });
    await r.registry.invoke('terminal:attach', { terminalId: terminal.id, cols: 80, rows: 24 });
    await r.registry.invoke('terminal:input', { terminalId: terminal.id, data: 'ls\r' });
    await r.registry.invoke('terminal:resize', { terminalId: terminal.id, cols: 120, rows: 30 });
    await r.registry.invoke('sessions:archive', { id: 'source', archived: true });
    expect(realpath).not.toHaveBeenCalled();
    expect(r.sessions.send).toHaveBeenCalledExactlyOnceWith('source', { text: 'hello' });
    expect(r.sessions.create).toHaveBeenCalledOnce(); expect(r.sessions.interrupt).toHaveBeenCalledOnce();
    expect(r.terminals.input).toHaveBeenCalledExactlyOnceWith(terminal.id, 'ls\r');
    expect(r.terminals.resize).toHaveBeenCalledExactlyOnceWith(terminal.id, 120, 30);
    expect(r.sessions.setArchived).toHaveBeenCalledExactlyOnceWith('source', true, undefined, undefined);
    // Host-only ownership fields stay refused even then.
    await expect(r.registry.invoke('sessions:create', { config: { ...r.source.config, mission: { missionId: 'forged' } } })).rejects.toThrow(/host-only/);
  });

  it('writes keystrokes and resizes synchronously and in order while Missions exist, never awaiting the filesystem', async () => {
    const r = await rig();
    const terminal = { id: 't-source', sessionId: 'source', cwd: r.root };
    r.terminals.list.mockReturnValue([terminal]);
    await r.registry.invoke('terminal:create', { sessionId: 'source' });
    // Every realpath from here on stalls, like a loaded or unreachable filesystem.
    const realpath = vi.spyOn(fs, 'realpath').mockImplementation(() => new Promise<never>(() => undefined));
    const keystrokes = ['g', 'i', 't', '\r'].map((data) => r.registry.invoke('terminal:input', { terminalId: terminal.id, data }));
    // Each write reached the PTY inside its own invoke call, before anything was awaited.
    expect(r.terminals.input.mock.calls).toEqual([[terminal.id, 'g'], [terminal.id, 'i'], [terminal.id, 't'], [terminal.id, '\r']]);
    await Promise.all(keystrokes);
    await r.registry.invoke('terminal:resize', { terminalId: terminal.id, cols: 100, rows: 40 });
    expect(r.terminals.resize).toHaveBeenCalledExactlyOnceWith(terminal.id, 100, 40);
    expect(realpath).not.toHaveBeenCalled();
  });

  it('still refuses a paused Mission lead shell per keystroke, without a filesystem round-trip', async () => {
    const r = await rig();
    const shell = { id: 't-lead', sessionId: 'lead', cwd: r.leadPath };
    r.terminals.list.mockReturnValue([shell]);
    await r.registry.invoke('terminal:create', { sessionId: 'lead' });
    await r.registry.invoke('terminal:input', { terminalId: shell.id, data: 'npm test\r' });
    expect(r.terminals.input).toHaveBeenCalledExactlyOnceWith(shell.id, 'npm test\r');
    const realpath = vi.spyOn(fs, 'realpath');
    r.patch({ status: 'paused' });
    await expect(r.registry.invoke('terminal:input', { terminalId: shell.id, data: 'rm -rf src\r' })).rejects.toThrow(/interactive shells/);
    await expect(r.registry.invoke('terminal:resize', { terminalId: shell.id, cols: 90, rows: 20 })).rejects.toThrow(/interactive shells/);
    expect(realpath).not.toHaveBeenCalled();
    // A refused recheck revokes the shell's verdict until a later full check passes again.
    await expect(r.registry.invoke('terminal:attach', { terminalId: shell.id, cols: 80, rows: 24 })).rejects.toThrow(/interactive shells/);
    r.patch({ status: 'running' });
    await expect(r.registry.invoke('terminal:input', { terminalId: shell.id, data: 'rm -rf src\r' })).rejects.toThrow(/Mission/);
    await r.registry.invoke('terminal:attach', { terminalId: shell.id, cols: 80, rows: 24 });
    await r.registry.invoke('terminal:input', { terminalId: shell.id, data: 'git status\r' });
    expect(r.terminals.input.mock.calls).toEqual([[shell.id, 'npm test\r'], [shell.id, 'git status\r']]);
    expect(r.terminals.resize).not.toHaveBeenCalled();
  });

  it('does not fail an ordinary request on an unexpected realpath error, while a Mission root still refuses', async () => {
    const r = await rig();
    vi.spyOn(fs, 'realpath').mockRejectedValue(eperm());
    await r.registry.invoke('sessions:send', { id: 'source', input: { text: 'still ordinary' } });
    await r.registry.invoke('sessions:interrupt', { id: 'source' });
    await r.registry.invoke('sessions:create', { config: { ...r.source.config } });
    expect(r.sessions.send).toHaveBeenCalledExactlyOnceWith('source', { text: 'still ordinary' });
    expect(r.sessions.interrupt).toHaveBeenCalledOnce(); expect(r.sessions.create).toHaveBeenCalledOnce();
    await expect(r.registry.invoke('app:openTerminal', { cwd: r.integrationPath })).rejects.toThrow(/Mission/);
    await expect(r.registry.invoke('sessions:moveTo', { id: 'source', cwd: path.join(r.workerPath, 'nested') })).rejects.toThrow(/Mission/);
    await expect(r.registry.invoke('sessions:create', { config: { ...r.source.config, projectRoot: r.verificationPath } })).rejects.toThrow(/Mission/);
    expect(r.sessions.moveTo).not.toHaveBeenCalled(); expect(r.sessions.create).toHaveBeenCalledOnce();
  });
});

describe('Mission remote policy', () => {
  it('classifies list/get/export as reads, never the mixed command endpoint or desktop saver', () => {
    expect(REMOTE_CHANNELS.has('app:fileSaveAs')).toBe(false);
    expect(REMOTE_READ_CHANNELS.has('app:fileSaveAs')).toBe(false);
    for (const channel of ['missions:list', 'missions:get', 'missions:exportPlan'] as const) { expect(REMOTE_CHANNELS.has(channel)).toBe(true); expect(REMOTE_READ_CHANNELS.has(channel)).toBe(true); }
    for (const channel of ['missions:create', 'missions:control', 'missions:command'] as const) { expect(REMOTE_CHANNELS.has(channel)).toBe(true); expect(REMOTE_WRITE_CHANNELS.has(channel)).toBe(true); expect(REMOTE_READ_CHANNELS.has(channel)).toBe(false); }
  });

  it('refuses new mutations before the real registry is invoked, but permits reads over the sealed connection', async () => {
    const r = await rig();
    const relay = new FakeRelay();
    const port = await relay.start();
    const invoke = vi.spyOn(r.registry, 'invoke');
    let viewOnly = true;
    const host = new RemoteHost({ registry: () => r.registry, secrets: { get: async () => undefined, set: async () => undefined }, pushState: () => undefined, log: () => undefined, broadcast: () => undefined, viewOnly: () => viewOnly });
    const client = new RelayClient({ vault: memoryVault(), wsFactory: (url, onMessage, onClose) => {
      const socket = new WebSocket(url);
      const queued: string[] = [];
      socket.on('open', () => { for (const raw of queued.splice(0)) socket.send(raw); });
      socket.on('message', (raw) => onMessage(String(raw)));
      socket.on('close', onClose);
      return { send: (raw) => { if (socket.readyState === WebSocket.OPEN) socket.send(raw); else queued.push(raw); }, close: () => socket.close() };
    } });
    const wait = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 30)); expect(check()).toBe(true); };
    try {
      await host.enable(`http://127.0.0.1:${port}`, ENROLL);
      const { code } = await host.startPairing('Mission host');
      const pairing = client.pair({ relayBase: `http://127.0.0.1:${port}`, code, deviceName: 'Mission browser' });
      await wait(() => !!host.state().pendingRequest);
      await host.respondPairing('approve');
      await pairing;
      await wait(() => host.state().status === 'online');
      await client.connect();
      expect(await client.invoke('missions:list', null)).toEqual([r.record()]);
      expect(await client.invoke('missions:get', { missionId: 'mission' })).toEqual(r.record());
      expect(await client.invoke('missions:exportPlan', { missionId: 'mission' })).toEqual({ suggestedName: 'plan.md', markdown: expect.stringContaining('Specification 1 · Plan 0') });
      await expect(client.invoke('app:fileSaveAs', { suggestedName: 'plan.md', content: 'No remote write' })).rejects.toThrow();
      expect(r.desktop.showSaveDialog).not.toHaveBeenCalled();
      for (const [channel, req] of [
        ['missions:create', { projectRoot: r.root, objective: 'bypass', mode: 'autonomous', permissionMode: 'ask', idempotencyKey: 'remote' }],
        ['missions:control', { missionId: 'mission', expectedRevision: 1, control: { action: 'stop' }, idempotencyKey: 'remote' }],
        ['missions:command', command('lead', '/mission status')]
      ] as const) await expect(client.invoke(channel, req)).rejects.toThrow('view-only');
      expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['missions:list', 'missions:get', 'missions:exportPlan']);
      expect(r.missions.create).not.toHaveBeenCalled();
      expect(r.missions.control).not.toHaveBeenCalled();
      viewOnly = false;
      expect(await client.invoke('missions:command', command('lead', '/mission status'))).toMatchObject({ kind: 'status' });
    } finally {
      await client.logout();
      await host.disable();
      await relay.stop();
    }
  });
});
