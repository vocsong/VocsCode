/**
 * Terminal backend: shell resolution, the OSC cwd parser, and the TerminalManager's attach /
 * flow-control / persistence contract (with a fake PTY), plus one round trip through a real PTY.
 * Everything here runs offline.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IPty } from '@lydell/node-pty';
import { DEFAULT_TERMINAL_SETTINGS, FLOW_HIGH_WATER, baseName, cleanTitle, parseOscCwd, type TerminalSettings } from '../src/shared/terminal';
import { TerminalManager, detectShells, interactiveArgs, resolveShell, terminalEnv } from '../src/main/terminal';
import { normalizeSettings } from '../src/main/settings';

describe('parseOscCwd', () => {
  it('reads OSC 7 file URLs on both platforms', () => {
    expect(parseOscCwd(7, 'file://host/C:/Users/me/proj', 'win32')).toBe('C:\\Users\\me\\proj');
    expect(parseOscCwd(7, 'file:///home/me/my%20proj', 'linux')).toBe('/home/me/my proj');
    expect(parseOscCwd(7, 'not-a-url', 'linux')).toBeUndefined();
  });
  it('reads OSC 9;9 and ignores other OSC 9 payloads', () => {
    expect(parseOscCwd(9, '9;C:\\dev\\repo', 'win32')).toBe('C:\\dev\\repo');
    expect(parseOscCwd(9, '4;3;50', 'win32')).toBeUndefined();
    expect(parseOscCwd(0, 'title', 'win32')).toBeUndefined();
  });
  it('labels paths by their last segment', () => {
    expect(baseName('C:\\dev\\repo\\')).toBe('repo');
    expect(baseName('/home/me/proj')).toBe('proj');
  });
  it('turns shell-announced titles into tab labels', () => {
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(cleanTitle('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ps, 'Windows PowerShell')).toBe('Windows PowerShell');
    expect(cleanTitle('C:\\Windows\\system32\\cmd.exe - ping  localhost', 'C:\\Windows\\System32\\cmd.exe', 'Command Prompt')).toBe('ping localhost');
    expect(cleanTitle('cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'Command Prompt')).toBe('Command Prompt');
    expect(cleanTitle('npm run dev', ps, 'x')).toBe('npm run dev');
    expect(cleanTitle('me@box: ~/proj - vim', '/bin/bash', 'bash')).toBe('me@box: ~/proj - vim');
    expect(cleanTitle('   ', ps, 'fallback')).toBe('fallback');
  });
});

describe('shell resolution', () => {
  it('detects at least one shell and resolves auto to an existing executable', () => {
    expect(detectShells().length).toBeGreaterThan(0);
    const r = resolveShell(DEFAULT_TERMINAL_SETTINGS);
    expect(existsSync(r.file)).toBe(true);
    expect(r.name.length).toBeGreaterThan(0);
  });
  it('honours a custom shell and falls back when the requested kind is missing', () => {
    const custom = resolveShell({ ...DEFAULT_TERMINAL_SETTINGS, shell: 'custom', customShellPath: '/opt/nu', customShellArgs: ['-l'] });
    expect(custom).toMatchObject({ kind: 'custom', file: '/opt/nu', args: ['-l'], name: 'nu' });
    const missing = resolveShell({ ...DEFAULT_TERMINAL_SETTINGS, shell: 'fish' }, undefined, [{ kind: 'cmd', name: 'Command Prompt', path: 'C:\\W\\cmd.exe' }]);
    expect(missing).toMatchObject({ kind: 'cmd', file: 'C:\\W\\cmd.exe' });
  });
  it('passes the flags that make a shell interactive with its profile', () => {
    expect(interactiveArgs('pwsh')).toEqual(['-NoLogo']);
    expect(interactiveArgs('gitbash')).toEqual(['--login', '-i']);
    expect(interactiveArgs('zsh', 'darwin')).toEqual(['-l']);
    expect(interactiveArgs('zsh', 'linux')).toEqual([]);
    expect(interactiveArgs('cmd')).toEqual([]);
  });
  it('builds a terminal environment', () => {
    const env = terminalEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }, '0.1.0');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.TERM_PROGRAM).toBe('vocs-code');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });
  it('normalizes stored terminal settings over the defaults', () => {
    const s = normalizeSettings({ terminal: { fontSize: 15, customShellArgs: ['-l', 3 as unknown as string] } as Partial<TerminalSettings> as TerminalSettings });
    expect(s.terminal.fontSize).toBe(15);
    expect(s.terminal.scrollback).toBe(DEFAULT_TERMINAL_SETTINGS.scrollback);
    expect(s.terminal.customShellArgs).toEqual(['-l']);
    expect(normalizeSettings({}).terminal).toEqual(DEFAULT_TERMINAL_SETTINGS);
  });
});

/** An IPty stand-in that records calls and lets the test emit output and exits. */
function fakePty() {
  const dataListeners: ((d: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  const calls: string[] = [];
  const p = {
    pid: 4242,
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    onData: (l: (d: string) => void) => {
      dataListeners.push(l);
      return { dispose: () => void dataListeners.splice(dataListeners.indexOf(l), 1) };
    },
    onExit: (l: (e: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(l);
      return { dispose: () => void exitListeners.splice(exitListeners.indexOf(l), 1) };
    },
    write: (d: string) => void calls.push(`write:${d}`),
    resize: (c: number, r: number) => void calls.push(`resize:${c}x${r}`),
    kill: () => {
      calls.push('kill');
      setTimeout(() => [...exitListeners].forEach((l) => l({ exitCode: -1, signal: 9 })), 0); // like a real process
    },
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    clear: () => undefined,
    emit: (d: string) => [...dataListeners].forEach((l) => l(d)),
    exit: (code: number) => [...exitListeners].forEach((l) => l({ exitCode: code })),
    calls
  };
  return p;
}
type Fake = ReturnType<typeof fakePty>;

const managers: TerminalManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll()));
});

function manager(fakes: Fake[] | null, dir: string, settings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS) {
  const pushes: { ch: string; payload: unknown }[] = [];
  const m = new TerminalManager({
    dir,
    settings: () => settings,
    version: 'test',
    cwdOf: (id) => (id === 's1' ? os.tmpdir() : undefined),
    push: (ch, payload) => void pushes.push({ ch, payload }),
    log: () => undefined,
    spawn: fakes ? (() => (fakes.shift() ?? fakePty()) as unknown as IPty) : undefined
  });
  managers.push(m);
  const data = () => pushes.filter((p) => p.ch === 'push:terminalData').map((p) => p.payload as { terminalId: string; seq: number; data: string });
  return { m, pushes, data };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vocs-terminals-'));
}

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('TerminalManager (fake pty)', () => {
  it('snapshots the screen on attach and streams only what came after', async () => {
    const fake = fakePty();
    const { m, data } = manager([fake], await tmpDir());
    expect(() => m.create('nope')).toThrow(/Session not found/);
    const info = m.create('s1', { cols: 40, rows: 5 });
    expect(info.sessionId).toBe('s1');
    expect(info.pid).toBe(4242);
    fake.emit('before-attach\r\n');
    expect(data()).toHaveLength(0); // nobody is watching yet
    const a = await m.attach(info.id, 60, 10);
    expect(a.snapshot).toContain('before-attach');
    expect(fake.calls).toContain('resize:60x10');
    fake.emit('after-attach');
    expect(data()).toHaveLength(1);
    expect(data()[0].data).toBe('after-attach');
    expect(data()[0].seq).toBeGreaterThan(a.seq);
    m.input(info.id, 'ls\r');
    expect(fake.calls).toContain('write:ls\r');
    // A second attach (renderer reload) sees everything so far and keeps the seq contract.
    const b = await m.attach(info.id, 60, 10);
    expect(b.snapshot).toContain('after-attach');
    expect(b.seq).toBe(data()[0].seq);
  });

  it('pauses a flooding pty until the renderer acknowledges, and lets it run on detach', async () => {
    const fake = fakePty();
    const { m, data } = manager([fake], await tmpDir());
    const info = m.create('s1');
    await m.attach(info.id, 80, 24);
    const before = fake.calls.length;
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 5; i++) fake.emit(chunk); // 320 KiB > FLOW_HIGH_WATER
    expect(fake.calls.slice(before).filter((c) => c === 'pause')).toHaveLength(1);
    expect(data().reduce((n, d) => n + d.data.length, 0)).toBe(5 * 64 * 1024);
    m.ack(info.id, 100 * 1024);
    expect(fake.calls[fake.calls.length - 1]).toBe('pause'); // still above the low-water mark
    m.ack(info.id, FLOW_HIGH_WATER);
    expect(fake.calls[fake.calls.length - 1]).toBe('resume');
    m.detach(info.id);
    const n = data().length;
    fake.emit('silent');
    expect(data()).toHaveLength(n);
  });

  it('keeps a tab whose shell failed and drops one that exited cleanly', async () => {
    const [a, b] = [fakePty(), fakePty()];
    const { m, data } = manager([a, b], await tmpDir());
    const ta = m.create('s1');
    const tb = m.create('s1');
    await m.attach(ta.id, 80, 24);
    a.exit(1);
    const after = m.list().find((t) => t.id === ta.id);
    expect(after?.exit).toEqual({ code: 1, signal: undefined });
    expect(after?.pid).toBeUndefined();
    expect(data().some((d) => d.terminalId === ta.id && /exited with code 1/.test(d.data))).toBe(true);
    b.exit(0);
    await waitFor(() => !m.list().some((t) => t.id === tb.id), 1000, 'clean exit to close the tab');
    expect(m.list().map((t) => t.id)).toEqual([ta.id]);
  });

  it('restarts a shell in the same tab and renames tabs', async () => {
    const [a, b] = [fakePty(), fakePty()];
    const { m } = manager([a, b], await tmpDir());
    const t = m.create('s1');
    a.exit(2);
    expect(m.list()[0].exit?.code).toBe(2);
    const restarted = m.restart(t.id);
    expect(restarted.id).toBe(t.id);
    expect(restarted.exit).toBeUndefined();
    expect(restarted.pid).toBe(4242);
    a.exit(9); // the old generation must not touch the tab any more
    expect(m.list()[0].exit).toBeUndefined();
    const renamed = m.rename(t.id, ' build ');
    expect(renamed.title).toBe('build');
    expect(renamed.customTitle).toBe(true);
    expect(m.rename(t.id, '').title).toBe(renamed.shellName);
  });

  it('persists screens and brings them back as restored tabs that spawn on first attach', async () => {
    const dir = await tmpDir();
    const fake = fakePty();
    const { m } = manager([fake], dir);
    const t = m.create('s1', { cols: 50, rows: 8 });
    m.rename(t.id, 'kept');
    fake.emit('remember-me\r\n');
    await m.persist();
    expect(existsSync(path.join(dir, `${t.id}.json`))).toBe(true);

    const spawned = fakePty();
    const second = manager([spawned], dir);
    await second.m.load();
    const restored = second.m.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: t.id, title: 'kept', restored: true, sessionId: 's1' });
    expect(restored[0].pid).toBeUndefined();
    const a = await second.m.attach(t.id, 50, 8);
    expect(a.snapshot).toContain('remember-me');
    expect(a.snapshot).toContain('restored from the previous session');
    expect(a.info.restored).toBe(false);
    expect(a.info.pid).toBe(4242);

    // Snapshots of sessions that no longer exist are dropped on load.
    await fs.writeFile(path.join(dir, 't_gone.json'), JSON.stringify({ info: { id: 't_gone', sessionId: 'deleted', title: 'x', shell: 'cmd', shellName: 'x', cwd: 'c:/', createdAt: 1 }, cols: 80, rows: 24, snapshot: '' }));
    const third = manager([], dir);
    await third.m.load();
    expect(third.m.list().map((x) => x.id)).toEqual([t.id]);
    expect(existsSync(path.join(dir, 't_gone.json'))).toBe(false);
  });

  it('closes a session\'s terminals together', async () => {
    const { m } = manager([fakePty(), fakePty()], await tmpDir());
    m.create('s1');
    m.create('s1');
    expect(m.list()).toHaveLength(2);
    await m.closeForSession('s1');
    expect(m.list()).toHaveLength(0);
  });
});

describe('TerminalManager (real pty)', () => {
  it('runs a real shell: a typed command echoes back and lands in the snapshot', async () => {
    const { m, data } = manager(null, await tmpDir());
    const info = m.create('s1', { cols: 100, rows: 30 });
    await m.attach(info.id, 100, 30);
    await waitFor(() => data().length > 0, 15_000, 'the shell prompt');
    expect(m.list()[0].pid).toBeGreaterThan(0); // ConPTY reports the pid once connected
    m.input(info.id, 'echo pty-roundtrip-42\r');
    await waitFor(() => data().some((d) => /pty-roundtrip-42/.test(d.data)), 15_000, 'the echoed command');
    const again = await m.attach(info.id, 100, 30);
    expect(again.snapshot).toContain('pty-roundtrip-42');
    await m.close(info.id);
    expect(m.list()).toHaveLength(0);
  }, 60_000);
});
