/** PTY process ownership, separate from its visible tab. This is not a hostile-code sandbox. */
import path from 'node:path';
import type * as PtyModule from '@lydell/node-pty';
import { which } from './runtime';
import { launchOwnedWindowsJob } from './owned-windows-job';
import type { ProcessOwnershipIntent } from './mission/process-ownership';

export interface OwnedTerminalProcess {
  pty: PtyModule.IPty;
  /** Positive containment proof, not just the root's onExit. Never resolve on a timeout. */
  quiescent: Promise<void>;
  /** The target shell's status from the supervisor, which can differ from the wrapper's status. */
  readonly exitCode?: number;
  /** Resolves once the shell was assigned to the Job and resumed; rejects when it never ran, which
   * lets an ordinary tab fall back to a plain shell. Absent (test doubles) means established. */
  established?: Promise<void>;
  /** May be retried after a timeout/failure; ownership is not surrendered by cancellation. */
  close(): void;
}

export type OwnedTerminalSpawn = (file: string, args: string[], options: PtyModule.IPtyForkOptions | PtyModule.IWindowsPtyForkOptions, spawn: typeof PtyModule.spawn) => OwnedTerminalProcess;

/** A managed shell must be assigned before it can run; post-spawn PID inventory is not proof. */
export function spawnOwnedTerminal(file: string, args: string[], options: PtyModule.IPtyForkOptions | PtyModule.IWindowsPtyForkOptions, spawn: typeof PtyModule.spawn, windowsJobHelper?: string, ownershipIntent?: ProcessOwnershipIntent): OwnedTerminalProcess {
  // Interactive shells create additional job-control groups; kill(-rootPid) cannot prove their
  // descendants stopped. Until a session/cgroup supervisor is supplied, do not claim otherwise.
  if (process.platform !== 'win32') throw new Error('Managed terminal process-tree containment is unavailable on this platform');
  if (!windowsJobHelper) throw new Error('Managed terminals require the bundled Windows Job Object helper');
  const executable = path.isAbsolute(file) ? file : /[\\/]/.test(file) ? path.resolve(options.cwd ?? process.cwd(), file) : which(file);
  if (!executable) throw new Error(`Managed terminal executable was not found: ${file}`);
  const owner = launchOwnedWindowsJob({
    executable, args, cwd: options.cwd ?? process.cwd(), helperPath: windowsJobHelper, ownershipIntent,
    launch: (wrapper, argv) => spawn(wrapper, argv, options),
    observeExit: (pty, exited) => { pty.onExit(exited); }
  });
  return { pty: owner.process, quiescent: owner.quiescent, established: owner.established, get exitCode() { return owner.exitCode; }, close: () => owner.cancel() };
}
