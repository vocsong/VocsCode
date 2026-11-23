/** The Windows check supervisor's startup bound (src/main/mission/check-process.ts): a cold start
 *  can spend well over 30 s in PowerShell and its Add-Type compile — GitHub's Windows runners did,
 *  which reported the first Mission check of a run as "blocked" and failed its integration. A slow
 *  start must still run the check; only a start slower than the bound is treated as hung. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOwnedCheck } from '../src/main/mission/check-process';
import { isolatedCheckEnvironment } from '../src/main/mission/verification';
import { WINDOWS_SUPERVISOR_STARTUP_MS } from '../src/main/owned-windows-job';

const realHelper = path.resolve('resources/mission/windows-check-job.ps1');
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-check-startup-'));
});
afterEach(async () => {
  // A supervisor given up on as hung can still hold its working folder until it notices and exits.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
});

/** The bundled helper behind a deliberate startup delay, standing in for a cold Add-Type compile. */
async function slowHelper(delayMs: number): Promise<string> {
  const file = path.join(root, 'slow-helper.ps1');
  await fs.writeFile(file, `Start-Sleep -Milliseconds ${delayMs}\r\n& '${realHelper.replace(/'/g, "''")}'\r\nexit $LASTEXITCODE\r\n`, 'utf8');
  return file;
}

function check(helper: string, startupTimeoutMs?: number) {
  let quiet = false;
  const owned = startOwnedCheck({
    command: 'node -e "process.exit(0)"', cwd: root, env: isolatedCheckEnvironment(root), timeoutMs: 10_000,
    outputLimitBytes: 4096, windowsJobHelper: helper, ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
    quiescent: () => { quiet = true; }, uncertain: () => undefined,
  });
  return { owned, quiet: () => quiet };
}

describe.skipIf(process.platform !== 'win32')('Windows check supervisor startup bound', () => {
  it('waits minutes, not seconds, for a supervisor to start', () => {
    expect(WINDOWS_SUPERVISOR_STARTUP_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('runs the check when the supervisor takes longer than 30 s to start', async () => {
    const { owned, quiet } = check(await slowHelper(35_000));
    const outcome = await owned.result;
    expect(outcome.error).toBeUndefined();
    expect(outcome).toMatchObject({ code: 0, timedOut: false, canceled: false, lingering: false });
    expect(quiet()).toBe(true);
  }, 120_000);

  it('still treats a supervisor slower than its bound as hung', async () => {
    const { owned } = check(await slowHelper(6_000), 1_500);
    const outcome = await owned.result;
    expect(outcome.code).toBeNull();
    expect(outcome.error).toMatch(/did not confirm complete process-tree quiescence/);
  }, 60_000);
});
