/**
 * The native loop as an MCP client: the app connects to the session's servers, maps their tools
 * into the local tool set, and gates them. The memory server doubles as the fixture — it ships with
 * the app, so the test exercises a real process rather than a stub protocol.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAdapter } from '../src/main/harness/native';
import { NativeMcpSession, mcpToolName } from '../src/main/harness/native/mcp-tools';
import type { StepParams, StepResult } from '../src/main/harness/native/drivers';
import type { HarnessContext } from '../src/main/harness/types';
import type { ResolvedServer } from '../src/main/mcp/effective';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import { serializeKnowledgeDocument, type KnowledgePageMeta } from '../src/shared/knowledge';
import type { PermissionMode, SessionEvent, SessionMeta } from '../src/shared/types';

const memoryScript = path.join(process.cwd(), 'resources', 'mcp', 'vocs-memory.mjs');

const mocks = vi.hoisted(() => ({ step: vi.fn<(p: StepParams) => Promise<StepResult>>() }));
vi.mock('../src/main/harness/native/drivers', () => ({ openaiStep: mocks.step, anthropicStep: mocks.step, isAnthropicProvider: () => false }));

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const SEARCH = mcpToolName('vocs-memory', 'knowledge_search');
const PROPOSE = mcpToolName('vocs-memory', 'knowledge_propose');

let root: string;
let wiki: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-mcp-'));
  wiki = path.join(root, '.vocs-code', 'wiki');
  await fs.mkdir(path.join(wiki, 'conventions'), { recursive: true });
  const meta: KnowledgePageMeta = {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    claim: 'A harness process belongs to exactly one session.',
    keywords: ['harness', 'session'],
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: [],
    review: { state: 'reviewed', by: 'human' }
  };
  await fs.writeFile(path.join(wiki, 'conventions', 'harness-lifecycle.md'), serializeKnowledgeDocument(meta, 'The main process owns it.'));
  mocks.step.mockReset();
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(root, { recursive: true, force: true });
});

function memoryServer(): ResolvedServer {
  return {
    def: { id: 'vocs-memory', transport: 'stdio', command: process.execPath, args: [memoryScript], env: { VOCS_MEMORY_ROOT: wiki } },
    missing: [],
    secretEnvKeys: [],
    secretHeaderKeys: []
  };
}

function brokenServer(): ResolvedServer {
  return { def: { id: 'broken', transport: 'stdio', command: path.join(root, 'not-a-real-binary'), args: [] }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] };
}

type Call = { id: string; name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>, id = name): Call => ({ name, args, id });

/** Minimal scripted-model harness: one turn, the tool calls it is told to make, then a text stop. */
function harness(mode: PermissionMode, servers: () => Promise<ResolvedServer[]>) {
  const settings = defaultSettings();
  settings.providers = [{ id: 'local', name: 'Local', kind: 'ollama', enabled: true, hasApiKey: false, models: [{ id: 'test', displayName: 'Test', provider: 'local' }] }];
  const meta = { cwd: root, usage: emptyUsage(), config: { harness: 'native', model: { provider: 'local', model: 'test' } }, harnessRef: {} } as SessionMeta;
  const events: SessionEvent[] = [];
  let saved: unknown = null;
  const approval = vi.fn<HarnessContext['requestApproval']>(async () => ({ optionId: 'allow' }));
  const ctx = {
    sessionId: 'test',
    session: () => meta,
    settings: () => settings,
    sessionDir: root,
    permissionMode: () => mode,
    effort: () => undefined,
    getApiKey: async () => undefined,
    emit: (e: SessionEvent) => events.push(e),
    requestApproval: approval,
    updateRef: (p: object) => Object.assign(meta.harnessRef, p),
    updateMeta: (p: object) => Object.assign(meta, p),
    readJson: async () => structuredClone(saved),
    writeJson: async (_name: string, value: unknown) => {
      saved = structuredClone(value);
    },
    log: vi.fn(),
    mcpServers: servers,
    ownedMcpIds: () => [],
    runtime: {}
  } as unknown as HarnessContext;
  const adapter = new NativeAdapter(ctx);
  return {
    approval,
    events,
    async dispose() {
      await adapter.dispose();
    },
    async run(calls: Call[]) {
      mocks.step.mockImplementationOnce(async () => ({ text: '', reasoning: '', toolCalls: calls, usage, stopReason: 'tool_calls' }));
      mocks.step.mockImplementationOnce(async () => ({ text: 'Done', reasoning: '', toolCalls: [], usage, stopReason: 'stop' }));
      const prior = events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn').length;
      await adapter.send({ text: 'Run the scripted tools', mode: 'now' });
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn')).toHaveLength(prior + 1), { timeout: 15_000 });
      // Tool cards are upserted repeatedly (running → done); keep the final state per tool id.
      const final = new Map<string, Extract<SessionEvent, { type: 'item.upsert' }>['item']>();
      for (const e of events) if (e.type === 'item.upsert' && e.item.kind === 'tool') final.set(e.item.id, e.item);
      return [...final.values()].slice(-calls.length).map((item) => ({ item }));
    }
  };
}

describe('native MCP tool mapping', () => {
  it('maps the memory server and trusts only its read-only tools', async () => {
    const session = await NativeMcpSession.connect([memoryServer()], { cwd: root, log: () => undefined });
    try {
      const search = session.tools.find((t) => t.name === SEARCH);
      const propose = session.tools.find((t) => t.name === PROPOSE);
      expect(search).toBeDefined();
      expect(propose).toBeDefined();
      // The app wrote this server, and only this server, so its read-only hint is honoured.
      expect(search!.mutating).toBe(false);
      expect(propose!.mutating).toBe(true);
      const result = await search!.call({ query: 'harness session' });
      expect(result.isError).toBe(false);
      expect(result.output).toContain('conventions/harness-lifecycle');
    } finally {
      await session.close();
    }
  });

  it('keeps the reachable servers when one cannot start', async () => {
    const session = await NativeMcpSession.connect([memoryServer(), brokenServer()], { cwd: root, log: () => undefined });
    try {
      expect(session.failures.map((f) => f.serverId)).toEqual(['broken']);
      expect(session.servers).toEqual(['vocs-memory']);
      expect(session.tools.map((t) => t.name)).toContain(SEARCH);
    } finally {
      await session.close();
    }
  });
});

describe('native MCP gating', () => {
  it('runs a trusted read-only tool unprompted and asks before a propose', async () => {
    const h = harness('auto', async () => [memoryServer()]);
    try {
      const results = await h.run([
        call(SEARCH, { query: 'harness session' }),
        call(PROPOSE, { title: 'PTY guard', claim: 'Guard reconnects.', body: 'Explain the guard.' })
      ]);
      expect(results[0].item).toMatchObject({ status: 'done' });
      expect(results[0].item).toMatchObject({ output: expect.stringContaining('conventions/harness-lifecycle') });
      // Auto mode is not allowed to treat a write-capable server tool as safe.
      expect(h.approval).toHaveBeenCalledTimes(1);
      expect(h.approval.mock.calls[0][0].toolName).toBe(PROPOSE);
      expect(String(h.approval.mock.calls[0][0].description)).toContain('vocs-memory');
      expect(results[1].item).toMatchObject({ status: 'done' });
      expect(await fs.readdir(path.join(wiki, '_proposals'))).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });

  it('hides write-capable MCP tools in plan mode and keeps read-only ones', async () => {
    const h = harness('plan', async () => [memoryServer()]);
    try {
      const results = await h.run([call(SEARCH, { query: 'harness session' })]);
      const offered = (mocks.step.mock.calls[0][0].tools ?? []).map((t) => t.name);
      expect(offered).toContain(SEARCH);
      expect(offered).not.toContain(PROPOSE);
      expect(results[0].item).toMatchObject({ status: 'done' });
      expect(h.approval).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
});
