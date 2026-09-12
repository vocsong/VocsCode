/**
 * Reading and writing MCP server definitions: the repo's `.mcp.json`, and each harness's own
 * store (`~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, `.vscode/mcp.json`,
 * `.gemini/settings.json`). No Electron imports, so this is testable in plain Node.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerDef, McpStoreInfo, McpTransport } from '../../shared/types';
import { errorMessage } from '../util/async';

/** The repo-level file, in the shape Claude Code, Cursor and VS Code all understand. */
export const PROJECT_MCP_FILE = '.mcp.json';

export function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
}

/** Same path with the home directory shortened to `~` and separators normalized, for display. */
export function shortHome(p: string, home = homeDir()): string {
  const abs = path.resolve(p);
  const h = path.resolve(home);
  const rest = abs.startsWith(h + path.sep) ? abs.slice(h.length + 1) : abs === h ? '' : null;
  return (rest === null ? abs : `~/${rest}`).replace(/\\/g, '/');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length ? out : undefined;
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
  }
  return Object.keys(out).length ? out : undefined;
}

/** A server id must be usable as a tool-name segment (`mcp__<id>__<tool>`). */
export function isValidServerId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id);
}

/**
 * One entry of a JSON MCP config. Accepts the four dialects in the wild: `command` (stdio),
 * `url` + optional `type`, VS Code's explicit `type: 'stdio' | 'http' | 'sse'`, and Gemini's
 * `httpUrl`.
 */
export function parseServerEntry(id: string, raw: unknown): McpServerDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const declared = str(r.type)?.toLowerCase();
  const url = str(r.url) ?? str(r.httpUrl) ?? str(r.serverUrl);
  const command = str(r.command);
  let transport: McpTransport;
  if (declared === 'sse') transport = 'sse';
  else if (declared === 'http' || declared === 'streamable-http' || declared === 'streamablehttp') transport = 'http';
  else if (declared === 'stdio') transport = 'stdio';
  else transport = url && !command ? 'http' : 'stdio';
  const def: McpServerDef = { id, transport };
  if (transport === 'stdio') {
    if (!command) return null;
    def.command = command;
    def.args = strArray(r.args);
    def.env = strRecord(r.env);
  } else {
    if (!url) return null;
    def.url = url;
    def.headers = strRecord(r.headers);
  }
  const description = str(r.description);
  if (description) def.description = description;
  if (r.disabled === true || r.enabled === false) def.disabled = true;
  return def;
}

/** Parses a JSON MCP config; accepts both the `mcpServers` and VS Code's `servers` key. */
export function parseMcpJson(raw: string): { servers: McpServerDef[]; error?: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    return { servers: [], error: `Invalid JSON: ${errorMessage(e)}` };
  }
  if (!doc || typeof doc !== 'object') return { servers: [], error: 'Expected a JSON object' };
  const d = doc as Record<string, unknown>;
  const table = (d.mcpServers ?? d.servers) as unknown;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { servers: [] };
  const servers: McpServerDef[] = [];
  for (const [id, entry] of Object.entries(table as Record<string, unknown>)) {
    if (!isValidServerId(id)) continue;
    const def = parseServerEntry(id, entry);
    if (def) servers.push(def);
  }
  return { servers };
}

/** The portable `.mcp.json` entry for one server. App-only fields are deliberately not written. */
export function toMcpJsonEntry(def: McpServerDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (def.transport === 'stdio') {
    out.command = def.command ?? '';
    if (def.args?.length) out.args = def.args;
    if (def.env && Object.keys(def.env).length) out.env = def.env;
  } else {
    out.type = def.transport;
    out.url = def.url ?? '';
    if (def.headers && Object.keys(def.headers).length) out.headers = def.headers;
  }
  if (def.description) out.description = def.description;
  return out;
}

export function toMcpJsonTable(servers: McpServerDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of servers) out[s.id] = toMcpJsonEntry(s);
  return out;
}

// ---------------------------------------------------------------------------
// Codex config.toml: just enough TOML to read `[mcp_servers.<name>]` tables.
// ---------------------------------------------------------------------------

type TomlValue = string | number | boolean | TomlArray | TomlTable;
interface TomlArray extends Array<TomlValue> {}
interface TomlTable {
  [key: string]: TomlValue;
}

/** Reads one TOML scalar, array or inline table. Returns the value and the rest of the line. */
function readTomlValue(text: string): { value: TomlValue; rest: string } | null {
  const s = text.trimStart();
  if (s.startsWith('"""') || s.startsWith("'''")) {
    const q = s.slice(0, 3);
    const end = s.indexOf(q, 3);
    if (end < 0) return null;
    return { value: s.slice(3, end), rest: s.slice(end + 3) };
  }
  if (s.startsWith('"')) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        const n = s[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '\\' ? '\\' : n === '"' ? '"' : n ?? '';
        continue;
      }
      if (c === '"') return { value: out, rest: s.slice(i + 1) };
      out += c;
    }
    return null;
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    if (end < 0) return null;
    return { value: s.slice(1, end), rest: s.slice(end + 1) };
  }
  if (s.startsWith('[')) {
    const items: TomlValue[] = [];
    let rest = s.slice(1);
    for (;;) {
      rest = rest.trimStart();
      if (rest.startsWith(']')) return { value: items, rest: rest.slice(1) };
      if (!rest) return null;
      const item = readTomlValue(rest);
      if (!item) return null;
      items.push(item.value);
      rest = item.rest.trimStart();
      if (rest.startsWith(',')) rest = rest.slice(1);
    }
  }
  if (s.startsWith('{')) {
    const obj: Record<string, TomlValue> = {};
    let rest = s.slice(1);
    for (;;) {
      rest = rest.trimStart();
      if (rest.startsWith('}')) return { value: obj, rest: rest.slice(1) };
      const kv = /^("([^"]*)"|'([^']*)'|[A-Za-z0-9_-]+)\s*=\s*/.exec(rest);
      if (!kv) return null;
      const key = kv[2] ?? kv[3] ?? kv[1];
      const item = readTomlValue(rest.slice(kv[0].length));
      if (!item) return null;
      obj[key] = item.value;
      rest = item.rest.trimStart();
      if (rest.startsWith(',')) rest = rest.slice(1);
    }
  }
  const scalar = /^[^\s#,\]}]+/.exec(s);
  if (!scalar) return null;
  const t = scalar[0];
  const value: TomlValue = t === 'true' ? true : t === 'false' ? false : Number.isFinite(Number(t)) ? Number(t) : t;
  return { value, rest: s.slice(scalar[0].length) };
}

/** Splits a dotted TOML key path, honouring quoted segments. */
function splitKeyPath(key: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^.\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(key))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Extracts the `mcp_servers` table from a Codex `config.toml`. Only the subset Codex documents
 * for MCP is understood; everything else in the file is ignored.
 */
export function parseCodexMcpToml(raw: string): McpServerDef[] {
  const tables = new Map<string, Record<string, TomlValue>>();
  let current: string[] | null = null;
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(t);
    if (header) {
      current = splitKeyPath(header[1]);
      continue;
    }
    if (!current || current[0] !== 'mcp_servers' || current.length < 2) continue;
    const kv = /^("([^"]*)"|'([^']*)'|[A-Za-z0-9_.-]+)\s*=\s*/.exec(t);
    if (!kv) continue;
    const parsed = readTomlValue(t.slice(kv[0].length));
    if (!parsed) continue;
    const key = kv[2] ?? kv[3] ?? kv[1];
    const table = current.slice(2).concat(splitKeyPath(key).slice(0, -1));
    const leaf = splitKeyPath(key).at(-1) ?? key;
    const name = current[1];
    const bucket = tables.get(name) ?? {};
    let target: Record<string, TomlValue> = bucket;
    for (const seg of table) {
      const next = target[seg];
      if (!next || typeof next !== 'object' || Array.isArray(next)) target[seg] = {};
      target = target[seg] as Record<string, TomlValue>;
    }
    target[leaf] = parsed.value;
    tables.set(name, bucket);
  }

  const servers: McpServerDef[] = [];
  for (const [name, t] of tables) {
    if (!isValidServerId(name)) continue;
    const url = typeof t.url === 'string' ? t.url : undefined;
    const command = typeof t.command === 'string' ? t.command : undefined;
    const def: McpServerDef = { id: name, transport: url && !command ? 'http' : 'stdio' };
    if (def.transport === 'stdio') {
      if (!command) continue;
      def.command = command;
      if (Array.isArray(t.args)) def.args = t.args.filter((a): a is string => typeof a === 'string');
      const env = strRecord(t.env);
      if (env) def.env = env;
    } else {
      def.url = url;
      const headers: Record<string, string> = { ...(strRecord(t.http_headers) ?? {}) };
      // Codex reads these two from its own environment; represent them the way this app does.
      for (const [h, varName] of Object.entries(strRecord(t.env_http_headers) ?? {})) headers[h] = `\${${varName}}`;
      if (typeof t.bearer_token_env_var === 'string') headers.Authorization = `Bearer \${${t.bearer_token_env_var}}`;
      if (Object.keys(headers).length) def.headers = headers;
    }
    const timeout = typeof t.tool_timeout_sec === 'number' ? t.tool_timeout_sec : undefined;
    if (timeout) def.timeoutMs = Math.round(timeout * 1000);
    if (t.enabled === false) def.disabled = true;
    servers.push(def);
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Stores on disk
// ---------------------------------------------------------------------------

export interface McpStoreSpec {
  id: string;
  label: string;
  path: string;
  format: 'json' | 'toml';
}

/** Every harness's global MCP store, in harness-meta display order. */
export function globalStores(home = homeDir()): McpStoreSpec[] {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return [
    { id: 'claude', label: 'Claude', path: path.join(claudeDir || home, '.claude.json'), format: 'json' },
    { id: 'codex', label: 'Codex', path: path.join(home, '.codex', 'config.toml'), format: 'toml' },
    { id: 'cursor', label: 'Cursor', path: path.join(home, '.cursor', 'mcp.json'), format: 'json' }
  ];
}

/** Harness-native project files that may sit next to the repo's own `.mcp.json`. */
export function projectStores(cwd: string): McpStoreSpec[] {
  return [
    { id: 'cursor', label: 'Cursor', path: path.join(cwd, '.cursor', 'mcp.json'), format: 'json' },
    { id: 'vscode', label: 'VS Code', path: path.join(cwd, '.vscode', 'mcp.json'), format: 'json' },
    { id: 'gemini', label: 'Gemini CLI', path: path.join(cwd, '.gemini', 'settings.json'), format: 'json' }
  ];
}

export async function readStore(spec: McpStoreSpec, home = homeDir()): Promise<McpStoreInfo> {
  const base: McpStoreInfo = { id: spec.id, label: spec.label, path: spec.path, display: shortHome(spec.path, home), exists: false, servers: [] };
  let raw: string;
  try {
    raw = await fs.readFile(spec.path, 'utf8');
  } catch {
    return base;
  }
  if (spec.format === 'toml') return { ...base, exists: true, servers: parseCodexMcpToml(raw) };
  const { servers, error } = parseMcpJson(raw);
  return { ...base, exists: true, servers, error };
}

export async function readStores(specs: McpStoreSpec[], home = homeDir()): Promise<McpStoreInfo[]> {
  return Promise.all(specs.map((s) => readStore(s, home)));
}

export interface ProjectMcpFile {
  file: string;
  exists: boolean;
  servers: McpServerDef[];
  error?: string;
}

/** Reads `<cwd>/.mcp.json`. A missing file is not an error — it is the common case. */
export async function readProjectMcp(cwd: string): Promise<ProjectMcpFile> {
  const file = path.join(cwd, PROJECT_MCP_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { file, exists: false, servers: [] };
  }
  const { servers, error } = parseMcpJson(raw);
  return { file, exists: true, servers, error };
}

/**
 * Rewrites the `mcpServers` table of `<cwd>/.mcp.json`, preserving any other top-level keys the
 * file already had. A file this app cannot parse is never overwritten.
 */
export async function writeProjectMcp(cwd: string, servers: McpServerDef[]): Promise<{ ok: boolean; file: string; error?: string }> {
  const file = path.join(cwd, PROJECT_MCP_FILE);
  let doc: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, file, error: 'Existing .mcp.json is not a JSON object; not overwriting it.' };
    doc = parsed as Record<string, unknown>;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') return { ok: false, file, error: errorMessage(e) };
    if (!code) return { ok: false, file, error: `Existing .mcp.json could not be parsed (${errorMessage(e)}); not overwriting it.` };
  }
  // VS Code's key wins if the file already used it, so an existing file keeps its dialect.
  const key = 'mcpServers' in doc || !('servers' in doc) ? 'mcpServers' : 'servers';
  doc[key] = toMcpJsonTable(servers);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, error: errorMessage(e) };
  }
}
