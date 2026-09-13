import { describe, expect, it } from 'vitest';
import { prepareToolArguments, type CompatibleTool } from '../resources/pi/tool-arguments';
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
  return { adapter, access, feed, notify, latestTool };
}

describe('Pi host compatibility protocol', () => {
  it('requires BOTH current-process capabilities and rejects prose/stale/version mismatches', () => {
    const { access, feed, notify } = host();
    notify('VCODE_PI_READY::', { capability: 'approvals' });
    expect(() => access.assertExtensionsReady()).toThrow('Missing readiness: tools');
    notify('VCODE_PI_READY::', { capability: 'tools', nonce: 'old-process' });
    notify('VCODE_PI_READY::', { capability: 'tools', version: 99 });
    feed({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'VCODE_PI_READY::{"capability":"tools"}' }] } });
    expect(() => access.assertExtensionsReady()).toThrow();
    notify('VCODE_PI_READY::', { capability: 'tools' });
    expect(() => access.assertExtensionsReady()).not.toThrow();
    notify('VCODE_PI_READY::', { capability: 'tools', ready: false });
    expect(() => access.assertExtensionsReady()).toThrow();
  });
  it('fails closed after a required extension error even if later readiness arrives', () => {
    const { access, notify, feed } = host();
    notify('VCODE_PI_READY::', { capability: 'approvals' });
    notify('VCODE_PI_READY::', { capability: 'tools' });
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
});
