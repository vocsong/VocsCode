import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { LOCAL_CONTROL_REPLY_BYTES } from '../../src/shared/local-control';

export const helper = path.resolve(import.meta.dirname, '../../resources/control/windows-pipe.ps1');
export const pipeName = () => `vocs-code-local-${randomBytes(16).toString('hex')}`;
type Outcome = { code: number; stdout: string; stderr: string };

export function powershell(script: string, args: string[], timeout = 30_000) {
  const root = realpathSync.native(String.raw`\\?\GLOBALROOT\SystemRoot`);
  let child!: ReturnType<typeof execFile>;
  const result = new Promise<Outcome>((resolve, reject) => {
    child = execFile(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
        cwd: path.dirname(script), windowsHide: true, encoding: 'utf8', timeout,
        maxBuffer: Math.ceil(LOCAL_CONTROL_REPLY_BYTES / 3) * 4 + 1024,
        env: { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP },
      }, (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== 'number' || error?.killed) reject(error);
        else resolve({ code, stdout: stdout.replaceAll('\r\n', '\n'), stderr });
      });
    // An early exit may close the input pipe before a write. Tests still check the actual outcome.
    child.stdin!.on('error', () => undefined);
  });
  return { child, result };
}

/** Measure the hosted runner's cold PowerShell/Add-Type launch on a disposable endpoint. Only
 * this preflight has a longer budget; each tested grant starts a fresh helper under the app's
 * unchanged deadline. No application dispatch or grant is attached to the preflight pipe. */
export async function prepareWindowsLocalPipeOnCi(): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const { child, result } = powershell(helper, ['-Mode', 'Serve', '-PipeName', pipeName(), '-ParentPid', String(process.pid)], 90_000);
  const ready = /^ready ([1-9]\d{0,9}) [1-9]\d{0,18}\r?\n$/;
  let banner = '';
  let readyMs: number | undefined;
  child.stdout!.on('data', (chunk: Buffer) => {
    banner += chunk.toString('utf8');
    if (readyMs === undefined && banner.includes('\n')) {
      if (Number(ready.exec(banner)?.[1]) === child.pid) readyMs = elapsed();
      child.stdin!.end();
    }
  });
  const exit = await result.catch(() => {
    throw new Error(`Windows pipe preflight did not start and exit cleanly (${elapsed()}ms)`);
  });
  if (readyMs === undefined || exit.code !== 0 || !ready.test(exit.stdout) || exit.stderr) {
    throw new Error(`Windows pipe preflight returned an invalid result (${elapsed()}ms, exit ${exit.code})`);
  }
  console.info(`Windows pipe preflight ready in ${readyMs}ms, stopped cleanly`);
}
