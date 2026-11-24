/**
 * Regression suite for ongoing session activity across adapters, ProcessTracker, SessionManager,
 * SessionStore persistence, KeepAwake, deferred unseen/notifications, and app-driven /goal deferral.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { hasOngoingWork, ongoingBadgeLabel, ongoingStripHeadline, runningSubagentCount } from '../src/shared/ongoing';
import { classifySessionOngoingProcesses, type TrackedProcess } from '../src/shared/processes';
import { ClaudeAdapter } from '../src/main/harness/claude';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { createAdapter } from '../src/main/harness/registry';
import { KeepAwake, type PowerBlocker } from '../src/main/keep-awake';
import { emptyUsage } from '../src/main/models/static-models';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn(), listHarnessModels: vi.fn() }));

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function proc(pid: number, ppid: number, name: string, owner: TrackedProcess['owner'], extra: Partial<TrackedProcess> = {}): TrackedProcess {
  return { pid, ppid, startedAt: 1_000 + pid, name, owner, ...extra };
}

describe('shared ongoing helpers', () => {
  it('formats compact badges and strip headlines for single and mixed items', () => {
    expect(ongoingBadgeLabel([])).toBe('');
    expect(ongoingBadgeLabel([{ id: '1', kind: 'subagent', label: 'Wait on CI', startedAt: 1 }])).toBe('1 subagent');
    expect(ongoingBadgeLabel([
      { id: '1', kind: 'subagent', label: 'A', startedAt: 1 },
      { id: '2', kind: 'subagent', label: 'B', startedAt: 2 }
    ])).toBe('2 subagents');
    expect(ongoingBadgeLabel([{ id: '1', kind: 'hook', label: 'lint', detail: 'Stop', startedAt: 1 }])).toBe('1 hook');
    expect(ongoingBadgeLabel([{ id: '1', kind: 'task', label: 'Delivering…', detail: 'wakeup', startedAt: 1 }])).toBe('Continuing…');
    expect(ongoingBadgeLabel([
      { id: '1', kind: 'subagent', label: 'A', startedAt: 1 },
      { id: '2', kind: 'hook', label: 'B', startedAt: 2 }
    ])).toBe('2 ongoing');
    expect(ongoingStripHeadline([{ id: '1', kind: 'subagent', agent: 'Explore', label: 'Search', startedAt: 1 }])).toBe('Background Explore running');
    expect(ongoingStripHeadline([{ id: '1', kind: 'task', detail: 'local_bash', label: 'gh run watch', startedAt: 1 }])).toBe('Background command running');
    expect(ongoingStripHeadline([{ id: '1', kind: 'task', detail: 'terminal', label: 'npm run dev', startedAt: 1 }])).toBe('Background command running');
    expect(ongoingStripHeadline([{ id: '1', kind: 'task', detail: 'schedule', label: 'Check PR every 5m', startedAt: 1 }])).toBe('Scheduled task pending');
    expect(ongoingStripHeadline([{ id: '1', kind: 'task', detail: 'timer', label: 'Wait 60s', startedAt: 1 }])).toBe('Timer running');
    expect(ongoingStripHeadline([{ id: '1', kind: 'hook', detail: 'Stop', label: 'verify', startedAt: 1 }])).toBe('Stop hook running');
    expect(runningSubagentCount({ ongoing: [{ id: '1', kind: 'subagent', label: 'A', startedAt: 1 }, { id: '2', kind: 'task', label: 'B', startedAt: 2 }] })).toBe(1);
  });
});

describe('classifySessionOngoingProcesses', () => {
  it('excludes idle harness roots, MCP servers, and empty terminal shells across harnesses', () => {
    const idleList: TrackedProcess[] = [
      // Claude root + MCP children + idle shell launcher
      proc(100, 1, 'claude.exe', { sessionId: 's_claude' }, { command: 'claude.exe --output-format stream-json' }),
      proc(101, 100, 'node.exe', { sessionId: 's_claude' }, { command: 'node resources/mcp/vocs-memory.mjs' }),
      proc(102, 100, 'node.exe', { sessionId: 's_claude' }, { command: 'node resources/mcp/gitnexus-scope.mjs' }),
      proc(103, 100, 'powershell.exe', { sessionId: 's_claude' }, { command: 'powershell.exe -Command $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT' }),
      // Pi root + idle terminal shell
      proc(200, 1, 'node.exe', { sessionId: 's_pi' }, { command: 'node node_modules/@earendil-works/pi-coding-agent/cli.js --mode rpc' }),
      proc(210, 1, 'pwsh.exe', { sessionId: 's_pi', terminalId: 't1', label: 'PowerShell' }, { command: 'pwsh.exe' }),
      // Codex app-server root
      proc(300, 1, 'codex.exe', { sessionId: 's_codex' }, { command: 'codex.exe app-server' }),
      // ACP root (including Windows cmd.exe shim launching agy.exe)
      proc(400, 1, 'cmd.exe', { sessionId: 's_acp' }, { command: 'cmd.exe /c "C:\\Users\\vocs\\agy.exe acp"' }),
      proc(401, 400, 'agy.exe', { sessionId: 's_acp' }, { command: 'agy.exe acp' }),
      // Earlier-run leftover (belongs in Left Behind, not live session activity)
      proc(900, 999, 'node.exe', { sessionId: 's_claude' }, { command: 'node stale.js', orphaned: true, previousRun: true })
    ];
    expect(classifySessionOngoingProcesses(idleList)).toEqual({});
  });

  it('descends through Windows cmd.exe shims and harness children to surface real tool subprocesses underneath', () => {
    const list: TrackedProcess[] = [
      proc(400, 1, 'cmd.exe', { sessionId: 's_shim' }, { command: 'cmd.exe /c "claude.exe --output-format stream-json"' }),
      proc(401, 400, 'claude.exe', { sessionId: 's_shim' }, { command: 'claude.exe --output-format stream-json' }),
      proc(402, 401, 'node.exe', { sessionId: 's_shim' }, { command: 'node scripts/watch-ci.mjs' })
    ];
    const bySession = classifySessionOngoingProcesses(list);
    expect(bySession.s_shim?.map((p) => ({ pid: p.pid, label: p.label }))).toEqual([
      { pid: 402, label: 'watch-ci.mjs' }
    ]);
  });

  it('surfaces detached Job processes, running terminal commands, and active child commands once per subtree root', () => {
    const list: TrackedProcess[] = [
      // Harness root + active bash command with grandchild worker
      proc(100, 1, 'claude.exe', { sessionId: 's1' }, { command: 'claude.exe' }),
      proc(101, 100, 'bash.exe', { sessionId: 's1' }, { command: 'bash -c "gh run watch 123"' }),
      proc(102, 101, 'gh.exe', { sessionId: 's1' }, { command: 'gh run watch 123' }),
      // Detached process in session Job Object
      proc(150, 9999, 'node.exe', { sessionId: 's1' }, { command: 'node server.js', orphaned: true }),
      proc(151, 150, 'esbuild.exe', { sessionId: 's1' }, { command: 'esbuild --service', orphaned: true }),
      // Active command running inside terminal tab
      proc(200, 1, 'pwsh.exe', { sessionId: 's2', terminalId: 't1', label: 'PowerShell' }, { command: 'pwsh.exe' }),
      proc(201, 200, 'node.exe', { sessionId: 's2', terminalId: 't1' }, { command: 'node npm-cli.js run dev' }),
      proc(202, 201, 'node.exe', { sessionId: 's2', terminalId: 't1' }, { command: 'node vite' }),
      // Native harness direct tool shell
      proc(300, 1, 'powershell.exe', { sessionId: 's3' }, { command: 'powershell -NoProfile -Command "Start-Sleep 60"' })
    ];
    const bySession = classifySessionOngoingProcesses(list);
    expect(bySession.s1?.map((p) => ({ pid: p.pid, detached: !!p.detached }))).toEqual([
      { pid: 101, detached: false },
      { pid: 150, detached: true }
    ]);
    expect(bySession.s2?.map((p) => ({ pid: p.pid, terminalId: p.terminalId }))).toEqual([
      { pid: 201, terminalId: 't1' }
    ]);
    expect(bySession.s3?.map((p) => p.pid)).toEqual([300]);
  });
});

describe('ClaudeAdapter ongoing signals', () => {
  function claudeFixture() {
    const events: SessionEvent[] = [];
    const ctx = {
      session: () => ({ id: 's_claude', cwd: process.cwd(), config: { harness: 'claude', projectRoot: process.cwd(), permissionMode: 'auto' }, harnessRef: {}, usage: emptyUsage() }),
      settings: () => defaultSettings(),
      permissionMode: () => 'auto',
      effort: () => undefined,
      emit: (e: SessionEvent) => events.push(e),
      updateMeta: vi.fn(),
      updateRef: vi.fn(),
      log: vi.fn(),
      sessionDir: null
    } as unknown as HarnessContext;
    const adapter = new ClaudeAdapter(ctx);
    const handle = (msg: Record<string, unknown>) => (adapter as unknown as { handle: (m: unknown, q: unknown) => void }).handle(msg, {});
    return { adapter, events, handle };
  }

  it('consumes background_tasks_changed with replace semantics and filters ambient tasks', () => {
    const { events, handle } = claudeFixture();
    handle({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 't_agent', task_type: 'local_agent', description: 'Wait for CI baseline' },
        { task_id: 't_bash', task_type: 'local_bash', description: 'gh run watch 42' },
        { task_id: 't_ambient', task_type: 'local_bash', description: 'watcher', ambient: true }
      ]
    });
    const ongoingEvents = () => events.filter((e): e is Extract<SessionEvent, { type: 'ongoing' }> => e.type === 'ongoing' && e.source === 'tasks');
    expect(ongoingEvents().at(-1)?.items).toMatchObject([
      { id: 'task:t_agent', kind: 'subagent', label: 'Wait for CI baseline' },
      { id: 'task:t_bash', kind: 'task', detail: 'local_bash', label: 'gh run watch 42' }
    ]);

    // Replace semantics: dropping a task removes it immediately.
    handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(ongoingEvents().at(-1)?.items).toEqual([]);
  });

  it('surfaces slow user hooks, suppresses fast hooks and internal callback hooks', async () => {
    vi.useFakeTimers();
    const { events, handle } = claudeFixture();
    const hookEvents = () => events.filter((e): e is Extract<SessionEvent, { type: 'ongoing' }> => e.type === 'ongoing' && e.source === 'hooks');

    // Internal SDK callback hook: never surfaced even if long.
    handle({ type: 'system', subtype: 'hook_started', hook_id: 'h_int', hook_name: 'PreToolUse:callback', hook_event: 'PreToolUse' });
    // Fast user hook: finishes before the 250ms visibility delay.
    handle({ type: 'system', subtype: 'hook_started', hook_id: 'h_fast', hook_name: 'format', hook_event: 'PostToolUse' });
    await vi.advanceTimersByTimeAsync(100);
    handle({ type: 'system', subtype: 'hook_response', hook_id: 'h_fast', outcome: 'success' });
    // Slow user Stop hook: stays active past 250ms.
    handle({ type: 'system', subtype: 'hook_started', hook_id: 'h_slow', hook_name: 'verify-tests', hook_event: 'Stop' });
    await vi.advanceTimersByTimeAsync(300);

    expect(hookEvents()).toHaveLength(1);
    expect(hookEvents()[0]!.items).toMatchObject([{ id: 'hook:h_slow', kind: 'hook', label: 'verify-tests', detail: 'Stop' }]);

    handle({ type: 'system', subtype: 'hook_response', hook_id: 'h_slow', outcome: 'success' });
    expect(hookEvents().at(-1)?.items).toEqual([]);
  });
});

describe('PiAdapter wakeup signal', () => {
  it('emits and clears wakeup ongoing state across the background subagent completion debounce', () => {
    const events: SessionEvent[] = [];
    const ctx = {
      session: () => ({ id: 's_pi', cwd: process.cwd(), config: { harness: 'pi', projectRoot: process.cwd(), permissionMode: 'auto' }, harnessRef: {}, usage: emptyUsage() }),
      settings: () => defaultSettings(),
      permissionMode: () => 'auto',
      effort: () => undefined,
      emit: (e: SessionEvent) => events.push(e),
      updateMeta: vi.fn(),
      updateRef: vi.fn(),
      log: vi.fn()
    } as unknown as HarnessContext;
    const adapter = new PiAdapter(ctx);
    const handleSubagentEvent = (raw: string) => (adapter as unknown as { handleSubagentEvent: (s: string) => void }).handleSubagentEvent(raw);
    const handleLine = (line: string) => (adapter as unknown as { handleLine: (s: string) => void }).handleLine(line);

    handleSubagentEvent(JSON.stringify({ version: 1, kind: 'wakeup', pending: true, count: 2, startedAt: 5_000 }));
    const wakeups = () => events.filter((e): e is Extract<SessionEvent, { type: 'ongoing' }> => e.type === 'ongoing' && e.source === 'wakeup');
    expect(wakeups().at(-1)?.items).toMatchObject([{ id: 'wakeup:subagent', kind: 'task', detail: 'wakeup', label: 'Delivering 2 subagent results…' }]);

    // Starting the parent turn clears the wakeup indicator even if the explicit false arrives late.
    handleLine(JSON.stringify({ type: 'agent_start' }));
    expect(wakeups().at(-1)?.items).toEqual([]);
  });
});

describe('CodexAppServerAdapter child thread ongoing tracking', () => {
  it('tracks active child threads without changing parent status', () => {
    const events: SessionEvent[] = [];
    const ctx = {
      emit: (e: SessionEvent) => events.push(e),
      session: () => ({ cwd: process.cwd(), usage: emptyUsage() }),
      permissionMode: () => 'auto',
      updateMeta: vi.fn(),
      updateRef: vi.fn(),
      log: vi.fn()
    } as unknown as HarnessContext;
    const adapter = new CodexAppServerAdapter(ctx);
    const notifications = new Map<string, (params: unknown) => void>();
    const rpc = { onNotification: (m: string, h: (p: unknown) => void) => notifications.set(m, h), onServerRequest: vi.fn(), close: vi.fn() };
    (adapter as unknown as { rpc: unknown; threadId: string }).rpc = rpc;
    (adapter as unknown as { threadId: string }).threadId = 'parent-thread';
    (adapter as unknown as { wireNotifications: (c: unknown) => void }).wireNotifications(rpc);

    notifications.get('item/started')!({ threadId: 'parent-thread', item: { id: 'c1', type: 'collabAgentToolCall', tool: 'spawn', description: 'Check Windows CI' } });
    notifications.get('turn/started')!({ threadId: 'child-thread-1', turn: { id: 'ct-1' } });
    const threadEvents = () => events.filter((e): e is Extract<SessionEvent, { type: 'ongoing' }> => e.type === 'ongoing' && e.source === 'threads');
    expect(threadEvents().at(-1)?.items).toMatchObject([{ id: 'thread:child-thread-1', kind: 'subagent', label: 'Check Windows CI' }]);
    expect(events.filter((e) => e.type === 'status')).toEqual([]);

    notifications.get('turn/completed')!({ threadId: 'child-thread-1', turn: { id: 'ct-1', status: 'completed', error: null, durationMs: 100 } });
    expect(threadEvents().at(-1)?.items).toEqual([]);
  });
});

describe('SessionManager ongoing lifecycle integration', () => {
  async function managerFixture(opts: { viewing?: boolean; notifications?: boolean } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-ongoing-mgr-'));
    dirs.push(dir);
    const store = new SessionStore(dir);
    await store.load();
    const settings = new SettingsStore(dir);
    await settings.load();
    await settings.update({ notifications: opts.notifications ?? true });
    const contexts = new Map<string, HarnessContext>();
    const sends: string[] = [];
    const live = new Set<number>();
    let nextBlocker = 0;
    const blocker: PowerBlocker = {
      start: vi.fn(() => { live.add(nextBlocker); return nextBlocker++; }),
      stop: vi.fn((id) => { live.delete(id); })
    };
    const awake = new KeepAwake(blocker, vi.fn());
    const notify = vi.fn();

    vi.mocked(createAdapter).mockImplementation((harness, ctx): HarnessAdapter => {
      contexts.set(ctx.session().id, ctx);
      return {
        id: harness,
        busy: false,
        start: async () => { ctx.emit({ type: 'status', status: 'idle' }); },
        send: async (input) => {
          sends.push(input.text);
          ctx.emit({ type: 'status', status: 'running' });
        },
        interrupt: async () => undefined,
        setModel: async () => undefined,
        setEffort: async () => undefined,
        setPermissionMode: async () => undefined,
        compact: async () => undefined,
        dispose: async () => undefined
      };
    });

    const manager = new SessionManager({
      store,
      settings,
      runtime: {} as never,
      analytics: { touchSession: vi.fn(), recordTurn: vi.fn(), recordToolCall: vi.fn(), recordUserMessage: vi.fn(), recordUserInputs: vi.fn(), recordUsage: vi.fn(), recordSubagent: vi.fn(), flush: vi.fn(async () => undefined) } as never,
      getSecret: async () => undefined,
      isViewing: () => opts.viewing ?? false,
      notify,
      pushEvent: vi.fn(),
      pushSessions: (list) => awake.sync(list),
      log: vi.fn()
    });

    const meta: SessionMeta = {
      id: 's1',
      title: 'PR 636',
      createdAt: 1,
      updatedAt: 1,
      cwd: dir,
      status: 'idle',
      harnessRef: {},
      usage: emptyUsage(),
      config: { harness: 'pi', permissionMode: 'auto', projectRoot: dir }
    };
    await store.upsert(meta);
    await manager.send('s1', { text: 'Start subagent' });
    const ctx = contexts.get('s1')!;
    return { dir, store, manager, ctx, awake, live, notify, sends, get: () => manager.get('s1')! };
  }

  it('projects subagent.run onto meta.ongoing, never persists it across restart, keeps KeepAwake alive, and defers unseen/notify until settled', async () => {
    vi.useFakeTimers();
    const f = await managerFixture({ viewing: false, notifications: true });
    f.awake.set('s1', true, f.manager.list({ refreshGit: false }));

    // Subagent starts in background while parent turn runs.
    f.ctx.emit({ type: 'subagent.run', run: { runId: 'r1', agent: 'Explore', description: 'Wait on CI', mode: 'background', status: 'running', startedAt: 1000, toolUses: 3, turns: 1 } });
    expect(f.get().ongoing).toMatchObject([{ id: 'subagent:r1', kind: 'subagent', runId: 'r1', label: 'Wait on CI', toolUses: 3, canStop: true }]);

    // Parent turn completes and returns to idle while background subagent is still running.
    f.ctx.emit({ type: 'item.upsert', item: { id: 't1', kind: 'turn', ts: 2000, status: 'completed' } as TranscriptItem });
    f.ctx.emit({ type: 'status', status: 'idle' });
    expect(f.get().status).toBe('idle');
    expect(hasOngoingWork(f.get())).toBe(true);
    // KeepAwake stays held while idle with ongoing background work!
    expect(f.live.size).toBe(1);
    // Unseen mark & OS notification are deferred while background work is still running.
    expect(f.get().unseenAt).toBeUndefined();
    expect(f.notify).not.toHaveBeenCalled();

    // Ephemeral invariant: sessions.json on disk never stores `ongoing`.
    await f.manager.flushPendingPersists();
    const reloaded = new SessionStore(f.dir);
    await reloaded.load();
    expect(reloaded.get('s1')?.ongoing).toBeUndefined();

    // Subagent finishes with no follow-up parent turn -> after 150ms settle grace, unseenAt & notification fire and KeepAwake releases.
    f.ctx.emit({ type: 'subagent.run', run: { runId: 'r1', agent: 'Explore', description: 'Wait on CI', mode: 'background', status: 'completed', startedAt: 1000, endedAt: 3000 } });
    expect(f.get().ongoing).toBeUndefined();
    expect(f.live.size).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.get().unseenAt).toBeTypeOf('number');
    expect(f.notify).toHaveBeenCalledWith('s1', 'PR 636', 'Background work finished');

    await f.manager.stopAll();
    f.awake.quit();
  });

  it('defers app-driven /goal continuation while background work runs and cancels it if the parent wakes up naturally', async () => {
    vi.useFakeTimers();
    const f = await managerFixture({ viewing: true, notifications: false });
    f.get().goal = { objective: 'Merge PR when CI is green', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, maxIterations: 5, autoContinue: true };

    f.ctx.emit({ type: 'subagent.run', run: { runId: 'r1', agent: 'general-purpose', description: 'Watch CI', mode: 'background', status: 'running', startedAt: 1000 } });
    f.ctx.emit({ type: 'item.upsert', item: { id: 't1', kind: 'turn', ts: 2000, status: 'completed' } as TranscriptItem });
    f.ctx.emit({ type: 'status', status: 'idle' });

    // Even after 10 seconds, /goal does NOT burn an iteration while the subagent is still running.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.get().goal?.iterations).toBe(0);
    expect(f.sends).toEqual(['Start subagent']);

    // Subagent finishes and no automatic parent turn starts -> deferred continuation wakes up!
    f.ctx.emit({ type: 'subagent.run', run: { runId: 'r1', agent: 'general-purpose', description: 'Watch CI', mode: 'background', status: 'completed', startedAt: 1000, endedAt: 12000 } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.get().goal?.iterations).toBe(1);
    expect(f.sends).toHaveLength(2);
    expect(f.sends[1]).toContain('Goal check-in 1/5');

    await f.manager.stopAll();
  });

  it('clears ongoing state immediately when the session is stopped', async () => {
    const f = await managerFixture({ viewing: true, notifications: false });
    f.ctx.emit({ type: 'ongoing', source: 'tasks', items: [{ id: 'task:b1', kind: 'task', label: 'gh run watch', detail: 'local_bash', startedAt: 1000 }] });
    expect(hasOngoingWork(f.get())).toBe(true);
    await f.manager.stop('s1');
    expect(f.get().ongoing).toBeUndefined();
  });
});
