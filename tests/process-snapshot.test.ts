/**
 * The OS process-table readers behind the Processes panel: the parsers for the Windows host's
 * replies and for `ps`, and — on the platform each belongs to — the real reader finding this test
 * process with its parent, creation time and command line.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PosixProcessSource,
  WindowsProcessSource,
  parseCommandLines,
  parsePsOutput,
  parsePsTime,
  parseWindowsSnapshot,
  type ProcessSource
} from '../src/main/process-snapshot';

const helper = path.resolve(__dirname, '..', 'resources', 'processes', 'windows-process-snapshot.ps1');
let source: ProcessSource | null = null;

afterEach(() => {
  source?.close();
  source = null;
});

describe('process table parsers', () => {
  it('parses the Windows host snapshot, keeping names that contain spaces', () => {
    const rows = parseWindowsSnapshot(['0\t0\t0\t0\t0\t[System Process]', '4120\t900\t1792143271800\t1530\t52428800\tVocs Code.exe', 'garbage']);
    expect(rows).toEqual([{ pid: 4120, ppid: 900, startedAt: 1792143271800, cpuMs: 1530, memory: 52428800, name: 'Vocs Code.exe' }]);
  });

  it('parses command lines by PID', () => {
    const lines = parseCommandLines(['31064\t"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-startup-window', '12984\tC:\\WINDOWS\\Explorer.EXE', 'x']);
    expect([...lines.entries()]).toEqual([
      [31064, '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --no-startup-window'],
      [12984, 'C:\\WINDOWS\\Explorer.EXE']
    ]);
  });

  it('parses procps and BSD cumulative CPU times', () => {
    expect(parsePsTime('00:00:03')).toBe(3_000);
    expect(parsePsTime('01:02:03')).toBe(3_723_000);
    expect(parsePsTime('2-00:00:01')).toBe(172_801_000);
    expect(parsePsTime('0:01.50')).toBe(1_500);
  });

  it('parses `ps` rows with an absolute start time and the full command', () => {
    const out = parsePsOutput(
      [
        '    1     0  11520 00:00:02 Thu Oct  2 09:15:07 2026 /sbin/init splash',
        ' 4242     1 204800 00:01:10 Fri Oct 16 10:00:00 2026 /usr/bin/node /home/me/app/node_modules/.bin/vite --port 5173'
      ].join('\n')
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      pid: 4242,
      ppid: 1,
      memory: 204800 * 1024,
      cpuMs: 70_000,
      startedAt: new Date(2026, 9, 16, 10, 0, 0).getTime(),
      name: 'node',
      command: '/usr/bin/node /home/me/app/node_modules/.bin/vite --port 5173'
    });
    expect(out[0].startedAt).toBe(new Date(2026, 9, 2, 9, 15, 7).getTime());
  });
});

describe.runIf(process.platform === 'win32')('Windows process reader', () => {
  it('sees this process with its parent, creation time and command line, and a child it starts', async () => {
    const reader = new WindowsProcessSource(helper);
    source = reader;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'vocs-snapshot-probe'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      const table = await reader.snapshot();
      const self = table.find((p) => p.pid === process.pid)!;
      expect(self.ppid).toBe(process.ppid);
      expect(self.name.toLowerCase()).toBe(path.basename(process.execPath).toLowerCase());
      expect(Math.abs(self.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(10_000);
      expect(self.memory).toBeGreaterThan(0);
      const probe = table.find((p) => p.pid === child.pid)!;
      expect(probe.ppid).toBe(process.pid);
      expect(probe.startedAt).toBeGreaterThanOrEqual(self.startedAt);
      // The reader is a helper the tracker hides; it is running and is this process's child too.
      expect(table.find((p) => p.pid === reader.helperPid)?.ppid).toBe(process.pid);
      const lines = await reader.commandLines([child.pid!, 999_999_999]);
      expect(lines.get(child.pid!)).toContain('vocs-snapshot-probe');
      expect(lines.has(999_999_999)).toBe(false);
    } finally {
      child.kill();
    }
  }, 180_000);
});

describe.runIf(process.platform !== 'win32')('POSIX process reader', () => {
  it('sees this process with its parent, creation time and command line', async () => {
    source = new PosixProcessSource();
    const table = await source.snapshot();
    const self = table.find((p) => p.pid === process.pid)!;
    expect(self.ppid).toBe(process.ppid);
    expect(Math.abs(self.startedAt - (Date.now() - process.uptime() * 1000))).toBeLessThan(10_000);
    expect(self.command).toContain(process.argv[1] ? path.basename(process.argv[1]) : 'node');
  });
});
