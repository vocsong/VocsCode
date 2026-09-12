import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

const isWin = process.platform === 'win32';

/** Quote one argument for cmd.exe the way cross-spawn does. */
export function quoteWin(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  // Escape backslashes that precede a quote, then the quote itself; trailing backslashes double up.
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}

/**
 * Spawns a CLI tool with stdio pipes. On Windows, .cmd/.bat shims (npm global installs)
 * must run through cmd.exe; arguments are quoted so paths with spaces survive.
 */
export function spawnTool(file: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const base: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...opts };
  if (isWin && /\.(cmd|bat)$/i.test(file)) {
    const command = [quoteWin(file), ...args.map(quoteWin)].join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      ...base,
      windowsVerbatimArguments: true
    });
  }
  return spawn(file, args, base);
}

/**
 * Resolves once the force-kill has been issued. On Windows the `taskkill /T /F` run is
 * awaited, because that is what actually reaches the cmd.exe-wrapped grandchild; quitting
 * before it exits can destroy the pending kill with the app process.
 */
export async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (isWin) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      // Never hang teardown on a wedged taskkill; the timer must not keep the loop alive either.
      const backstop = setTimeout(finish, 5000);
      backstop.unref();
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('close', finish);
        killer.on('error', finish);
      } catch {
        finish();
      }
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/**
 * Shutdown for a spawned harness: close stdin, give the child a bounded grace period to exit
 * on its own, then force-kill its tree. Awaiting this guarantees the whole tree is gone before
 * the caller continues, so quit-time teardown cannot race a detached kill timer.
 */
export async function shutdownChild(child: ChildProcess, graceMs = 1500): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref())
    ]);
  }
  await killTree(child);
}
