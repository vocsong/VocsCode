/** Real Windows supervisor, including the inherited-stdio mode used by terminal integration.
 * These pipe tests do not certify ConPTY; the terminal suite must exercise that integration. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-job-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const helper = path.resolve('resources/mission/windows-check-job.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function inherited(commandLine: string) {
  const name = `vocs-mission-test-${randomUUID()}`;
  let socket: Socket | undefined;
  const frames: Array<Record<string, unknown>> = [];
  const server = createServer((connection) => {
    socket = connection;
    let pending = '';
    connection.setEncoding('utf8');
    connection.on('data', (data: string) => {
      pending += data;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(pending.slice(0, newline)) as Record<string, unknown>);
        pending = pending.slice(newline + 1);
      }
    });
    connection.write(`${JSON.stringify({ executable: process.execPath, commandLine, cwd: root, timeoutMs: 0, inheritStdio: true })}\n`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${name}`, resolve); });
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ControlPipe', name], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  return {
    child, frames, exited, stdout: () => stdout, stderr: () => stderr,
    cancel: () => socket?.write('cancel\n'),
    disconnect: () => socket?.end(),
    async dispose() {
      // Disconnect requests scoped Job teardown; kill only this known supervisor as a fallback.
      socket?.destroy();
      if (child.exitCode === null) child.kill();
      await exited;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe.skipIf(process.platform !== 'win32')('Windows owned Job Object resource', () => {
  it('inherits raw stdin/stdout but emits ownership proof only on the separate control pipe', async () => {
    await fs.writeFile(path.join(root, 'echo.cjs'), "process.stdin.once('data',d=>{process.stdout.write(d);process.stderr.write('warning');process.exit(0)});");
    const running = await inherited(`"${process.execPath}" echo.cjs`);
    try {
      await vi.waitFor(() => expect(running.frames[0]).toMatchObject({ type: 'ready' }), { timeout: 15_000 });
      running.child.stdin.write('raw terminal input\n');
      expect(await running.exited).toBe(0);
      expect(running.stdout()).toBe('raw terminal input\n');
      expect(running.stderr()).toBe('warning');
      expect(running.frames).toHaveLength(2);
      expect(running.frames[1]).toMatchObject({ type: 'done', quiescent: true, childTreeZero: true, code: 0, canceled: false, lingering: false });
    } finally { await running.dispose(); }
  }, 20_000);

  it('terminates a detached descendant before issuing a tree-zero receipt', async () => {
    await fs.writeFile(path.join(root, 'writer.cjs'), "setTimeout(()=>require('node:fs').writeFileSync('late.txt','wrong'),1200);setTimeout(()=>{},1500);");
    await fs.writeFile(path.join(root, 'root.cjs'), "require('node:child_process').spawn(process.execPath,['writer.cjs'],{stdio:'ignore',detached:true}).unref();");
    const running = await inherited(`"${process.execPath}" root.cjs`);
    try {
      expect(await running.exited).toBe(0);
      expect(running.frames.at(-1)).toMatchObject({ type: 'done', quiescent: true, childTreeZero: true, code: 0, lingering: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(fs.stat(path.join(root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await running.dispose(); }
  }, 20_000);

  it('kills the owned Job if the supervisor crashes, but emits no false tree-zero receipt', async () => {
    await fs.writeFile(path.join(root, 'writer.cjs'), "require('node:fs').writeFileSync('started.txt','ready');setTimeout(()=>require('node:fs').writeFileSync('late.txt','wrong'),1200);setTimeout(()=>{},1500);");
    const running = await inherited(`"${process.execPath}" writer.cjs`);
    try {
      await vi.waitFor(async () => expect(await fs.readFile(path.join(root, 'started.txt'), 'utf8')).toBe('ready'), { timeout: 15_000 });
      running.child.kill(); // Only the positively owned helper, never a process-name/tree search.
      await running.exited;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(running.frames.filter((frame) => frame.type === 'done')).toEqual([]);
      await expect(fs.stat(path.join(root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await running.dispose(); }
  }, 20_000);

  it('kills its owned Job on control EOF without treating root exit as proof', async () => {
    await fs.writeFile(path.join(root, 'writer.cjs'), "require('node:fs').writeFileSync('started.txt','ready');setTimeout(()=>require('node:fs').writeFileSync('late.txt','wrong'),1200);setTimeout(()=>{},1500);");
    const running = await inherited(`"${process.execPath}" writer.cjs`);
    try {
      await vi.waitFor(async () => expect(await fs.readFile(path.join(root, 'started.txt'), 'utf8')).toBe('ready'), { timeout: 15_000 });
      running.disconnect();
      await running.exited;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(fs.stat(path.join(root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await running.dispose(); }
  }, 20_000);
});
