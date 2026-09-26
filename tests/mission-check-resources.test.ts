import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { allocateCheckPort } from '../src/main/mission/check-resources';
import { startOwnedCheck } from '../src/main/mission/check-process';
import { isolatedCheckEnvironment } from '../src/main/mission/verification';

it('holds the actual port reservation until the safely owned check is resumed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-check-port-'));
  const port = await allocateCheckPort();
  let allow!: () => void, ready!: () => void;
  const gate = new Promise<void>((resolve) => { allow = resolve; });
  const ownedReady = new Promise<void>((resolve) => { ready = resolve; });
  let quiet = false;
  await fs.writeFile(path.join(root, 'listen.cjs'), "const net=require('node:net'),fs=require('node:fs');const server=net.createServer();server.listen(Number(process.env.PORT),'127.0.0.1',()=>{fs.writeFileSync('ran.txt',process.env.PORT);server.close();});");
  const check = startOwnedCheck({
    command: 'node listen.cjs', cwd: root, env: isolatedCheckEnvironment(root, {}, port.port), timeoutMs: 5000,
    outputLimitBytes: 1024, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'),
    beforeResume: async () => { ready(); await gate; await port.prepareForSpawn(); },
    quiescent: () => { quiet = true; }, uncertain: () => undefined,
  });
  try {
    await Promise.race([ownedReady, check.result.then((outcome) => { throw new Error(`Check stopped before resource handoff: ${outcome.error ?? outcome.code}`); })]);
    const attemptedBind = await new Promise<string>((resolve) => {
      const other = createServer();
      other.once('error', (error: NodeJS.ErrnoException) => { other.close(); resolve(error.code ?? 'unknown'); });
      other.listen({ port: port.port, host: '127.0.0.1', exclusive: true }, () => other.close(() => resolve('bound')));
    });
    expect(attemptedBind).toBe('EADDRINUSE');
    await expect(fs.stat(path.join(root, 'ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    allow();
    expect(await check.result).toMatchObject({ code: 0, canceled: false, timedOut: false, lingering: false });
    expect(quiet).toBe(true);
    expect(await fs.readFile(path.join(root, 'ran.txt'), 'utf8')).toBe(String(port.port));
  } finally {
    allow(); check.cancel(); await check.result; await port.release();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
