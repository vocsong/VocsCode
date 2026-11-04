import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverChatImports } from '../src/main/chat-import';

let fixture: string;
const sessionId = '11111111-1111-4111-8111-111111111111';
const uuid = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
const clear = '<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>';
const start = '2026-06-01T12:00:00.000Z';

beforeEach(async () => {
  // Canonical paths matter on macOS, where /var is a symlink to /private/var.
  fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'vocs-claude-chain-')));
});
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

function message(index: number, parent: number | null, role: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: role, uuid: uuid(index), parentUuid: parent === null ? null : uuid(parent), sessionId,
    cwd: fixture, timestamp: start, message: { role, content }, ...extra,
  };
}

function branch() {
  return [
    message(1, null, 'user', 'Shared question'), message(2, 1, 'assistant', 'Shared answer'),
    message(3, 2, 'user', 'Abandoned question'), message(4, 3, 'assistant', 'Abandoned answer'),
    message(5, 2, 'user', 'Replacement question'),
  ];
}

async function transcript(records: unknown[]) {
  const configDir = path.join(fixture, '.claude');
  const project = fixture.replace(/[^a-zA-Z0-9]/g, '-');
  const filename = path.join(configDir, 'projects', project, `${sessionId}.jsonl`);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return configDir;
}

function contextInput(items: Awaited<ReturnType<typeof discoverChatImports>>['sessions'][number]['items']) {
  // This is the exact text/role input supplied by the parser to persistence and handoff.
  return items.map((item) => ({ kind: item.kind, text: 'text' in item ? item.text : '' }));
}

async function sdkMessages(configDir: string) {
  const sdkUrl = pathToFileURL(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')).href;
  const script = `
    const { getSessionMessages } = await import(${JSON.stringify(sdkUrl)});
    const messages = await getSessionMessages(${JSON.stringify(sessionId)}, { dir: ${JSON.stringify(fixture)} });
    process.stdout.write(JSON.stringify(messages.map(({ uuid, type, message }) => ({ uuid, type, message }))));
  `;
  // A fresh process sets all homes before SDK module initialization. Only this synthetic
  // project's known path is queried; no logged-in runtime or private histories are used.
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture, env: { ...process.env, HOME: fixture, USERPROFILE: fixture, CLAUDE_CONFIG_DIR: configDir },
    maxBuffer: 1024 * 1024, timeout: 30_000,
  });
  return JSON.parse(stdout) as { uuid: string; type: string; message: { role: string; content: unknown } }[];
}

type PreservationFormat = 'messages' | 'segment';

function compact(index: number, anchor: number, kept: number[], format: PreservationFormat, extra: Record<string, unknown> = {}) {
  return {
    type: 'system', subtype: 'compact_boundary', uuid: uuid(index), parentUuid: null, sessionId,
    compactMetadata: format === 'messages'
      ? { preservedMessages: { anchorUuid: uuid(anchor), uuids: kept.map(uuid) } }
      : { preservedSegment: { anchorUuid: uuid(anchor), headUuid: uuid(kept[0]), tailUuid: uuid(kept[kept.length - 1]) } },
    ...extra,
  };
}

function compacted(format: PreservationFormat): Record<string, unknown>[] {
  return [
    message(1, null, 'user', 'Abandoned question'), message(2, 1, 'assistant', 'Abandoned answer'),
    message(3, 2, 'user', 'Retained constraint'), message(4, 3, 'assistant', 'Retained decision'),
    compact(5, 6, [3, 4], format), message(6, 5, 'user', 'Accepted summary', { isCompactSummary: true }),
    message(7, 6, 'user', 'Latest question'), message(8, 7, 'assistant', 'Latest answer'),
  ];
}

async function expectAccepted(configDir: string, ids: number[], texts: string[], title = texts[0]) {
  const native = await sdkMessages(configDir);
  expect(native.map((entry) => entry.uuid)).toEqual(ids.map(uuid));
  const result = await discoverChatImports('claude', { claudeDir: configDir });
  expect(result.skippedReasons).toEqual({});
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0].candidate).toMatchObject({ title, messageCount: texts.length, sourceSessionId: sessionId, projectRoot: fixture });
  expect(contextInput(result.sessions[0].items)).toEqual(native.map((entry) => ({ kind: entry.type, text: entry.message.content })));
  expect(contextInput(result.sessions[0].items).map((entry) => entry.text)).toEqual(texts);
  expect(JSON.stringify(result)).not.toMatch(/Abandoned|private-/);
}

describe('Claude parent-linked import', () => {
  it.each(['messages', 'segment'] as const)('relocates %s preservation before extracting ordered text, count and custom title', async (format) => {
    const configDir = await transcript([
      ...compacted(format),
      { type: 'progress', uuid: uuid(9), parentUuid: uuid(2), sessionId },
      { type: 'custom-title', customTitle: 'Compacted custom title', sessionId },
    ]);
    await expectAccepted(configDir, [6, 3, 4, 7, 8], ['Accepted summary', 'Retained constraint', 'Retained decision', 'Latest question', 'Latest answer'], 'Compacted custom title');
  });

  it.each(['messages', 'segment'] as const)('ignores trailing meta when selecting the compacted conversation (%s)', async (format) => {
    // Import deliberately selects a meaningful conversation leaf, not a trailing
    // isMeta row (the SDK currently lets such a row select its ancestor branch).
    const result = await discoverChatImports('claude', { claudeDir: await transcript([
      ...compacted(format), message(10, 2, 'user', 'private-trailing-meta', { isMeta: true }),
      { type: 'custom-title', customTitle: 'Compacted custom title', sessionId },
    ]) });
    expect(result.skippedReasons).toEqual({});
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Compacted custom title', messageCount: 5 });
    expect(contextInput(result.sessions[0].items).map((entry) => entry.text)).toEqual([
      'Accepted summary', 'Retained constraint', 'Retained decision', 'Latest question', 'Latest answer',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Abandoned|private-/);
  });

  it.each(['messages', 'segment'] as const)('supports %s prefix preservation anchored at the boundary', async (format) => {
    const records = compacted(format);
    records[4] = compact(5, 5, [3, 4], format);
    await expectAccepted(await transcript(records), [3, 4, 6, 7, 8], ['Retained constraint', 'Retained decision', 'Accepted summary', 'Latest question', 'Latest answer']);
  });

  it('uses explicit ordered UUIDs instead of walking the old chain, with messages superseding segment', async () => {
    const records = compacted('messages');
    records[4] = compact(5, 6, [4, 3], 'messages', {
      compactMetadata: {
        preservedMessages: { anchorUuid: uuid(6), uuids: [uuid(4), uuid(3)] },
        preservedSegment: { anchorUuid: uuid(6), headUuid: uuid(1), tailUuid: uuid(2) },
      },
    });
    await expectAccepted(await transcript(records), [6, 4, 3, 7, 8], ['Accepted summary', 'Retained decision', 'Retained constraint', 'Latest question', 'Latest answer']);
  });

  it.each(['messages', 'segment'] as const)('resolves repeated compactions using the already relocated %s history', async (format) => {
    const configDir = await transcript([
      ...compacted('messages'), compact(9, 10, [3, 4, 7, 8], format),
      message(10, 9, 'user', 'Second summary'), message(11, 10, 'user', 'Second latest question'), message(12, 11, 'assistant', 'Second latest answer'),
    ]);
    await expectAccepted(configDir, [10, 3, 4, 7, 8, 11, 12], [
      'Second summary', 'Retained constraint', 'Retained decision', 'Latest question', 'Latest answer', 'Second latest question', 'Second latest answer',
    ]);
  });

  it.each(['messages', 'segment'] as const)('does not select a disconnected compact boundary or its %s preservation as the leaf', async (format) => {
    const configDir = await transcript([
      ...compacted('messages'), compact(9, 10, [1, 2], format), message(10, 9, 'user', 'Abandoned compact summary'),
      message(11, 8, 'assistant', 'Accepted continuation'),
    ]);
    await expectAccepted(configDir, [6, 3, 4, 7, 8, 11], [
      'Accepted summary', 'Retained constraint', 'Retained decision', 'Latest question', 'Latest answer', 'Accepted continuation',
    ]);
  });

  it.each(['messages', 'segment'] as const)('ignores a trailing disconnected boundary with valid %s metadata', async (format) => {
    await expectAccepted(await transcript([...compacted('messages'), compact(9, 9, [1, 2], format)]),
      [6, 3, 4, 7, 8], ['Accepted summary', 'Retained constraint', 'Retained decision', 'Latest question', 'Latest answer']);
  });

  it('supports an empty ordered preservation list as a no-op', async () => {
    const records = compacted('messages');
    records[4] = compact(5, 6, [], 'messages');
    await expectAccepted(await transcript(records), [6, 7, 8], ['Accepted summary', 'Latest question', 'Latest answer']);
  });

  it.each(['messages', 'segment'] as const)('retains compacted order across a subsequent clear reset (%s)', async (format) => {
    const result = await discoverChatImports('claude', { claudeDir: await transcript([
      ...compacted(format), message(9, null, 'user', clear), message(10, null, 'user', 'After clear'),
    ]) });
    expect(result.skippedReasons).toEqual({});
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Accepted summary', messageCount: 6 });
    expect(contextInput(result.sessions[0].items).map((entry) => entry.text)).toEqual([
      'Accepted summary', 'Retained constraint', 'Retained decision', 'Latest question', 'Latest answer', 'After clear',
    ]);
  });

  it.each([
    { preservedMessages: null },
    { preservedMessages: { anchorUuid: uuid(6), uuids: 'not-an-array' } },
    { preservedMessages: { anchorUuid: uuid(6), uuids: [uuid(3), 42] } },
    { preservedMessages: { anchorUuid: uuid(6), uuids: [uuid(3), uuid(99)] } },
    { preservedMessages: { anchorUuid: uuid(99), uuids: [uuid(3), uuid(4)] } },
    { preservedMessages: { anchorUuid: uuid(2), uuids: [uuid(3), uuid(4)] } },
    { preservedMessages: { anchorUuid: uuid(6), uuids: [uuid(3), uuid(7)] } },
    { preservedMessages: { anchorUuid: uuid(6), uuids: [uuid(3), uuid(3)] } },
    { preservedMessages: { anchorUuid: uuid(6), uuids: [uuid(3), uuid(6)] } },
    { preservedMessages: { anchorUuid: uuid(6), uuids: [uuid(3), uuid(4)], unknownRelocation: true } },
    { preservedSegment: { anchorUuid: uuid(6), headUuid: uuid(99), tailUuid: uuid(4) } },
    { preservedSegment: { anchorUuid: uuid(6), headUuid: uuid(3), tailUuid: uuid(99) } },
    { preservedSegment: { anchorUuid: uuid(6), headUuid: uuid(4), tailUuid: uuid(3) } },
    { preservedSegment: { anchorUuid: uuid(6), headUuid: uuid(3) } },
    { preservedUnknown: { anchorUuid: uuid(6) } },
  ])('refuses malformed or unsupported preservation without partially importing (%j)', async (compactMetadata) => {
    const records = compacted('messages');
    records[4] = { ...records[4], compactMetadata };
    const result = await discoverChatImports('claude', { claudeDir: await transcript(records) });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(1);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
    expect(JSON.stringify(result)).not.toMatch(/Retained|Abandoned|Latest/);
  });

  it('retains flat legacy compaction records that do not declare preservation', async () => {
    const result = await discoverChatImports('claude', { claudeDir: await transcript([
      message(1, null, 'user', 'Legacy question', { parentUuid: undefined }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 123 } },
      message(2, null, 'assistant', 'Legacy answer', { parentUuid: undefined }),
    ]) });
    expect(result.skippedReasons).toEqual({});
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Legacy question', messageCount: 2 });
    expect(contextInput(result.sessions[0].items).map((entry) => entry.text)).toEqual(['Legacy question', 'Legacy answer']);
  });

  it('refuses flat exports that declare preservation without any reconstructable links', async () => {
    const records = compacted('messages').map(({ parentUuid: _parentUuid, ...record }) => record);
    const result = await discoverChatImports('claude', { claudeDir: await transcript(records) });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
  });

  it('refuses damaged preservation even on an inactive boundary rather than guessing it is harmless', async () => {
    const configDir = await transcript([
      ...compacted('messages'), compact(9, 9, [99], 'messages'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
  });

  it.each(['cycle', 'missing', 'forward'] as const)('refuses a %s in the segment being preserved', async (kind) => {
    const records = compacted('segment');
    records[3] = message(4, kind === 'cycle' ? 4 : kind === 'missing' ? 99 : 6, 'assistant', 'Retained decision');
    const result = await discoverChatImports('claude', { claudeDir: await transcript(records) });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
  });

  it.each(['messages', 'segment'] as const)('refuses preservation crossing a clear reset (%s)', async (format) => {
    const records = compacted(format);
    records.splice(4, 0, message(9, null, 'user', clear));
    const result = await discoverChatImports('claude', { claudeDir: await transcript(records) });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
  });

  it('does not turn an unlisted forward raw link into a verified relocation', async () => {
    const records = compacted('messages');
    records.splice(4, 0, message(9, 6, 'assistant', 'private-forward-link'));
    records.push(message(10, 9, 'user', 'private-forward-leaf'));
    const result = await discoverChatImports('claude', { claudeDir: await transcript(records) });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
  });

  it('matches the public SDK accepted chain before materializing title, count and context input', async () => {
    const configDir = await transcript([
      ...branch(),
      message(6, 5, 'assistant', [{ type: 'tool_use', id: 'tool', name: 'read', input: { private: 'tool-input' } }]),
      message(7, 6, 'user', [{ type: 'tool_result', tool_use_id: 'tool', content: 'private-tool-result' }]),
      { type: 'system', subtype: 'compact_boundary', uuid: uuid(8), parentUuid: uuid(7), sessionId },
      message(9, 8, 'user', 'private-meta-bridge', { isMeta: true }),
      message(10, 9, 'assistant', 'Replacement answer'),
      { type: 'progress', uuid: uuid(11), parentUuid: uuid(4), sessionId },
      { type: 'custom-title', customTitle: 'Accepted custom title', sessionId },
    ]);
    const native = await sdkMessages(configDir);
    expect(native.map((entry) => entry.uuid)).toEqual([1, 2, 5, 6, 7, 10].map(uuid));
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.skippedReasons).toEqual({});
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].candidate).toMatchObject({ sourceSessionId: sessionId, title: 'Accepted custom title', projectRoot: fixture, messageCount: 4 });
    const expected = [
      { kind: 'user', text: 'Shared question' }, { kind: 'assistant', text: 'Shared answer' },
      { kind: 'user', text: 'Replacement question' }, { kind: 'assistant', text: 'Replacement answer' },
    ];
    expect(contextInput(result.sessions[0].items)).toEqual(expected);
    expect(native.filter((entry) => typeof entry.message.content === 'string').map((entry) => ({ kind: entry.type, text: entry.message.content }))).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/Abandoned|private-|tool-input/);
  });

  it.each(['system', 'meta', 'sidechain', 'progress'] as const)('does not let trailing %s select an abandoned parent branch', async (kind) => {
    const extra = kind === 'meta' ? { isMeta: true } : { isSidechain: true };
    const tail = kind === 'meta' || kind === 'sidechain'
      ? message(8, 4, 'user', 'private-tail', extra)
      : { type: kind, uuid: uuid(8), parentUuid: uuid(4), sessionId };
    const configDir = await transcript([...branch(), message(6, 5, 'assistant', 'Replacement answer'), tail]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(contextInput(result.sessions[0].items)).toEqual([
      { kind: 'user', text: 'Shared question' }, { kind: 'assistant', text: 'Shared answer' },
      { kind: 'user', text: 'Replacement question' }, { kind: 'assistant', text: 'Replacement answer' },
    ]);
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Shared question', messageCount: 4 });
    expect(JSON.stringify(result)).not.toMatch(/Abandoned|private-tail/);
  });

  it('uses the latest meaningful tool-only leaf rather than the last text-bearing leaf', async () => {
    const configDir = await transcript([
      ...branch(),
      message(6, 5, 'assistant', [{ type: 'tool_use', id: 'tool', name: 'read', input: {} }]),
      message(7, 6, 'user', [{ type: 'tool_result', tool_use_id: 'tool', content: 'private-result' }]),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(contextInput(result.sessions[0].items)).toEqual([
      { kind: 'user', text: 'Shared question' }, { kind: 'assistant', text: 'Shared answer' }, { kind: 'user', text: 'Replacement question' },
    ]);
    expect(result.sessions[0].candidate.messageCount).toBe(3);
  });

  it('follows sidechain links used as bridges without importing their text', async () => {
    const configDir = await transcript([
      ...branch(), message(6, 5, 'assistant', 'private-sidechain', { isSidechain: true }), message(7, 6, 'assistant', 'Replacement answer'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual(['Shared question', 'Shared answer', 'Replacement question', 'Replacement answer']);
  });

  it('derives the title and context only from the selected root, not a disconnected abandoned branch', async () => {
    const configDir = await transcript([
      message(1, null, 'user', 'Abandoned title'), message(2, 1, 'assistant', 'Abandoned answer'),
      message(3, null, 'user', 'Accepted title'), message(4, 3, 'assistant', 'Accepted answer'),
    ]);
    const native = await sdkMessages(configDir);
    expect(native.map((entry) => entry.uuid)).toEqual([3, 4].map(uuid));
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Accepted title', messageCount: 2 });
    expect(contextInput(result.sessions[0].items)).toEqual([{ kind: 'user', text: 'Accepted title' }, { kind: 'assistant', text: 'Accepted answer' }]);
  });

  it.each(['connected', 'reset'] as const)('retains nonempty accepted conversation before and after a %s clear without reviving rewinds', async (kind) => {
    const configDir = await transcript([
      ...branch(), message(6, 5, 'assistant', 'Replacement answer'),
      message(7, kind === 'reset' ? null : 6, 'user', clear),
      message(8, kind === 'reset' ? null : 7, 'user', 'After clear'), message(9, 8, 'assistant', 'After clear answer'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Shared question', messageCount: 6 });
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual([
      'Shared question', 'Shared answer', 'Replacement question', 'Replacement answer', 'After clear', 'After clear answer',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Abandoned|command-name/);
  });

  it('retains the accepted nonempty chain when the final reset consists only of clear artifacts', async () => {
    const configDir = await transcript([
      ...branch(), message(6, 5, 'assistant', 'Replacement answer'), message(7, null, 'user', clear),
      message(8, 7, 'user', '<local-command-stdout>Conversation cleared.</local-command-stdout>'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.sessions[0].candidate.messageCount).toBe(4);
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual(['Shared question', 'Shared answer', 'Replacement question', 'Replacement answer']);
  });

  it('does not let exact duplicate rows move the leaf back to an abandoned branch', async () => {
    const records = branch();
    const configDir = await transcript([...records, message(6, 5, 'assistant', 'Replacement answer'), records[3]]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual(['Shared question', 'Shared answer', 'Replacement question', 'Replacement answer']);
    expect(result.sessions[0].candidate.messageCount).toBe(4);
  });

  it('retains separate accepted segments across repeated clear resets and ignores duplicate clear rows', async () => {
    const reset = message(7, null, 'user', clear);
    const configDir = await transcript([
      ...branch(), message(6, 5, 'assistant', 'Replacement answer'), reset,
      message(8, null, 'user', 'After first clear'), message(9, 8, 'assistant', 'First clear answer'), reset,
      message(10, null, 'user', clear), message(11, null, 'user', 'After second clear'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual([
      'Shared question', 'Shared answer', 'Replacement question', 'Replacement answer', 'After first clear', 'First clear answer', 'After second clear',
    ]);
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Shared question', messageCount: 7 });
  });

  it.each(['linked', 'legacy'] as const)('preserves an entirely legacy pre-clear segment with a %s reset marker before linked history', async (format) => {
    const legacyQuestion = message(1, null, 'user', 'Legacy accepted question');
    const legacyAnswer = message(2, null, 'assistant', 'Legacy accepted answer');
    const configDir = await transcript([
      { ...legacyQuestion, parentUuid: undefined }, { ...legacyAnswer, parentUuid: undefined },
      message(3, null, 'user', clear, format === 'legacy' ? { parentUuid: undefined } : {}),
      message(4, null, 'user', 'New abandoned question'), message(5, 4, 'assistant', 'New abandoned answer'),
      message(6, null, 'user', 'New accepted question'), message(7, 6, 'assistant', 'New accepted answer'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.skippedReasons).toEqual({});
    expect(result.sessions[0].candidate).toMatchObject({ title: 'Legacy accepted question', messageCount: 4 });
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual([
      'Legacy accepted question', 'Legacy accepted answer', 'New accepted question', 'New accepted answer',
    ]);
  });

  it('can follow a legacy clear marker as an explicit reset bridge without guessing a missing ancestor', async () => {
    const configDir = await transcript([
      ...branch(), message(6, 5, 'assistant', 'Replacement answer'),
      message(7, null, 'user', clear, { parentUuid: undefined }), message(8, 7, 'user', 'After clear'),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.skippedReasons).toEqual({});
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual(['Shared question', 'Shared answer', 'Replacement question', 'Replacement answer', 'After clear']);
  });

  it('preserves an entirely legacy post-clear segment after a linked pre-clear conversation', async () => {
    const configDir = await transcript([
      ...branch(), message(6, 5, 'assistant', 'Replacement answer'), message(7, null, 'user', clear),
      message(8, null, 'user', 'Legacy after clear', { parentUuid: undefined }), message(9, null, 'assistant', 'Legacy answer', { parentUuid: undefined }),
    ]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.skippedReasons).toEqual({});
    expect(contextInput(result.sessions[0].items).map((item) => item.text)).toEqual([
      'Shared question', 'Shared answer', 'Replacement question', 'Replacement answer', 'Legacy after clear', 'Legacy answer',
    ]);
  });

  it('refuses damaged linked records rather than assuming the last intact branch is still accepted', async () => {
    const configDir = await transcript([...branch(), message(6, 5, 'assistant', 'Replacement answer'), null]);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.sessions).toEqual([]);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
    expect(result.malformedLines).toBe(1);
  });

  it.each(['missing-parent', 'cycle', 'forward-parent', 'invalid-parent', 'missing-uuid', 'conflicting-uuid', 'mixed-unlinked'] as const)('refuses %s rather than falling back to abandoned history', async (kind) => {
    const records: unknown[] = [...branch(), message(6, 5, 'assistant', 'Replacement answer')];
    if (kind === 'missing-parent') records.push(message(7, 99, 'user', 'private-unresolved'));
    if (kind === 'cycle') records.push(message(7, 7, 'user', 'private-unresolved'));
    if (kind === 'forward-parent') records.push(message(7, 8, 'user', 'private-unresolved'), { type: 'progress', uuid: uuid(8), parentUuid: null });
    if (kind === 'invalid-parent') records.push(message(7, null, 'user', 'private-unresolved', { parentUuid: 42 }));
    if (kind === 'missing-uuid') records.push(message(7, 6, 'user', 'private-unresolved', { uuid: undefined }));
    if (kind === 'conflicting-uuid') records.push(message(6, 4, 'assistant', 'private-conflicting'));
    if (kind === 'mixed-unlinked') records.push(message(7, null, 'user', 'private-unresolved', { parentUuid: undefined }));
    const configDir = await transcript(records);
    const result = await discoverChatImports('claude', { claudeDir: configDir });
    expect(result.sessions).toEqual([]);
    expect(result.skippedFiles).toBe(1);
    expect(result.skippedReasons).toEqual({ invalidHistory: 1 });
    expect(JSON.stringify(result)).not.toMatch(/Abandoned|private-|Replacement/);
  });
});
