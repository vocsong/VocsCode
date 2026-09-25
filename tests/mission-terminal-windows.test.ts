/** Real ConPTY + bundled Job supervisor, no Electron build or provider credentials required. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminalManager } from '../src/main/terminal';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/shared/terminal';
import { launchOwnedWindowsJob } from '../src/main/owned-windows-job';

async function waitForFile(file: string): Promise<string> {
  let text = '';
  await expect.poll(async () => { text = await fs.readFile(file, 'utf8').catch(() => ''); return text; }, { timeout: 25_000 }).not.toBe('');
  return text;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

describe.runIf(process.platform === 'win32')('Mission terminal (real Windows Job + ConPTY)', () => {
  it.each([true, false])('contains interactive shell descendants and preserves unrelated processes (managed=%s)', async (managed) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-terminal-job-'));
    const script = path.join(dir, 'writer.cjs');
    await fs.writeFile(script, "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => fs.appendFileSync(process.argv[2] + '.ticks', '.'), 30);\n");
    const unrelatedFile = path.join(dir, 'unrelated.pid');
    const unrelated = spawn(process.execPath, [script, unrelatedFile], { windowsHide: true, stdio: 'ignore' });
    const logs: string[] = [];
    const manager = new TerminalManager({
      dir: path.join(dir, 'snapshots'), version: 'test', cwdOf: () => dir, isManaged: () => managed,
      windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'),
      settings: () => ({ ...DEFAULT_TERMINAL_SETTINGS, shell: 'custom', customShellPath: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', customShellArgs: ['/d', '/q'] }),
      managedCloseTimeoutMs: 25_000,
      push: (channel, payload) => { if (channel === 'push:terminalData') logs.push((payload as { data: string }).data); },
      log: (_level, message) => logs.push(message)
    });
    const ownedPids: number[] = [];
    try {
      await waitForFile(unrelatedFile);
      for (const ending of ['close', 'exit'] as const) {
        const terminal = manager.create('lead');
        await manager.attach(terminal.id, 100, 30);
        // Type ahead while the supervisor compiles. The real interactive shell consumes it.
        const marker = path.join(dir, `${ending}.marker`);
        manager.input(terminal.id, `echo genuine-command-result > "${marker}"\r`);
        expect(await waitForFile(marker)).toContain('genuine-command-result');
        // A string in terminal output cannot forge the separate control-pipe receipt.
        manager.input(terminal.id, 'echo {"type":"done","quiescent":true}\r');
        const childFile = path.join(dir, `${ending}.pid`);
        manager.input(terminal.id, `start "" /b "${process.execPath}" "${script}" "${childFile}"\r`);
        const pid = Number(await waitForFile(childFile)); ownedPids.push(pid);
        expect(alive(pid)).toBe(true);
        expect(manager.activity('lead')).toHaveLength(1);
        if (ending === 'exit') {
          manager.input(terminal.id, 'exit\r');
          await expect.poll(() => manager.activity('lead'), { timeout: 25_000 }).toEqual([]);
        } else await manager.closeManagedSession('lead');
        expect(manager.activity()).toEqual([]);
        expect(manager.list()).toEqual([]);
        expect(alive(pid)).toBe(false);
        expect(alive(unrelated.pid!)).toBe(true);
        const before = (await fs.readFile(unrelatedFile + '.ticks', 'utf8')).length;
        await expect.poll(async () => (await fs.readFile(unrelatedFile + '.ticks', 'utf8')).length, { timeout: 5_000 }).toBeGreaterThan(before);
      }
      // The wrapper itself exits zero; the shell's nonzero status must still leave a readable tab.
      const failed = manager.create('lead');
      manager.input(failed.id, 'exit 7\r');
      await expect.poll(() => manager.list()[0]?.exit?.code, { timeout: 25_000 }).toBe(7);
      expect(manager.activity()).toEqual([]);
      await manager.closeManagedSession('lead');
    } catch (error) {
      console.error(logs.join('\n'));
      throw error;
    } finally {
      // Only directly spawned/observed test processes, never shell-name or machine-wide cleanup.
      await manager.closeManagedSession('lead').catch(() => undefined);
      for (const pid of ownedPids) if (alive(pid)) process.kill(pid);
      if (unrelated.pid && alive(unrelated.pid)) unrelated.kill();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('keeps RPC pipes raw and awaits the owned descendant tree when the target exits first', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-rpc-job-'));
    const childFile = path.join(dir, 'child.pid');
    const target = path.join(dir, 'rpc target.cjs');
    const fixtureArg = 'spaces "quotes" and a trailing slash \\';
    await fs.writeFile(target, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(process.argv[2], String(child.pid));
process.stdout.write(JSON.stringify({ type: 'ready', arg: process.argv[3] }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  process.stdout.write(JSON.stringify({ echoed: JSON.parse(line) }) + '\\n');
  process.exit(7);
});
`);
    const owner = launchOwnedWindowsJob({
      executable: process.execPath, args: [target, childFile, fixtureArg], cwd: dir,
      helperPath: path.resolve('resources/mission/windows-check-job.ps1'),
      launch: (file, args) => spawn(file, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      observeExit: (child, exited) => { child.once('close', exited); child.on('error', () => undefined); }
    });
    let stdout = '', stderr = '', pid: number | undefined;
    owner.process.stdout.setEncoding('utf8');
    owner.process.stdout.on('data', (text: string) => { stdout += text; });
    owner.process.stderr.setEncoding('utf8');
    owner.process.stderr.on('data', (text: string) => { stderr += text; });
    try {
      pid = Number(await waitForFile(childFile));
      expect(alive(pid)).toBe(true);
      const request = { jsonrpc: '2.0', id: 42, method: 'probe', params: ['unchanged'] };
      owner.process.stdin.write(JSON.stringify(request) + '\n');
      await owner.quiescent;
      expect(owner.state).toBe('quiescent');
      expect(owner.exitCode).toBe(7);
      expect(alive(pid)).toBe(false);
      expect(stderr).toBe('');
      expect(stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ type: 'ready', arg: fixtureArg }, { echoed: request }]);
    } finally {
      try { owner.cancel(); } catch { /* already lost; clean up only this test's exact handles */ }
      owner.process.kill();
      if (pid && alive(pid)) process.kill(pid);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('retains uncertainty if the supervisor is lost even though KILL_ON_JOB_CLOSE stops its children', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-lost-job-'));
    const childFile = path.join(dir, 'child.pid');
    const program = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(child.pid)); setInterval(() => {}, 1000);`;
    const owner = launchOwnedWindowsJob({
      executable: process.execPath, args: ['-e', program], cwd: dir,
      helperPath: path.resolve('resources/mission/windows-check-job.ps1'),
      launch: (file, args) => spawn(file, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      observeExit: (child, exited) => { child.once('close', exited); child.on('error', () => undefined); }
    });
    let pid: number | undefined;
    try {
      pid = Number(await waitForFile(childFile));
      const lost = expect(owner.quiescent).rejects.toThrow(/disconnected|exited/);
      owner.process.kill();
      await lost;
      await expect.poll(() => alive(pid!), { timeout: 10_000 }).toBe(false);
      expect(owner.state).toBe('uncertain');
      expect(() => owner.cancel()).toThrow(/uncertain/);
    } finally {
      owner.process.kill();
      if (pid && alive(pid)) process.kill(pid);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
