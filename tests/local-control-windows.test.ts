import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { windowsLocalPipe } from '../src/main/control/windows-pipe';
import { LOCAL_CONTROL_REPLY_BYTES, LOCAL_CONTROL_REQUEST_BYTES, type LocalControlReply } from '../src/shared/local-control';
import { helper, pipeName, powershell, prepareWindowsLocalPipeOnCi } from './support/windows-local-pipe-fixture';

const probe = path.join(import.meta.dirname, 'support/windows-local-pipe-probe.ps1');
const payload = { fixture: 'snow \u96ea' };

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
  beforeAll(prepareWindowsLocalPipeOnCi, 95_000);

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
