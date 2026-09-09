/**
 * Live smoke tests: drive each harness adapter against the real backend installed on this
 * machine. Skipped unless HARNESS_SMOKE=1. Individual harnesses can be selected with
 * HARNESS_SMOKE_ONLY=codex,pi,... Each test sends one prompt asking for the literal token
 * PONG and asserts the adapter produced an assistant item containing it plus a turn item.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ApprovalDecision, HarnessId, SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { createAdapter } from '../src/main/harness/registry';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import { RuntimeResolver } from '../src/main/runtime';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';

const enabled = process.env.HARNESS_SMOKE === '1';
const only = (process.env.HARNESS_SMOKE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (id: string) => enabled && (only.length === 0 || only.includes(id));

const appRoot = path.resolve(__dirname, '..');
const tmpRoot = path.join(os.tmpdir(), `vocs-code-smoke-${Date.now()}`);
const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const c of cleanups) await c().catch(() => undefined);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

async function makeCtx(harness: HarnessId, extra: Partial<SessionMeta['config']> = {}) {
  const cwd = path.join(tmpRoot, harness);
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'README.md'), '# smoke\n');
  const settings = defaultSettings();
  const runtime = new RuntimeResolver({ appRuntimeDir: path.join(tmpRoot, 'runtime'), resourcesDir: path.join(appRoot, 'resources'), appRoot }, () => settings);
  const meta: SessionMeta = {
    id: `smoke_${harness}`,
    title: 'smoke',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { harness, projectRoot: cwd, permissionMode: 'auto', ...extra },
    cwd,
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage()
  };
  const events: SessionEvent[] = [];
  const items = new Map<string, TranscriptItem>();
  let resolveIdle: (() => void) | null = null;
  let turns = 0;
  const ctx: HarnessContext = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => settings,
    runtime,
    sessionDir: path.join(tmpRoot, 'sessions', harness),
    permissionMode: () => meta.config.permissionMode,
    effort: () => meta.config.effort,
    getApiKey: async () => undefined,
    emit: (event) => {
      events.push(event);
      if (event.type === 'item.upsert') items.set(event.item.id, event.item);
      if (event.type === 'item.delta') {
        const it = items.get(event.id);
        if (it?.kind === 'assistant' && event.textDelta) it.text += event.textDelta;
      }
      if (event.type === 'item.upsert' && event.item.kind === 'turn') turns++;
      if (event.type === 'status' && event.status === 'idle' && turns > 0) resolveIdle?.();
      if (event.type === 'status' && (event.status === 'error' || event.status === 'stopped')) resolveIdle?.();
    },
    requestApproval: async (draft: ApprovalDraft): Promise<ApprovalDecision> => {
      events.push({ type: 'log', level: 'info', message: `auto-approving ${draft.kind}: ${draft.command ?? draft.title}` });
      return { optionId: draft.options[0]?.id ?? 'allow' };
    },
    updateRef: (patch) => Object.assign(meta.harnessRef, patch),
    updateMeta: (patch) => Object.assign(meta, patch),
    log: (level, message) => {
      if (process.env.HARNESS_SMOKE_VERBOSE) console.log(`[${harness}] ${level}: ${message}`);
    },
    readJson: async () => null,
    writeJson: async () => undefined
  };
  await fs.mkdir(ctx.sessionDir, { recursive: true });
  const waitTurn = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no turn within ${ms}ms; events: ${summarize(events)}`)), ms);
      resolveIdle = () => {
        clearTimeout(t);
        resolve();
      };
    });
  return { ctx, meta, events, items, waitTurn };
}

function summarize(events: SessionEvent[]): string {
  return events
    .slice(-25)
    .map((e) => (e.type === 'item.upsert' ? `${e.type}:${e.item.kind}${e.item.kind === 'info' ? `(${e.item.text.slice(0, 120)})` : ''}` : e.type === 'error' ? `error(${e.message})` : e.type === 'status' ? `status:${e.status}` : e.type))
    .join(' | ');
}

function assistantText(items: Map<string, TranscriptItem>): string {
  const text = [...items.values()]
    .filter((i) => i.kind === 'assistant')
    .map((i) => (i.kind === 'assistant' ? i.text : ''))
    .join('\n');
  if (text.trim()) return text;
  // Surface the harness-reported failure so an account/network problem reads as such.
  const failures = [...items.values()]
    .map((i) => (i.kind === 'turn' && i.error ? `turn ${i.status}: ${i.error}` : i.kind === 'info' && i.level === 'error' ? `error: ${i.text}` : ''))
    .filter(Boolean);
  return failures.length ? `<<no assistant text; ${failures.join(' | ')}>>` : '';
}

const PROMPT = 'Reply with exactly the single word PONG and nothing else. Do not use any tools.';

describe('live harness smoke', () => {
  it.runIf(want('codex'))('codex app-server answers a prompt', async () => {
    const { ctx, items, waitTurn, meta } = await makeCtx('codex');
    const adapter = createAdapter('codex', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    expect(meta.harnessRef.codexThreadId).toBeTruthy();
    const models = await adapter.listModels!();
    expect(models.length).toBeGreaterThan(0);
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    expect(assistantText(items)).toMatch(/PONG/i);
    expect([...items.values()].some((i) => i.kind === 'turn' && i.status === 'completed')).toBe(true);
  });

  it.runIf(want('codex-exec'))('codex exec SDK answers a prompt', async () => {
    const { ctx, items, waitTurn } = await makeCtx('codex-exec');
    const adapter = createAdapter('codex-exec', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    expect(assistantText(items)).toMatch(/PONG/i);
  });

  it.runIf(want('pi'))('pi rpc answers a prompt and lists models', async () => {
    const { ctx, items, waitTurn, meta } = await makeCtx('pi');
    const adapter = createAdapter('pi', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    const models = await adapter.listModels!();
    expect(models.length).toBeGreaterThan(0);
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    expect(assistantText(items)).toMatch(/PONG/i);
    expect(meta.harnessRef.piSessionFile).toBeTruthy();
  });

  it.runIf(want('claude'))('claude agent sdk answers a prompt', async () => {
    const { ctx, items, waitTurn, meta } = await makeCtx('claude');
    const adapter = createAdapter('claude', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    expect(assistantText(items)).toMatch(/PONG/i);
    expect(meta.harnessRef.claudeSessionId).toBeTruthy();
  });

  it.runIf(want('acp'))('deepseek harness over ACP answers a prompt', async () => {
    const { ctx, items, waitTurn, meta } = await makeCtx('acp', { acpAgent: process.env.HARNESS_SMOKE_ACP_AGENT ?? 'dsh' });
    const adapter = createAdapter('acp', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    expect(meta.harnessRef.acpSessionId).toBeTruthy();
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    expect(assistantText(items)).toMatch(/PONG/i);
  });

  it.runIf(want('native'))('native loop answers a prompt through an OpenAI-compatible provider', async () => {
    const provider = process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null;
    if (!provider) {
      console.warn('native smoke skipped: no provider API key in env');
      return;
    }
    const model = provider === 'deepseek' ? 'deepseek-v4-flash' : provider === 'openai' ? 'gpt-5.4-mini' : 'claude-sonnet-5';
    const { ctx, items, waitTurn } = await makeCtx('native', { model: { provider, model } });
    const adapter = createAdapter('native', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: PROMPT });
    await waitTurn(170_000);
    expect(assistantText(items)).toMatch(/PONG/i);
  });

  it.runIf(want('native-tools'))('native loop uses tools with approvals', async () => {
    const provider = process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.OPENAI_API_KEY ? 'openai' : null;
    if (!provider) return;
    const model = provider === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-5.4-mini';
    const { ctx, items, waitTurn, meta } = await makeCtx('native', { model: { provider, model }, permissionMode: 'ask' });
    const adapter = createAdapter('native', ctx);
    cleanups.push(() => adapter.dispose());
    await adapter.start();
    await adapter.send({ text: 'Create a file named hello.txt containing the text "hello from vocs code" using the write_file tool, then read it back with read_file and confirm. Reply DONE at the end.' });
    await waitTurn(170_000);
    const content = await fs.readFile(path.join(meta.cwd, 'hello.txt'), 'utf8');
    expect(content).toMatch(/hello from vocs code/);
    expect([...items.values()].some((i) => i.kind === 'approval' || (i.kind === 'tool' && i.name === 'write_file'))).toBe(true);
  });
});
