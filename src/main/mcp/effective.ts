/**
 * The effective MCP set for a session, and the per-harness dialects it converts to.
 *
 * Three things happen here, in order: merge the global list with the repo file under the user's
 * per-repo switches (docs/MCP.md §2), resolve `${VAR}` references from the environment or the
 * secret store (§8), and normalize a stdio command so a Windows `.cmd` shim can actually be
 * spawned (§9). Adapters see only the result. No Electron imports.
 */
import type {
  McpEffectiveEntry,
  McpProjectState,
  McpServerDef,
  McpSupport,
  HarnessId
} from '../../shared/types';

export interface EffectiveInput {
  global: McpServerDef[];
  repo: McpServerDef[];
  state: McpProjectState;
  harness: HarnessId;
  support: McpSupport;
}

/**
 * Every defined server with its verdict for this session. A repo entry shadows a global one of
 * the same id, because the repo is the more specific scope.
 */
export function effectiveEntries(input: EffectiveInput): McpEffectiveEntry[] {
  const { global, repo, state, harness, support } = input;
  const injectable = support === 'inject' || support === 'client';
  const disabledGlobal = new Set(state.disabledGlobal ?? []);
  const enabledRepo = new Set(state.enabledRepo ?? []);
  const liveRepoIds = new Set(repo.filter((d) => enabledRepo.has(d.id)).map((d) => d.id));

  const verdict = (def: McpServerDef, scope: 'global' | 'repo'): McpEffectiveEntry => {
    const off = (reason: McpEffectiveEntry['reason']): McpEffectiveEntry => ({ def, scope, enabled: false, reason });
    if (scope === 'global') {
      if (def.disabled) return off('disabled');
      if (disabledGlobal.has(def.id)) return off('disabled');
      if (liveRepoIds.has(def.id)) return off('shadowed');
    } else if (!enabledRepo.has(def.id)) {
      return off('not-enabled');
    }
    if (def.harnesses?.length && !def.harnesses.includes(harness)) return off('harness-filtered');
    if (!injectable) return off('not-injected');
    return { def, scope, enabled: true };
  };

  return [...repo.map((d) => verdict(d, 'repo')), ...global.map((d) => verdict(d, 'global'))];
}

/** Just the servers a session should actually get, repo first. */
export function effectiveServers(input: EffectiveInput): McpServerDef[] {
  return effectiveEntries(input)
    .filter((e) => e.enabled)
    .map((e) => e.def);
}

// ---------------------------------------------------------------------------
// ${VAR} resolution
// ---------------------------------------------------------------------------

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function referencedVars(def: McpServerDef): string[] {
  const out = new Set<string>();
  const scan = (v: string | undefined) => {
    if (!v) return;
    for (const m of v.matchAll(VAR_RE)) out.add(m[1]);
  };
  scan(def.url);
  for (const v of Object.values(def.env ?? {})) scan(v);
  for (const v of Object.values(def.headers ?? {})) scan(v);
  return [...out];
}

export type SecretLookup = (varName: string) => Promise<string | undefined>;

/**
 * A server with its `${VAR}` references filled in. `secretEnvKeys` / `secretHeaderKeys` name the
 * fields that came from a reference rather than a literal the user typed — Codex's exec SDK
 * flattens its config into `--config` argv, so those must not be inlined there (§8).
 */
export interface ResolvedServer {
  def: McpServerDef;
  /** References that resolved to nothing; the field is left empty and the caller warns. */
  missing: string[];
  secretEnvKeys: string[];
  secretHeaderKeys: string[];
}

export async function resolveVars(def: McpServerDef, opts: { env?: NodeJS.ProcessEnv; secret?: SecretLookup }): Promise<ResolvedServer> {
  const env = opts.env ?? {};
  const missing = new Set<string>();
  const cache = new Map<string, string>();

  const value = async (name: string): Promise<string> => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const fromEnv = env[name];
    const v = (fromEnv !== undefined && fromEnv !== '' ? fromEnv : await opts.secret?.(name)) ?? '';
    if (!v) missing.add(name);
    cache.set(name, v);
    return v;
  };

  const expand = async (raw: string): Promise<{ text: string; referenced: boolean }> => {
    const names = [...raw.matchAll(VAR_RE)].map((m) => m[1]);
    if (!names.length) return { text: raw, referenced: false };
    let text = raw;
    for (const name of names) text = text.split(`\${${name}}`).join(await value(name));
    return { text, referenced: true };
  };

  const out: McpServerDef = { ...def };
  const secretEnvKeys: string[] = [];
  const secretHeaderKeys: string[] = [];

  if (def.url) out.url = (await expand(def.url)).text;
  if (def.env) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(def.env)) {
      const r = await expand(v);
      next[k] = r.text;
      if (r.referenced) secretEnvKeys.push(k);
    }
    out.env = next;
  }
  if (def.headers) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(def.headers)) {
      const r = await expand(v);
      next[k] = r.text;
      if (r.referenced) secretHeaderKeys.push(k);
    }
    out.headers = next;
  }
  return { def: out, missing: [...missing], secretEnvKeys, secretHeaderKeys };
}

// ---------------------------------------------------------------------------
// Windows shim normalisation
// ---------------------------------------------------------------------------

export interface NormalizeOpts {
  /** PATH lookup; the app's `which` from main/runtime.ts. */
  which?: (cmd: string) => string | null;
  platform?: NodeJS.Platform;
  comspec?: string;
}

/**
 * Resolves a stdio command to a real path, and wraps a Windows `.cmd` / `.bat` shim in
 * `cmd /c` so harnesses that call `child_process.spawn` directly do not fail with EINVAL.
 * This is the form the Codex CLI's own config uses for `npx` servers on Windows.
 */
export function normalizeStdio(def: McpServerDef, opts: NormalizeOpts = {}): McpServerDef {
  if (def.transport !== 'stdio' || !def.command) return def;
  const platform = opts.platform ?? process.platform;
  const args = def.args ?? [];
  const bare = def.command;
  if (platform === 'win32' && /^cmd(\.exe)?$/i.test(bare)) return def;
  const resolved = (opts.which?.(bare) ?? null) || bare;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) {
    return resolved === bare ? def : { ...def, command: resolved };
  }
  return { ...def, command: opts.comspec ?? process.env.ComSpec ?? 'cmd.exe', args: ['/c', resolved, ...args] };
}

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

export type ClaudeMcpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; timeout?: number }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; timeout?: number };

/** `Options.mcpServers` for the Claude Agent SDK. */
export function toClaude(defs: McpServerDef[]): Record<string, ClaudeMcpServer> {
  const out: Record<string, ClaudeMcpServer> = {};
  for (const d of defs) {
    // The SDK ignores a per-server timeout below a second; do not send one it would drop.
    const timeout = d.timeoutMs && d.timeoutMs >= 1000 ? d.timeoutMs : undefined;
    if (d.transport === 'stdio') {
      if (!d.command) continue;
      out[d.id] = { type: 'stdio', command: d.command, ...(d.args?.length ? { args: d.args } : {}), ...(d.env && Object.keys(d.env).length ? { env: d.env } : {}), ...(timeout ? { timeout } : {}) };
    } else {
      if (!d.url) continue;
      out[d.id] = { type: d.transport, url: d.url, ...(d.headers && Object.keys(d.headers).length ? { headers: d.headers } : {}), ...(timeout ? { timeout } : {}) };
    }
  }
  return out;
}

/** The value kinds this app ever writes into Codex's `mcp_servers` table. */
export type CodexTomlValue = string | number | boolean | string[] | Record<string, string>;

export interface CodexMcpConfig {
  /** The `mcp_servers` table for Codex's TOML config. */
  config: Record<string, Record<string, CodexTomlValue>>;
  /** Values the Codex process must carry in its environment, when secrets stay out of the table. */
  env: Record<string, string>;
}

/** A stable, shell-safe env var name for one server's header. */
export function codexHeaderVar(serverId: string, header: string): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `VOCS_MCP_${slug(serverId)}_${slug(header)}`;
}

/**
 * The `mcp_servers` table for Codex. In `env-ref` mode no resolved secret is written into the
 * table, because the exec SDK flattens it into `--config key=value` argv, which is visible in
 * the process list: stdio values are handed over through the Codex environment (`env_vars`) and
 * HTTP headers through `env_http_headers`.
 */
export function toCodex(servers: ResolvedServer[], mode: 'inline' | 'env-ref' = 'inline'): CodexMcpConfig {
  const config: Record<string, Record<string, CodexTomlValue>> = {};
  const env: Record<string, string> = {};
  for (const { def, secretEnvKeys, secretHeaderKeys } of servers) {
    const t: Record<string, CodexTomlValue> = {};
    if (def.transport === 'stdio') {
      if (!def.command) continue;
      t.command = def.command;
      if (def.args?.length) t.args = def.args;
      const plain: Record<string, string> = {};
      const passthrough: string[] = [];
      for (const [k, v] of Object.entries(def.env ?? {})) {
        if (mode === 'env-ref' && secretEnvKeys.includes(k)) {
          env[k] = v;
          passthrough.push(k);
        } else {
          plain[k] = v;
        }
      }
      if (Object.keys(plain).length) t.env = plain;
      if (passthrough.length) t.env_vars = passthrough;
    } else {
      if (!def.url) continue;
      t.url = def.url;
      const plain: Record<string, string> = {};
      const viaEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(def.headers ?? {})) {
        if (mode === 'env-ref' && secretHeaderKeys.includes(k)) {
          const name = codexHeaderVar(def.id, k);
          env[name] = v;
          viaEnv[k] = name;
        } else {
          plain[k] = v;
        }
      }
      if (Object.keys(plain).length) t.http_headers = plain;
      if (Object.keys(viaEnv).length) t.env_http_headers = viaEnv;
    }
    if (def.timeoutMs) t.tool_timeout_sec = Math.max(1, Math.round(def.timeoutMs / 1000));
    config[def.id] = t;
  }
  return { config, env };
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http' | 'sse'; name: string; url: string; headers: { name: string; value: string }[] };

/** `session/new.mcpServers`. HTTP and SSE entries are dropped unless the agent advertised them. */
export function toAcp(defs: McpServerDef[], caps: { http?: boolean; sse?: boolean } = {}): AcpMcpServer[] {
  const out: AcpMcpServer[] = [];
  for (const d of defs) {
    if (d.transport === 'stdio') {
      if (!d.command) continue;
      out.push({ name: d.id, command: d.command, args: d.args ?? [], env: Object.entries(d.env ?? {}).map(([name, value]) => ({ name, value })) });
      continue;
    }
    if (!d.url) continue;
    if (d.transport === 'http' && !caps.http) continue;
    if (d.transport === 'sse' && !caps.sse) continue;
    out.push({ type: d.transport, name: d.id, url: d.url, headers: Object.entries(d.headers ?? {}).map(([name, value]) => ({ name, value })) });
  }
  return out;
}
