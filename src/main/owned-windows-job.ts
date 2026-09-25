/** Owned Windows Job controller shared by PTYs and managed RPC processes. Not a sandbox.
 * The bundled supervisor assigns a suspended target before resume; stdio stays raw. All control
 * and empty-Job receipts use a separate non-inherited named pipe, never target output or PIDs. */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';

export interface OwnedWindowsJob<T> {
  process: T;
  /** Positive empty-Job receipt AND supervisor exit. A lost proof rejects, never becomes success. */
  quiescent: Promise<void>;
  readonly exitCode?: number;
  readonly state: 'live' | 'closing' | 'uncertain' | 'quiescent';
  /** Safe to retry while the supervisor still owns the Job. Never signals a reusable numeric PID. */
  cancel(): void;
}

export interface OwnedWindowsJobOptions<T> {
  executable: string;
  args: string[];
  cwd: string;
  /** Absolute bundled host resource path, not a script loaded from the assigned workspace. */
  helperPath: string;
  /** Own cwd/env/stdio here; called exactly once with the trusted supervisor and its argv. */
  launch(file: string, args: string[]): T;
  /** PTY onExit or ChildProcess close. ChildProcess callers must also handle its error event. */
  observeExit(process: T, exited: () => void): void;
  /** Optional trusted host-built Win32 command line, for launchers such as cmd.exe shims. */
  commandLine?: string;
  /** Optional fsynced host intent; the supervisor persists its final proof even after pipe loss. */
  ownershipIntent?: { path: string; hash: string };
  startupTimeoutMs?: number;
}

/** libuv places non-detached children in a kill-on-parent-close Job on Windows. The owner must
 * survive app death to observe its own Job becoming empty. Windows PowerShell exits without
 * running scripts under DETACHED_PROCESS, so a detached Node trampoline starts it normally and
 * waits for its close. Raw stdio is inherited, not parsed. Electron uses its supported Node mode;
 * that switch is stripped before launching the supervisor/target. This is not a sandbox. */
export const independentWindowsSupervisorScript = `
const { spawn } = require('node:child_process');
const [file, encoded] = process.argv.slice(1);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(file, JSON.parse(encoded), { env, windowsHide: true, stdio: 'inherit' });
child.once('error', () => process.exit(1));
child.once('close', code => process.exit(code ?? 1));
`;
export function spawnIndependentWindowsSupervisor(file: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', independentWindowsSupervisorScript, file, JSON.stringify(args)], {
    ...options, env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** CreateProcess argv quoting, not cmd.exe escaping. */
export function windowsJobCommandLine(file: string, args: string[]): string {
  const quote = (arg: string) => {
    if (!/[\s"]/.test(arg) && arg) return arg;
    return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
  };
  return [file, ...args].map(quote).join(' ');
}

export function launchOwnedWindowsJob<T>(options: OwnedWindowsJobOptions<T>): OwnedWindowsJob<T> {
  if (process.platform !== 'win32') throw new Error('Windows Job Object ownership is unavailable on this platform');
  if (!options.helperPath || !path.isAbsolute(options.helperPath) || !statSync(options.helperPath).isFile()) throw new Error('Process ownership requires the bundled Windows Job Object helper');
  if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.cwd)) throw new Error('Owned process executable and cwd must be absolute');
  if (options.ownershipIntent && (!path.isAbsolute(options.ownershipIntent.path) || !/^[0-9a-f]{64}$/.test(options.ownershipIntent.hash))) throw new Error('Invalid durable process ownership intent');
  const pipeName = `vocs-job-${randomUUID()}`;
  let socket: Socket | undefined, connected = false, ready = false, requestedClose = false, treeQuiet = false, rootExited = false, failed = false;
  let state: OwnedWindowsJob<T>['state'] = 'live', exitCode: number | undefined;
  let prove!: () => void, reject!: (error: Error) => void;
  const quiescent = new Promise<void>((resolve, fail) => { prove = resolve; reject = fail; });
  // Spawn/setup can fail before the caller receives a handle; never leave an unhandled rejection.
  void quiescent.catch(() => undefined);
  const settle = () => {
    if (!failed && treeQuiet && rootExited) { state = 'quiescent'; prove(); }
  };
  const fail = (message: string) => {
    if (state === 'quiescent' || failed) return;
    failed = true; state = 'uncertain';
    clearTimeout(startup);
    reject(new Error(message));
  };
  const server = createServer((client) => {
    if (connected) { client.destroy(); return; }
    connected = true; socket = client;
    server.close(); // The supervisor connects before the target is resumed; no second peer.
    let pending = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 16_384) { fail('Oversized Job supervisor receipt'); client.destroy(); return; }
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === 'ready' && !ready && !treeQuiet) {
            ready = true;
            clearTimeout(startup);
            client.write(requestedClose ? 'cancel\n' : 'resume\n');
          } else if (frame.type === 'done' && frame.quiescent === true && frame.childTreeZero === true && Number.isSafeInteger(frame.code) && !failed && !treeQuiet) {
            exitCode = frame.code as number;
            treeQuiet = true; clearTimeout(startup); settle(); client.end();
          } else if (frame.type === 'uncertain' && !treeQuiet) {
            // Kernel handles stay with the supervisor. A later empty-Job receipt may still arrive.
            requestedClose = true; state = 'uncertain';
            client.write('cancel\n');
          } else throw new Error('Invalid Job supervisor receipt');
        } catch (error) { fail(String(error)); client.destroy(); }
      }
    });
    client.on('error', (error) => fail(`Job supervisor connection failed: ${error.message}`));
    client.on('close', () => { if (!treeQuiet) fail('Job supervisor disconnected without confirming its process tree stopped'); });
    client.write(`${JSON.stringify({ executable: options.executable, commandLine: options.commandLine ?? windowsJobCommandLine(options.executable, options.args), cwd: options.cwd, inheritStdio: true, timeoutMs: 0, waitForResume: true })}\n`);
    if (requestedClose) client.write('cancel\n');
  });
  server.on('error', (error) => fail(`Job supervisor pipe failed: ${error.message}`));
  server.listen(`\\\\.\\pipe\\${pipeName}`);
  const startup = setTimeout(() => {
    requestedClose = true;
    if (socket) socket.write('cancel\n');
    fail('Job supervisor did not establish process ownership');
    socket?.destroy(); server.close();
  }, options.startupTimeoutMs ?? 30_000);
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  let root: T;
  try {
    root = options.launch(path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.helperPath, '-ControlPipe', pipeName,
        ...(options.ownershipIntent ? ['-OwnerIntent', options.ownershipIntent.path, '-OwnerHash', options.ownershipIntent.hash] : [])]);
  } catch (error) {
    clearTimeout(startup); server.close(); socket?.destroy();
    throw error;
  }
  try {
    options.observeExit(root, () => {
      rootExited = true;
      clearTimeout(startup);
      // Pipe delivery may trail the root's exit callback. EOF, not root exit, decides proof loss.
      if (!connected) { fail('Job supervisor exited before establishing process ownership'); server.close(); }
      settle();
    });
  } catch (error) {
    // Launch already returned a process: retain its handle even if observer setup fails.
    requestedClose = true;
    if (socket && !socket.destroyed) socket.write('cancel\n');
    fail(`Cannot observe Job supervisor exit: ${String(error)}`);
  }
  return {
    process: root, quiescent,
    get exitCode() { return exitCode; },
    get state() { return state; },
    cancel() {
      requestedClose = true;
      // Never kill the supervisor first: it retains/queries the Job until activeProcesses=0.
      if (failed) throw new Error('Process ownership is uncertain; the Job supervisor cannot confirm teardown');
      if (state === 'quiescent') return;
      if (state !== 'uncertain') state = 'closing';
      if (!treeQuiet && socket && !socket.destroyed) socket.write('cancel\n');
    }
  };
}
