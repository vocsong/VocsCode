/**
 * The OS process-table readers behind the Processes panel: the parsers for the Windows host's
 * replies and for `ps`, and — on the platform each belongs to — the real reader finding this test
 * process with its parent, creation time and command line. On Windows, a session's Job keeps a
 * process launched through a shell that exits at once (`Start-Process`), which no parent chain can.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PosixProcessSource,
  WindowsProcessSource,
  parseAdoptReply,
  parseCommandLines,
  parseJobMembers,
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

  it('parses adoption results and Job members', () => {
    expect([...parseAdoptReply(['42\tok', '43\t!reused', '44\t!assign 5', 'junk']).entries()]).toEqual([
      [42, true],
      [43, 'reused'],
      [44, 'assign 5']
    ]);
    expect([...parseJobMembers(['s_abc\t10 11 12', 's_empty\t', 'bad']).entries()]).toEqual([
      ['s_abc', [10, 11, 12]],
      ['s_empty', []]
    ]);
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

  it('keeps a process started through a launcher that exits at once in its owner\'s Job', async () => {
    const reader = new WindowsProcessSource(helper);
    source = reader;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-job-'));
    const marker = `vocs-job-probe-${process.pid}-${Date.now()}`;
    // A harness that, when told to, runs a short-lived PowerShell tool shell which Start-Processes
    // a hidden window and exits, exactly as an agent's "run it in its own window" does.
    const script = path.join(dir, 'harness.js');
    await fs.writeFile(
      script,
      [
        "const { spawn } = require('child_process');",
        "process.stdin.once('data', () => {",
        `  const launcher = spawn('powershell.exe', ['-NoProfile', '-Command', "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep 90 # ${marker}'"], { stdio: 'ignore' });`,
        "  launcher.on('exit', () => console.log('LAUNCHER_EXITED ' + launcher.pid));",
        '});',
        'setTimeout(() => {}, 120000);'
      ].join('\n')
    );
    const harness = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'ignore'] });
    let detached = 0;
    try {
      await new Promise((resolve) => harness.once('spawn', resolve));
      const startedAt = (await reader.snapshot()).find((p) => p.pid === harness.pid)!.startedAt;
      // A creation time that does not match names another process: never adopted.
      expect((await reader.adopt('s_probe', [{ pid: harness.pid!, startedAt: startedAt + 1 }])).get(harness.pid!)).toBe('reused');
      expect((await reader.adopt('s_probe', [{ pid: harness.pid!, startedAt }])).get(harness.pid!)).toBe(true);
      expect((await reader.jobs()).get('s_probe')).toEqual([harness.pid]);

      const launcherPid = await new Promise<number>((resolve) => {
        let out = '';
        harness.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const m = /LAUNCHER_EXITED (\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        harness.stdin!.write('go\n');
      });
      const members = (await reader.jobs()).get('s_probe') ?? [];
      const lines = await reader.commandLines(members);
      detached = members.find((pid) => lines.get(pid)?.includes(marker)) ?? 0;
      expect(detached, `a Job member runs ${marker}`).toBeGreaterThan(0);
      const table = await reader.snapshot();
      // Its parent, the launcher, is gone: only the Job says whose it is.
      expect(table.find((p) => p.pid === detached)!.ppid).toBe(launcherPid);
      expect(table.some((p) => p.pid === launcherPid)).toBe(false);
    } finally {
      if (detached) process.kill(detached);
      harness.kill();
      await fs.rm(dir, { recursive: true, force: true });
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
