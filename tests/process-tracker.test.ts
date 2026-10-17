/**
 * The process tracker behind the Processes panel: which processes count as the app's, who each
 * works for, which ones were left behind (by a parent that died, or by an earlier run), and that
 * ending one ends its subtree and nothing else. A fake process table drives every case; the real
 * readers are covered in process-snapshot.test.ts.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessTracker, type ProcessTrackerOptions } from '../src/main/process-tracker';
import type { ProcessSource, RawProcess } from '../src/main/process-snapshot';
import type { ProcessSummary, TrackedProcess } from '../src/shared/processes';

const APP = 1000;
const T0 = 1_800_000_000_000;

class FakeSource implements ProcessSource {
  table: RawProcess[] = [];
  commands = new Map<number, string>();
  helperPid?: number;
  closed = false;
  async snapshot(): Promise<RawProcess[]> {
    return this.table.map((p) => ({ ...p }));
  }
  async commandLines(pids: number[]): Promise<Map<number, string>> {
    return new Map(pids.filter((pid) => this.commands.has(pid)).map((pid) => [pid, this.commands.get(pid)!]));
  }
  close(): void {
    this.closed = true;
  }
}

/** A Windows reader with session Jobs: members are set by the test, adoptions are recorded. */
class JobSource extends FakeSource {
  members = new Map<string, Set<number>>();
  calls: [string, { pid: number; startedAt: number }[]][] = [];
  refuse = new Set<number>();
  constructor(table: RawProcess[]) {
    super();
    this.table = table;
  }
  async adopt(owner: string, targets: { pid: number; startedAt: number }[]): Promise<Map<number, true | string>> {
    this.calls.push([owner, targets]);
    const out = new Map<number, true | string>();
    for (const t of targets) {
      if (this.refuse.has(t.pid)) {
        out.set(t.pid, 'assign 5');
        continue;
      }
      if (!this.members.has(owner)) this.members.set(owner, new Set());
      this.members.get(owner)!.add(t.pid);
      out.set(t.pid, true);
    }
    return out;
  }
  async jobs(): Promise<Map<string, number[]>> {
    const live = new Set(this.table.map((p) => p.pid));
    return new Map([...this.members].map(([owner, pids]) => [owner, [...pids].filter((pid) => live.has(pid))]));
  }
}

const proc = (pid: number, ppid: number, startedAt: number, name: string, over: Partial<RawProcess> = {}): RawProcess => ({ pid, ppid, startedAt, cpuMs: 0, memory: 1024 * 1024, name, ...over });

let dir: string;
let source: FakeSource;
let clock: number;
let signals: [number, NodeJS.Signals | 0][];
let summaries: ProcessSummary[];

function tracker(over: Partial<ProcessTrackerOptions> = {}): ProcessTracker {
  return new ProcessTracker({
    source,
    rootPid: APP,
    internalPids: () => [APP, 1001],
    registryFile: path.join(dir, 'processes.json'),
    cpuCount: 4,
    now: () => clock,
    signal: (pid, sig) => {
      signals.push([pid, sig]);
    },
    platform: 'win32',
    observeSpawns: false,
    onSummary: (s) => summaries.push(s),
    ...over
  });
}

const byPid = (list: TrackedProcess[], pid: number) => list.find((p) => p.pid === pid);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-processes-'));
  source = new FakeSource();
  clock = T0;
  signals = [];
  summaries = [];
  source.table = [
    proc(4, 0, T0 - 900_000, 'System'),
    proc(APP, 900, T0 - 60_000, 'Vocs Code.exe'),
    // Chromium's renderer: part of the app, never listed.
    proc(1001, APP, T0 - 59_000, 'Vocs Code.exe')
  ];
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('process tracker', () => {
  it('lists what the app started and attributes it to the session that started it', async () => {
    source.table.push(
      proc(2000, APP, T0 - 30_000, 'claude.exe'),
      proc(2001, 2000, T0 - 29_000, 'conhost.exe'),
      proc(2002, 2000, T0 - 20_000, 'bash.exe'),
      proc(2003, 2002, T0 - 19_000, 'node.exe'),
      proc(3000, APP, T0 - 40_000, 'cmd.exe'),
      proc(3001, 3000, T0 - 39_000, 'node.exe'),
      // Not the app's: an unrelated process.
      proc(5000, 900, T0 - 10_000, 'chrome.exe')
    );
    source.commands.set(2003, 'node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js run dev');
    const t = tracker();
    t.claim(2000, { sessionId: 's1' });
    t.claim(3000, { label: 'GitNexus server' });
    const list = await t.list();

    expect(list.error).toBeUndefined();
    // The console host is tracked for ending but not listed; the app and its renderer never are.
    expect(list.processes.map((p) => p.pid).sort()).toEqual([2000, 2002, 2003, 3000, 3001]);
    expect(byPid(list.processes, 2000)!.owner).toEqual({ sessionId: 's1' });
    expect(byPid(list.processes, 2003)!.owner).toEqual({ sessionId: 's1' });
    expect(byPid(list.processes, 2003)!.command).toContain('npm-cli.js run dev');
    // A label names the root that was started; its children only inherit who they work for.
    expect(byPid(list.processes, 3000)!.owner).toEqual({ label: 'GitNexus server' });
    expect(byPid(list.processes, 3001)!.owner).toEqual({});
    expect(list.processes.some((p) => p.orphaned)).toBe(false);
    expect(summaries.at(-1)).toEqual({ count: 5, orphaned: 0 });
  });

  it('never follows a reused PID: a process older than its recorded parent is not that parent\'s child', async () => {
    // 6000's parent PID is the app's, but it started before the app did: the PID was reused.
    source.table.push(proc(6000, APP, T0 - 120_000, 'stranger.exe'), proc(6001, 6000, T0 - 110_000, 'child.exe'));
    expect((await tracker().list()).processes).toEqual([]);
  });

  it('attributes a terminal tab\'s shell and what runs in it to that tab\'s session', async () => {
    source.table.push(proc(7000, APP, T0 - 10_000, 'powershell.exe'), proc(7001, 7000, T0 - 5_000, 'node.exe'));
    const t = tracker({ terminalRoots: () => [{ pid: 7000, sessionId: 's2', terminalId: 't1', title: 'PowerShell' }] });
    const list = await t.list();
    expect(byPid(list.processes, 7000)!.owner).toEqual({ sessionId: 's2', terminalId: 't1', label: 'PowerShell' });
    expect(byPid(list.processes, 7001)!.owner).toEqual({ sessionId: 's2', terminalId: 't1' });
  });

  it('tracks a terminal shell even when the pseudo-console, not the app, is its recorded parent', async () => {
    source.table.push(proc(7100, 4, T0 - 10_000, 'pwsh.exe'), proc(7101, 7100, T0 - 5_000, 'node.exe'));
    const t = tracker({ terminalRoots: () => [{ pid: 7100, sessionId: 's2', terminalId: 't2', title: 'pwsh' }] });
    const list = await t.list();
    expect(list.processes.map((p) => p.pid)).toEqual([7100, 7101]);
    expect(list.processes.every((p) => !p.orphaned && p.owner.sessionId === 's2')).toBe(true);
  });

  it('keeps a process whose Vocs Code parent exited, flagged as left behind with its subtree', async () => {
    source.table.push(proc(2000, APP, T0 - 30_000, 'claude.exe'), proc(2002, 2000, T0 - 20_000, 'node.exe'), proc(2003, 2002, T0 - 19_000, 'esbuild.exe'));
    const t = tracker();
    t.claim(2000, { sessionId: 's1' });
    await t.list();

    // The harness exits; Windows does not re-parent, so the dev server still points at the dead PID.
    source.table = source.table.filter((p) => p.pid !== 2000);
    clock += 10_000;
    const list = await t.list();
    expect(list.processes.map((p) => p.pid).sort()).toEqual([2002, 2003]);
    for (const p of list.processes) {
      expect(p.orphaned).toBe(true);
      expect(p.owner.sessionId).toBe('s1');
      expect(p.previousRun).toBeUndefined();
    }
    expect(summaries.at(-1)).toEqual({ count: 2, orphaned: 2 });
  });

  it('claims a child a tracked process started just before it died, but not an older stranger with that parent PID', async () => {
    source.table.push(proc(2000, APP, T0 - 30_000, 'claude.exe'));
    const t = tracker();
    t.claim(2000, { sessionId: 's1' });
    await t.list();

    clock += 10_000;
    source.table = source.table.filter((p) => p.pid !== 2000);
    // Started after the last sample by the now-dead harness: still the app's.
    source.table.push(proc(2005, 2000, T0 + 4_000, 'node.exe'));
    // Already running at the last sample without being under the harness: not the app's.
    source.table.push(proc(2006, 2000, T0 - 5_000, 'other.exe'));
    const list = await t.list();
    expect(list.processes.map((p) => p.pid)).toEqual([2005]);
    expect(list.processes[0]).toMatchObject({ orphaned: true, owner: { sessionId: 's1' } });
  });

  it('finds what an earlier run left behind, by PID and creation time, from the saved list', async () => {
    source.table.push(proc(2000, APP, T0 - 30_000, 'claude.exe'), proc(2002, 2000, T0 - 20_000, 'node.exe'));
    source.commands.set(2002, 'node server.js');
    const first = tracker();
    first.claim(2000, { sessionId: 's1' });
    await first.list();
    // The save is fire-and-forget; wait for the file.
    await expect.poll(async () => (await fs.readFile(path.join(dir, 'processes.json'), 'utf8').catch(() => '')).includes('"pid": 2002')).toBe(true);

    // The app quits: its direct children die with it, the grandchild survives. A new run starts.
    source.table = [
      proc(4, 0, T0 - 900_000, 'System'),
      proc(8000, 900, T0 + 60_000, 'Vocs Code.exe'),
      proc(2002, 2000, T0 - 20_000, 'node.exe'),
      proc(2010, 2002, T0 + 61_000, 'node.exe'),
      // The harness's PID was reused by an unrelated process; it must not be adopted.
      proc(2000, 900, T0 + 50_000, 'notepad.exe')
    ];
    clock = T0 + 120_000;
    const second = tracker({ rootPid: 8000, internalPids: () => [8000] });
    const list = await second.list();
    expect(list.processes.map((p) => p.pid).sort()).toEqual([2002, 2010]);
    expect(byPid(list.processes, 2002)).toMatchObject({ orphaned: true, previousRun: true, owner: { sessionId: 's1' }, command: 'node server.js' });
    expect(byPid(list.processes, 2010)).toMatchObject({ orphaned: true, previousRun: true });
    expect(summaries.at(-1)).toEqual({ count: 2, orphaned: 2 });
  });

  it('starts from the live tree when the saved list is corrupt, keeping a copy and saying so', async () => {
    await fs.writeFile(path.join(dir, 'processes.json'), '{"version":1,"processes":[{"pid":');
    source.table.push(proc(2000, APP, T0 - 30_000, 'node.exe'));
    const logs: [string, string][] = [];
    const list = await tracker({ log: (level, message) => logs.push([level, message]) }).list();
    expect(list.processes.map((p) => p.pid)).toEqual([2000]);
    expect(logs.some(([level, message]) => level === 'warn' && message.includes('is not valid JSON'))).toBe(true);
    expect((await fs.readdir(dir)).some((name) => name.startsWith('processes.json.corrupt-'))).toBe(true);
  });

  it('retries a save that failed on the next sample, even when nothing changed', async () => {
    const file = path.join(dir, 'processes.json');
    // A directory where the file belongs makes the atomic rename fail.
    await fs.mkdir(file);
    source.table.push(proc(2000, APP, T0 - 30_000, 'node.exe'));
    const logs: [string, string][] = [];
    const t = tracker({ log: (level, message) => logs.push([level, message]) });
    await t.list();
    await expect.poll(() => logs.some(([level, message]) => level === 'warn' && message.includes('could not save the process list'))).toBe(true);

    await fs.rm(file, { recursive: true });
    clock += 10_000;
    await t.refresh();
    await expect.poll(async () => (await fs.readFile(file, 'utf8').catch(() => '')).includes('"pid": 2000')).toBe(true);
  });

  it('ends a target and its whole subtree, parents first, and refuses anything it does not track', async () => {
    source.table.push(
      proc(2000, APP, T0 - 30_000, 'claude.exe'),
      proc(2001, 2000, T0 - 29_000, 'conhost.exe'),
      proc(2002, 2000, T0 - 20_000, 'bash.exe'),
      proc(2003, 2002, T0 - 19_000, 'node.exe'),
      proc(3000, APP, T0 - 40_000, 'gitnexus.exe'),
      proc(5000, 900, T0 - 10_000, 'chrome.exe')
    );
    const t = tracker();
    const result = await t.end([
      { pid: 2000, startedAt: T0 - 30_000 },
      // Same PID, different creation time: a stale row naming a reused PID.
      { pid: 3000, startedAt: T0 - 1 },
      { pid: 5000, startedAt: T0 - 10_000 },
      { pid: APP, startedAt: T0 - 60_000 },
      { pid: 1001, startedAt: T0 - 59_000 }
    ]);
    expect(signals.map(([pid]) => pid)).toEqual([2000, 2001, 2002, 2003]);
    expect(signals.every(([, sig]) => sig === 'SIGKILL')).toBe(true);
    expect(result.ended).toBe(4);
    expect(result.failed.map((f) => f.pid).sort()).toEqual([1001, 3000, 5000, APP].sort());
  });

  it('ends nothing when the fresh sample fails, rather than trusting an older one', async () => {
    source.table.push(proc(2000, APP, T0 - 30_000, 'node.exe'));
    const t = tracker();
    await t.list();
    source.snapshot = async () => {
      throw new Error('The Windows process reader stopped answering.');
    };
    const result = await t.end([{ pid: 2000, startedAt: T0 - 30_000 }]);
    expect(signals).toEqual([]);
    expect(result).toEqual({ ended: 0, failed: [{ pid: 2000, error: 'The Windows process reader stopped answering.' }] });
  });

  it('gives POSIX processes a chance to exit before a SIGKILL', async () => {
    source.table.push(proc(2000, APP, T0 - 30_000, 'node'), proc(2001, 2000, T0 - 20_000, 'node'));
    const alive = new Set([2001]);
    const t = tracker({
      platform: 'linux',
      signal: (pid, sig) => {
        signals.push([pid, sig]);
        if (sig === 0 && !alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
    });
    const result = await t.end([{ pid: 2000, startedAt: T0 - 30_000 }]);
    expect(result).toEqual({ ended: 2, failed: [] });
    expect(signals).toEqual([[2000, 'SIGTERM'], [2001, 'SIGTERM'], [2000, 0], [2001, 0], [2001, 'SIGKILL']]);
  });

  it('attributes a process started through a launcher that has exited to its session, through the session Job', async () => {
    // claude.exe ran a PowerShell tool that Start-Processed a server window and exited: the window's
    // recorded parent (2500) was never sampled, so no parent chain leads back to the app.
    source.table.push(proc(2000, APP, T0 - 30_000, 'claude.exe'), proc(3000, 2500, T0 - 5_000, 'powershell.exe'), proc(3001, 3000, T0 - 4_000, 'node.exe'));
    const without = tracker();
    without.claim(2000, { sessionId: 's1' });
    expect((await without.list()).processes.map((p) => p.pid)).toEqual([2000]);

    const jobs = new JobSource(source.table);
    jobs.members.set('s1', new Set([2000, 3000, 3001]));
    const t = tracker({ source: jobs });
    t.claim(2000, { sessionId: 's1' });
    const list = await t.list();
    expect(list.processes.map((p) => p.pid)).toEqual([2000, 3000, 3001]);
    expect(byPid(list.processes, 3000)).toMatchObject({ owner: { sessionId: 's1' }, orphaned: true });
    expect(byPid(list.processes, 3001)).toMatchObject({ owner: { sessionId: 's1' }, orphaned: true });
    expect(byPid(list.processes, 3000)!.previousRun).toBeUndefined();
  });

  it('puts a session\'s processes into its Job at spawn and when found, never app services, Mission sessions or Job-owned shells', async () => {
    const jobs = new JobSource([
      ...source.table,
      proc(2000, APP, T0 - 30_000, 'claude.exe'),
      proc(2001, 2000, T0 - 29_000, 'node.exe'),
      proc(2002, 2000, T0 - 29_000, 'conhost.exe'),
      proc(3000, APP, T0 - 40_000, 'cmd.exe'),
      proc(4000, APP, T0 - 20_000, 'pi.exe'),
      proc(4001, 4000, T0 - 19_000, 'node.exe'),
      proc(7000, APP, T0 - 10_000, 'powershell.exe'),
      proc(7001, 7000, T0 - 9_000, 'node.exe'),
      proc(7100, APP, T0 - 8_000, 'powershell.exe'),
      proc(7101, 7100, T0 - 7_000, 'node.exe')
    ]);
    const t = tracker({
      source: jobs,
      adoptable: (owner) => owner.sessionId !== 's_mission',
      terminalRoots: () => [
        { pid: 7000, sessionId: 's2', terminalId: 't1', owned: true },
        { pid: 7100, sessionId: 's2', terminalId: 't2' }
      ]
    });
    // At spawn, before the harness can start anything: no creation time is known yet.
    t.claim(2000, { sessionId: 's1' });
    await expect.poll(() => jobs.calls.length).toBe(1);
    expect(jobs.calls[0]).toEqual(['s1', [{ pid: 2000, startedAt: 0 }]]);
    t.claim(3000, { label: 'GitNexus server' });
    t.claim(4000, { sessionId: 's_mission' });
    expect(jobs.calls).toHaveLength(1);

    await t.list();
    expect(jobs.calls.slice(1).sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['s1', [{ pid: 2001, startedAt: T0 - 29_000 }]],
      ['s2', [{ pid: 7100, startedAt: T0 - 8_000 }, { pid: 7101, startedAt: T0 - 7_000 }]]
    ]);
    // Members are not adopted again.
    clock += 2_000;
    await t.list();
    expect(jobs.calls).toHaveLength(3);
  });

  it('leaves an earlier run\'s leftover out of the session Job, and left behind across samples', async () => {
    await fs.writeFile(path.join(dir, 'processes.json'), JSON.stringify({ version: 1, savedAt: T0, processes: [{ pid: 5000, ppid: 4000, startedAt: T0 - 90_000, name: 'node.exe', owner: { sessionId: 's1' } }] }));
    const jobs = new JobSource([...source.table, proc(5000, 4000, T0 - 90_000, 'node.exe'), proc(2000, APP, T0 - 30_000, 'claude.exe')]);
    const t = tracker({ source: jobs });
    t.claim(2000, { sessionId: 's1' });
    for (let i = 0; i < 2; i++) {
      clock += 2_000;
      const list = await t.list();
      expect(byPid(list.processes, 5000)).toMatchObject({ orphaned: true, previousRun: true, owner: { sessionId: 's1' } });
    }
    expect(jobs.calls.flatMap(([, targets]) => targets.map((target) => target.pid))).not.toContain(5000);
    // Even listed by a Job (another path put it there), it keeps what is known about it.
    jobs.members.get('s1')!.add(5000);
    clock += 2_000;
    expect(byPid((await t.list()).processes, 5000)).toMatchObject({ previousRun: true });
  });

  it('does not retry a process the reader refused to put into a Job', async () => {
    const jobs = new JobSource([...source.table, proc(2000, APP, T0 - 30_000, 'claude.exe'), proc(2001, 2000, T0 - 29_000, 'elevated.exe')]);
    jobs.refuse.add(2001);
    const logs: string[] = [];
    const t = tracker({ source: jobs, log: (_level, message) => logs.push(message) });
    t.claim(2000, { sessionId: 's1' });
    await t.list();
    expect(jobs.calls.flatMap(([, targets]) => targets.map((target) => target.pid))).toEqual([2000, 2001]);
    expect(logs.some((m) => m.includes('2001 stays out of s1') && m.includes('assign 5'))).toBe(true);
    clock += 2_000;
    await t.list();
    expect(jobs.calls).toHaveLength(2);
  });

  it('reports CPU as a share of the whole machine between two samples', async () => {
    source.table.push(proc(2000, APP, T0 - 30_000, 'node.exe', { cpuMs: 1_000 }));
    const t = tracker();
    expect(byPid((await t.list()).processes, 2000)!.cpu).toBeUndefined();
    source.table = source.table.map((p) => (p.pid === 2000 ? { ...p, cpuMs: 3_000 } : p));
    clock += 2_000;
    // 2 s of CPU over 2 s of wall time on 4 cores is a quarter of the machine.
    expect(byPid((await t.list()).processes, 2000)!.cpu).toBeCloseTo(25);
  });

  it('answers a polling panel from the last sample while it is fresh', async () => {
    source.table.push(proc(2000, APP, T0 - 30_000, 'node.exe'));
    const t = tracker();
    const first = await t.list();
    source.table.push(proc(2001, APP, T0 - 1_000, 'node.exe'));
    clock += 500;
    expect(await t.list()).toBe(first);
    clock += 1_500;
    expect((await t.list()).processes).toHaveLength(2);
  });

  it('reports an unreadable process table instead of an empty one', async () => {
    source.snapshot = async () => {
      throw new Error('The Windows process reader did not start.');
    };
    const list = await tracker().list();
    expect(list).toMatchObject({ processes: [], error: 'The Windows process reader did not start.' });
  });

  it('saves on close only after it has sampled, and closes its reader', async () => {
    const t = tracker();
    await t.close();
    expect(source.closed).toBe(true);
    await expect(fs.stat(path.join(dir, 'processes.json'))).rejects.toThrow();
  });
});
