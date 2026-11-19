import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowsLocalPipe } from '../src/main/control/windows-pipe';
import { LOCAL_CONTROL_REPLY_BYTES, LOCAL_CONTROL_REQUEST_BYTES, type LocalControlReply } from '../src/shared/local-control';

const helper = path.resolve(import.meta.dirname, '../resources/control/windows-pipe.ps1');
const probe = path.join(import.meta.dirname, 'support/windows-local-pipe-probe.ps1');
const pipeName = () => `vocs-code-local-${randomBytes(16).toString('hex')}`;
const payload = { fixture: 'snow \u96ea' };
type Outcome = { code: number; stdout: string; stderr: string };

function powershell(script: string, args: string[], timeout = 30_000) {
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
    // An early helper exit can close the input pipe before the request is written. Its outcome
    // still has to match exactly; an EPIPE is never itself an expected refusal.
    child.stdin!.on('error', () => undefined);
  });
  return { child, result };
}

type Peer = { name: string; pid: number; started: string };

function call(peer: Peer, request: object = payload) {
  const { child, result } = powershell(helper, ['-Mode', 'Call', '-PipeName', peer.name,
    '-ExpectedPid', String(peer.pid), '-ExpectedStarted', peer.started]);
  child.stdin!.end(`request ${Buffer.from(JSON.stringify(request)).toString('base64')}\n`);
  return result;
}

function replyLine(reply: LocalControlReply) {
  return `reply ${Buffer.from(JSON.stringify(reply)).toString('base64')}\n`;
}

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
});

async function fixture(reply: LocalControlReply) {
  const name = pipeName();
  const owner = new AbortController();
  controllers.push(owner);
  const dispatch = vi.fn(async (_request: unknown) => reply);
  const pipe = await windowsLocalPipe(helper)({ name, signal: owner.signal, dispatch, closed: () => undefined });
  return { peer: { name, pid: pipe.pid, started: pipe.started }, dispatch };
}

describe.runIf(process.platform === 'win32')('native Windows local control pipe', () => {
  it('denies a restricted token at open, allows the owner, and has an explicit one-user ACL', async () => {
    const reply = { ok: true, result: { fixture: 'owner' } } as const;
    const { peer, dispatch } = await fixture(reply);
    expect(await powershell(probe, ['-PipeName', peer.name, '-ExpectedPid', String(peer.pid)]).result).toEqual({
      code: 0, stdout: 'restricted denied; owner allowed; protected one-user DACL\n', stderr: '',
    });
    expect(dispatch).not.toHaveBeenCalled(); // Neither open forwarded application bytes.
    expect(await call(peer)).toEqual({ code: 0, stdout: replyLine(reply), stderr: '' });
    expect(dispatch.mock.calls).toEqual([[payload]]);
  });

  it('refuses the wrong server PID or birth time before forwarding, then exchanges exact-limit frames', async () => {
    const request = { fixture: 'x'.repeat(LOCAL_CONTROL_REQUEST_BYTES - Buffer.byteLength(JSON.stringify({ fixture: '' }))) };
    const reply = { ok: true, result: { fixture: '' } } as const;
    const largeReply = { ...reply, result: { fixture: 'x'.repeat(LOCAL_CONTROL_REPLY_BYTES - Buffer.byteLength(JSON.stringify(reply))) } };
    const { peer, dispatch } = await fixture(largeReply);
    const refused = { code: 3, stdout: '', stderr: '' };
    expect(await call({ ...peer, pid: process.pid })).toEqual(refused);
    expect(await call({ ...peer, started: String(BigInt(peer.started) + 1n) })).toEqual(refused);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await call(peer, request)).toEqual({ code: 0, stdout: replyLine(largeReply), stderr: '' });
    expect(dispatch.mock.calls).toEqual([[request]]);
  });

  it('closes the endpoint when the watched owner process dies, even with its input held open', async () => {
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 45000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => { owner.once('spawn', resolve); owner.once('error', reject); });
      const name = pipeName();
      const serve = powershell(helper, ['-Mode', 'Serve', '-PipeName', name, '-ParentPid', String(owner.pid)], 40_000);
      const lifetime = serve.result;
      let banner = '';
      serve.child.stdout!.on('data', (chunk: Buffer) => { banner += chunk.toString('utf8'); });
      try {
        await Promise.race([
          expect.poll(() => banner, { timeout: 30_000 }).toMatch(/^ready \d+ \d+\r?\n$/),
          lifetime.then((exit) => { throw new Error(`Pipe helper exited before owner: ${exit.code} ${exit.stderr}`); }),
        ]);
        const ready = /^ready (\d+) (\d+)\r?\n$/.exec(banner)!;
        expect(Number(ready[1])).toBe(serve.child.pid);
        expect(owner.kill()).toBe(true); // Only the fixture child; leave Serve's stdin open.
        expect(await lifetime).toEqual({ code: 0, stdout: `ready ${ready[1]} ${ready[2]}\n`, stderr: '' });
        expect(await call({ name, pid: Number(ready[1]), started: ready[2]! })).toEqual({ code: 4, stdout: '', stderr: '' });
      } finally {
        serve.child.stdin!.destroy();
        serve.child.kill();
        await lifetime.catch(() => undefined);
      }
    } finally { owner.kill(); }
  });
});
