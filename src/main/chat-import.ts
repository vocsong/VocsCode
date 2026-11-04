import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatImportCandidate, ChatImportSkipCounts, ChatImportSkipReason, ChatImportSource } from '../shared/chat-import';
import type { TranscriptItem } from '../shared/types';

export interface ParsedChatImport {
  candidate: ChatImportCandidate;
  items: TranscriptItem[];
}

export interface ChatImportDiscovery {
  sessions: ParsedChatImport[];
  skippedFiles: number;
  skippedReasons: ChatImportSkipCounts;
  scanErrors: number;
  malformedLines: number;
  truncated: boolean;
}

/** Trusted main-process configuration, also used to isolate fixture tests from real histories. */
export interface ChatImportOptions {
  claudeDir?: string;
  codexDir?: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
}

type RecordValue = Record<string, unknown>;

const DEFAULT_LIMITS = {
  maxFiles: 1_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 20_000,
};

/**
 * Only known transcript trees are scanned. No renderer-controlled filename is accepted.
 * Claude's JSONL format is internal; unknown record kinds are intentionally ignored.
 * https://code.claude.com/docs/en/sessions#where-transcripts-are-stored
 * https://github.com/openai/codex/tree/main/codex-rs/rollout
 */
export async function discoverChatImports(source: ChatImportSource, options: ChatImportOptions = {}): Promise<ChatImportDiscovery> {
  if (source !== 'claude' && source !== 'codex') throw new Error('Unsupported chat import source');
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => {
    const value = options[key as keyof typeof DEFAULT_LIMITS];
    return [key, typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback];
  })) as typeof DEFAULT_LIMITS;
  const root = source === 'claude'
    ? options.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude'))
    : options.codexDir ?? (process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'));
  const result: ChatImportDiscovery = { sessions: [], skippedFiles: 0, skippedReasons: {}, scanErrors: 0, malformedLines: 0, truncated: false };
  const skip = (reason: ChatImportSkipReason, count = 1): void => {
    result.skippedFiles += count;
    result.skippedReasons[reason] = (result.skippedReasons[reason] ?? 0) + count;
  };
  const sessions = new Map<string, ParsedChatImport>();
  const blockedCodexSessions = new Map<string, ChatImportSkipReason>();
  const acceptedCodexFiles = new Map<string, number>();
  let visited = 0;
  let files = 0;
  let bytes = 0;

  async function visit(dir: string, depth: number): Promise<void> {
    if (result.truncated) return;
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const entries = await opendir(dir);
      for await (const entry of entries) {
        if (++visited > limits.maxEntries || files >= limits.maxFiles || bytes >= limits.maxTotalBytes) {
          result.truncated = true;
          break;
        }
        if (entry.isSymbolicLink()) continue;
        const filename = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const recurse = source === 'claude'
            ? depth === 0
            : depth < 3 && /^\d{2,4}$/.test(entry.name);
          if (recurse) await visit(filename, depth + 1);
          if (result.truncated) break;
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (source === 'claude' ? depth !== 1 || entry.name.startsWith('agent-') : !entry.name.startsWith('rollout-')) continue;
        files++;
        try {
          const contents = await readTranscript(filename, limits.maxFileBytes, limits.maxTotalBytes - bytes);
          bytes += contents.length;
          const parsed = parseTranscript(source, contents.toString('utf8'), filename);
          result.malformedLines += parsed.malformedLines;
          if (!parsed.session) {
            skip(parsed.skipReason);
            if (source === 'codex' && parsed.refusedSourceSessionId) {
              const id = `codex-${hash(parsed.refusedSourceSessionId)}`;
              if (!blockedCodexSessions.has(id) || parsed.skipReason === 'invalidHistory') blockedCodexSessions.set(id, parsed.skipReason);
            }
            continue;
          }
          if (source === 'codex') {
            const id = parsed.session.candidate.id;
            acceptedCodexFiles.set(id, (acceptedCodexFiles.get(id) ?? 0) + 1);
          }
          const previous = sessions.get(parsed.session.candidate.id);
          if (!previous || parsed.session.candidate.updatedAt > previous.candidate.updatedAt
            || (parsed.session.candidate.updatedAt === previous.candidate.updatedAt && parsed.session.items.length > previous.items.length)) {
            sessions.set(parsed.session.candidate.id, parsed.session);
          }
        } catch (error) {
          // Aggregate reasons never include source paths, messages or raw filesystem errors.
          skip(error instanceof ChatImportLimitError ? error.reason : 'unreadable');
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.scanErrors++;
    }
  }

  // Refuse symlinked configuration roots, as well as linked child files/directories.
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.scanErrors++;
    return result;
  }
  if (source === 'claude') await visit(path.join(root, 'projects'), 0);
  else {
    await visit(path.join(root, 'sessions'), 0);
    await visit(path.join(root, 'archived_sessions'), 0);
  }
  // Reverts can keep a stable thread ID while replacing its physical rollout. Refusing
  // the linked current history must not expose an older standalone copy of that thread.
  for (const [id, reason] of blockedCodexSessions) {
    const files = acceptedCodexFiles.get(id) ?? 0;
    if (files) {
      sessions.delete(id);
      skip(reason, files);
    }
  }
  result.sessions = [...sessions.values()].sort((a, b) => b.candidate.updatedAt - a.candidate.updatedAt || a.candidate.id.localeCompare(b.candidate.id));
  return result;
}

class ChatImportLimitError extends Error {
  constructor(readonly reason: 'tooLarge' | 'scanBudget') {
    super('Transcript exceeds import limit');
  }
}

async function readTranscript(filename: string, maxFileBytes: number, remainingBytes: number): Promise<Buffer> {
  const limit = Math.min(maxFileBytes, remainingBytes);
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Transcript is not a file');
    if (stat.size > maxFileBytes) throw new ChatImportLimitError('tooLarge');
    if (stat.size > remainingBytes) throw new ChatImportLimitError('scanBudget');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new ChatImportLimitError(maxFileBytes <= remainingBytes ? 'tooLarge' : 'scanBudget');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timestamp(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function textContent(content: unknown, allowedTypes: readonly string[], transform: (text: string) => string = (text) => text): string {
  if (typeof content === 'string') return transform(content);
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const value = object(part);
    return value && allowedTypes.includes(string(value.type)) ? transform(string(value.text)) : '';
  }).filter(Boolean).join('\n');
}

/** Claude also persists local CLI artifacts as user text, without necessarily setting isMeta.
 * Match whole text blocks only: examples in prose and assistant explanations are conversation.
 */
function claudeUserText(text: string): string {
  const trimmed = text.trim();
  const local = /^<(local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/.exec(trimmed);
  if (local?.[0] === trimmed) return '';
  const fields = new Map<string, string>();
  const field = /<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>\s*/y;
  for (let index = 0; index < 3; index++) {
    const match = field.exec(trimmed);
    if (!match || fields.has(match[1])) return text;
    fields.set(match[1], match[2]);
  }
  if (field.lastIndex !== trimmed.length) return text;
  const name = fields.get('command-name')!.trim();
  const message = fields.get('command-message')!.trim();
  const args = fields.get('command-args')!.trim();
  // Do not discard unfamiliar envelopes or nonredundant command-message text.
  if (!/^\/[\w:.-]+$/.test(name) || (message !== name && message !== name.slice(1))) return text;
  if (name === '/clear' && !args) return '';
  // Custom/model-facing slash commands are real prompts, not local output.
  return args ? `${name} ${args}` : name;
}

function absoluteCwd(value: unknown): string {
  const cwd = string(value);
  return cwd && !cwd.includes('\0') && (path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)) ? cwd : '';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Core compact::is_summary_message requires this exact prefix followed by a newline.
// https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/summary_prefix.md
const CODEX_SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

/** Decode the text-only XML emitted by Codex's HookPromptXml serializer. */
function codexXmlText(value: string): string | undefined {
  let valid = !/[<\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(value) && !value.includes(']]>');
  const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  const decoded = value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);|&/g, (entity) => {
    if (entity in named) return named[entity];
    if (entity.startsWith('&#')) {
      const point = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      if (point === 9 || point === 10 || point === 13 || point >= 0x20 && point <= 0xD7FF || point >= 0xE000 && point <= 0xFFFD || point >= 0x10000 && point <= 0x10FFFF) return String.fromCodePoint(point);
    }
    valid = false;
    return entity;
  });
  return valid ? decoded : undefined;
}

/** A serialized hook prompt requires a nonempty run id and well-formed quoted attributes/text.
 * https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs
 */
function isCodexHookPrompt(text: string): boolean {
  const hook = /^<hook_prompt((?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_:.-]*[ \t\r\n]*=[ \t\r\n]*(?:"[^"<]*"|'[^'<]*'))*)[ \t\r\n]*>([\s\S]*)<\/hook_prompt>$/.exec(text);
  if (!hook || codexXmlText(hook[2]) === undefined) return false;
  const names = new Set<string>();
  let runId: string | undefined;
  for (const attribute of hook[1].matchAll(/([A-Za-z_:][A-Za-z0-9_:.-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/g)) {
    const name = attribute[1];
    const value = codexXmlText(attribute[2] ?? attribute[3]);
    if (names.has(name) || value === undefined) return false;
    names.add(name);
    if (name === 'hook_run_id') runId = value;
  }
  return !!runId?.trim();
}

/** Codex's persisted contextual user fragments are not real prompt/rollback boundaries.
 * Match complete wrappers, as core's ContextualUserFragment does, rather than arbitrary tags.
 * https://github.com/openai/codex/blob/main/codex-rs/core/src/context/contextual_user_message.rs
 */
function isCodexContext(content: unknown): boolean {
  const parts = Array.isArray(content) ? content : [{ type: 'input_text', text: content }];
  return parts.some((part) => {
    const item = object(part);
    if (item?.type !== 'input_text') return false;
    const raw = string(item.text);
    if (raw.startsWith(CODEX_SUMMARY_PREFIX + '\n')) return true;
    const text = raw.trim();
    const lower = text.toLowerCase();
    // Default fragment markers ignore ASCII case; custom internal/external and hook XML do not.
    const tags = ['environment_context', 'user_shell_command', 'turn_aborted', 'subagent_notification', 'agent_message_board_notification', 'recommended_plugins', 'skill'];
    if (tags.some((tag) => lower.startsWith(`<${tag}>`) && lower.endsWith(`</${tag}>`))) return true;
    if (lower.startsWith('# agents.md instructions') && lower.endsWith('</instructions>')) return true;
    if (text.startsWith('<goal_context>') && text.endsWith('</goal_context>')) return true;
    if (/^<codex_internal_context source="[a-z][a-z0-9_]*">/.test(text) && text.endsWith('</codex_internal_context>')) return true;
    const external = /^<external_([^>]*)>/.exec(text);
    if (external && text.endsWith(`</external_${external[1]}>`)) return true;
    if (isCodexHookPrompt(text)) return true;
    return (text.startsWith('Warning: apply_patch was requested via ') && text.endsWith('Use the apply_patch tool instead of exec_command.'))
      || text.startsWith('Warning: The maximum number of unified exec processes you can keep open is')
      || text.startsWith('Warning: Your account was flagged for potentially high-risk cyber activity');
  });
}

/** Legacy inter-agent instructions were assistant messages containing one serialized envelope. */
function isCodexAgentInstruction(content: unknown): boolean {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const part = object(content[0]);
  if (!part || (part.type !== 'input_text' && part.type !== 'output_text')) return false;
  try {
    const instruction = object(JSON.parse(string(part.text)));
    return !!instruction && typeof instruction.author === 'string' && typeof instruction.recipient === 'string'
      && typeof instruction.content === 'string' && typeof instruction.trigger_turn === 'boolean';
  } catch {
    return false;
  }
}

interface CodexImportEntry {
  sourceId: string;
  boundary: boolean;
  item?: TranscriptItem;
}

/** ThreadRolledBack counts real user prompts, not task_started or mirrored UserMessage events.
 * Entries retain even textless prompts so attachment-only turns consume the correct boundary.
 * https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/history.rs
 */
function rollbackCodex(entries: CodexImportEntry[], seen: Set<string>, count: number): void {
  if (!count) return;
  const boundaries = entries.flatMap((entry, index) => entry.boundary ? [index] : []);
  if (!boundaries.length) return;
  const cut = boundaries[Math.max(0, boundaries.length - count)];
  for (const entry of entries.splice(cut)) if (entry.sourceId) seen.delete(entry.sourceId);
}

interface TranscriptRecord {
  record: RecordValue;
  lineNumber: number;
}

function claudeChainEntry(record: RecordValue): boolean {
  return (record.type === 'user' || record.type === 'assistant')
    && record.isSidechain !== true && record.isMeta !== true && record.parent_tool_use_id == null;
}

function claudeClearReset(record: RecordValue): boolean {
  if (!claudeChainEntry(record) || record.type !== 'user' || record.parentUuid !== null && Object.hasOwn(record, 'parentUuid')) return false;
  const content = textContent(object(record.message)?.content, ['text']);
  return content.trim().startsWith('<command-') && claudeUserText(content) === '';
}

/** Persisted compactMetadata is camelCase; the public SDK wire declarations use snake_case.
 * Apply boundaries in file order so later compactions can preserve an already relocated
 * segment. Only explicit preservation edges may point forward in the physical file.
 */
function claudePreservedParents(records: TranscriptRecord[], byUuid: Map<string, TranscriptRecord>): Map<TranscriptRecord, TranscriptRecord> | undefined {
  const parents = new Map<TranscriptRecord, TranscriptRecord>();
  const segments = new Map<TranscriptRecord, number>();
  let segment = 0;
  for (const entry of records) {
    const uuid = string(entry.record.uuid);
    if (uuid && byUuid.get(uuid) !== entry) continue;
    if (claudeClearReset(entry.record)) segment++;
    segments.set(entry, segment);
  }
  const parentOf = (entry: TranscriptRecord): TranscriptRecord | undefined => parents.get(entry) ?? byUuid.get(string(entry.record.parentUuid));
  const validEdge = (entry: TranscriptRecord, parent: TranscriptRecord): boolean => parents.has(entry) || parent.lineNumber < entry.lineNumber;
  const children = new Map<TranscriptRecord, Set<TranscriptRecord>>();
  const addChild = (parent: TranscriptRecord, child: TranscriptRecord): void => {
    let entries = children.get(parent);
    if (!entries) children.set(parent, entries = new Set());
    entries.add(child);
  };
  for (const child of byUuid.values()) {
    const parent = parentOf(child);
    if (parent && validEdge(child, parent)) addChild(parent, child);
  }
  const reparent = (child: TranscriptRecord, parent: TranscriptRecord): void => {
    const previous = parentOf(child);
    if (previous) children.get(previous)?.delete(child);
    parents.set(child, parent);
    addChild(parent, child);
  };
  for (const boundary of records) {
    const record = boundary.record;
    if (record.type !== 'system' || record.subtype !== 'compact_boundary') continue;
    if (string(record.uuid) && byUuid.get(string(record.uuid)) !== boundary) continue;
    // Do not mistake unfamiliar preservation encodings for summarize-everything compaction.
    if (Object.hasOwn(record, 'compact_metadata')) return undefined;
    if (!Object.hasOwn(record, 'compactMetadata')) continue;
    const metadata = object(record.compactMetadata);
    if (!metadata || Object.keys(metadata).some((key) => /preserv/i.test(key) && key !== 'preservedMessages' && key !== 'preservedSegment')) return undefined;
    const messages = Object.hasOwn(metadata, 'preservedMessages');
    if (!messages && !Object.hasOwn(metadata, 'preservedSegment')) continue;
    // The ordered UUID list supersedes the legacy segment, including its old links.
    const preservation = object(messages ? metadata.preservedMessages : metadata.preservedSegment);
    const keys = messages ? ['anchorUuid', 'uuids'] : ['anchorUuid', 'headUuid', 'tailUuid'];
    if (!preservation || Object.keys(preservation).some((key) => !keys.includes(key))) return undefined;
    const anchor = byUuid.get(string(preservation.anchorUuid));
    if (!anchor || !string(record.uuid) || byUuid.get(string(record.uuid)) !== boundary) return undefined;
    let kept: TranscriptRecord[];
    if (messages) {
      if (!Array.isArray(preservation.uuids)) return undefined;
      kept = [];
      for (const uuid of preservation.uuids) {
        const entry = byUuid.get(string(uuid));
        if (!entry) return undefined;
        kept.push(entry);
      }
    } else {
      const head = byUuid.get(string(preservation.headUuid));
      let entry = byUuid.get(string(preservation.tailUuid));
      if (!head || !entry) return undefined;
      kept = [];
      const visited = new Set<TranscriptRecord>();
      while (true) {
        if (visited.has(entry)) return undefined;
        visited.add(entry);
        kept.push(entry);
        if (entry === head) break;
        const parent = parentOf(entry);
        if (!parent || !validEdge(entry, parent)) return undefined;
        entry = parent;
      }
      kept.reverse();
    }
    const preserved = new Set(kept);
    if (preserved.size !== kept.length || preserved.has(anchor) || segments.get(anchor) !== segments.get(boundary)
      || kept.some((entry) => entry.lineNumber >= boundary.lineNumber || segments.get(entry) !== segments.get(boundary))) return undefined;
    // Supported anchors are the boundary itself (prefix preservation) or a summary
    // descended from it. An unrelated/older anchor needs semantics we cannot infer.
    const anchorPath = new Set<TranscriptRecord>();
    let entry = anchor;
    while (entry !== boundary) {
      if (anchorPath.has(entry) || preserved.has(entry)) return undefined;
      anchorPath.add(entry);
      const parent = parentOf(entry);
      if (!parent || !validEdge(entry, parent)) return undefined;
      entry = parent;
    }
    if (!kept.length) continue;
    const tail = kept[kept.length - 1];
    // Move existing children after the preserved tail. Never launder a broken raw
    // forward link into a valid edge merely because it names the same anchor.
    for (const child of children.get(anchor) ?? []) {
      if (!preserved.has(child)) reparent(child, tail);
    }
    for (const [index, child] of kept.entries()) reparent(child, index ? kept[index - 1] : anchor);
  }
  return parents;
}

/** Resolve before extracting text: textless tools, system and metadata rows can be bridges.
 * Only conversation entries choose the leaf; a trailing status row must not select an old branch.
 * Public getSessionMessages contract: https://platform.claude.com/docs/en/agent-sdk/typescript
 */
function claudeAcceptedChain(records: TranscriptRecord[], malformedLines: number): TranscriptRecord[] | undefined {
  // Older exports without links retain their flat transcript semantics, unless they
  // declare a compaction relocation which a flat reader cannot safely reconstruct.
  if (!records.some(({ record }) => Object.hasOwn(record, 'parentUuid'))) {
    return records.some(({ record }) => {
      if (record.type !== 'system' || record.subtype !== 'compact_boundary') return false;
      if (Object.hasOwn(record, 'compact_metadata')) return true;
      if (!Object.hasOwn(record, 'compactMetadata')) return false;
      const metadata = object(record.compactMetadata);
      return !metadata || Object.keys(metadata).some((key) => /preserv/i.test(key));
    }) ? undefined : records;
  }
  // An unreadable row may contain a replacement branch or mutation. Do not mistake the
  // last intact branch for accepted history; legacy interrupted exports remain tolerated.
  if (malformedLines) return undefined;
  const byUuid = new Map<string, TranscriptRecord>();
  for (const entry of records) {
    const uuid = string(entry.record.uuid);
    if (!uuid) continue;
    const previous = byUuid.get(uuid);
    // Conflicting identities make even an apparently valid ancestor ambiguous.
    if (previous && JSON.stringify(previous.record) !== JSON.stringify(entry.record)) return undefined;
    if (!previous) byUuid.set(uuid, entry);
  }

  const preservedParents = claudePreservedParents(records, byUuid);
  if (!preservedParents) return undefined;
  const accepted: TranscriptRecord[] = [];
  let segmentStart = 0;
  let segmentIndex = 0;
  let segmentHasLinks = false;
  let leaf: TranscriptRecord | undefined;
  const resolve = (endIndex: number): boolean => {
    // A wholly legacy segment separated by an explicit /clear reset is unambiguous.
    // Never use this fallback for mixed linked/unlinked records in the same segment.
    if (!segmentHasLinks) {
      for (let index = segmentIndex; index < endIndex; index++) accepted.push(records[index]);
      return true;
    }
    let entry = leaf;
    const path: TranscriptRecord[] = [];
    const visited = new Set<TranscriptRecord>();
    while (entry) {
      const { record, lineNumber } = entry;
      if (visited.has(entry) || !string(record.uuid) || byUuid.get(string(record.uuid)) !== entry) return false;
      visited.add(entry);
      if (claudeChainEntry(record) && object(record.message)?.role !== record.type) return false;
      path.push(entry);
      // A recognized local reset is also an explicit root in older exports that
      // omitted parentUuid on the /clear row itself. Relocations override raw roots.
      const relocated = preservedParents.has(entry);
      if (!relocated && (record.parentUuid === null || lineNumber === segmentStart && !Object.hasOwn(record, 'parentUuid'))) break;
      const parent = preservedParents.get(entry) ?? byUuid.get(string(record.parentUuid));
      // No fallback to an earlier leaf: that could resurrect a discarded rewind.
      // Verified relocation edges may run forward; raw parents must still be older.
      if (!parent || !relocated && parent.lineNumber >= lineNumber || parent.lineNumber < segmentStart) return false;
      entry = parent;
    }
    for (const ancestor of path.reverse()) accepted.push(ancestor);
    return true;
  };
  for (const [index, entry] of records.entries()) {
    const { record } = entry;
    const uuid = string(record.uuid);
    // Exact duplicate rows do not move the active leaf back or create another reset.
    if (uuid && byUuid.get(uuid) !== entry) continue;
    const conversation = claudeChainEntry(record);
    const clearReset = claudeClearReset(record);
    // /clear is a local reset, not a rewind. Keep each reset's accepted conversation,
    // including a nonempty pre-clear segment when the final segment is just artifacts.
    if (clearReset) {
      if (!resolve(index)) return undefined;
      segmentStart = entry.lineNumber;
      segmentIndex = index;
      segmentHasLinks = false;
      leaf = undefined;
    }
    segmentHasLinks ||= !clearReset && Object.hasOwn(record, 'parentUuid');
    if (conversation) leaf = entry;
  }
  return resolve(records.length) ? accepted : undefined;
}

type ParsedTranscript = { session: ParsedChatImport; malformedLines: number }
  | { session?: undefined; skipReason: ChatImportSkipReason; malformedLines: number; refusedSourceSessionId?: string };

function parseTranscript(source: ChatImportSource, contents: string, filename: string): ParsedTranscript {
  const items: TranscriptItem[] = [];
  const codexEntries: CodexImportEntry[] = [];
  const seen = new Set<string>();
  let sourceSessionId = '';
  let projectRoot = '';
  let title = '';
  let createdAt: number | undefined;
  let updatedAt: number | undefined;
  let malformedLines = 0;
  let subagent = false;
  let hasLines = false;
  let recognizedHistory = false;
  const records: TranscriptRecord[] = [];
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.trim()) continue;
    hasLines = true;
    let record: RecordValue | undefined;
    try { record = object(JSON.parse(line)); } catch { malformedLines++; continue; }
    if (!record) { malformedLines++; continue; }
    records.push({ record, lineNumber: index + 1 });
  }
  const claudeChain = source === 'claude' ? claudeAcceptedChain(records, malformedLines) : undefined;
  if (source === 'claude' && !claudeChain) return { skipReason: 'invalidHistory', malformedLines };
  // Session metadata and timestamps retain physical-file semantics. Conversation text
  // is extracted separately in logical parent order, which preservation can relocate.
  const claudeTimestamps = new Map<TranscriptRecord, number>();
  if (source === 'claude') {
    for (const entry of records) {
      const { record } = entry;
      const ts = timestamp(record.timestamp);
      if (ts) {
        createdAt = Math.min(createdAt ?? ts, ts);
        updatedAt = Math.max(updatedAt ?? ts, ts);
      }
      claudeTimestamps.set(entry, ts ?? updatedAt ?? 0);
      if (record.type === 'agent-setting') subagent = true;
      if (record.isSidechain === true || record.isMeta === true || record.parent_tool_use_id != null) {
        recognizedHistory = true;
        continue;
      }
      if (record.type === 'custom-title') title = string(record.customTitle) || title;
    }
  }
  for (const entry of source === 'claude' ? claudeChain! : records) {
    const { record, lineNumber } = entry;
    const ts = timestamp(record.timestamp);
    if (ts) {
      createdAt = Math.min(createdAt ?? ts, ts);
      updatedAt = Math.max(updatedAt ?? ts, ts);
    }
    if (source === 'claude') {
      if (record.type === 'agent-setting') subagent = true;
      if (record.isSidechain === true || record.isMeta === true || record.parent_tool_use_id != null) {
        recognizedHistory = true;
        continue;
      }
      sourceSessionId ||= string(record.sessionId);
      projectRoot ||= absoluteCwd(record.cwd);
      if (record.type !== 'user' && record.type !== 'assistant') continue;
      const message = object(record.message);
      if (!message || message.role !== record.type) continue;
      recognizedHistory = true;
      const text = textContent(message.content, ['text'], record.type === 'user' ? claudeUserText : undefined);
      if (!text.trim()) continue;
      const uuid = string(record.uuid);
      if (uuid && seen.has(uuid)) continue;
      if (uuid) seen.add(uuid);
      const item = { id: `import-${hash(`${source}:${uuid || lineNumber}`)}`, ts: claudeTimestamps.get(entry) ?? 0, text };
      items.push(record.type === 'user' ? { ...item, kind: 'user' } : { ...item, kind: 'assistant', ...(typeof message.model === 'string' ? { model: message.model } : {}) });
    } else {
      const payload = object(record.payload);
      if (!payload) continue;
      if (record.type === 'event_msg' && payload.type === 'thread_rolled_back') {
        const count = payload.num_turns;
        // An invalid mutation marker makes the surviving history unknowable: skip the file.
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 0xFFFF_FFFF) return { skipReason: 'invalidHistory', malformedLines: malformedLines + 1 };
        rollbackCodex(codexEntries, seen, count);
        continue;
      }
      if (record.type === 'inter_agent_communication' || record.type === 'response_item' && payload.type === 'agent_message') {
        codexEntries.push({ sourceId: '', boundary: true });
        continue;
      }
      if (record.type === 'session_meta') {
        // A paginated child stores only a local suffix. Reconstructing its immutable
        // prefix needs physical rollout identity plus validated byte/ordinal cutoffs.
        // Until supported, refuse every declared base rather than creating incomplete
        // continuation context. Only classify its shape here; never follow source paths.
        // https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/thread-store/src/local/rollout_lineage.rs
        const historyMode = payload.history_mode === undefined ? 'legacy' : payload.history_mode;
        if (historyMode !== 'legacy' && historyMode !== 'paginated') return { skipReason: 'invalidHistory', malformedLines, refusedSourceSessionId: string(payload.id) };
        if (payload.history_base != null) {
          const base = object(payload.history_base);
          const validBase = historyMode === 'paginated' && base
            && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(string(base.thread_id))
            && typeof base.end_ordinal_exclusive === 'number' && Number.isSafeInteger(base.end_ordinal_exclusive) && base.end_ordinal_exclusive > 0
            && typeof base.end_byte_offset === 'number' && Number.isSafeInteger(base.end_byte_offset) && base.end_byte_offset > 0;
          return { skipReason: validBase ? 'unsupportedHistory' : 'invalidHistory', malformedLines, refusedSourceSessionId: string(payload.id) };
        }
        recognizedHistory = true;
        sourceSessionId ||= string(payload.id);
        projectRoot ||= absoluteCwd(payload.cwd);
        const sessionSource = object(payload.source);
        subagent ||= !!sessionSource?.subagent || string(payload.source).startsWith('subagent') || !!payload.parent_thread_id;
        const start = timestamp(payload.timestamp);
        if (start) createdAt = Math.min(createdAt ?? start, start);
      }
      if (record.type === 'turn_context') projectRoot ||= absoluteCwd(payload.cwd);
      // event_msg mirrors the same conversation; importing both duplicates every turn.
      if (record.type !== 'response_item' || payload.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) continue;
      recognizedHistory = true;
      if (payload.role === 'assistant' && payload.channel === 'analysis') continue;
      if (payload.role === 'user' && isCodexContext(payload.content)) continue;
      const messageId = string(payload.id);
      if (messageId && seen.has(messageId)) continue;
      if (messageId) seen.add(messageId);
      const text = textContent(payload.content, ['input_text', 'output_text']);
      const instruction = payload.role === 'assistant' && isCodexAgentInstruction(payload.content);
      const entry: CodexImportEntry = { sourceId: messageId, boundary: payload.role === 'user' || instruction };
      codexEntries.push(entry);
      if (!text.trim() || instruction) continue;
      const item = { id: `import-${hash(`${source}:${messageId || lineNumber}`)}`, ts: ts ?? updatedAt ?? 0, text };
      const phase = payload.phase === 'final_answer' ? 'final' : payload.phase === 'commentary' || payload.channel === 'commentary' ? 'commentary' : undefined;
      entry.item = payload.role === 'user' ? { ...item, kind: 'user' } : { ...item, kind: 'assistant', ...(phase ? { phase } : {}) };
    }
  }
  if (source === 'codex') items.push(...codexEntries.flatMap((entry) => entry.item ? [entry.item] : []));
  if (subagent) return { skipReason: 'subagent', malformedLines };
  if (!items.length) return { skipReason: !hasLines || recognizedHistory || sourceSessionId || projectRoot ? 'empty' : 'invalidHistory', malformedLines };
  if (!projectRoot) return { skipReason: 'missingProject', malformedLines };
  // Filenames are only a fallback for older transcripts without provider metadata.
  sourceSessionId ||= path.basename(filename, '.jsonl');
  const id = `${source}-${hash(sourceSessionId)}`;
  const firstUser = items.find((item) => item.kind === 'user');
  title = (title || (firstUser && 'text' in firstUser ? firstUser.text : '') || `Imported ${source === 'claude' ? 'Claude Code' : 'Codex'} chat`).replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    session: {
      candidate: { id, source, sourceSessionId, title, projectRoot, createdAt: createdAt ?? 0, updatedAt: updatedAt ?? createdAt ?? 0, messageCount: items.length },
      items: items.map((item) => ({ ...item, id: `${id}-${item.id}`, ts: item.ts || createdAt || 0 })),
    },
    malformedLines,
  };
}
