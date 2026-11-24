/**
 * Which MCP tools pi's gate may treat as reads. Only a tool on the built-in read-only allowlist, of a
 * definition the app itself built for that built-in server (vocs-memory, gitnexus, cua-driver),
 * carries that trust; a server name, a label or a tool annotation never does. The
 * parent approvals extension decides through the real bridge here, so these are execution-level:
 * a tool the gate should have asked about or blocked must not run.
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vocsCodeApprovals from '../resources/pi/vocs-code-approvals';
import { DECLINED_REASON, PLAN_REASON } from '../resources/pi/subagent-gate';
import { BUILTIN_READ_ONLY_TOOLS, BUILTIN_SERVERS, MISSION_TOOLS, loadMcpBridge, mcpReadOnlyToolNames, mcpToolNames, reservedBuiltinName, reservedKey } from '../resources/pi/vocs-code-mcp';
import { MCP_BUILTIN_IDS } from '../src/shared/types';
import { BUILTIN_MISSION_TOOLS as HOST_MISSION_TOOLS, BUILTIN_READ_ONLY_TOOLS as HOST_READ_ONLY_TOOLS } from '../src/shared/builtin-tools';
import { missionServerDef } from '../src/main/mcp/mission';
import { gitnexusBaseDef } from '../src/main/mcp/gitnexus';
import type { PiMcpTool } from '../resources/pi/mcp-client';
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

/** Expected decisions for an ordinary third-party MCP tool, per the tier contract. */
const THIRD_PARTY: [mode: string, outcome: 'ask' | 'block' | 'run'][] = [['ask', 'ask'], ['accept-edits', 'ask'], ['auto', 'run'], ['plan', 'block']];

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
      if (outcome === 'run') {
        expect(result).toBeUndefined();
        expect(select).not.toHaveBeenCalled();
        return;
      }
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
      // A built-in's other tools follow the tier like a third-party tool: they run in auto.
      expect(write?.block).toBe(mode === 'auto' ? undefined : true);
      expect(select).toHaveBeenCalledTimes(mode === 'ask' ? 1 : 0);
    }
  });

  it('is the one memory server loaded when a third-party alias sits beside it', async () => {
    bridge = await stubPiMcpBridge([appMemoryDef(), third('vocs_memory'), third('Vocs.Memory')], annotatedTools);
    expect(await mcpToolNames()).toEqual(['mcp__vocs_memory__knowledge_search', 'mcp__vocs_memory__knowledge_propose']);
    expect(bridge.connected).toEqual(['vocs-memory']);
    expect([...(await mcpReadOnlyToolNames())]).toEqual(['mcp__vocs_memory__knowledge_search']);
  });
});

/** What the app-built code-graph and computer-use servers list: reads, and tools that change things. */
function builtinTools(serverId: string): PiMcpTool[] {
  const tool = (name: string, readOnly?: boolean): PiMcpTool => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, ...(readOnly === undefined ? {} : { readOnly }) });
  if (serverId === 'gitnexus') return [tool('query'), tool('context'), tool('rename', true), tool('cypher')];
  if (serverId === 'cua-driver') return [tool('get_window_state', false), tool('list_windows'), tool('click'), tool('type_text', true)];
  return [tool('query', true), tool('get_window_state', true), tool('knowledge_search', true)];
}

/** The definition the app hands pi for its own Cua Driver server (the host sets `builtin`). */
const appCuaDef = () => ({ id: 'cua-driver', transport: 'stdio', command: 'cua-driver', args: ['mcp'], builtin: 'cua-driver' });

describe('the app-built gitnexus and cua-driver servers', () => {
  it('trusts exactly the allowlisted read-only tools, whatever the server annotates', async () => {
    bridge = await stubPiMcpBridge([gitnexusBaseDef(), appCuaDef()], builtinTools);
    // `rename` and `type_text` claim readOnly; `get_window_state` denies it. The allowlist decides.
    expect([...(await mcpReadOnlyToolNames())].sort()).toEqual([
      'mcp__cua_driver__get_window_state', 'mcp__cua_driver__list_windows', 'mcp__gitnexus__context', 'mcp__gitnexus__query'
    ]);
  });

  it.each(['plan', 'ask', 'accept-edits', 'auto'])('runs a read-only gitnexus or cua tool without asking in %s mode', async (mode) => {
    bridge = await stubPiMcpBridge([gitnexusBaseDef(), appCuaDef()], builtinTools);
    const select = vi.fn(async () => 'Deny');
    const gate = parentGate(mode);
    for (const toolName of ['mcp__gitnexus__query', 'mcp__gitnexus__context', 'mcp__cua_driver__get_window_state', 'mcp__cua_driver__list_windows']) {
      await expect(gate({ toolName, toolCallId: toolName, input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } })).resolves.toBeUndefined();
    }
    expect(select).not.toHaveBeenCalled();
  });

  const changing: [mode: string, outcome: 'ask' | 'block' | 'run'][] = [['plan', 'block'], ['ask', 'ask'], ['accept-edits', 'ask'], ['auto', 'run'], ['full-auto', 'run']];
  it.each(changing)('gates gitnexus rename and cua click like any tool in %s mode (%s)', async (mode, outcome) => {
    bridge = await stubPiMcpBridge([gitnexusBaseDef(), appCuaDef()], builtinTools);
    const select = vi.fn(async () => 'Deny');
    const gate = parentGate(mode);
    for (const toolName of ['mcp__gitnexus__rename', 'mcp__gitnexus__cypher', 'mcp__cua_driver__click', 'mcp__cua_driver__type_text']) {
      const result = await gate({ toolName, toolCallId: toolName, input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } });
      if (outcome === 'run') expect(result).toBeUndefined();
      else expect(result).toEqual({ block: true, reason: outcome === 'block' ? PLAN_REASON : DECLINED_REASON });
    }
    expect(select).toHaveBeenCalledTimes(outcome === 'ask' ? 4 : 0);
    expect(bridge.calls).toEqual([]);
  });

  it('gives no trust to a server that only claims a built-in identity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A lookalike name without the host's marker is refused; a marker on another id grants nothing.
    bridge = await stubPiMcpBridge([
      third('vocs-memory'), third('gitnexus'), third('cua-driver'),
      { ...third('notes'), builtin: 'gitnexus' },
      { ...third('tools'), builtin: 'cua-driver' }
    ], builtinTools);
    expect((await mcpReadOnlyToolNames()).size).toBe(0);
    expect(bridge.connected).toEqual(['notes', 'tools']);
    const select = vi.fn(async () => 'Deny');
    const plan = parentGate('plan');
    for (const toolName of ['mcp__notes__query', 'mcp__notes__get_window_state', 'mcp__tools__knowledge_search']) {
      await expect(plan({ toolName, toolCallId: toolName, input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } })).resolves.toEqual({ block: true, reason: PLAN_REASON });
    }
    const ask = parentGate('ask');
    await expect(ask({ toolName: 'mcp__notes__query', toolCallId: 'q', input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } })).resolves.toEqual({ block: true, reason: DECLINED_REASON });
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('the app-built Mission server', () => {
  /** The definition the app hands pi for a mission session (the host sets `builtin`). */
  const appMissionDef = () => {
    const def = missionServerDef({ missionServerPath: '/app/resources/mcp/vocs-mission.mjs', attachment: { url: 'http://127.0.0.1:9', token: 'M'.repeat(43) } });
    if (!def) throw new Error('Mission definition was not built');
    // The stub hands definitions over in the config file, which may never carry a capability.
    return { ...def, env: {} };
  };
  const missionTools = (): PiMcpTool[] => ['start_builder', 'ask_lead', 'delete_repo'].map((name) => ({ name, inputSchema: { type: 'object', properties: {} } }));

  it.each(['plan', 'ask', 'accept-edits', 'auto'])('runs its coordination tools without asking in %s mode, and gates anything else it lists', async (mode) => {
    bridge = await stubPiMcpBridge([appMissionDef()], missionTools);
    expect([...(await mcpReadOnlyToolNames())].sort()).toEqual(['mcp__vocs_mission__ask_lead', 'mcp__vocs_mission__start_builder']);
    const select = vi.fn(async () => 'Deny');
    const gate = parentGate(mode);
    for (const toolName of ['mcp__vocs_mission__start_builder', 'mcp__vocs_mission__ask_lead']) {
      await expect(gate({ toolName, toolCallId: toolName, input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } })).resolves.toBeUndefined();
    }
    const other = await gate({ toolName: 'mcp__vocs_mission__delete_repo', toolCallId: 'd', input: {} }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } });
    expect(other?.block).toBe(mode === 'auto' ? undefined : true);
    expect(select).toHaveBeenCalledTimes(mode === 'ask' || mode === 'accept-edits' ? 1 : 0);
  });

  it('gives no trust to a lookalike: a reserved alias is refused, provenance on another id grants nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bridge = await stubPiMcpBridge([third('vocs-mission'), third('Vocs_Mission'), { ...third('notes'), builtin: 'vocs-mission' }], missionTools);
    expect((await mcpReadOnlyToolNames()).size).toBe(0);
    expect(bridge.connected).toEqual(['notes']);
    await expect(parentGate('plan')({ toolName: 'mcp__notes__start_builder', toolCallId: 's', input: {} }, { cwd: process.cwd(), ui: { select: vi.fn(), notify: vi.fn() } })).resolves.toEqual({ block: true, reason: PLAN_REASON });
  });
});

describe('reserved and duplicate names in the bridge', () => {
  it.each(['vocs_memory', 'Vocs-Memory', 'GitNexus', 'gitnexus', 'cua_driver', 'vocs_mission', 'Vocs.Mission'])('does not load a third-party server named %s', async (id) => {
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

  it('trusts exactly the host read-only allowlist', () => {
    expect(BUILTIN_READ_ONLY_TOOLS).toEqual(HOST_READ_ONLY_TOOLS);
  });

  it('trusts exactly the host Mission coordination tools', () => {
    expect(MISSION_TOOLS).toEqual(HOST_MISSION_TOOLS);
  });

  const names = [
    ...MCP_BUILTIN_IDS,
    'vocs_memory', 'vocs.memory', 'Vocs-Memory', 'VOCS__MEMORY', '_vocs-memory_', 'vocs-memory.', 'vocsmemory', 'vocs-memory-2',
    'GitNexus', 'gitnexus_', 'git-nexus', 'Git.Nexus', 'cua_driver', 'CUA.DRIVER', 'cua-driver-x', 'Vocs.OpenRouter', 'vocs_openrouters',
    'notes', 'my-server', 'My_Server', 'a..b', 'A-B', '2server', 'x', 'x.', 'X_'
  ];

  it.each(names)('folds %s the way the host does', (name) => {
    expect(reservedKey(name)).toBe(mcpIdKey(name));
    expect(reservedBuiltinName(name)).toBe(reservedBuiltinFor(name));
  });
});
