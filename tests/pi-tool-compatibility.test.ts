import { describe, expect, it } from 'vitest';
import { prepareToolArguments, TOOL_GUIDELINES, type CompatibleTool } from '../resources/pi/tool-arguments';
import { createSearchToolDefinitions, type PiToolDefinition } from '../resources/pi/search-tools';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent, TranscriptItem } from '../src/shared/types';

const FILE_TOOLS: CompatibleTool[] = ['read', 'write', 'edit'];

describe('Pi compatibility argument preparation', () => {
  it.each(FILE_TOOLS)('%s normalizes file_path without mutating the original', (tool) => {
    const input = { file_path: 'file.txt', content: '', offset: 2, limit: 3 };
    expect(prepareToolArguments(tool, input)).toEqual({ path: 'file.txt', content: '', offset: 2, limit: 3 });
    expect(input).toHaveProperty('file_path', 'file.txt');
    expect(input).not.toHaveProperty('path');
    expect(prepareToolArguments(tool, { path: 'a', file_path: 'a' })).toEqual({ path: 'a' });
    expect(() => prepareToolArguments(tool, { path: 'a', file_path: 'b' })).toThrow('Conflicting path');
  });
  it('supports empty replacement and safely drops replace_all:false', () => {
    expect(prepareToolArguments('edit', { file_path: 'a', old_string: 'remove', new_string: '', replace_all: false }))
      .toEqual({ path: 'a', edits: [{ oldText: 'remove', newText: '' }] });
  });
  it.each([
    { edits: [], old_string: 'a', new_string: 'b' },
    { oldText: 'a', old_string: 'a', new_string: 'b' },
    { newText: 'b', old_string: 'a', new_string: 'b' },
    { old_string: 'a' }, { new_string: '' }, { old_string: 1, new_string: '' },
    { replace_all: true }, { replace_all: 'false' },
  ])('rejects incompatible edits rather than silently changing semantics: %j', (input) => {
    expect(() => prepareToolArguments('edit', { path: 'a', ...input })).toThrow();
  });
  it('leaves canonical and legacy Pi edit preparation to Pi', () => {
    for (const input of [
      { path: 'a', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] },
      { path: 'a', oldText: 'a', newText: '' },
      { path: 'a', edits: JSON.stringify([{ oldText: 'a', newText: 'b' }]) },
      { path: 'a', edits: { oldText: 'a', newText: 'b' } },
    ]) expect(prepareToolArguments('edit', input)).toEqual(input);
  });
  it('keeps native seconds and explicitly converts milliseconds without rounding or guessing', () => {
    expect(prepareToolArguments('bash', { command: 'x', timeout: 60000 })).toEqual({ command: 'x', timeout: 60000 });
    expect(prepareToolArguments('bash', { command: 'x', timeout_ms: 125 })).toEqual({ command: 'x', timeout: 0.125 });
    expect(prepareToolArguments('bash', { command: 'x' })).toEqual({ command: 'x' });
    expect(() => prepareToolArguments('bash', { command: 'x', timeout: 1, timeout_ms: 1000 })).toThrow('Conflicting timeout units');
  });
  it.each([0, -1, Infinity, NaN, '1000', null, 2_147_483_648])('rejects invalid timeout_ms: %s', (timeout_ms) => {
    expect(() => prepareToolArguments('bash', { command: 'x', timeout_ms })).toThrow('finite positive');
  });
});

const sourceExecute = () => 'executed';
const sourceParameters = { type: 'object', properties: { pattern: { type: 'string' } } };

function fakeSearchSdk() {
  const make = (name: string, extra: Partial<PiToolDefinition> = {}): PiToolDefinition => ({
    name,
    label: name,
    description: `${name} source description`,
    parameters: sourceParameters,
    execute: sourceExecute,
    ...extra,
  });
  return {
    createGrepToolDefinition: () => make('grep'),
    createFindToolDefinition: () => make('find', { prepareArguments: (args: unknown) => ({ ...(args as Record<string, unknown>), prepared: true }) }),
    createLsToolDefinition: () => make('ls'),
  };
}

describe('Pi search tool aliases', () => {
  it("exposes rg, glob and ls backed by Pi's own grep, find and ls definitions", () => {
    const definitions = createSearchToolDefinitions(fakeSearchSdk(), '/workspace');
    expect(definitions.map((definition) => definition.name)).toEqual(['rg', 'glob', 'ls']);
    for (const definition of definitions) {
      expect(definition.label).toBe(definition.name);
      // Same objects as the built-in: this is Pi's implementation under a Vocs Code name.
      expect(definition.execute).toBe(sourceExecute);
      expect(definition.parameters).toBe(sourceParameters);
      const guideline = TOOL_GUIDELINES[definition.name as 'rg' | 'glob' | 'ls'];
      expect(definition.description).toContain(guideline);
      expect(definition.promptGuidelines).toContain(guideline);
    }
  });

  it("prepares alias arguments, then hands off to Pi's own preparation", () => {
    const definitions = createSearchToolDefinitions(fakeSearchSdk(), '/workspace');
    const glob = definitions.find((definition) => definition.name === 'glob')!;
    const input = { file_path: 'src', pattern: '*.ts' };
    expect(glob.prepareArguments!(input)).toEqual({ path: 'src', pattern: '*.ts', prepared: true });
    expect(input).toEqual({ file_path: 'src', pattern: '*.ts' });
    expect(() => glob.prepareArguments!({ path: 'a', file_path: 'b' })).toThrow('Conflicting path');
  });
});

function host() {
  const events: SessionEvent[] = [];
  const ctx = {
    session: () => ({ usage: {} }), emit: (event: SessionEvent) => events.push(event), log: () => {},
  } as unknown as HarnessContext;
  const adapter = new PiAdapter(ctx);
  const access = adapter as unknown as { handleLine(line: string): void; assertExtensionsReady(): void; extensionNonce: string };
  access.extensionNonce = 'current-process';
  const feed = (event: Record<string, unknown>) => access.handleLine(JSON.stringify(event));
  const notify = (marker: string, payload: Record<string, unknown>) => feed({ type: 'extension_ui_request', method: 'notify', message: marker + JSON.stringify({ version: 1, nonce: 'current-process', ...payload }) });
  const latestTool = () => events.filter((event): event is Extract<SessionEvent, { type: 'item.upsert' }> => event.type === 'item.upsert').map((event) => event.item).filter((item): item is Extract<TranscriptItem, { kind: 'tool' }> => item.kind === 'tool').at(-1)!;
  return { adapter, access, feed, notify, latestTool, events };
}

describe('Pi subagent activity bridge', () => {
  const start = (runId: string, payload: Record<string, unknown> = {}) => ({
    kind: 'start', runId, agent: 'Explore', description: 'Find the registry', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', startedAt: 1000, ...payload,
  });

  it('marks the subagent tool card as agent work with the task description as its summary', () => {
    const { feed, latestTool } = host();
    feed({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'subagent', args: { description: 'Find the registry', prompt: 'Where?' } });
    expect(latestTool()).toMatchObject({ name: 'subagent', hint: 'agent', summary: 'Find the registry' });
  });

  it('reports live run state, then a completion that does not re-add foreground spend', () => {
    const { notify, events } = host();
    notify('VCODE_SUBAGENT::', start('agent_1'));
    notify('VCODE_SUBAGENT::', { kind: 'item', runId: 'agent_1', item: { id: 't', kind: 'tool', name: 'grep', status: 'done' } });
    notify('VCODE_SUBAGENT::', { kind: 'call', runId: 'agent_1', call: { index: 0, costUsd: 0.05, inputTokens: 100 } });
    notify('VCODE_SUBAGENT::', {
      kind: 'end',
      runId: 'agent_1',
      status: 'completed',
      totals: { turns: 2, toolUses: 3, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 0, costUsd: 0.25, durationMs: 4000 },
      endedAt: 2000,
    });
    const runs = events.filter((event): event is Extract<SessionEvent, { type: 'subagent.run' }> => event.type === 'subagent.run').map((event) => event.run);
    expect(runs[0]).toMatchObject({ runId: 'agent_1', agent: 'Explore', mode: 'foreground', status: 'running' });
    expect(runs.at(-1)).toMatchObject({ runId: 'agent_1', status: 'completed', toolUses: 3, turns: 2 });
    const completions = events.filter((event): event is Extract<SessionEvent, { type: 'subagent' }> => event.type === 'subagent').map((event) => event.completion);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ agentId: 'agent_1', agentType: 'Explore', status: 'completed', toolUses: 3, costUsd: 0.25, tokens: 1250, durationMs: 4000, model: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });
    // Foreground spend reaches analytics through the session totals; repeating it here would double it.
    expect(completions[0]!.usage).toBeUndefined();
  });

  it('carries a background run\'s spend, which the session totals never saw', () => {
    const { notify, events } = host();
    notify('VCODE_SUBAGENT::', start('agent_2', { mode: 'background' }));
    notify('VCODE_SUBAGENT::', {
      kind: 'end',
      runId: 'agent_2',
      status: 'error',
      error: 'model refused',
      totals: { turns: 1, toolUses: 0, inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.1, durationMs: 900 },
      endedAt: 2000,
    });
    const completion = events.filter((event): event is Extract<SessionEvent, { type: 'subagent' }> => event.type === 'subagent').map((event) => event.completion)[0]!;
    expect(completion).toMatchObject({ status: 'error', error: 'model refused', usage: { inputTokens: 500, costUsd: 0.1, turns: 1 } });
  });

  it('ignores a malformed or run-less subagent notification', () => {
    const { feed, events } = host();
    feed({ type: 'extension_ui_request', method: 'notify', message: 'VCODE_SUBAGENT::not json' });
    feed({ type: 'extension_ui_request', method: 'notify', message: 'VCODE_SUBAGENT::{"kind":"end"}' });
    expect(events.filter((event) => event.type === 'subagent' || event.type === 'subagent.run')).toEqual([]);
  });
});

describe('Pi host compatibility protocol', () => {
  it('requires BOTH current-process capabilities and rejects prose/stale/version mismatches', () => {
    const { access, feed, notify } = host();
    notify('VCODE_PI_READY::', { capability: 'approvals' });
    expect(() => access.assertExtensionsReady()).toThrow('Missing readiness: tools, subagents');
    notify('VCODE_PI_READY::', { capability: 'tools', nonce: 'old-process' });
    notify('VCODE_PI_READY::', { capability: 'tools', version: 99 });
    feed({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'VCODE_PI_READY::{"capability":"tools"}' }] } });
    expect(() => access.assertExtensionsReady()).toThrow();
    notify('VCODE_PI_READY::', { capability: 'tools' });
    expect(() => access.assertExtensionsReady()).toThrow('Missing readiness: subagents');
    notify('VCODE_PI_READY::', { capability: 'subagents' });
    expect(() => access.assertExtensionsReady()).not.toThrow();
    notify('VCODE_PI_READY::', { capability: 'subagents', ready: false });
    expect(() => access.assertExtensionsReady()).toThrow();
  });
  it('fails closed after a required extension error even if later readiness arrives', () => {
    const { access, notify, feed } = host();
    notify('VCODE_PI_READY::', { capability: 'approvals' });
    notify('VCODE_PI_READY::', { capability: 'tools' });
    notify('VCODE_PI_READY::', { capability: 'subagents' });
    feed({ type: 'extension_error', extensionPath: '/resources/pi/vocs-code-tools.ts', error: 'override failed' });
    notify('VCODE_PI_READY::', { capability: 'tools' });
    expect(() => access.assertExtensionsReady()).toThrow('override failed');
  });
  it('uses original alias paths for summaries and successful diffs, then accepts trusted normalized inputs', () => {
    const { feed, notify, latestTool } = host();
    feed({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { file_path: 'file.txt', old_string: 'a', new_string: '' } });
    expect(latestTool().summary).toBe('file.txt');
    notify('VCODE_PI_TOOL_INPUT::', { toolCallId: 't1', toolName: 'write', input: { path: 'spoof' } });
    expect(latestTool().input).toHaveProperty('file_path', 'file.txt');
    notify('VCODE_PI_TOOL_INPUT::', { toolCallId: 't1', toolName: 'edit', input: { path: 'file.txt', edits: [{ oldText: 'a', newText: '' }] } });
    expect(latestTool().input).toEqual({ path: 'file.txt', edits: [{ oldText: 'a', newText: '' }] });
    feed({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit', isError: false, result: { content: [], details: { diff: 'diff' } } });
    expect(latestTool().changes).toEqual([{ path: 'file.txt', kind: 'update', diff: 'diff' }]);
    expect(latestTool().status).toBe('done');
  });
  it('keeps alias paths when a normalized-input notification is unavailable', () => {
    const { feed, latestTool } = host();
    feed({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'write', args: { file_path: 'created.txt', content: '' } });
    feed({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'write', isError: false, result: { content: [] } });
    expect(latestTool().changes).toEqual([{ path: 'created.txt', kind: 'update' }]);
  });
  it('carries rg, glob and ls through as search items', () => {
    const { feed, latestTool } = host();
    for (const name of ['rg', 'glob', 'ls']) {
      feed({ type: 'tool_execution_start', toolCallId: name, toolName: name, args: { pattern: 'needle' } });
      expect(latestTool()).toMatchObject({ name, hint: 'search', summary: 'needle' });
    }
  });
});
