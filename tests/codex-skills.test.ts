/**
 * Codex runs no slash commands outside its TUI, but it runs skills named as `$name`. Both Codex
 * adapters list skills for the composer and turn a picked `/name args` into `$name args` — the
 * app-server one also attaching the structured skill item — so the skill runs instead of the slash
 * reaching the model as text. Offline: the app-server is a fake JSON-RPC peer, the exec SDK a stub.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { codexSkillInvocation, listCodexSkills } from '../src/main/harness/codex-skills';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import type { HarnessContext } from '../src/main/harness/types';
import type { HarnessRef, SessionMeta } from '../src/shared/types';

type AnyRecord = Record<string, any>;

const mocks = vi.hoisted(() => ({ children: [] as AnyRecord[], runs: [] as unknown[] }));

vi.mock('../src/main/harness/spawn', () => ({
  spawnTool: () => {
    const child = mocks.children.shift();
    if (!child) throw new Error('no scripted child process');
    return child;
  },
  shutdownChild: async () => undefined,
  killTree: async () => undefined,
  quoteWin: (arg: string) => arg,
  usesWindowsCommandShim: () => false
}));

vi.mock('@openai/codex-sdk', () => {
  class Codex {
    startThread() {
      return {
        id: 'exec-thread',
        runStreamed: async (input: unknown) => {
          mocks.runs.push(input);
          return { events: (async function* () { yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } }; })() };
        }
      };
    }
  }
  return { Codex };
});

function fakeChild(): AnyRecord {
  const child = new EventEmitter() as AnyRecord;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 7, kill: vi.fn() });
  return child;
}

/** The app-server side of the stdio transport: answers requests, records them, can notify. */
function fakeServer(child: AnyRecord, handlers: Record<string, (params: AnyRecord) => unknown>) {
  const requests: AnyRecord[] = [];
  let buf = '';
  const write = (msg: AnyRecord) => child.stdout.write(JSON.stringify(msg) + '\n');
  child.stdin.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
      if (!line) continue;
      const msg = JSON.parse(line) as AnyRecord;
      if (msg.method === undefined) continue;
      requests.push(msg);
      if (msg.id === undefined || msg.id === null) continue;
      void Promise.resolve(handlers[msg.method]?.(msg.params ?? {}) ?? {}).then((result) => write({ id: msg.id, result }));
    }
  });
  return { requests, notify: (method: string, params: AnyRecord = {}) => write({ method, params }) };
}

function makeCtx(harness: 'codex' | 'codex-exec', over: Partial<SessionMeta> = {}) {
  const meta: SessionMeta = {
    id: 's1', title: 't', createdAt: 0, updatedAt: 0,
    config: { harness, projectRoot: '/proj', permissionMode: 'auto' },
    cwd: '/proj', status: 'idle', harnessRef: {}, usage: emptyUsage(),
    ...over
  };
  const settings = defaultSettings();
  const ctx = {
    sessionId: 's1', session: () => meta, settings: () => settings,
    runtime: { resolve: () => null },
    sessionDir: process.cwd(), permissionMode: () => meta.config.permissionMode, effort: () => undefined,
    getApiKey: async () => undefined, emit: () => {}, requestApproval: async () => ({ optionId: 'deny' }),
    updateRef: (patch: Partial<HarnessRef>) => Object.assign(meta.harnessRef, patch),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    log: vi.fn(), readJson: async () => null, writeJson: async () => undefined, mcpServers: async () => [], ownedMcpIds: () => []
  } as unknown as HarnessContext;
  return { ctx, meta };
}

const SKILLS = [
  { name: 'pdf', description: 'Long description of PDF work', interface: { shortDescription: 'Work with PDFs' }, path: '/proj/.codex/skills/pdf/SKILL.md', scope: 'repo', enabled: true },
  { name: 'pdf', description: 'User-level duplicate', path: '/home/.codex/skills/pdf/SKILL.md', scope: 'user', enabled: true },
  { name: 'off', description: 'Disabled skill', path: '/x/SKILL.md', scope: 'user', enabled: false }
];

beforeEach(() => {
  mocks.children.length = 0;
  mocks.runs.length = 0;
});

describe('codex skills', () => {
  it('lists enabled skills once each, preferring the short description', async () => {
    const rpc = { request: vi.fn(async () => ({ data: [{ cwd: '/proj', skills: SKILLS, errors: [] }] })) };
    expect(await listCodexSkills(rpc as never, '/proj')).toEqual([{ name: 'pdf', description: 'Work with PDFs', path: '/proj/.codex/skills/pdf/SKILL.md' }]);
    expect(rpc.request).toHaveBeenCalledWith('skills/list', { cwds: ['/proj'] });
  });

  it('turns /skill into $skill only for a known skill', () => {
    const known = [{ name: 'pdf' }];
    expect(codexSkillInvocation('/PDF merge a.pdf b.pdf', known)).toEqual({ text: '$pdf merge a.pdf b.pdf', skill: { name: 'pdf' } });
    expect(codexSkillInvocation('/pdf', known).text).toBe('$pdf');
    expect(codexSkillInvocation('/review this', known)).toEqual({ text: '/review this' });
    expect(codexSkillInvocation('please /pdf', known)).toEqual({ text: 'please /pdf' });
  });

  it('app-server: publishes skills, re-lists on skills/changed, and sends a picked one as $name plus the skill item', async () => {
    const child = fakeChild();
    mocks.children.push(child);
    let skills: AnyRecord[] = SKILLS;
    const server = fakeServer(child, {
      initialize: () => ({}),
      'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'gpt-5', modelProvider: 'openai', reasoningEffort: null }),
      'model/list': () => ({ data: [] }),
      'skills/list': () => ({ data: [{ cwd: '/proj', skills, errors: [] }] }),
      'turn/start': () => ({ turn: { id: 'turn-1' } })
    });
    const { ctx, meta } = makeCtx('codex');
    (ctx.runtime as unknown as { resolve: () => unknown }).resolve = () => ({ name: 'codex', path: 'C:/fake/codex.exe' });
    const adapter = new CodexAppServerAdapter(ctx);
    try {
      await adapter.start();
      await vi.waitFor(() => expect(meta.harnessCommandList).toEqual([{ name: 'pdf', description: 'Work with PDFs', kind: 'skill' }]));
      expect(meta.harnessCommands).toEqual(['pdf']);

      await adapter.send({ text: '/pdf merge the reports' });
      await vi.waitFor(() => expect(server.requests.some((r) => r.method === 'turn/start')).toBe(true));
      const turn = server.requests.find((r) => r.method === 'turn/start')!;
      expect(turn.params.input).toEqual([
        { type: 'text', text: '$pdf merge the reports', text_elements: [] },
        { type: 'skill', name: 'pdf', path: '/proj/.codex/skills/pdf/SKILL.md' }
      ]);

      skills = [{ name: 'lint', description: 'Lint it', path: '/proj/.codex/skills/lint/SKILL.md', enabled: true }];
      server.notify('skills/changed');
      await vi.waitFor(() => expect(meta.harnessCommands).toEqual(['lint']));
    } finally {
      await adapter.dispose();
    }
  });

  it('exec: translates /skill into $skill from the last reported list before its own lookup answers', async () => {
    const { CodexExecAdapter } = await import('../src/main/harness/codex-exec');
    const { ctx } = makeCtx('codex-exec', { harnessCommandList: [{ name: 'pdf', kind: 'skill' }] });
    const adapter = new CodexExecAdapter(ctx);
    await adapter.start();
    await adapter.send({ text: '/pdf summarize' });
    await vi.waitFor(() => expect(mocks.runs).toHaveLength(1));
    expect(mocks.runs[0]).toEqual([{ type: 'text', text: '$pdf summarize' }]);
    await adapter.dispose();
  });
});
