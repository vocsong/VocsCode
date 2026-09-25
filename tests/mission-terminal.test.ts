/** Terminal lifecycle proofs are independent of visible tabs and of the root PTY exit event. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from '@lydell/node-pty';
import { TerminalManager, type TerminalManagerDeps } from '../src/main/terminal';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/shared/terminal';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fakePty(pid = 4242) {
  const exits = new Set<(exit: { exitCode: number }) => void>();
  const data = new Set<(text: string) => void>();
  return {
    pid, cols: 80, rows: 24, process: 'test-shell', handleFlowControl: false,
    onData: (listener: (text: string) => void) => { data.add(listener); return { dispose: () => { data.delete(listener); } }; },
    onExit: (listener: (exit: { exitCode: number }) => void) => { exits.add(listener); return { dispose: () => { exits.delete(listener); } }; },
    write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), clear: vi.fn(),
    exit: (exitCode = 1) => { for (const listener of [...exits]) listener({ exitCode }); },
    emit: (text: string) => { for (const listener of data) listener(text); }
  };
}
function owned(pid = 4242) {
  const pty = fakePty(pid), proof = deferred();
  return { pty, proof, close: vi.fn(), quiescent: proof.promise };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(options: Partial<TerminalManagerDeps> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-terminal-'));
  const processes: ReturnType<typeof owned>[] = [];
  const spawn = vi.fn(() => {
    const process = owned(4242 + processes.length);
    processes.push(process);
    return process.pty as IPty;
  });
  const manager = new TerminalManager({
    dir, settings: () => ({ ...DEFAULT_TERMINAL_SETTINGS, shell: 'custom', customShellPath: 'test-shell' }),
    version: 'test', cwdOf: () => dir, isManaged: () => true,
    spawn, killTree: (pty) => pty.kill(), managedCloseTimeoutMs: 250,
    spawnOwned: (file, args, opts, start) => {
      const pty = start(file, args, opts);
      return { ...processes.at(-1)!, pty };
    },
    push: vi.fn(), log: vi.fn(), ...options
  });
  cleanup.push(async () => {
    await manager.closeAll();
    for (const process of processes) { process.pty.exit(); process.proof.resolve(); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { manager, processes, spawn, dir };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('Mission terminal ownership', () => {
  it('does not finish cleanup or admit a new shell until both tree proof and delayed PTY exit arrive', async () => {
    const observed: number[] = [];
    const { manager, processes, spawn } = await fixture({ onActivity: () => observed.push(manager.activity('lead').length) });
    const terminal = manager.create('lead');
    const cleanupWorkspace = vi.fn();
    const closing = manager.closeManagedSession('lead').then(cleanupWorkspace);
    await tick();
    expect(manager.list()).toEqual([]); // Tab removal is not process completion.
    expect(manager.activity('lead')).toEqual([expect.objectContaining({ terminalId: terminal.id, state: 'closing', managed: true })]);
    expect(() => manager.create('lead')).toThrow(/closing/);
    processes[0].proof.resolve();
    await tick();
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(manager.activity('lead')).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    processes[0].pty.exit();
    await closing;
    expect(manager.activity('lead')).toEqual([]);
    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(processes[0].close).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([1, 0]); // Wake the coordinator even after its visible tab was removed.
  });

  it('keeps managed archive cleanup pending after root exit while owned children are still unconfirmed', async () => {
    const { manager, processes } = await fixture();
    manager.create('lead');
    const cleanupWorkspace = vi.fn();
    const closing = manager.closeForSession('lead').then(cleanupWorkspace);
    processes[0].pty.exit();
    await tick();
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    processes[0].proof.resolve();
    await closing;
    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
  });

  it('retains uncertainty after timeout/root exit, and allows only a later positive proof to release it', async () => {
    const { manager, processes } = await fixture();
    manager.create('lead');
    const cleanupWorkspace = vi.fn();
    const closing = manager.closeManagedSession('lead').then(cleanupWorkspace);
    processes[0].pty.exit();
    await expect(closing).rejects.toThrow(/timed out/);
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    expect(manager.activity('lead')).toEqual([expect.objectContaining({ state: 'uncertain', reason: expect.stringContaining('timed out') })]);
    expect(() => manager.create('lead')).toThrow(/uncertain/);
    const retry = manager.closeManagedSession('lead').then(cleanupWorkspace);
    processes[0].proof.resolve();
    await retry;
    expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
    expect(manager.activity()).toEqual([]);
  });

  it('retains kill failure and cancels only the requested session, never unrelated shells', async () => {
    const killTree = vi.fn();
    const { manager, processes } = await fixture({ killTree });
    manager.create('lead');
    manager.create('unrelated');
    processes[0].close.mockImplementation(() => { throw new Error('Job termination denied'); });
    await expect(manager.closeManagedSession('lead')).rejects.toThrow('Job termination denied');
    expect(manager.activity('lead')).toEqual([expect.objectContaining({ state: 'uncertain' })]);
    expect(processes[0].close).toHaveBeenCalledTimes(1);
    expect(processes[1].close).not.toHaveBeenCalled();
    expect(processes[1].pty.kill).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled(); // Managed ownership never falls back to taskkill/PID guesses.
    expect(manager.list().map((t) => t.sessionId)).toEqual(['unrelated']);
    processes[0].close.mockImplementation(() => undefined);
    const retry = manager.closeManagedSession('lead');
    processes[0].proof.resolve(); processes[0].pty.exit();
    await retry;
    expect(manager.activity().map((r) => r.sessionId)).toEqual(['unrelated']);
  });

  it('does not lose the killed predecessor during restart or let its late exit change the replacement', async () => {
    const { manager, processes, spawn } = await fixture();
    const terminal = manager.create('lead');
    const restarted = manager.restart(terminal.id);
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(manager.activity('lead')).toHaveLength(1);
    processes[0].pty.exit();
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    processes[0].proof.resolve();
    expect((await restarted).id).toBe(terminal.id);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(manager.activity('lead')).toHaveLength(1);
    processes[0].pty.exit(9);
    expect(manager.list()[0].exit).toBeUndefined();
  });

  it('does not spawn duplicate replacement shells when two restart requests overlap', async () => {
    const { manager, processes, spawn } = await fixture();
    const terminal = manager.create('lead');
    const restarts = Promise.allSettled([manager.restart(terminal.id), manager.restart(terminal.id)]);
    processes[0].proof.resolve(); processes[0].pty.exit();
    const results = await restarts;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(spawn).toHaveBeenCalledTimes(2); // Initial shell plus exactly one replacement.
    expect(manager.activity('lead')).toHaveLength(1);
  });

  it('does not accept new input after managed kill has started', async () => {
    const { manager, processes } = await fixture();
    const terminal = manager.create('lead');
    manager.kill(terminal.id);
    manager.input(terminal.id, 'new mutation\\r');
    expect(processes[0].pty.write).not.toHaveBeenCalled();
    const closing = manager.closeManagedSession('lead');
    processes[0].proof.resolve(); processes[0].pty.exit();
    await closing;
    expect(manager.activity()).toEqual([]);
  });

  it('refuses a managed restart when child teardown fails instead of spawning a conflicting writer', async () => {
    const { manager, processes, spawn } = await fixture();
    const terminal = manager.create('lead');
    processes[0].close.mockImplementation(() => { throw new Error('cannot terminate Job'); });
    await expect(manager.restart(terminal.id)).rejects.toThrow('cannot terminate Job');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(manager.activity('lead')[0].state).toBe('uncertain');
    processes[0].close.mockImplementation(() => undefined);
  });

  it('keeps ordinary-source closing and exited shells visible to admission after their tabs disappear', async () => {
    const { manager, processes } = await fixture({ isManaged: () => false });
    const terminal = manager.create('source');
    await manager.close(terminal.id);
    expect(manager.list()).toEqual([]);
    expect(manager.activity('source')).toEqual([expect.objectContaining({ managed: false, state: 'uncertain' })]);
    expect(processes[0].pty.kill).toHaveBeenCalledTimes(1);
    processes[0].pty.exit();
    expect(manager.activity('source')).toHaveLength(1); // Root exit alone says nothing about its children.
    await expect(manager.closeManagedSession('source')).rejects.toThrow(/without process-tree containment/);
    expect(processes[0].pty.kill).toHaveBeenCalledTimes(1); // No signal sent to an exited/reusable PID.
  });

  it('does not turn the ordinary closeForSession timeout into a quiescent admission result', async () => {
    const { manager } = await fixture({ isManaged: () => false });
    manager.create('source');
    await manager.closeForSession('source'); // Legacy callers still have their bounded UI wait.
    expect(manager.list()).toEqual([]);
    expect(manager.activity('source')).toEqual([expect.objectContaining({ state: 'uncertain' })]);
    await expect(manager.closeManagedSession('source')).rejects.toThrow(/cannot be confirmed/);
  });

  it('retains both ordinary process generations across an immediate restart', async () => {
    const { manager, processes } = await fixture({ isManaged: () => false });
    const terminal = manager.create('source');
    await manager.restart(terminal.id);
    expect(manager.activity('source')).toHaveLength(2);
    processes[0].pty.exit();
    expect(manager.activity('source').map((r) => r.state)).toEqual(['uncertain', 'live']);
    expect(manager.list()[0].exit).toBeUndefined();
  });

  it('keeps the spawn cwd even if shell output advertises another directory', async () => {
    const { manager, processes, dir } = await fixture();
    const terminal = manager.create('lead');
    processes[0].pty.emit('\x1b]9;9;' + os.tmpdir() + '\x07');
    await manager.screenText(terminal.id);
    expect(manager.activity('lead')[0]).toMatchObject({ cwd: dir, reportedCwd: os.tmpdir() });
  });

  it('preserves the admission gate immediately before actual managed spawn on create and lazy restore', async () => {
    const beforeSpawn = vi.fn();
    const { manager, processes, spawn, dir } = await fixture({ beforeSpawn });
    const terminal = manager.create('lead');
    expect(beforeSpawn).toHaveBeenCalledWith(dir);
    expect(beforeSpawn.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]);
    await manager.persist();
    processes[0].proof.resolve(); processes[0].pty.exit();
    await tick();
    await manager.closeManagedSession('missing'); // No resources, no synthetic error.
    const restored = new TerminalManager({
      dir, settings: () => DEFAULT_TERMINAL_SETTINGS, cwdOf: () => dir, version: 'test',
      isManaged: () => false, beforeSpawn: () => { throw new Error('baseline lease held'); },
      spawn, push: vi.fn(), log: vi.fn()
    });
    await restored.load();
    expect(restored.activity()).toEqual([]); // Lazy snapshots own no process.
    const attached = await restored.attach(terminal.id, 80, 24);
    expect(attached.info.exit?.code).toBe(-1);
    expect(attached.snapshot).toContain('baseline lease held');
    expect(spawn).toHaveBeenCalledTimes(1);
    await restored.closeAll();
  });

  it('retains unresolved ownership across app reload without trusting a persisted PID as a kill target', async () => {
    const { manager, dir } = await fixture();
    manager.create('lead');
    await manager.persist();
    const killTree = vi.fn();
    const recovered = new TerminalManager({
      dir, settings: () => DEFAULT_TERMINAL_SETTINGS, cwdOf: () => dir, version: 'test',
      isManaged: () => true, killTree, push: vi.fn(), log: vi.fn()
    });
    await recovered.load();
    expect(recovered.activity('lead')).toEqual([expect.objectContaining({ state: 'uncertain', reason: expect.stringContaining('Previous app run') })]);
    await expect(recovered.closeManagedSession('lead')).rejects.toThrow(/without process-tree containment/);
    expect(killTree).not.toHaveBeenCalled();
    expect(() => recovered.create('lead')).toThrow(/uncertain/);
  });

  it('does not quarantine an unreadable ownership record into a false quiet state on the next load', async () => {
    const { manager, dir, spawn } = await fixture();
    const receipt = path.join(dir, 'unresolved.owner');
    await fs.writeFile(receipt, '{incomplete');
    await expect(manager.load()).rejects.toThrow(/Cannot read terminal process ownership/);
    await expect(manager.load()).rejects.toThrow(/Cannot read terminal process ownership/);
    expect(await fs.readFile(receipt, 'utf8')).toBe('{incomplete');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not leave a phantom process record when the beforeSpawn lease refuses launch', async () => {
    const { manager, dir, spawn } = await fixture({ beforeSpawn: () => { throw new Error('lease held'); } });
    expect(() => manager.create('lead')).toThrow('lease held');
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.activity()).toEqual([]);
    expect((await fs.readdir(dir)).filter((file) => file.endsWith('.owner'))).toEqual([]);
  });

  it('retains a successfully spawned process if later PTY setup throws before a tab is returned', async () => {
    const process = owned();
    process.pty.onData = () => { throw new Error('PTY listener setup failed'); };
    const { manager } = await fixture({
      spawn: () => process.pty as IPty,
      spawnOwned: (file, args, options, start) => ({ ...process, pty: start(file, args, options) })
    });
    expect(() => manager.create('lead')).toThrow('PTY listener setup failed');
    expect(manager.list()).toEqual([]);
    expect(manager.activity('lead')).toHaveLength(1);
    const closing = manager.closeManagedSession('lead');
    process.proof.resolve(); process.pty.exit();
    await closing;
    expect(manager.activity()).toEqual([]);
  });

  it('does not allow WSL guest processes to masquerade as a contained Windows terminal', async () => {
    const { manager, spawn } = await fixture({ settings: () => ({ ...DEFAULT_TERMINAL_SETTINGS, shell: 'custom', customShellPath: 'wsl.exe' }) });
    expect(() => manager.create('lead')).toThrow(/WSL guest processes/);
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.activity()).toEqual([]);
  });

  it('fails closed before invoking the PTY backend when managed containment is unavailable', async () => {
    const { manager, spawn } = await fixture({ spawnOwned: undefined, windowsJobHelper: undefined });
    expect(() => manager.create('lead')).toThrow(process.platform === 'win32' ? /Job Object helper/ : /containment is unavailable/);
    expect(manager.list()).toEqual([]);
    expect(manager.activity()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
