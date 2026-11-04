import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverChatImports } from '../src/main/chat-import';

let fixture: string;
const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-06-01T12:00:00.000Z';
const cwd = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app';

beforeEach(async () => { fixture = await mkdtemp(path.join(tmpdir(), 'vocs-codex-lineage-')); });
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

function meta(id: string, extra: Record<string, unknown> = {}) {
  return { type: 'session_meta', timestamp, payload: { id, timestamp, cwd, source: 'cli', history_mode: 'paginated', ...extra } };
}
function message(role: 'user' | 'assistant', text: string) {
  return { type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
}
function encode(records: unknown[]) { return records.map((record) => JSON.stringify(record)).join('\n') + '\n'; }
async function rollout(name: string, records: unknown[]) {
  const filename = path.join(fixture, 'sessions/2026/06/01', `rollout-${name}.jsonl`);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, encode(records));
}
function base(extra: Record<string, unknown> = {}) {
  return { thread_id: parentId, end_ordinal_exclusive: 3, end_byte_offset: 1000, ...extra };
}

describe('Codex inherited rollout safety', () => {
  it('refuses a discovered child suffix rather than silently importing incomplete inherited history or post-cutoff context', async () => {
    const prefix = [meta(parentId), message('user', 'Parent accepted question'), message('assistant', 'Parent accepted answer')];
    const historyBase = base({ end_byte_offset: Buffer.byteLength(encode(prefix)) });
    await rollout(parentId, [...prefix, message('user', 'Parent post-cutoff question'), message('assistant', 'Parent post-cutoff answer')]);
    await rollout(childId, [
      meta(childId, { history_base: historyBase }), message('user', 'private-child-local-question'), message('assistant', 'private-child-local-answer'),
      { type: 'event_msg', timestamp, payload: { type: 'thread_rolled_back', num_turns: 1 } },
      message('user', 'private-child-replacement'), message('assistant', 'private-child-replacement-answer'),
    ]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    // The independent source is valid on its own. The child is deliberately not offered:
    // neither child-only text nor the parent's unbounded tail may become its handoff input.
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].candidate.sourceSessionId).toBe(parentId);
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual([
      'Parent accepted question', 'Parent accepted answer', 'Parent post-cutoff question', 'Parent post-cutoff answer',
    ]);
    expect(result.skippedReasons).toEqual({ unsupportedHistory: 1 });
    expect(JSON.stringify(result)).not.toContain('private-child');
  });

  it.each([true, false])('does not fall back to an older rollout of the same reverted thread (linked file first: %s)', async (linkedFirst) => {
    const previous = [meta(childId), message('user', 'Discarded pre-revert question'), message('assistant', 'Discarded pre-revert answer')];
    const current = [meta(childId, { history_base: base() }), message('user', 'private-current-suffix')];
    const files = linkedFirst ? [['linked', current], ['previous', previous]] as const : [['previous', previous], ['linked', current]] as const;
    for (const [name, records] of files) await rollout(name, [...records]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(2);
    expect(result.skippedReasons).toEqual({ unsupportedHistory: 2 });
    expect(JSON.stringify(result)).not.toMatch(/Discarded|private-/);
  });

  it('does not expose an older same-thread snapshot when the replacement declares malformed lineage', async () => {
    await rollout('old', [meta(childId), message('user', 'Discarded pre-revert question')]);
    await rollout('replacement', [meta(childId, { history_base: {} }), message('user', 'private-current-suffix')]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(2);
    expect(result.skippedReasons).toEqual({ invalidHistory: 2 });
  });

  it('reports an unsupported linked history even when its parent is missing without exposing the local suffix', async () => {
    await rollout(childId, [meta(childId, { history_base: base() }), message('user', 'private-partial-history')]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(1);
    expect(result.skippedReasons).toEqual({ unsupportedHistory: 1 });
    expect(result.malformedLines).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private-|rollout-/);
  });

  it.each([
    {}, 'not-a-position', [],
    base({ end_byte_offset: -1 }), base({ end_byte_offset: 0.5 }), base({ end_byte_offset: Number.MAX_SAFE_INTEGER + 1 }),
    base({ end_ordinal_exclusive: 0 }), base({ end_ordinal_exclusive: '3' }), base({ thread_id: '../outside' }),
  ].map((history_base) => ({ history_base })))('refuses missing or malformed bases without exposing local suffixes: $history_base', async ({ history_base }) => {
    await rollout(childId, [meta(childId, { history_base }), message('user', 'private-partial-history')]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(1);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
    expect(result.scanErrors).toBe(0);
    expect(result.malformedLines).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/private-|outside|rollout-/);
  });

  it('refuses cyclic sources instead of offering either local suffix', async () => {
    await rollout(parentId, [meta(parentId, { history_base: base({ thread_id: childId }) }), message('user', 'private-parent-suffix')]);
    await rollout(childId, [meta(childId, { history_base: base() }), message('user', 'private-child-suffix')]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ unsupportedHistory: 2 });
    expect(result.skippedFiles).toBe(2);
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it('does not offer a child when its source exceeds the existing per-file limit', async () => {
    await rollout(parentId, [meta(parentId), message('user', 'x'.repeat(4_000))]);
    await rollout(childId, [meta(childId, { history_base: base() }), message('user', 'private-child-suffix')]);
    const result = await discoverChatImports('codex', { codexDir: fixture, maxFileBytes: 2_000 });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ tooLarge: 1, unsupportedHistory: 1 });
    expect(result.skippedFiles).toBe(2);
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it.each(['legacy', undefined, 'future'])('does not ignore a non-null history_base under mode %s', async (history_mode) => {
    await rollout(childId, [meta(childId, { history_mode, history_base: base() }), message('user', 'private-child-suffix')]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
  });

  it.each(['future', null, 1, {}])('refuses malformed or unknown history modes even without a base: %j', async (history_mode) => {
    await rollout(childId, [meta(childId, { history_mode }), message('user', 'private-unknown-history')]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
    expect(JSON.stringify(result)).not.toContain('private-');
  });

  it.each(['legacy', 'paginated', undefined].flatMap((history_mode) => [undefined, null].map((history_base) => ({ history_mode, history_base }))))('preserves complete standalone $history_mode histories with base $history_base including rollback', async ({ history_mode, history_base }) => {
    await rollout(parentId, [
      meta(parentId, { history_mode, history_base }), message('user', 'Accepted question'), message('assistant', 'Accepted answer'),
      message('user', 'Discarded question'), message('assistant', 'Discarded answer'),
      { type: 'event_msg', timestamp, payload: { type: 'thread_rolled_back', num_turns: 1 } },
    ]);
    const result = await discoverChatImports('codex', { codexDir: fixture });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].candidate).toMatchObject({ sourceSessionId: parentId, title: 'Accepted question', projectRoot: cwd, messageCount: 2 });
    expect(result.sessions[0].items.map((item) => 'text' in item ? item.text : '')).toEqual(['Accepted question', 'Accepted answer']);
    expect(result.skippedReasons).toEqual({});
  });
});
