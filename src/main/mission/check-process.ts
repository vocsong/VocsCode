/** Check-process ownership, not a sandbox. Windows uses a trusted suspended-launch Job supervisor;
 * POSIX uses a dedicated process group. Root exit/stdio close alone never release a check lease. */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { recordUnlaunchedProcessIntent, type ProcessOwnershipIntent } from './process-ownership';
import { spawnIndependentWindowsSupervisor } from '../owned-windows-job';

export interface CheckOutcome {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  canceled: boolean;
  outputLimited: boolean;
  lingering: boolean;
  error?: string;
}

interface CheckProcessOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimitBytes: number;
  windowsJobHelper?: string;
  /** Fsynced host intent; the supervisor publishes proof even after the host's stdio disappears. */
  ownershipIntent?: ProcessOwnershipIntent;
  /** Release OS resource reservations only after the root is safely owned and not yet executing. */
  beforeResume?(): Promise<void>;
  quiescent(): void;
  uncertain(): void;
}

export interface OwnedCheckProcess {
  result: Promise<CheckOutcome>;
  /** Remains callable after an uncertain result; cancellation does not surrender ownership. */
  cancel(): void;
}

export function startOwnedCheck(options: CheckProcessOptions): OwnedCheckProcess {
  if (process.platform === 'win32') {
    if (!options.windowsJobHelper || !path.isAbsolute(options.windowsJobHelper) || !statSync(options.windowsJobHelper).isFile()) throw new Error('Windows verification requires the bundled Mission Job Object helper');
    return windowsCheck(options);
  }
  return posixCheck(options);
}

function capture(limit: number, overflow: () => void) {
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0, outputLimited = false;
  return {
    push(stream: 'stdout' | 'stderr', data: Buffer) {
      const room = Math.max(0, limit - size);
      if (room) (stream === 'stdout' ? stdout : stderr).push(data.subarray(0, room));
      size += data.length;
      if (size > limit && !outputLimited) { outputLimited = true; overflow(); }
    },
    value: () => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), outputLimited }),
  };
}

function windowsCheck(options: CheckProcessOptions): OwnedCheckProcess {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const child = spawnIndependentWindowsSupervisor(path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.windowsJobHelper!,
      ...(options.ownershipIntent ? ['-OwnerIntent', options.ownershipIntent.path, '-OwnerHash', options.ownershipIntent.hash] : [])],
    { cwd: options.env.TEMP, env: options.env });
  let finish!: (outcome: CheckOutcome) => void;
  const result = new Promise<CheckOutcome>((resolve) => { finish = resolve; });
  let settled = false, quiet = false, ready = false, canceled = false, timedOut = false;
  let protocolError: string | undefined, pending = '', helperError = '';
  let receipt: Partial<CheckOutcome> | undefined;
  const cancel = () => {
    canceled = true;
    if (!child.stdin.destroyed) child.stdin.write('cancel\n', () => undefined);
  };
  const logs = capture(options.outputLimitBytes, cancel);
  const settle = (patch: Partial<CheckOutcome>) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    finish({ code: null, ...logs.value(), timedOut, canceled, lingering: false, ...patch });
  };
  const uncertain = (message: string) => {
    if (!quiet) options.uncertain();
    settle({ error: message });
  };
  const expired = () => {
    cancel();
    uncertain('Check supervisor did not confirm complete process-tree quiescence');
  };
  // PowerShell/Add-Type startup is bounded separately from the actual command's timeout.
  let watchdog = setTimeout(expired, 30_000);
  child.stdin.on('error', () => { /* close/error below determines whether a receipt exists */ });
  child.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    if (pending.length > 256 * 1024) { protocolError = 'Oversized check supervisor frame'; pending = ''; cancel(); uncertain(protocolError); return; }
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === 'stdout' || frame.type === 'stderr') {
          if (typeof frame.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw new Error('Invalid output frame');
          logs.push(frame.type, Buffer.from(frame.data, 'base64'));
        } else if (frame.type === 'ready' && !ready && !quiet) {
          ready = true;
          clearTimeout(watchdog);
          watchdog = setTimeout(() => { timedOut = true; expired(); }, options.timeoutMs + 15_000);
          void (options.beforeResume?.() ?? Promise.resolve()).then(() => {
            if (!canceled && !child.stdin.destroyed) child.stdin.write('resume\n', () => undefined);
          }).catch((error) => { protocolError = `Check resource preparation failed: ${String(error)}`; cancel(); });
        } else if (frame.type === 'uncertain' && typeof frame.error64 === 'string') {
          uncertain(Buffer.from(frame.error64, 'base64').toString('utf8'));
        } else if (frame.type === 'done' && !quiet && frame.quiescent === true && frame.childTreeZero === true && Number.isSafeInteger(frame.code)
          && typeof frame.timedOut === 'boolean' && typeof frame.canceled === 'boolean' && typeof frame.lingering === 'boolean' && typeof frame.error64 === 'string') {
          quiet = true;
          const error = protocolError || Buffer.from(frame.error64, 'base64').toString('utf8') || (!ready ? 'The check never started' : undefined);
          receipt = { code: frame.code as number, timedOut: timedOut || frame.timedOut, canceled: canceled || frame.canceled, lingering: frame.lingering, error };
          child.stdin.end();
        } else throw new Error('Invalid check supervisor receipt');
      } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        cancel(); uncertain(protocolError);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { if (helperError.length < 16_384) helperError += chunk.toString('utf8').slice(0, 16_384 - helperError.length); });
  child.once('error', (error) => {
    // A failed OS spawn has no root or descendants. A launched supervisor without a receipt is
    // different: its death triggers KILL_ON_JOB_CLOSE but is not proof the kernel finished it.
    if (!child.pid) {
      try {
        if (options.ownershipIntent) recordUnlaunchedProcessIntent(options.ownershipIntent);
        quiet = true; options.quiescent();
      } catch { options.uncertain(); }
    } else options.uncertain();
    settle({ error: `Check supervisor failed: ${error.message}` });
  });
  child.once('close', () => {
    clearTimeout(watchdog);
    if (!quiet) uncertain(`Check supervisor exited without a quiescence receipt${helperError ? `: ${helperError.trim()}` : ''}`);
    else { options.quiescent(); settle(receipt ?? {}); }
  });
  child.stdin.write(`${JSON.stringify({ shell: path.join(system, 'cmd.exe'), command: options.command, cwd: options.cwd, timeoutMs: options.timeoutMs, waitForResume: true })}\n`, () => undefined);
  return { result, cancel };
}

function posixCheck(options: CheckProcessOptions): OwnedCheckProcess {
  // The trusted group leader waits on our pipe before executing the approved command. Unlike
  // SIGSTOP/SIGCONT there is no lost-wakeup race when resource preparation finishes very quickly.
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r start && exec /bin/sh -c "$1"', 'mission-check', options.command],
    { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let finish!: (outcome: CheckOutcome) => void;
  const result = new Promise<CheckOutcome>((resolve) => { finish = resolve; });
  let settled = false, quiet = false, closed = false, exited = false, canceled = false, timedOut = false, lingering = false;
  let code: number | null = null, failure: string | undefined, monitor: ReturnType<typeof setInterval> | undefined;
  let stopping = false, groupGone = false, deadline = 0;
  const groupExists = () => {
    if (!child.pid || groupGone) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { groupGone = true; return false; } throw error; }
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    finish({ code, ...logs.value(), timedOut, canceled, lingering, error: failure });
  };
  const poll = () => {
    try {
      if (!groupExists() && closed) {
        quiet = true; clearInterval(monitor); monitor = undefined; options.quiescent(); settle();
      } else if (Date.now() >= deadline) {
        clearInterval(monitor); monitor = undefined;
        failure ??= 'Owned process group did not confirm complete quiescence';
        options.uncertain(); settle();
      }
    } catch (error) {
      failure = String(error); clearInterval(monitor); monitor = undefined; options.uncertain(); settle();
    }
  };
  const stop = () => {
    if (quiet) return;
    stopping = true;
    // Once the original group is observed absent, never signal that reusable numeric ID again.
    try { if (child.pid && !groupGone) process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupGone = true; else failure = String(error); }
    if (!monitor) { deadline = Date.now() + 10_000; monitor = setInterval(poll, 20); }
  };
  const cancel = () => { canceled = true; stop(); };
  const logs = capture(options.outputLimitBytes, stop);
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  child.stdin.on('error', () => { /* exit/error observes whether the owned group is gone */ });
  child.once('spawn', () => {
    void (options.beforeResume?.() ?? Promise.resolve()).then(() => {
      if (!stopping && !child.stdin.destroyed) child.stdin.end('start\n');
    }).catch((error) => { failure = `Check resource preparation failed: ${String(error)}`; stop(); });
  });
  child.stdout.on('data', (data: Buffer) => logs.push('stdout', data));
  child.stderr.on('data', (data: Buffer) => logs.push('stderr', data));
  child.once('error', (error) => {
    failure = error.message;
    if (!child.pid) { closed = true; quiet = true; options.quiescent(); settle(); } else stop();
  });
  child.once('exit', (exitCode) => {
    code = exitCode; exited = true;
    try { if (!stopping && groupExists()) lingering = true; } catch (error) { failure = String(error); }
    stop();
  });
  child.once('close', () => { closed = true; if (exited) poll(); });
  return { result, cancel };
}
