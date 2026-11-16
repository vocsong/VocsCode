/**
 * Which MCP tools pi's gate may treat as reads. Only a definition the app itself built for its
 * memory server carries that trust; a server name, a label or a tool annotation never does. The
 * parent approvals extension decides through the real bridge here, so these are execution-level:
 * a tool the gate should have asked about or blocked must not run.
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vocsCodeApprovals from '../resources/pi/vocs-code-approvals';
import { DECLINED_REASON, PLAN_REASON } from '../resources/pi/subagent-gate';
import { BUILTIN_SERVERS, loadMcpBridge, mcpReadOnlyToolNames, mcpToolNames, reservedBuiltinName, reservedKey } from '../resources/pi/vocs-code-mcp';
import { MCP_BUILTIN_IDS } from '../src/shared/types';
import { mcpIdKey, reservedBuiltinFor } from '../src/shared/mcp-ids';
import { memoryServerDef, vocsMemoryBaseDef } from '../src/main/mcp/memory';
import { annotatedTools, stubPiMcpBridge, type StubbedBridge } from './support/pi-mcp-stub';

type ToolCallHandler = (event: { toolName: string; toolCallId?: string; input: Record<string, unknown> }, ctx: object) => Promise<{ block?: boolean; reason?: string } | undefined>;

function parentGate(mode: string): ToolCallHandler {
  process.env.VOCS_CODE_PERMISSION_MODE = mode;
  delete process.env.VOCS_CODE_MODE_FILE;
  let handler: ToolCallHandler | undefined;
  vocsCodeApprovals({ on: (event, h) => { if (event === 'tool_call') handler = h as unknown as ToolCallHandler; } } as Parameters<typeof vocsCodeApprovals>[0]);
  if (!handler) throw new Error('tool_call handler was not registered');
  return handler;
}

let bridge: StubbedBridge | undefined;
afterEach(async () => {
  await bridge?.restore();
  bridge = undefined;
  delete process.env.VOCS_CODE_PERMISSION_MODE;
  vi.restoreAllMocks();
});

/** The definition the app hands pi for its own memory server. */
function appMemoryDef() {
  const root = path.join(os.tmpdir(), 'vocs-builtin-trust-project');
  const def = memoryServerDef({ projectRoot: root, cwd: root }, vocsMemoryBaseDef(), { memoryServerPath: path.join(root, 'vocs-memory.mjs') });
  if (!def) throw new Error('memory definition was not built');
  return def;
}

const third = (id: string) => ({ id, transport: 'http', url: 'https://mcp.example.invalid/mcp' });

/** Expected decisions for an ordinary third-party MCP tool. */
const THIRD_PARTY: [mode: string, outcome: 'ask' | 'block'][] = [['ask', 'ask'], ['auto', 'ask'], ['plan', 'block']];

describe('a third-party server with read-only annotations, under any name', () => {
  // The memory server's own name is included: without the app's marker it is just a definition.
  const ids = ['vocs_memory', 'vocs.memory', 'Vocs-Memory', 'vocs-memory', 'notes'];

  it.each(ids)('is never trusted as a read by the bridge (%s)', async (id) => {
    bridge = await stubPiMcpBridge([third(id)], annotatedTools);
    expect((await mcpReadOnlyToolNames()).size).toBe(0);
    expect((await loadMcpBridge()).every((tool) => tool.readOnly === false)).toBe(true);
  });

  for (const id of ids) {
    it.each(THIRD_PARTY)(`is gated like any third-party tool by the parent in %s mode (${id})`, async (mode, outcome) => {
      bridge = await stubPiMcpBridge([third(id)], annotatedTools);
      const tool = 'mcp__' + id.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '__knowledge_search';
      const select = vi.fn(async () => 'Deny');
      const result = await parentGate(mode)({ toolName: tool, toolCallId: 'c1', input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } });
      expect(result?.block).toBe(true);
      if (outcome === 'ask') {
        expect(select).toHaveBeenCalledTimes(1);
        expect(result?.reason).toBe(DECLINED_REASON);
      } else {
        expect(select).not.toHaveBeenCalled();
        expect(result?.reason).toBe(PLAN_REASON);
      }
      expect(bridge.calls).toEqual([]);
    });
  }
});

describe('the app-built memory server', () => {
  it('keeps its read-only tools trusted and its other tools gated', async () => {
    bridge = await stubPiMcpBridge([appMemoryDef()], annotatedTools);
    const readOnly = await mcpReadOnlyToolNames();
    expect([...readOnly]).toEqual(['mcp__vocs_memory__knowledge_search']);
    for (const mode of ['ask', 'auto', 'plan']) {
      const select = vi.fn(async () => 'Deny');
      const gate = parentGate(mode);
      await expect(gate({ toolName: 'mcp__vocs_memory__knowledge_search', input: {} }, { cwd: process.cwd(), ui: { select } })).resolves.toBeUndefined();
      const write = await gate({ toolName: 'mcp__vocs_memory__knowledge_propose', input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } });
      expect(write?.block).toBe(true);
      expect(select).toHaveBeenCalledTimes(mode === 'plan' ? 0 : 1);
    }
  });

  it('is the one memory server loaded when a third-party alias sits beside it', async () => {
    bridge = await stubPiMcpBridge([appMemoryDef(), third('vocs_memory'), third('Vocs.Memory')], annotatedTools);
    expect(await mcpToolNames()).toEqual(['mcp__vocs_memory__knowledge_search', 'mcp__vocs_memory__knowledge_propose']);
    expect(bridge.connected).toEqual(['vocs-memory']);
    expect([...(await mcpReadOnlyToolNames())]).toEqual(['mcp__vocs_memory__knowledge_search']);
  });
});

describe('reserved and duplicate names in the bridge', () => {
  it.each(['vocs_memory', 'Vocs-Memory', 'GitNexus', 'gitnexus', 'cua_driver'])('does not load a third-party server named %s', async (id) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge = await stubPiMcpBridge([third(id)], annotatedTools);
    expect(await mcpToolNames()).toEqual([]);
    expect(bridge.connected).toEqual([]);
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/reserved/i);
  });

  it('loads only the first of two servers whose tool names would collide', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge = await stubPiMcpBridge([third('my-server'), third('My_Server')], () => [{ name: 'lookup', inputSchema: { type: 'object' } }]);
    expect(await mcpToolNames()).toEqual(['mcp__my_server__lookup']);
    expect(bridge.connected).toEqual(['my-server']);
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/My_Server/);
  });

  it('registers one tool when a server lists two names that fold together', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge = await stubPiMcpBridge([third('notes')], () => [
      { name: 'get-item', inputSchema: { type: 'object' } },
      { name: 'Get.Item', inputSchema: { type: 'object' } }
    ]);
    const tools = await loadMcpBridge();
    expect(tools.map((t) => t.name)).toEqual(['mcp__notes__get_item']);
    expect(tools[0].label).toBe('notes: get-item');
  });
});

describe('the bridge mirrors the host name rules', () => {
  // pi loads the bridge on its own, so it carries copies; these pin them to the host's.
  it('reserves exactly the host built-in ids', () => {
    expect([...BUILTIN_SERVERS].sort()).toEqual([...MCP_BUILTIN_IDS].sort());
  });

  const names = [
    ...MCP_BUILTIN_IDS,
    'vocs_memory', 'vocs.memory', 'Vocs-Memory', 'VOCS__MEMORY', '_vocs-memory_', 'vocs-memory.', 'vocsmemory', 'vocs-memory-2',
    'GitNexus', 'gitnexus_', 'git-nexus', 'Git.Nexus', 'cua_driver', 'CUA.DRIVER', 'cua-driver-x', 'Vocs.Mission', 'vocs_missions',
    'notes', 'my-server', 'My_Server', 'a..b', 'A-B', '2server', 'x', 'x.', 'X_'
  ];

  it.each(names)('folds %s the way the host does', (name) => {
    expect(reservedKey(name)).toBe(mcpIdKey(name));
    expect(reservedBuiltinName(name)).toBe(reservedBuiltinFor(name));
  });
});
