import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatImportCandidate, ChatImportSource } from '../shared/chat-import';
import type { TranscriptItem } from '../shared/types';

export interface ParsedChatImport {
  candidate: ChatImportCandidate;
  items: TranscriptItem[];
}

export interface ChatImportDiscovery {
  sessions: ParsedChatImport[];
  skippedFiles: number;
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
  const result: ChatImportDiscovery = { sessions: [], skippedFiles: 0, malformedLines: 0, truncated: false };
  const sessions = new Map<string, ParsedChatImport>();
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
          const contents = await readTranscript(filename, Math.min(limits.maxFileBytes, limits.maxTotalBytes - bytes));
          bytes += contents.length;
          const parsed = parseTranscript(source, contents.toString('utf8'), filename);
          result.malformedLines += parsed.malformedLines;
          if (!parsed.session) {
            result.skippedFiles++;
            continue;
          }
          const previous = sessions.get(parsed.session.candidate.id);
          if (!previous || parsed.session.candidate.updatedAt > previous.candidate.updatedAt
            || (parsed.session.candidate.updatedAt === previous.candidate.updatedAt && parsed.session.items.length > previous.items.length)) {
            sessions.set(parsed.session.candidate.id, parsed.session);
          }
        } catch {
          // Counts are useful to the picker without exposing source paths, messages or errors.
          result.skippedFiles++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.skippedFiles++;
    }
  }

  // Refuse symlinked configuration roots, as well as linked child files/directories.
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.skippedFiles++;
    return result;
  }
  if (source === 'claude') await visit(path.join(root, 'projects'), 0);
  else {
    await visit(path.join(root, 'sessions'), 0);
    await visit(path.join(root, 'archived_sessions'), 0);
  }
  result.sessions = [...sessions.values()].sort((a, b) => b.candidate.updatedAt - a.candidate.updatedAt || a.candidate.id.localeCompare(b.candidate.id));
  return result;
}

async function readTranscript(filename: string, limit: number): Promise<Buffer> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Transcript exceeds import limit');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error('Transcript exceeds import limit');
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

function textContent(content: unknown, allowedTypes: readonly string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const value = object(part);
    return value && allowedTypes.includes(string(value.type)) ? string(value.text) : '';
  }).filter(Boolean).join('\n');
}

function absoluteCwd(value: unknown): string {
  const cwd = string(value);
  return cwd && !cwd.includes('\0') && (path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)) ? cwd : '';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseTranscript(source: ChatImportSource, contents: string, filename: string): { session?: ParsedChatImport; malformedLines: number } {
  const items: TranscriptItem[] = [];
  const seen = new Set<string>();
  let sourceSessionId = '';
  let projectRoot = '';
  let title = '';
  let createdAt: number | undefined;
  let updatedAt: number | undefined;
  let malformedLines = 0;
  let subagent = false;
  let lineNumber = 0;
  for (const line of contents.split('\n')) {
    lineNumber++;
    if (!line.trim()) continue;
    let record: RecordValue | undefined;
    try { record = object(JSON.parse(line)); } catch { malformedLines++; continue; }
    if (!record) { malformedLines++; continue; }
    const ts = timestamp(record.timestamp);
    if (ts) {
      createdAt = Math.min(createdAt ?? ts, ts);
      updatedAt = Math.max(updatedAt ?? ts, ts);
    }
    if (source === 'claude') {
      if (record.type === 'agent-setting') subagent = true;
      if (record.isSidechain === true || record.isMeta === true || record.parent_tool_use_id != null) continue;
      sourceSessionId ||= string(record.sessionId);
      projectRoot ||= absoluteCwd(record.cwd);
      if (record.type === 'custom-title') title = string(record.customTitle) || title;
      if (record.type !== 'user' && record.type !== 'assistant') continue;
      const message = object(record.message);
      if (!message || message.role !== record.type) continue;
      const text = textContent(message.content, ['text']);
      if (!text.trim()) continue;
      const uuid = string(record.uuid);
      if (uuid && seen.has(uuid)) continue;
      if (uuid) seen.add(uuid);
      const item = { id: `import-${hash(`${source}:${uuid || lineNumber}`)}`, ts: ts ?? updatedAt ?? 0, text };
      items.push(record.type === 'user' ? { ...item, kind: 'user' } : { ...item, kind: 'assistant', ...(typeof message.model === 'string' ? { model: message.model } : {}) });
    } else {
      const payload = object(record.payload);
      if (!payload) continue;
      if (record.type === 'session_meta') {
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
      if (payload.role === 'assistant' && payload.channel === 'analysis') continue;
      const text = textContent(payload.content, ['input_text', 'output_text']);
      if (!text.trim()) continue;
      const messageId = string(payload.id);
      if (messageId && seen.has(messageId)) continue;
      if (messageId) seen.add(messageId);
      const item = { id: `import-${hash(`${source}:${messageId || lineNumber}`)}`, ts: ts ?? updatedAt ?? 0, text };
      const phase = payload.phase === 'final_answer' ? 'final' : payload.phase === 'commentary' || payload.channel === 'commentary' ? 'commentary' : undefined;
      items.push(payload.role === 'user' ? { ...item, kind: 'user' } : { ...item, kind: 'assistant', ...(phase ? { phase } : {}) });
    }
  }
  if (subagent || !items.length || !projectRoot) return { malformedLines };
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
