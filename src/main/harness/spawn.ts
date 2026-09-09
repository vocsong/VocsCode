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

/** Best-effort process tree kill (Windows needs taskkill for cmd.exe-wrapped children). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWin) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}
