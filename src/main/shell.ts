import { spawn, type ChildProcess } from 'node:child_process';
import { detectShell } from './harness/native/tools';
import { killTree } from './harness/spawn';
import { shortId } from './util/async';

export interface ShellRun {
  runId: string;
  sessionId: string;
  child: ChildProcess;
}

/** Runs user-typed commands from the Terminal panel with streaming output. */
export class ShellRunner {
  private runs = new Map<string, ShellRun>();

  run(sessionId: string, cwd: string, command: string, onOutput: (runId: string, chunk: string, done: boolean, exitCode: number | null) => void): string {
    const sh = detectShell();
    const runId = shortId('run_');
    const child = spawn(sh.file, sh.args(command), { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.runs.set(runId, { runId, sessionId, child });
    child.stdout.on('data', (d: Buffer) => onOutput(runId, d.toString(), false, null));
    child.stderr.on('data', (d: Buffer) => onOutput(runId, d.toString(), false, null));
    child.on('error', (e) => {
      onOutput(runId, `\n[failed to start: ${e.message}]\n`, true, null);
      this.runs.delete(runId);
    });
    child.on('close', (code) => {
      onOutput(runId, '', true, code);
      this.runs.delete(runId);
    });
    return runId;
  }

  kill(runId: string): void {
    const r = this.runs.get(runId);
    if (!r) return;
    try {
      killTree(r.child); // the shell's children (npm, node, …) must die with it
    } catch {
      /* ignore */
    }
  }

  killAll(): void {
    for (const id of [...this.runs.keys()]) this.kill(id);
  }
}
