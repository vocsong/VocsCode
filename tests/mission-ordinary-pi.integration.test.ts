/** Real installed Pi + registered native subagent + detached OS writer, no live provider.
 * Production SessionManager, PiAdapter, Windows Job, admission and baseline capture are composed.
 * The only model is the existing deterministic offline provider. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { MissionWorkspaceAdmission } from '../src/main/mission/admission';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import type { SessionEventEnvelope } from '../src/shared/types';
import { piIntegrationPaths } from './pi-offline-runner';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
let root: string | undefined, manager: SessionManager | undefined, admission: MissionWorkspaceAdmission | undefined;
let unrelated: ChildProcess | undefined;
afterEach(async () => {
  admission?.close();
  await manager?.stopAll(); await manager?.flushPendingPersists();
  if (unrelated && unrelated.exitCode === null && unrelated.signalCode === null) {
    const closed = new Promise<void>((resolve) => unrelated!.once('close', () => resolve()));
    unrelated.kill(); await closed;
  }
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

async function until(check: () => boolean | Promise<boolean>, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(diagnostic());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!enabled || process.platform !== 'win32')('ordinary Pi native writer ownership through Mission baseline', () => {
  it('blocks after root idle, after a switch to plan, and after child completion until the actual descendant Job is empty', async () => {
    const { cli } = piIntegrationPaths();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ordinary-pi-writer-'));
    const source = path.join(root, 'source'), agentDir = path.join(root, 'agent');
    await fs.mkdir(source); await fs.mkdir(agentDir);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: 'always' }));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir); vi.stubEnv('PI_OFFLINE', '1'); vi.stubEnv('PI_TELEMETRY', '0');
    vi.stubEnv('VOCS_CODE_SUBAGENT_COMPLETION_MS', '500');
    git(source, ['init', '--initial-branch=main']);
    git(source, ['config', 'user.name', 'Mission Writer Test']);
    git(source, ['config', 'user.email', 'mission-writer-test@example.invalid']);
    git(source, ['config', 'commit.gpgsign', 'false']);
    git(source, ['config', 'core.autocrlf', 'false']);
    await fs.writeFile(path.join(source, 'source.txt'), 'unchanged\n');
    git(source, ['add', '.']); git(source, ['commit', '-m', 'Fixture baseline']);
    const head = git(source, ['rev-parse', 'HEAD']);
    const index = await fs.readFile(path.join(source, '.git', 'index'));

    const armed = path.join(root, 'armed'), finishChild = path.join(root, 'finish-child'), allowWrite = path.join(root, 'allow-write');
    const lateWrite = path.join(source, 'late-write');
    const launcher = path.join(root, 'launch-descendant.cjs');
    const descendant = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(armed)}, 'ready'); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(allowWrite)})) return; fs.writeFileSync(${JSON.stringify(lateWrite)}, 'native child descendant wrote after root idle'); clearInterval(timer); setInterval(() => {}, 1000); }, 20);`;
    await fs.writeFile(launcher, `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref(); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(finishChild)})) { clearInterval(timer); process.exit(0); } }, 20);`);
    const bin = path.join(root, 'pi.cmd');
    await fs.writeFile(bin, `@"${process.execPath}" "${cli}" %*\r\n`);
    unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });

    const store = new SessionStore(path.join(root, 'data')); await store.load();
    const settings = defaultSettings(); settings.providers = []; settings.autoCompactionThreshold = undefined;
    settings.mcpDisabledBuiltins = ['gitnexus', 'vocs-memory', 'cua-driver'];
    settings.pi.extraArgs = ['--offline', '--no-extensions', '--no-approve', '--no-skills', '--no-themes', '--no-context-files', '--no-prompt-templates', '-e', path.resolve('tests/fixtures/pi-scripted-provider.mjs')];
    const events: SessionEventEnvelope[] = [], logs: string[] = [];
    manager = new SessionManager({
      store, settings: { get: () => settings, update: async () => settings } as unknown as SettingsStore,
      runtime: { resolve: () => ({ path: bin, source: 'installed' }), resource: (...parts: string[]) => path.resolve('resources', ...parts) } as never,
      analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn(), recordSubagent: vi.fn() } as never,
      getSecret: async () => undefined, pushEvent: (event) => events.push(event), pushSessions: () => {}, notify: () => {}, log: (_level, message) => logs.push(message),
      withWorkspaceDispatch: (meta, dispatch) => admission!.dispatch(meta.cwd, dispatch),
      // The ownership this suite exercises applies only while ordinary process ownership is enabled.
      ordinaryProcessOwnership: () => true,
    });
    admission = new MissionWorkspaceAdmission({ sessions: () => manager!.list(), activity: (id) => manager!.activity(id), terminals: () => [] });
    const workspaces = new MissionWorkspaces({ root: path.join(root, 'workspaces'), quiescence: admission });
    const session = await manager.create({ title: 'Ordinary writer', config: { harness: 'pi', projectRoot: source, permissionMode: 'full-auto', model: { provider: 'vocs-offline', model: 'scripted' } } });
    const childPrompt = JSON.stringify({ calls: [{ id: 'child-shell', name: 'bash', arguments: { command: `"${process.execPath.replaceAll('\\', '/')}" "${launcher.replaceAll('\\', '/')}"`, timeout: 60 } }] });
    await manager.send(session.id, { text: JSON.stringify({ calls: [{ id: 'delegate', name: 'subagent', arguments: { description: 'Delayed native writer', type: 'general-purpose', background: true, prompt: childPrompt } }] }) });
    const diagnostic = () => JSON.stringify({ activity: manager!.activity(session.id), events: events.slice(-10), logs: logs.slice(-15) });
    await until(async () => !manager!.activity(session.id).turn && !!await fs.stat(armed).catch(() => undefined), diagnostic);
    expect(manager.activity(session.id)).toMatchObject({ nativeChildren: 1, tools: 0, turn: false, quiescent: false });
    expect(await workspaces.probeBaseline(source)).toMatchObject({ ok: false, reason: 'busy' });
    await manager.setPermissionMode(session.id, 'plan');
    expect(await workspaces.probeBaseline(source)).toMatchObject({ ok: false, reason: 'busy' });
    await fs.writeFile(finishChild, 'finish only the native child, not its OS descendant');
    await until(() => events.some(({ event }) => event.type === 'subagent.run' && event.run.status === 'completed') && manager!.activity(session.id).nativeChildren === 0 && !manager!.activity(session.id).turn, diagnostic);
    const completedTurns = () => new Set(events.flatMap(({ event }) => event.type === 'item.upsert' && event.item.kind === 'turn' && event.item.status === 'completed' ? [event.item.id] : [])).size;
    // The native child is terminal while its debounced triggerTurn handoff has not fired. Neither
    // root busy=false nor the child's terminal event may release the workspace in this gap.
    expect(completedTurns()).toBe(1);
    expect(await workspaces.probeBaseline(source)).toMatchObject({ ok: false, reason: 'busy' });
    await until(() => completedTurns() === 2 && !manager!.activity(session.id).turn, diagnostic);
    expect(await workspaces.probeBaseline(source)).toMatchObject({ ok: false, reason: 'busy' });
    await fs.writeFile(allowWrite, 'prove the descendant still writes');
    await until(async () => !!await fs.stat(lateWrite).catch(() => undefined), diagnostic);
    expect(await fs.readFile(lateWrite, 'utf8')).toContain('after root idle');
    expect(await workspaces.probeBaseline(source)).toMatchObject({ ok: false, reason: 'busy' });
    await manager.stop(session.id);
    expect(manager.activity(session.id)).toMatchObject({ active: false, uncertain: false, quiescent: true });
    expect(unrelated.exitCode).toBeNull(); expect(unrelated.signalCode).toBeNull();
    await fs.unlink(lateWrite); // Remove only this fixture's deliberate edit, after positive Job teardown.
    const lease = await admission.acquire(source); expect(lease).toBeDefined();
    const sent = vi.fn(); const waiting = admission.dispatch(source, async () => { sent(); });
    await new Promise((resolve) => setTimeout(resolve, 30)); expect(sent).not.toHaveBeenCalled();
    await lease!.assertQuiescent(); await lease!.release(); await waiting; expect(sent).toHaveBeenCalledTimes(1);
    expect(await workspaces.probeBaseline(source)).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(source, 'source.txt'), 'utf8')).toBe('unchanged\n');
    expect(git(source, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await fs.readFile(path.join(source, '.git', 'index'))).toEqual(index);
    expect(events.filter(({ event }) => event.type === 'subagent.run' && event.run.status === 'completed')).toHaveLength(1);
    // A new fixed plan-mode discussion has no old writer debt. Its real settled read may remain
    // alive during capture; Mission admission neither stops nor interrupts this exempt source.
    await manager.send(session.id, { text: JSON.stringify({ calls: [{ id: 'read-source', name: 'read', arguments: { path: 'source.txt' } }] }) });
    await until(() => completedTurns() === 3 && !manager!.activity(session.id).turn, diagnostic);
    expect(manager.activity(session.id)).toMatchObject({ active: true, turn: false, tools: 0, nativeChildren: 0, processes: false, uncertain: false, quiescent: true });
    expect(events.some(({ event }) => event.type === 'item.upsert' && event.item.kind === 'tool' && event.item.name === 'read' && event.item.status === 'done')).toBe(true);
    expect(await workspaces.probeBaseline(source)).toMatchObject({ ok: true });
    expect(manager.activity(session.id).active).toBe(true);
    expect(await fs.readFile(path.join(source, 'source.txt'), 'utf8')).toBe('unchanged\n');
    expect(git(source, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await fs.readFile(path.join(source, '.git', 'index'))).toEqual(index);
  }, 90_000);
});
