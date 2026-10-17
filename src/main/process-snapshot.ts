/**
 * Reads the OS process table for the process tracker. Windows has no cheap built-in for parent
 * PIDs (a WMI query costs about 350 ms), so a long-lived PowerShell host
 * (resources/processes/windows-process-snapshot.ps1) answers each request with one Toolhelp
 * snapshot in a few tens of milliseconds. POSIX runs `ps`. Neither reader ever signals a process.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

export interface RawProcess {
  pid: number;
  ppid: number;
  /** Creation time (epoch ms); 0 when the OS would not say (another user's or a protected process). */
  startedAt: number;
  /** Total CPU time consumed so far (ms). */
  cpuMs: number;
  /** Working set / resident size in bytes. */
  memory: number;
  name: string;
  /** Present when the reader gets it for free (POSIX); Windows reads it on request. */
  command?: string;
}

export interface ProcessSource {
  /** A helper process the reader keeps running, which the tracker must not list as the app's work. */
  readonly helperPid?: number;
  snapshot(): Promise<RawProcess[]>;
  /** Command lines for PIDs the snapshot left without one; missing entries could not be read. */
  commandLines(pids: number[]): Promise<Map<number, string>>;
  /**
   * Windows only: puts each process into its owner's Job Object, so whatever it starts later stays
   * attributable after its parent exits. Answers per PID: true, or why it was not adopted.
   */
  adopt?(owner: string, targets: { pid: number; startedAt: number }[]): Promise<Map<number, true | string>>;
  /** Windows only: the live members of each owner's Job. */
  jobs?(): Promise<Map<string, number[]>>;
  close(): void;
}

/** Owner keys travel as one protocol token. */
export const JOB_OWNER = /^[A-Za-z0-9_.-]{1,80}$/;

function int(text: string): number {
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

/** Parses the host's `snap` reply: pid, ppid, created ms, cpu ms, working set, exe name per line. */
export function parseWindowsSnapshot(lines: string[]): RawProcess[] {
  const out: RawProcess[] = [];
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const pid = int(cols[0]);
    if (!pid) continue;
    out.push({ pid, ppid: int(cols[1]), startedAt: int(cols[2]), cpuMs: int(cols[3]), memory: int(cols[4]), name: cols.slice(5).join('\t') });
  }
  return out;
}

/** Parses the host's `cmd` reply: pid TAB command line per line. */
/** Parses the host's `adopt` reply: pid TAB ok, or pid TAB !reason. */
export function parseAdoptReply(lines: string[]): Map<number, true | string> {
  const out = new Map<number, true | string>();
  for (const line of lines) {
    const [pid, result = ''] = line.split('\t');
    const n = int(pid);
    if (n) out.set(n, result === 'ok' ? true : result.replace(/^!/, '') || 'unknown');
  }
  return out;
}

/** Parses the host's `jobs` reply: owner TAB space-separated member PIDs. */
export function parseJobMembers(lines: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    out.set(line.slice(0, tab), line.slice(tab + 1).split(' ').map(int).filter((pid) => pid > 0));
  }
  return out;
}

export function parseCommandLines(lines: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const pid = int(line.slice(0, tab));
    if (pid) out.set(pid, line.slice(tab + 1));
  }
  return out;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** `ps` cumulative CPU time: `[[dd-]hh:]mm:ss[.cc]` on both procps and BSD ps. */
export function parsePsTime(text: string): number {
  const match = /^(?:(\d+)-)?([\d:.]+)$/.exec(text.trim());
  if (!match) return 0;
  const parts = match[2].split(':').map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (Number.isFinite(part) ? part : 0);
  return Math.round((int(match[1] ?? '0') * 86_400 + seconds) * 1000);
}

/** Parses `ps -A -o pid=,ppid=,rss=,time=,lstart=,args=` run under LC_ALL=C. */
export function parsePsOutput(text: string): RawProcess[] {
  const out: RawProcess[] = [];
  const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s?(.*)$/;
  for (const line of text.split('\n')) {
    const m = row.exec(line);
    if (!m) continue;
    const month = MONTHS[m[5]];
    const startedAt = month === undefined ? 0 : new Date(int(m[10]), month, int(m[6]), int(m[7]), int(m[8]), int(m[9])).getTime();
    const command = m[11].trim();
    const exe = command.split(' ')[0] ?? '';
    out.push({
      pid: int(m[1]),
      ppid: int(m[2]),
      memory: int(m[3]) * 1024,
      cpuMs: parsePsTime(m[4]),
      startedAt,
      name: exe.split('/').pop() || exe,
      command
    });
  }
  return out;
}

/** How long the PowerShell host may take to compile its helper; a cold machine has needed over 30 s. */
const HOST_STARTUP_MS = 120_000;
const HOST_REQUEST_MS = 20_000;
/** A host that failed to start is not retried more often than this. */
const HOST_RETRY_MS = 60_000;

/** One long-lived PowerShell host; requests are serialized and each reply ends with a `.` line. */
export class WindowsProcessSource implements ProcessSource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { lines: string[]; resolve: (lines: string[]) => void; reject: (e: Error) => void } | null = null;
  private partial = '';
  private failedAt = 0;
  private lastError = '';
  private closed = false;

  constructor(private readonly helperPath: string) {}

  get helperPid(): number | undefined {
    return this.child?.pid;
  }

  snapshot(): Promise<RawProcess[]> {
    return this.request('snap').then(parseWindowsSnapshot);
  }

  async adopt(owner: string, targets: { pid: number; startedAt: number }[]): Promise<Map<number, true | string>> {
    if (!JOB_OWNER.test(owner)) throw new Error(`Not a job owner key: ${owner}`);
    const out = new Map<number, true | string>();
    for (let i = 0; i < targets.length; i += 64) {
      const items = targets.slice(i, i + 64).map((t) => `${t.pid}:${Math.max(0, Math.round(t.startedAt))}`);
      for (const [pid, result] of parseAdoptReply(await this.request(`adopt ${owner} ${items.join(' ')}`))) out.set(pid, result);
    }
    return out;
  }

  async jobs(): Promise<Map<string, number[]>> {
    return parseJobMembers(await this.request('jobs'));
  }

  async commandLines(pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    // Keep each request line short; a few dozen PIDs per round trip is plenty.
    for (let i = 0; i < pids.length; i += 64) {
      for (const [pid, line] of parseCommandLines(await this.request(`cmd ${pids.slice(i, i + 64).join(' ')}`))) out.set(pid, line);
    }
    return out;
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (!child) return;
    try {
      child.stdin.end('exit\n');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 2_000).unref();
  }

  private request(line: string): Promise<string[]> {
    const run = this.queue.then(async () => {
      await this.start();
      return this.exchange(line, HOST_REQUEST_MS);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The process reader is closed.'));
    if (this.ready) return this.ready;
    if (this.failedAt && Date.now() - this.failedAt < HOST_RETRY_MS) return Promise.reject(new Error(this.lastError));
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const child = spawn(path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    const lost = (reason: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.failedAt = Date.now();
      this.lastError = `The Windows process reader stopped: ${reason}${stderr.trim() ? ` (${stderr.trim().split(/\r?\n/)[0]})` : ''}`;
      this.partial = '';
      this.pending?.reject(new Error(this.lastError));
      this.pending = null;
    };
    child.on('error', (e) => lost(e.message));
    child.on('exit', (code) => lost(`exit code ${code}`));
    this.ready = this.exchange(null, HOST_STARTUP_MS).then((lines) => {
      if (lines[0] !== 'ready') throw new Error('The Windows process reader did not start.');
      this.failedAt = 0;
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private exchange(line: string | null, timeoutMs: number): Promise<string[]> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(this.lastError || 'The Windows process reader is not running.'));
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.lastError = 'The Windows process reader stopped answering.';
        child.kill();
        reject(new Error(this.lastError));
      }, timeoutMs);
      this.pending = {
        lines: [],
        resolve: (lines) => {
          clearTimeout(timer);
          resolve(lines);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      };
      if (line !== null) child.stdin.write(`${line}\n`);
    });
  }

  private read(chunk: string): void {
    const text = this.partial + chunk;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      const pending = this.pending;
      if (!pending) continue;
      if (line === '.') {
        this.pending = null;
        const error = pending.lines.find((l) => l.startsWith('!'));
        if (error) pending.reject(new Error(error.slice(1)));
        else pending.resolve(pending.lines);
      } else pending.lines.push(line);
    }
  }
}

export class PosixProcessSource implements ProcessSource {
  snapshot(): Promise<RawProcess[]> {
    return new Promise((resolve, reject) => {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,lstart=,args='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: HOST_REQUEST_MS },
        (error, stdout) => (error ? reject(error) : resolve(parsePsOutput(stdout))));
    });
  }

  async commandLines(): Promise<Map<number, string>> {
    return new Map();
  }

  close(): void {}
}

export function createProcessSource(windowsHelperPath: string, platform: NodeJS.Platform = process.platform): ProcessSource {
  return platform === 'win32' ? new WindowsProcessSource(windowsHelperPath) : new PosixProcessSource();
}
