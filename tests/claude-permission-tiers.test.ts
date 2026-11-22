/**
 * The Vocs Code tier contract at the Claude SDK boundary: what the PreToolUse hook and canUseTool
 * return, what reaches requestApproval, and which SDK options / setPermissionMode calls are made.
 * The hook runs on every call in every session, so a Claude settings allow rule (which skips
 * canUseTool) can no longer skip the tier.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanUseTool, HookCallback, HookJSONOutput, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ResolvedServer } from '../src/main/mcp/effective';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import type { ApprovalDecision, PermissionMode, SessionEvent } from '../src/shared/types';
import { AsyncQueue } from '../src/main/util/async';
import { PLAN_MODE_DENIAL } from '../src/main/harness/permissions';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter } from '../src/main/harness/claude';

let ROOT = '';
let OUTSIDE = '';
beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-claude-tiers-'));
  ROOT = path.join(base, 'project');
  OUTSIDE = path.join(base, 'outside');
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(OUTSIDE, { recursive: true });
  // A junction (Windows) / directory symlink inside the project that leads out of it.
  await fs.symlink(OUTSIDE, path.join(ROOT, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
});
afterAll(async () => {
  if (ROOT) await fs.rm(path.dirname(ROOT), { recursive: true, force: true });
});

const adapters: ClaudeAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  queryMock.mockReset();
});

const builtin = (id: string): ResolvedServer => ({ def: { id, transport: 'stdio', command: 'node', builtin: id } as ResolvedServer['def'], missing: [], secretEnvKeys: [], secretHeaderKeys: [] });
const thirdParty: ResolvedServer = { def: { id: 'github', transport: 'stdio', command: 'gh-mcp' } as ResolvedServer['def'], missing: [], secretEnvKeys: [], secretHeaderKeys: [] };

async function makeAdapter(initial: PermissionMode, decision: ApprovalDecision = { optionId: 'allow' }) {
  let mode = initial;
  const events: SessionEvent[] = [];
  const requestApproval = vi.fn(async (_draft: ApprovalDraft) => decision);
  const messages = new AsyncQueue<SDKMessage>();
  const setPermissionMode = vi.fn(async (_mode: string) => undefined);
  queryMock.mockReturnValue({ [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close(), setPermissionMode });
  const ctx = {
    sessionId: 'claude-tiers',
    sessionDir: ROOT,
    session: () => ({ cwd: ROOT, config: { harness: 'claude', projectRoot: ROOT, permissionMode: mode }, harnessRef: {}, usage: {} }),
    settings: () => ({ claude: { settingSources: [], useProviderKey: false }, providers: [] }),
    runtime: { resolve: () => ({ path: process.execPath, source: 'system' }) },
    permissionMode: () => mode,
    effort: () => undefined,
    getApiKey: async () => undefined,
    mcpServers: async () => [builtin('vocs-memory'), thirdParty],
    emit: (event: SessionEvent) => events.push(event),
    requestApproval,
    updateRef: vi.fn(),
    updateMeta: vi.fn(),
    log: vi.fn()
  } as unknown as HarnessContext;
  const adapter = new ClaudeAdapter(ctx);
  adapters.push(adapter);
  await adapter.start();
  const options = (queryMock.mock.calls.at(-1)![0] as { options: Options }).options;
  const canUseTool = options.canUseTool as CanUseTool;
  const hook = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
  let n = 0;
  const pre = (tool: string, input: Record<string, unknown>, server?: { name: string; source: string }): Promise<HookJSONOutput> =>
    hook({ hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd: ROOT, tool_name: tool, tool_input: input, tool_use_id: `tu-${++n}`, ...(server ? { mcp_server: server } : {}) } as Parameters<HookCallback>[0], `tu-${n}`, { signal: new AbortController().signal });
  const use = (tool: string, input: Record<string, unknown>, server?: { name: string; source: string }): Promise<PermissionResult> =>
    canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: `cu-${++n}`, requestId: `r-${n}`, ...(server ? { mcpServer: server } : {}) } as Parameters<CanUseTool>[2]) as Promise<PermissionResult>;
  /** The decision the hook hands Claude Code; `undefined` means it left the call to Claude's own pipeline. */
  const decide = async (tool: string, input: Record<string, unknown>, server?: { name: string; source: string }) => {
    const out = await pre(tool, input, server) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return out.hookSpecificOutput?.permissionDecision;
  };
  return { adapter, options, pre, use, decide, requestApproval, setPermissionMode, events, setMode: (next: PermissionMode) => { mode = next; } };
}

const MEMORY = { name: 'vocs-memory', source: 'dynamic' };
const GITHUB = { name: 'github', source: 'dynamic' };
const inside = () => ({ file_path: path.join(ROOT, 'src', 'a.ts'), old_string: 'a', new_string: 'b' });

describe('Claude tier contract: PreToolUse re-gates every call in ordinary sessions', () => {
  it.each<[PermissionMode, string, Record<string, unknown>, string]>([
    ['plan', 'Read', { file_path: path.join(ROOT, 'a.ts') }, 'allow'],
    ['plan', 'Edit', inside(), 'deny'],
    ['plan', 'Bash', { command: 'npm test' }, 'deny'],
    ['ask', 'Edit', inside(), 'ask'],
    ['ask', 'Bash', { command: 'npm test' }, 'ask'],
    ['accept-edits', 'Edit', inside(), 'allow'],
    ['accept-edits', 'Bash', { command: 'npm test' }, 'ask'],
    ['auto', 'Bash', { command: 'npm test' }, 'allow'],
    ['auto', 'Bash', { command: 'rm -rf /' }, 'ask'],
    ['full-auto', 'Bash', { command: 'rm -rf /' }, 'allow']
  ])('%s: %s %j → %s', async (mode, tool, input, expected) => {
    const { decide, requestApproval } = await makeAdapter(mode);
    await expect(decide(tool, input)).resolves.toBe(expected);
    // The hook never prompts itself; 'ask' is answered by the one canUseTool card.
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('denies in Plan with the Plan denial text', async () => {
    const { pre } = await makeAdapter('plan');
    await expect(pre('Write', { file_path: path.join(ROOT, 'x.ts'), content: '' })).resolves.toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PLAN_MODE_DENIAL }
    });
  });

  it('a call a Claude allow rule would pass still gets exactly one approval card in Ask', async () => {
    const { decide, use, requestApproval } = await makeAdapter('ask');
    // Hook 'ask' makes Claude Code call canUseTool even when a settings rule allows the tool.
    await expect(decide('Bash', { command: 'git push' })).resolves.toBe('ask');
    await expect(use('Bash', { command: 'git push' })).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({ kind: 'command', command: 'git push' });
  });

  it('leaves session-control tools to Claude Code (AskUserQuestion still reaches canUseTool for its answers)', async () => {
    const { pre } = await makeAdapter('plan');
    await expect(pre('AskUserQuestion', { questions: [] })).resolves.toEqual({ continue: true });
    await expect(pre('Agent', { prompt: 'explore', subagent_type: 'Explore' })).resolves.toEqual({ continue: true });
  });
});

describe('Claude tier contract: MCP tools', () => {
  it.each<PermissionMode>(['plan', 'ask', 'accept-edits', 'auto', 'full-auto'])('runs built-in read-only tools without asking in %s', async (mode) => {
    const { decide, use, requestApproval } = await makeAdapter(mode);
    await expect(decide('mcp__vocs-memory__knowledge_search', { query: 'x' }, MEMORY)).resolves.toBe('allow');
    await expect(use('mcp__vocs-memory__knowledge_search', { query: 'x' }, MEMORY)).resolves.toEqual({ behavior: 'allow', updatedInput: { query: 'x' } });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('canUseTool also runs a built-in read-only tool in Plan (a Claude ask rule can route it there)', async () => {
    const { use, requestApproval } = await makeAdapter('plan');
    await expect(use('mcp__vocs-memory__knowledge_read', { page: 'x' }, MEMORY)).resolves.toEqual({ behavior: 'allow', updatedInput: { page: 'x' } });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('treats a built-in tool off the read-only list, or a lookalike server, as third-party', async () => {
    const { decide } = await makeAdapter('plan');
    await expect(decide('mcp__vocs-memory__knowledge_propose', { title: 'x' }, MEMORY)).resolves.toBe('deny');
    // A user-scope server reusing the built-in name gets no read-only trust.
    await expect(decide('mcp__vocs-memory__knowledge_search', { query: 'x' }, { name: 'vocs-memory', source: 'user' })).resolves.toBe('deny');
  });

  it.each<[PermissionMode, string]>([['plan', 'deny'], ['ask', 'ask'], ['accept-edits', 'ask'], ['auto', 'allow'], ['full-auto', 'allow']])('third-party MCP in %s → %s', async (mode, expected) => {
    const { decide } = await makeAdapter(mode);
    await expect(decide('mcp__github__create_issue', { title: 'x' }, GITHUB)).resolves.toBe(expected);
  });
});

describe('Claude tier contract: outside the project', () => {
  it('asks for an edit that escapes the project through a junction, even in Accept edits', async () => {
    const { decide, use, requestApproval } = await makeAdapter('accept-edits');
    const input = { file_path: path.join(ROOT, 'escape', 'leak.txt'), content: 'x' };
    await expect(decide('Write', input)).resolves.toBe('ask');
    await use('Write', input);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0].description).toContain('(outside the project directory)');
  });

  it('canUseTool resolves the real path: a junction escape is not an in-project edit', async () => {
    const { use, requestApproval } = await makeAdapter('accept-edits', { optionId: 'deny' });
    const input = { file_path: path.join(ROOT, 'escape', 'leak.txt'), content: 'x' };
    await expect(use('Write', input)).resolves.toEqual({ behavior: 'deny', message: 'The user declined this action.' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('runs that edit in Full access', async () => {
    const { decide } = await makeAdapter('full-auto');
    await expect(decide('Write', { file_path: path.join(ROOT, 'escape', 'leak.txt'), content: 'x' })).resolves.toBe('allow');
  });

  it('"Allow for session" never covers an outside-project edit and is never forwarded to Claude', async () => {
    const { use, requestApproval } = await makeAdapter('ask', { optionId: 'allow_session' });
    const result = await use('Write', { file_path: path.join(ROOT, 'escape', 'leak.txt'), content: 'x' });
    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: path.join(ROOT, 'escape', 'leak.txt'), content: 'x' } });
    await use('Write', { file_path: path.join(ROOT, 'escape', 'leak.txt'), content: 'y' });
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });
});

describe('Claude tier contract: tier changes apply live', () => {
  it('never starts the CLI in bypassPermissions, and never with the bypass capability', async () => {
    const { options } = await makeAdapter('full-auto');
    expect(options.permissionMode).toBe('default');
    expect(options.allowDangerouslySkipPermissions).not.toBe(true);
  });

  it('hands the live switch to Full access to the running CLI, with no restart warning', async () => {
    const { adapter, setPermissionMode, events, setMode } = await makeAdapter('ask');
    setMode('full-auto');
    await adapter.setPermissionMode('full-auto');
    expect(setPermissionMode).toHaveBeenCalledTimes(1);
    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(JSON.stringify(events)).not.toContain('restart');
  });

  it('switches to Full access and back to Plan without a restart', async () => {
    const { adapter, decide, setPermissionMode, events, setMode } = await makeAdapter('ask');
    await expect(decide('Bash', { command: 'rm -rf /' })).resolves.toBe('ask');
    setMode('full-auto');
    await adapter.setPermissionMode('full-auto');
    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(JSON.stringify(events)).not.toContain('restart');
    await expect(decide('Bash', { command: 'rm -rf /' })).resolves.toBe('allow');
    setMode('plan');
    await adapter.setPermissionMode('plan');
    expect(setPermissionMode).toHaveBeenLastCalledWith('plan');
    await expect(decide('Bash', { command: 'ls' })).resolves.toBe('deny');
  });

  it('clears "Allow for session" grants on any tier change', async () => {
    const { adapter, decide, use, setMode } = await makeAdapter('ask', { optionId: 'allow_session' });
    await use('Bash', { command: 'npm test' });
    await expect(decide('Bash', { command: 'npm test' })).resolves.toBe('allow');
    setMode('accept-edits');
    await adapter.setPermissionMode('accept-edits');
    await expect(decide('Bash', { command: 'npm test' })).resolves.toBe('ask');
  });
});
