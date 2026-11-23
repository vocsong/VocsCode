/**
 * Vocs Code — GitNexus scope proxy.
 *
 * GitNexus can serve one shared MCP server for every indexed repo
 * (`gitnexus serve`, Streamable HTTP at POST /api/mcp). A session must only
 * reach the repos in its allow-list, so Vocs Code injects this small stdio MCP
 * server into each harness: it forwards JSON-RPC to the shared HTTP server
 * while enforcing the per-session scope.
 *
 * Plain ESM, `node:` builtins and global `fetch` only — harnesses spawn it as
 * `node <path>`, so it can never depend on the app's TypeScript build.
 *
 * Scope rules (the security boundary):
 *   - `initialize` is answered locally after the proxy opens its own upstream
 *     session; `notifications/initialized` is answered locally.
 *   - `group_*` tools are hidden from `tools/list` and rejected from `tools/call`.
 *   - `list_repos` is forwarded then filtered to the allow-list.
 *   - every other tool is pinned to the session's primary repo when `repo` is
 *     absent, and rejected when `repo` names a repo outside the allow-list.
 *   - repo-scoped resources (`gitnexus://repo/<name>/...`) are rejected outside
 *     the allow-list; resources that do not reference a repo are kept.
 *
 * Anything malformed is answered with a JSON-RPC error — stdout only ever
 * carries JSON-RPC frames, diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const PROXY_SERVER_NAME = 'vocs-code-gitnexus-scope';
const PROXY_VERSION = '1.0.0';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const GROUP_TOOL_PREFIX = 'group_';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/* ──────────────────────────── allow-list helpers ─────────────────────────── */

/** Normalise a filesystem path for comparison (separators, trailing slash, case). */
function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Normalise a repo name for comparison. */
function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Does `value` (a repo name or path) match any entry in the allow-list, by name
 * or by path? Empty/absent values never match — callers decide the default.
 */
function matchesAllow(value, allow) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  const list = Array.isArray(allow) ? allow : [];
  const pathValue = normalizePath(raw);
  const nameValue = normalizeName(raw);
  return list.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.name === 'string' && entry.name && normalizeName(entry.name) === nameValue) return true;
    if (typeof entry.path === 'string' && entry.path && normalizePath(entry.path) === pathValue) return true;
    return false;
  });
}

/**
 * Parse `VOCS_GITNEXUS_ALLOW` (a JSON array of `{name, path}`) into a clean
 * list. A malformed value denies everything rather than widening access.
 */
export function parseAllow(raw) {
  if (Array.isArray(raw)) return sanitizeAllow(raw);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    return sanitizeAllow(JSON.parse(raw));
  } catch {
    process.stderr.write('vocs-code-gitnexus-scope: VOCS_GITNEXUS_ALLOW is not valid JSON; denying all repos\n');
    return [];
  }
}

function sanitizeAllow(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const repoPath = typeof entry.path === 'string' ? entry.path : '';
    if (!name && !repoPath) continue;
    out.push({ name, path: repoPath });
  }
  return out;
}

/** Extract `gitnexus://repo/<name>/...` → `<name>`, else null. */
function repoNameFromUri(uri) {
  if (typeof uri !== 'string') return null;
  const match = uri.match(/^gitnexus:\/\/repo\/([^/?#]+)(?:[/?#]|$)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function entryAllowed(name, path, allow) {
  if (!name && !path) return false; // unknown shape: drop rather than widen
  return (name && matchesAllow(name, allow)) || (path && matchesAllow(path, allow));
}

/**
 * May a `tools/call` target this repo argument? An absent (undefined/null/empty)
 * `repo` is valid: the caller defaults it to the session's primary repo.
 */
export function repoAllowed(repoArg, allow) {
  if (repoArg === undefined || repoArg === null) return true;
  const value = String(repoArg).trim();
  if (!value) return true;
  return matchesAllow(value, allow);
}

/**
 * May a resource be surfaced? A URI that is not `gitnexus://repo/<name>/...`
 * does not reference a repo and is kept; a repo-scoped URI must be allow-listed.
 */
export function resourceAllowed(uri, allow) {
  const name = repoNameFromUri(uri);
  if (name === null) return true;
  return matchesAllow(name, allow);
}

/* ─────────────────────────────── filtering ──────────────────────────────── */

/** Drop cross-repo `group_*` tools; keep everything else (including `list_repos`). */
export function filterTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string' && !tool.name.startsWith(GROUP_TOOL_PREFIX));
}

function stripQuotes(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** Find the end index of the first balanced JSON array/object starting at 0. */
function findJsonEnd(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Filter a parsed repo list (array, or object carrying one under a known key). */
function filterRepoJson(value, allow) {
  const drop = (entry) => !entryAllowed(entry?.name, entry?.path, allow);
  if (Array.isArray(value)) return value.filter((entry) => !drop(entry));
  if (value && typeof value === 'object') {
    for (const key of ['repos', 'repositories', 'results', 'entries', 'items']) {
      if (Array.isArray(value[key])) return { ...value, [key]: value[key].filter((entry) => !drop(entry)) };
    }
  }
  return undefined;
}

/** Try to filter a JSON repo-list payload, optionally with a trailing text suffix. */
function filterJsonListText(text, allow) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const direct = tryParseJson(trimmed);
  if (direct.ok) {
    const filtered = filterRepoJson(direct.value, allow);
    if (filtered !== undefined) return JSON.stringify(filtered, null, 2);
  }
  // GitNexus appends a markdown "next step" hint after the JSON payload.
  if (trimmed[0] === '[' || trimmed[0] === '{') {
    const end = findJsonEnd(trimmed);
    if (end > 0) {
      const parsed = tryParseJson(trimmed.slice(0, end));
      if (parsed.ok) {
        const filtered = filterRepoJson(parsed.value, allow);
        if (filtered !== undefined) return JSON.stringify(filtered, null, 2) + trimmed.slice(end);
      }
    }
  }
  return null;
}

function isDetailLine(line) {
  return /^\s*(path|indexed|commit|stats|files|symbols|edges|clusters|processes|name|repo|repos)\s*:/i.test(line);
}

/** Indexes of lines that begin a repo entry (YAML `- name:`, or a header above `Path:`). */
function entryStartIndices(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*-\s*name\s*:/i.test(line)) {
      starts.push(i);
      continue;
    }
    if (/^\s*path\s*:/i.test(line)) continue;
    const next = lines[i + 1] ?? '';
    if (/^\s*path\s*:\s*/i.test(next) && line.trim() !== '' && !isDetailLine(line)) starts.push(i);
  }
  return starts;
}

function extractNamePath(block) {
  const header = block[0] ?? '';
  let name = '';
  let path = '';
  const yamlName = header.match(/^\s*-\s*name\s*:\s*(.*)$/i);
  if (yamlName) {
    name = stripQuotes(yamlName[1]);
  } else {
    const summary = header.match(/^(.*?)\s+—\s+/);
    name = stripQuotes(summary ? summary[1] : header).replace(/^\s*-\s*/, '').trim();
  }
  for (const line of block) {
    const pathMatch = line.match(/^\s*path\s*:\s*(.*)$/i);
    if (pathMatch) {
      path = stripQuotes(pathMatch[1]);
      break;
    }
  }
  if (!name) {
    for (const line of block) {
      const nameMatch = line.match(/^\s*name\s*:\s*(.*)$/i);
      if (nameMatch) {
        name = stripQuotes(nameMatch[1]);
        break;
      }
    }
  }
  return { name, path };
}

/** Filter human/YAML text into blocks, keeping only allow-listed repo entries. */
function filterRepoBlocksText(text, allow) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const starts = entryStartIndices(lines);
  if (starts.length === 0) return null;
  const out = lines.slice(0, starts[0]);
  for (let i = 0; i < starts.length; i += 1) {
    const begin = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const block = lines.slice(begin, end);
    const { name, path } = extractNamePath(block);
    if (entryAllowed(name, path, allow)) out.push(...block);
  }
  return out.join('\n');
}

function redactedReposText(allow) {
  const names = (Array.isArray(allow) ? allow : []).map((entry) => entry?.name || entry?.path).filter(Boolean);
  return `repos: []\n# Vocs Code scope: this payload could not be filtered safely. Allowed repos: ${names.join(', ') || '(none)'}\n`;
}

/**
 * Filter a `list_repos` payload to the allow-list. Handles the JSON payload the
 * real GitNexus MCP server returns (with an appended markdown hint) and the
 * human/YAML renderings. If the shape is unknown it never widens access: text
 * that mentions a repo outside the allow-list is redacted to an empty list.
 */
export function filterListReposText(text, allow) {
  if (typeof text !== 'string' || !text) return text;
  const list = Array.isArray(allow) ? allow : [];
  const fromJson = filterJsonListText(text, list);
  if (fromJson !== null) return fromJson;
  const fromBlocks = filterRepoBlocksText(text, list);
  if (fromBlocks !== null) return fromBlocks;
  const refs = [...text.matchAll(/gitnexus:\/\/repo\/([^/\s"'\\)]+)/g)].map((match) => {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  });
  if (refs.some((ref) => !matchesAllow(ref, list))) return redactedReposText(list);
  return text;
}

/** Apply `filterListReposText` to every text part of an MCP tool-call result. */
function filterListReposResult(result, allow) {
  if (!result || typeof result !== 'object') return result;
  const next = { ...result };
  if (Array.isArray(result.content)) {
    next.content = result.content.map((part) => {
      if (part && part.type === 'text' && typeof part.text === 'string') return { ...part, text: filterListReposText(part.text, allow) };
      return part;
    });
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    const filtered = filterRepoJson(result.structuredContent, allow);
    if (filtered !== undefined) next.structuredContent = filtered;
  }
  return next;
}

/** Filter the Markdown sections of `gitnexus://setup` by repo name. */
function filterSetupText(text, allow) {
  if (typeof text !== 'string' || !text) return text;
  const parts = text.split(/\n-{3,}\n/);
  if (parts.length <= 1) return filterListReposText(text, allow);
  return parts
    .filter((part) => {
      const header = part.match(/#\s*GitNexus MCP\s+—\s+(.+)/);
      return !header || matchesAllow(header[1].trim(), allow);
    })
    .join('\n---\n');
}

/** Filter the all-repos resources (`gitnexus://repos`, `gitnexus://setup`). */
function filterResourceResult(result, allow, uri) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.contents)) return result;
  return {
    ...result,
    contents: result.contents.map((part) => {
      if (part && typeof part.text === 'string') {
        const text = uri === 'gitnexus://setup' ? filterSetupText(part.text, allow) : filterListReposText(part.text, allow);
        return { ...part, text };
      }
      return part;
    })
  };
}

/* ─────────────────────────── SSE / JSON-RPC parsing ─────────────────────── */

/** Parse a Streamable-HTTP SSE body and return the first JSON message. */
export function parseSseJson(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const events = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const event of events) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    const parsed = tryParseJson(data);
    if (parsed.ok) return parsed.value;
  }
  return undefined;
}

function asRpcError(error) {
  const rpc = new Error(typeof error?.message === 'string' ? error.message : 'upstream error');
  rpc.code = typeof error?.code === 'number' ? error.code : -32603;
  if (error?.data !== undefined) rpc.data = error.data;
  return rpc;
}

/* ───────────────────────────── upstream client ──────────────────────────── */

/**
 * Stateful Streamable-HTTP MCP client: POST JSON-RPC, capture `mcp-session-id`
 * on initialize, replay it on every later request, parse SSE or JSON responses
 * and re-initialize once when the upstream reports an expired session (404).
 */
export class UpstreamClient {
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.url = opts.url ?? process.env.VOCS_GITNEXUS_URL ?? '';
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.headers = opts.headers && typeof opts.headers === 'object' ? opts.headers : {};
    this.sessionId = null;
    this.protocolVersion = null;
    this._nextId = 1;
    this._initializePromise = null;
    if (typeof this.fetch !== 'function') throw new Error('UpstreamClient: fetch is not available');
  }

  /** Open (or reuse) the upstream session and send `notifications/initialized`. */
  async initialize() {
    if (!this._initializePromise) {
      this._initializePromise = this._initializeOnce().catch((error) => {
        this._initializePromise = null;
        throw error;
      });
    }
    return this._initializePromise;
  }

  async _initializeOnce() {
    this.sessionId = null;
    const response = await this._post({
      jsonrpc: '2.0',
      id: this._nextId++,
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: PROXY_SERVER_NAME, version: PROXY_VERSION }
      }
    });
    const { message } = await this._readResponse(response);
    if (message?.error) throw asRpcError(message.error);
    if (message?.result?.protocolVersion) this.protocolVersion = message.result.protocolVersion;
    await this._notify('notifications/initialized', {});
    return message?.result;
  }

  /** Send one request, retrying once after a re-initialize on session expiry. */
  async request(method, params) {
    if (!this.sessionId) await this.initialize();
    const send = () => this._post({ jsonrpc: '2.0', id: this._nextId++, method, params: params ?? {} });
    let response = await send();
    if (response.status === 404) {
      this.sessionId = null;
      this._initializePromise = null;
      await this.initialize();
      response = await send();
    }
    if (response.status >= 400) {
      await this._readResponse(response);
      throw new Error(`upstream ${method} failed with HTTP ${response.status}`);
    }
    const { message } = await this._readResponse(response);
    if (message?.error) throw asRpcError(message.error);
    return message?.result;
  }

  async _notify(method, params) {
    try {
      await this._post({ jsonrpc: '2.0', method, params: params ?? {} });
    } catch {
      // Notifications are best-effort; a failed one must not break the session.
    }
  }

  async _post(body) {
    // The upstream is one fixed URL; a redirect would carry the session headers somewhere else.
    const response = await this.fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body), redirect: 'manual' });
    if (response.type === 'opaqueredirect' || REDIRECT_STATUSES.has(response.status) || (response.status >= 300 && response.status < 400 && response.headers?.has?.('location'))) {
      try {
        await response.body?.cancel?.();
      } catch {
        // The body is discarded either way.
      }
      throw new Error(`upstream redirected (HTTP ${response.status}); update its URL`);
    }
    return response;
  }

  _headers() {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    return headers;
  }

  async _readResponse(response) {
    const headerId = response.headers?.get?.('mcp-session-id');
    if (headerId) this.sessionId = headerId;
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    let message;
    if (contentType.includes('text/event-stream') || /^\s*data:/.test(text) || /\ndata:/.test(text)) {
      message = parseSseJson(text);
    }
    if (message === undefined) {
      const parsed = tryParseJson(text.trim());
      if (parsed.ok) message = parsed.value;
    }
    return { message, text };
  }
}

/* ─────────────────────────────── stdio proxy ────────────────────────────── */

/**
 * Run the newline-delimited JSON-RPC loop against an injected upstream client.
 * Tests drive this directly; the CLI entry point below wires the real streams.
 */
export async function runScopeProxy({ input, output, upstream, env = process.env } = {}) {
  if (!input) throw new Error('runScopeProxy: input stream is required');
  if (!output) throw new Error('runScopeProxy: output stream is required');
  if (!upstream) throw new Error('runScopeProxy: upstream is required');

  const primary = env?.VOCS_GITNEXUS_PRIMARY ?? '';
  const allow = parseAllow(env?.VOCS_GITNEXUS_ALLOW);

  const write = (message) => {
    try {
      output.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Output closed; nothing useful to do.
    }
  };
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message, data) => write({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  let upstreamReady = false;
  const ensureUpstream = async () => {
    if (!upstreamReady) {
      await upstream.initialize();
      upstreamReady = true;
    }
  };

  const handleToolCall = async (id, params) => {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
    if (name.startsWith(GROUP_TOOL_PREFIX)) {
      respond(id, { content: [{ type: 'text', text: 'Group tools are unavailable in a scoped session.' }], isError: true });
      return;
    }
    await ensureUpstream();
    if (name === 'list_repos') {
      const result = await upstream.request('tools/call', { ...params, name, arguments: args });
      respond(id, filterListReposResult(result, allow));
      return;
    }
    const repo = args.repo;
    const pinned = repo === undefined || repo === null || (typeof repo === 'string' && repo.trim() === '');
    if (!pinned && !repoAllowed(repo, allow)) {
      respond(id, { content: [{ type: 'text', text: `Repository "${String(repo)}" is not in this session's GitNexus scope.` }], isError: true });
      return;
    }
    const nextParams = { ...params, name, arguments: pinned ? { ...args, repo: primary } : args };
    respond(id, await upstream.request('tools/call', nextParams));
  };

  const handleResourceRead = async (id, params) => {
    const uri = typeof params?.uri === 'string' ? params.uri : '';
    if (repoNameFromUri(uri) !== null && !resourceAllowed(uri, allow)) {
      respondError(id, -32002, `Resource "${uri}" is outside this session's GitNexus scope.`);
      return;
    }
    await ensureUpstream();
    const result = await upstream.request('resources/read', { ...params, uri });
    // Non-repo resources are kept, but the all-repos resources still enumerate
    // every indexed repo, so their text is filtered too.
    if (uri === 'gitnexus://repos' || uri === 'gitnexus://setup') {
      respond(id, filterResourceResult(result, allow, uri));
      return;
    }
    respond(id, result);
  };

  const handle = async (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      respondError(null, -32600, 'Invalid Request');
      return;
    }
    const id = message.id;
    const isNotification = id === undefined || id === null;
    const method = message.method;
    if (typeof method !== 'string') {
      if (!isNotification) respondError(id, -32600, 'Invalid Request: missing method');
      return;
    }
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    try {
      switch (method) {
        case 'initialize': {
          await ensureUpstream();
          respond(id, {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: PROXY_SERVER_NAME, version: PROXY_VERSION }
          });
          return;
        }
        case 'notifications/initialized':
          // Answered locally; the proxy already sent its own initialized upstream.
          return;
        case 'tools/list': {
          await ensureUpstream();
          const result = await upstream.request('tools/list', params);
          respond(id, { ...(result && typeof result === 'object' ? result : {}), tools: filterTools(result?.tools) });
          return;
        }
        case 'tools/call':
          await handleToolCall(id, params);
          return;
        case 'resources/list': {
          await ensureUpstream();
          const result = await upstream.request('resources/list', params);
          const resources = Array.isArray(result?.resources) ? result.resources : [];
          const filtered = resources.filter((resource) => resourceAllowed(resource?.uri, allow) && resourceAllowed(resource?.name, allow));
          respond(id, { ...(result && typeof result === 'object' ? result : {}), resources: filtered });
          return;
        }
        case 'resources/read':
          await handleResourceRead(id, params);
          return;
        case 'prompts/list':
        case 'prompts/get': {
          await ensureUpstream();
          respond(id, await upstream.request(method, params));
          return;
        }
        default: {
          // Forward unknown methods; if there is no upstream equivalent the
          // upstream's method-not-found error is passed straight back.
          await ensureUpstream();
          const result = await upstream.request(method, params);
          if (!isNotification) respond(id, result);
          return;
        }
      }
    } catch (error) {
      if (!isNotification) respondError(id, typeof error?.code === 'number' ? error.code : -32603, error?.message ?? 'Proxy error');
    }
  };

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = tryParseJson(trimmed);
    if (!parsed.ok) {
      respondError(null, -32700, 'Parse error');
      continue;
    }
    await handle(parsed.value);
  }
}

/* ─────────────────────────────── CLI entry ──────────────────────────────── */

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const upstream = new UpstreamClient({ url: process.env.VOCS_GITNEXUS_URL });
  runScopeProxy({ input: process.stdin, output: process.stdout, upstream, env: process.env }).catch((error) => {
    process.stderr.write(`vocs-code-gitnexus-scope: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
