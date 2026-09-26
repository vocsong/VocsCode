/** Exact durable owner receipts: no PID discovery or a previous launch's success as proof. */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedPiOwnershipIntent, inspectManagedPiOwnership, recordUnlaunchedManagedPiIntent } from '../src/main/harness/pi-ownership';
import { launchOwnedWindowsJob, windowsJobCommandLine } from '../src/main/owned-windows-job';

let root: string;
const children: ChildProcess[] = [];
const owner = { sessionId: 'session', missionId: 'mission', generation: 3 };
const helper = path.resolve('resources/mission/windows-check-job.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-pi-recovery-')); });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill(); await closed;
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('never certifies missing, mismatched, orphaned or unreceipted ownership records', async () => {
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ state: 'absent', quiescent: false });
  const intent = await createManagedPiOwnershipIntent(root, owner);
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ state: 'unknown', quiescent: false, intents: 1 });
  await recordUnlaunchedManagedPiIntent(intent);
  expect(await inspectManagedPiOwnership(root, owner)).toEqual({ state: 'quiescent', quiescent: true, intents: 1 });
  expect(await inspectManagedPiOwnership(root, { ...owner, sessionId: 'different' })).toMatchObject({ quiescent: false });
  expect(await inspectManagedPiOwnership(root, { ...owner, generation: 4 })).toMatchObject({ quiescent: false });
  expect(await inspectManagedPiOwnership(root, { ...owner, notBefore: intent.record.createdAt + 1 })).toMatchObject({ quiescent: false });
  const receipt = JSON.parse(await fs.readFile(intent.receiptPath, 'utf8'));
  for (const patch of [{ nonce: randomUUID() }, { intentHash: '0'.repeat(64) }, { generation: 99 }, { missionId: 'different' }, { quiescent: false }, { childTreeZero: false }, { source: 'target_stdout' }]) {
    await fs.writeFile(intent.receiptPath, JSON.stringify({ ...receipt, ...patch }));
    expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ state: 'unknown', quiescent: false });
  }
  await fs.writeFile(intent.receiptPath, JSON.stringify(receipt));
  const next = await createManagedPiOwnershipIntent(root, owner);
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: false, intents: 2 });
  await recordUnlaunchedManagedPiIntent(next);
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: true, intents: 2 });
  await fs.rm(next.path);
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: false });
});

it('rejects partial intent writes and links rather than using an earlier valid receipt', async () => {
  const intent = await createManagedPiOwnershipIntent(root, owner); await recordUnlaunchedManagedPiIntent(intent);
  await fs.appendFile(intent.path, 'truncated');
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: false });
  await fs.writeFile(intent.path, JSON.stringify(intent.record) + '\n');
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: true });
  const directory = path.dirname(intent.path); const moved = directory + '-moved';
  await fs.rename(directory, moved); await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: false });
});

describe.runIf(process.platform === 'win32')('real supervisor crash-recovery receipt', () => {
  it('persists a matching empty-Job proof after the old app dies and no control reader remains', async () => {
    const intent = await createManagedPiOwnershipIntent(root, owner);
    const started = path.join(root, 'writer-started'); const late = path.join(root, 'late-write');
    const writer = path.join(root, 'writer.cjs'); const target = path.join(root, 'target.cjs');
    await fs.writeFile(writer, `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'UNSAFE'), 2000);`);
    await fs.writeFile(target, `require('node:child_process').spawn(process.execPath, [${JSON.stringify(writer)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);`);
    const pipeName = `mission-crash-${randomUUID()}`;
    const hostScript = path.join(root, 'old-app.cjs');
    const request = { executable: process.execPath, commandLine: windowsJobCommandLine(process.execPath, [target]), cwd: root, inheritStdio: true, timeoutMs: 0, waitForResume: true };
    await fs.writeFile(hostScript, `
const server = require('node:net').createServer(client => {
  client.setEncoding('utf8'); let pending = '';
  client.on('error', () => {});
  client.on('data', chunk => { pending += chunk; let end; while ((end = pending.indexOf('\\n')) >= 0) { const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1); if (frame.type === 'ready') client.write('resume\\n'); } });
  client.write(${JSON.stringify(JSON.stringify(request) + '\n')});
});
server.listen(${JSON.stringify(`\\\\.\\pipe\\${pipeName}`)}, () => process.stdout.write('listening'));
`);
    const oldApp = spawn(process.execPath, [hostScript], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(oldApp);
    let listening = ''; oldApp.stdout?.on('data', (data: Buffer) => { listening += data.toString(); });
    await vi.waitFor(() => expect(listening).toBe('listening'), { timeout: 10000 });
    const supervisor = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ControlPipe', pipeName,
      '-OwnerIntent', intent.path, '-OwnerHash', intent.hash], { windowsHide: true, stdio: 'ignore' }); children.push(supervisor);
    const closed = new Promise<void>((resolve) => supervisor.once('close', () => resolve()));
    await vi.waitFor(async () => expect(await fs.readFile(started, 'utf8')).toBe('ready'), { timeout: 15000 });
    expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: false });
    // Kill exactly the pipe-owning app fixture, not its supervisor and never a PID inventory.
    const oldClosed = new Promise<void>((resolve) => oldApp.once('close', () => resolve()));
    oldApp.kill(); await oldClosed; await closed;
    expect(await inspectManagedPiOwnership(root, { ...owner, notBefore: intent.record.createdAt })).toEqual({ state: 'quiescent', quiescent: true, intents: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(await fs.readdir(root)).not.toContain('late-write');
  }, 25000);

  it('records not-started proof when the app disappears before the supervisor can connect', async () => {
    const intent = await createManagedPiOwnershipIntent(root, owner);
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ControlPipe', `missing-${randomUUID()}`,
      '-OwnerIntent', intent.path, '-OwnerHash', intent.hash], { windowsHide: true, stdio: 'ignore' }); children.push(child);
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(JSON.parse(await fs.readFile(intent.receiptPath, 'utf8'))).toMatchObject({ source: 'supervisor', outcome: 'not_started', nonce: intent.record.nonce });
    expect(await inspectManagedPiOwnership(root, owner)).toEqual({ state: 'quiescent', quiescent: true, intents: 1 });
  }, 20000);

  it('never reuses a completed intent to launch another process under an earlier receipt', async () => {
    const intent = await createManagedPiOwnershipIntent(root, owner);
    const target = path.join(root, 'single-use.cjs'); const marker = path.join(root, 'runs');
    await fs.writeFile(target, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run');`);
    const launch = () => {
      const job = launchOwnedWindowsJob({
        executable: process.execPath, args: [target], cwd: root, helperPath: helper, ownershipIntent: intent,
        launch: (file, args) => spawn(file, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
        observeExit: (child, exited) => { child.once('close', exited); child.once('error', exited); },
      });
      children.push(job.process); return job;
    };
    await launch().quiescent;
    expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ quiescent: true });
    await expect(launch().quiescent).rejects.toThrow(/exited|disconnected/);
    expect(await fs.readFile(marker, 'utf8')).toBe('run');
  }, 15000);

  it('never substitutes a flushed temporary receipt for a failed final publication', async () => {
    const intent = await createManagedPiOwnershipIntent(root, owner);
    await fs.mkdir(intent.receiptPath); // Inject a real atomic-rename failure, not a passing stub.
    const job = launchOwnedWindowsJob({
      executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, helperPath: helper, ownershipIntent: intent,
      launch: (file, args) => spawn(file, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      observeExit: (child, exited) => { child.once('close', exited); child.once('error', exited); },
    });
    children.push(job.process);
    await expect(job.quiescent).rejects.toThrow(/exited|disconnected/);
    expect((await fs.readdir(path.dirname(intent.path))).some((name) => name.includes('.tmp-'))).toBe(true);
    expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ state: 'unknown', quiescent: false });
  }, 15000);

  it('leaves recovery unknown when the supervisor itself is killed before a receipt', async () => {
    const intent = await createManagedPiOwnershipIntent(root, owner);
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ControlPipe', `missing-${randomUUID()}`,
      '-OwnerIntent', intent.path, '-OwnerHash', intent.hash], { windowsHide: true, stdio: 'ignore' }); children.push(child);
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill(); await closed;
    expect(await inspectManagedPiOwnership(root, owner)).toMatchObject({ state: 'unknown', quiescent: false });
  }, 15000);
});
