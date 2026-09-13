/**
 * Logging coverage: the main log must record what a bug report needs and must never carry a key.
 * Covers the redaction safety net, corrupt-store quarantine lines, session lifecycle and harness
 * failure lines, and terminal spawn failures. Everything runs offline in plain Node.
 */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { IPty } from '@lydell/node-pty';
import { createLogger, redactSecrets } from '../src/main/log';
import { readJson, readJsonl } from '../src/main/util/fs';
import { SessionStore } from '../src/main/store';
import { SettingsStore, defaultSettings } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import { TerminalManager } from '../src/main/terminal';
import { DEFAULT_TERMINAL_SETTINGS } from '../src/shared/terminal';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SessionEvent, SessionMeta } from '../src/shared/types';

// The registry is the only path to a real adapter; a scripted one keeps the harness-start
// failure path deterministic and offline.
const registryMock = vi.hoisted(() => ({ startImpl: async (): Promise<void> => undefined }));
vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (_id: string, _ctx: HarnessContext): HarnessAdapter => ({
    id: 'native',
    busy: false,
    start: () => registryMock.startImpl(),
    send: async () => undefined,
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    dispose: async () => undefined
  })
}));

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
});
function tmpDir(prefix: string): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), `vocs-logging-${prefix}-`));
  dirs.push(d);
  return d;
}
type Line = [string, string];
function collector(): { lines: Line[]; log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void } {
  const lines: Line[] = [];
  return { lines, log: (level, message) => void lines.push([level, message]) };
}
const has = (lines: Line[], level: string, re: RegExp) => lines.some(([l, m]) => l === level && re.test(m));

describe('redactSecrets', () => {
  it('masks provider keys, GitHub tokens and bearer headers wherever they appear', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789')).toBe('OPENAI_API_KEY=[redacted]');
    expect(redactSecrets('anthropic said: invalid x-api-key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe('anthropic said: invalid x-api-key [redacted]');
    expect(redactSecrets('remote: got ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456')).toBe('remote: got [redacted]');
    expect(redactSecrets('groq gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 and xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('groq [redacted] and [redacted]');
    expect(redactSecrets('headers: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe('headers: Authorization: Bearer [redacted]');
  });

  it('masks key=value and JSON assignments by field name', () => {
    expect(redactSecrets('{"apiKey": "abcdef123456", "model": "gpt-5"}')).toBe('{"apiKey": "[redacted]", "model": "gpt-5"}');
    expect(redactSecrets('config token=abc123def456 ok')).toBe('config token=[redacted] ok');
    expect(redactSecrets("password: 'hunter2hunter2'")).toBe("password: '[redacted]'");
  });

  it('leaves ordinary log content alone, including token counts and model ids', () => {
    const lines = [
      '[s_1] session created: harness=claude model=anthropic/claude-fable-5-1 permissions=ask cwd=G:\\proj',
      '[s_1] turn completed in 12.3s (5000000 in / 1200 out) $0.0412',
      'usage contextTokens: 123456 inputTokens=5000000 totalTokens:9',
      'mcp github: no value for GITHUB_TOKEN',
      'settings updated: theme, providers'
    ];
    for (const line of lines) expect(redactSecrets(line)).toBe(line);
  });
});

describe('createLogger', () => {
  it('applies redaction to every line written to main.log', async () => {
    const dir = tmpDir('logger');
    const { log } = createLogger(dir, false);
    log('warn', 'provider rejected key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 for anthropic');
    await new Promise((r) => setTimeout(r, 50));
    const text = await fs.readFile(path.join(dir, 'main.log'), 'utf8');
    expect(text).toContain('WARN provider rejected key [redacted] for anthropic');
    expect(text).not.toContain('sk-ant-');
  });
});

describe('persistence read logging', () => {
  it('readJson says which file was quarantined and where the copy went', async () => {
    const dir = tmpDir('readjson');
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, '{"theme": "midn', 'utf8');
    const c = collector();
    expect(await readJson(file, { fallback: true }, { log: c.log })).toEqual({ fallback: true });
    expect(has(c.lines, 'warn', /settings\.json is not valid JSON .*moved a copy to .*settings\.json\.corrupt-\d+/)).toBe(true);
    expect((await fs.readdir(dir)).some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true);
  });

  it('readJson stays silent for a missing file', async () => {
    const c = collector();
    expect(await readJson(path.join(tmpDir('missing'), 'nope.json'), 7, { log: c.log })).toBe(7);
    expect(c.lines).toEqual([]);
  });

  it('readJsonl counts the lines it had to skip', async () => {
    const file = path.join(tmpDir('jsonl'), 'transcript.jsonl');
    await fs.writeFile(file, '{"id":"a"}\nnot json\n{"id":"b"}\n{"id":"c"\n', 'utf8');
    const c = collector();
    const rows = await readJsonl<{ id: string }>(file, { log: c.log });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(has(c.lines, 'warn', /transcript\.jsonl: skipped 2 unparsable line\(s\) out of 4/)).toBe(true);
  });

  it('SessionStore reports a corrupt index and dropped entries instead of silently starting empty', async () => {
    const corrupt = tmpDir('store-corrupt');
    await fs.writeFile(path.join(corrupt, 'sessions.json'), '[{"id":', 'utf8');
    const c1 = collector();
    expect(await new SessionStore(corrupt, c1.log).load()).toEqual([]);
    expect(has(c1.lines, 'warn', /sessions\.json is not valid JSON/)).toBe(true);
    expect(has(c1.lines, 'info', /loaded 0 session\(s\)/)).toBe(true);

    const shaped = tmpDir('store-shaped');
    await fs.writeFile(path.join(shaped, 'sessions.json'), JSON.stringify([{ id: 's_ok', status: 'running' }, { id: '../escape' }, null]), 'utf8');
    const c2 = collector();
    const list = await new SessionStore(shaped, c2.log).load();
    expect(list.map((s) => s.id)).toEqual(['s_ok']);
    expect(list[0].status).toBe('idle');
    expect(has(c2.lines, 'warn', /dropped 2 malformed session entries/)).toBe(true);
    expect(has(c2.lines, 'info', /loaded 1 session\(s\); 1 were still running/)).toBe(true);
  });

  it('SettingsStore logs a corrupt settings file and a listener that throws', async () => {
    const dir = tmpDir('settings');
    await fs.writeFile(path.join(dir, 'settings.json'), '{oops', 'utf8');
    const c = collector();
    const store = new SettingsStore(dir, c.log);
    await store.load();
    expect(has(c.lines, 'warn', /settings\.json is not valid JSON/)).toBe(true);
    store.onChange(() => {
      throw new Error('listener exploded');
    });
    let second = false;
    store.onChange(() => {
      second = true;
    });
    await expect(store.update({ theme: 'system' })).resolves.toBeTruthy();
    expect(second).toBe(true);
    expect(has(c.lines, 'warn', /settings listener failed: .*listener exploded/)).toBe(true);
  });
});

describe('SessionManager logging', () => {
  const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

  function fixture() {
    const session: SessionMeta = {
      id: 's_log',
      title: 'Logged session',
      createdAt: 1,
      updatedAt: 1,
      config: { harness: 'native', projectRoot: 'G:/project', permissionMode: 'ask' },
      cwd: 'G:/project',
      status: 'idle',
      harnessRef: {},
      usage: { ...ZERO },
      queued: 0
    };
    const c = collector();
    const settings = defaultSettings();
    const manager = new SessionManager({
      store: {
        list: () => [session],
        get: (id: string) => (id === session.id ? session : undefined),
        upsert: vi.fn(async () => undefined),
        appendTranscript: vi.fn(async () => undefined),
        sessionDir: () => 'G:/project/.session'
      } as unknown as SessionManager['deps']['store'],
      settings: { get: () => settings } as unknown as SessionManager['deps']['settings'],
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: c.log
    });
    const emit = (event: SessionEvent) => (manager as unknown as { emit: (id: string, value: SessionEvent) => void }).emit(session.id, event);
    return { manager, session, emit, lines: c.lines };
  }

  it('records a harness that fails to start at error level, with the harness named', async () => {
    registryMock.startImpl = async () => {
      throw new Error('codex binary missing');
    };
    const f = fixture();
    await expect(f.manager.send(f.session.id, { text: 'hello' })).rejects.toThrow('codex binary missing');
    expect(has(f.lines, 'info', /\[s_log\] starting native \(model=default permissions=ask cwd=G:\/project\)/)).toBe(true);
    expect(has(f.lines, 'error', /\[s_log\] native failed to start after \d+ms: .*codex binary missing/)).toBe(true);
    expect(f.session.status).toBe('error');
  });

  it('records a successful start with its duration and the user input shape only', async () => {
    registryMock.startImpl = async () => undefined;
    const f = fixture();
    await f.manager.send(f.session.id, { text: 'top secret prompt text', images: [{ mimeType: 'image/png', data: 'AAAA' }] });
    expect(has(f.lines, 'info', /\[s_log\] native started in \d+ms/)).toBe(true);
    expect(has(f.lines, 'debug', /user input: 22 chars, 1 image\(s\)/)).toBe(true);
    expect(f.lines.some(([, m]) => m.includes('top secret prompt text'))).toBe(false);
  });

  it('logs fatal harness errors, stopped status, and the approval audit trail', async () => {
    registryMock.startImpl = async () => undefined;
    const f = fixture();
    await f.manager.send(f.session.id, { text: 'go' });
    f.emit({ type: 'error', message: 'context window exceeded', fatal: false });
    expect(has(f.lines, 'warn', /\[s_log\] native error: context window exceeded/)).toBe(true);

    const requestApproval = (f.manager as unknown as { requestApproval: (id: string, draft: { kind: string; title: string; options: { id: string; label: string }[] }) => Promise<{ optionId: string }> }).requestApproval.bind(f.manager);
    const decision = requestApproval(f.session.id, { kind: 'command', title: 'Run npm test', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] });
    const requestLine = f.lines.find(([l, m]) => l === 'info' && /approval ap_\w+ requested \(ask\): Run npm test/.test(m));
    expect(requestLine).toBeTruthy();
    const requestId = /approval (ap_\w+) requested/.exec(requestLine![1])![1];
    await f.manager.respondApproval(f.session.id, requestId, { optionId: 'allow' });
    expect(await decision).toEqual({ optionId: 'allow' });
    expect(has(f.lines, 'info', new RegExp(`approval ${requestId} → allow \\(Run npm test\\)`))).toBe(true);

    f.emit({ type: 'status', status: 'stopped', detail: 'pi exited (1)' });
    expect(has(f.lines, 'info', /\[s_log\] harness stopped: pi exited \(1\)/)).toBe(true);

    f.emit({ type: 'error', message: 'process crashed', fatal: true });
    expect(has(f.lines, 'error', /\[s_log\] native fatal error: process crashed/)).toBe(true);
  });

  it('logs turn outcomes and permission mode changes', async () => {
    registryMock.startImpl = async () => undefined;
    const f = fixture();
    await f.manager.send(f.session.id, { text: 'go' });
    f.emit({ type: 'item.upsert', item: { id: 'turn_1', kind: 'turn', ts: Date.now(), status: 'completed', durationMs: 4200, usage: { inputTokens: 900, outputTokens: 120 }, costUsd: 0.0123 } });
    expect(has(f.lines, 'info', /\[s_log\] turn completed in 4\.2s \(900 in \/ 120 out\) \$0\.0123/)).toBe(true);
    f.emit({ type: 'item.upsert', item: { id: 'turn_2', kind: 'turn', ts: Date.now(), status: 'failed', error: 'rate limited' } });
    expect(has(f.lines, 'warn', /\[s_log\] turn failed: rate limited/)).toBe(true);
    await f.manager.setPermissionMode(f.session.id, 'full-auto');
    expect(has(f.lines, 'info', /\[s_log\] permission mode ask → full-auto/)).toBe(true);
  });
});

describe('TerminalManager logging', () => {
  function deps(spawn: () => IPty, log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void) {
    return {
      dir: tmpDir('terms'),
      settings: () => ({ ...DEFAULT_TERMINAL_SETTINGS, customShellArgs: [] as string[] }),
      version: '0.0.0-test',
      cwdOf: () => 'G:/project',
      push: () => undefined,
      log,
      spawn: spawn as unknown as NonNullable<ConstructorParameters<typeof TerminalManager>[0]['spawn']>
    };
  }

  it('logs a shell that cannot be started and rethrows for the renderer', () => {
    const c = collector();
    const tm = new TerminalManager(
      deps(() => {
        throw new Error('ENOENT: pwsh.exe');
      }, c.log)
    );
    expect(() => tm.create('s_1')).toThrow(/Could not start .* in G:\/project: ENOENT: pwsh\.exe/);
    expect(has(c.lines, 'warn', /terminal t_\w+: Could not start .*ENOENT: pwsh\.exe/)).toBe(true);
  });

  it('logs a non-zero shell exit but not a clean one', () => {
    const c = collector();
    let exit: ((e: { exitCode: number; signal?: number }) => void) | null = null;
    const pty = {
      pid: 4242,
      cols: 80,
      rows: 24,
      process: 'fake',
      handleFlowControl: false,
      onData: () => ({ dispose: () => undefined }),
      onExit: (l: (e: { exitCode: number; signal?: number }) => void) => {
        exit = l;
        return { dispose: () => undefined };
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      clear: () => undefined
    } as unknown as IPty;
    const tm = new TerminalManager(deps(() => pty, c.log));
    const info = tm.create('s_1');
    expect(has(c.lines, 'debug', new RegExp(`terminal ${info.id}: started .* pid 4242 in G:/project`))).toBe(true);
    exit!({ exitCode: 127 });
    expect(has(c.lines, 'info', new RegExp(`terminal ${info.id} \\(.*\\) exited with code 127`))).toBe(true);
    const before = c.lines.length;
    const second = tm.create('s_1');
    exit!({ exitCode: 0 });
    expect(c.lines.slice(before).some(([, m]) => m.includes(`terminal ${second.id}`) && /exited/.test(m))).toBe(false);
  });
});
