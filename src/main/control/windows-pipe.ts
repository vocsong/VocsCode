import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { ControlError } from '../../shared/control';
import { LOCAL_CONTROL_REQUEST_BYTES, LOCAL_CONTROL_REPLY_BYTES, type LocalControlReply } from '../../shared/local-control';
import { withProcessOwner } from '../process-context';
import type { OpenLocalPipe, LocalPipe } from './local';

const START_TIMEOUT_MS = 30_000;
const REPLY_TIMEOUT_MS = 8_000;
const LINE_LIMIT = Math.ceil(LOCAL_CONTROL_REQUEST_BYTES / 3) * 4 + 16;
const invalid = { ok: false, error: 'invalid_request' } as const;
const unavailable = { ok: false, error: 'unavailable' } as const;

/** The helper owns the Windows handle/DACL; only this parent owns dispatch and its grant. */
export function windowsLocalPipe(helperPath: string): OpenLocalPipe {
  return ({ name, signal, dispatch, closed }) => new Promise<LocalPipe>((resolve, reject) => {
    if (process.platform !== 'win32' || !path.isAbsolute(helperPath) || !/^vocs-code-local-[a-f0-9]{32}$/.test(name) || signal.aborted) {
      reject(new ControlError('unavailable'));
      return;
    }
    let root: string;
    try { root = realpathSync.native(String.raw`\\?\GLOBALROOT\SystemRoot`); }
    catch { reject(new ControlError('unavailable')); return; }
    const child = withProcessOwner({ label: 'Local CLI and MCP' }, () => spawn(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath, '-Mode', 'Serve', '-PipeName', name, '-ParentPid', String(process.pid)], {
        cwd: path.dirname(helperPath), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP },
      },
    ));
    let stopped = false, ready = false, pending = false, line = '';
    let deadline = setTimeout(stop, START_TIMEOUT_MS);

    function stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      child.stdin.destroy();
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      closed();
      if (!ready) reject(new ControlError('unavailable'));
    }
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', stop);
    child.on('exit', stop);
    child.stdin.on('error', stop);
    child.stdout.on('error', stop);
    child.stdout.on('end', stop);

    async function reply(encoded: string): Promise<void> {
      let response: LocalControlReply;
      try {
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > LOCAL_CONTROL_REQUEST_BYTES || bytes.toString('base64') !== encoded) throw new Error('Invalid request');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        response = await dispatch(JSON.parse(text));
      } catch { response = invalid; }
      if (stopped) return;
      let body = Buffer.from(JSON.stringify(response), 'utf8');
      if (body.length > LOCAL_CONTROL_REPLY_BYTES) body = Buffer.from(JSON.stringify(unavailable));
      // The OS helper reads exactly one reply before accepting another request.
      clearTimeout(deadline);
      pending = false;
      child.stdin.write(`reply ${body.toString('base64')}\n`);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      line += chunk;
      if (line.length > LINE_LIMIT) { stop(); return; }
      let end: number;
      while (!stopped && (end = line.indexOf('\n')) >= 0) {
        const frame = line.slice(0, end).replace(/\r$/, '');
        line = line.slice(end + 1);
        if (!ready) {
          const info = /^ready ([1-9]\d{0,9}) ([1-9]\d{0,18})$/.exec(frame);
          if (!info || Number(info[1]) !== child.pid) { stop(); return; }
          clearTimeout(deadline);
          ready = true;
          resolve({ pid: Number(info[1]), started: info[2]!, close: stop });
        } else {
          const request = /^request ([A-Za-z0-9+/]+={0,2})$/.exec(frame);
          if (pending || !request) { stop(); return; }
          pending = true;
          deadline = setTimeout(stop, REPLY_TIMEOUT_MS);
          void reply(request[1]!).catch(stop);
        }
      }
    });
  });
}
