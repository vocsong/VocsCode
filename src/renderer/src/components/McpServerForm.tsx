/** The MCP server editor, shared by the global MCP page and the per-repo right-panel tab. */
import React, { useEffect, useMemo, useState } from 'react';
import type { HarnessId, McpInspectResult, McpServerDef, McpTransport } from '../../../shared/types';
import { HARNESSES } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { Badge, Button, Field, Icon, Spinner } from './ui';

/** Harnesses that can actually be handed a server; the rest read their own store or have no seam. */
export const MCP_TARGET_HARNESSES = HARNESSES.filter((h) => h.capabilities.mcp === 'inject' || h.capabilities.mcp === 'client');

export function emptyServer(): McpServerDef {
  return { id: '', transport: 'stdio', command: '', args: [] };
}

/** `KEY=value` lines, the shape both env and headers are edited in. */
export function parsePairs(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const at = t.indexOf('=');
    if (at <= 0) continue;
    const key = t.slice(0, at).trim();
    if (key) out[key] = t.slice(at + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function formatPairs(rec: Record<string, string> | undefined): string {
  return Object.entries(rec ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Every `${VAR}` the definition references, in the order they appear. */
export function referencedVars(def: McpServerDef): string[] {
  const out: string[] = [];
  const scan = (v: string | undefined) => {
    for (const m of (v ?? '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  };
  scan(def.url);
  for (const v of Object.values(def.env ?? {})) scan(v);
  for (const v of Object.values(def.headers ?? {})) scan(v);
  return out;
}

export function serverSummary(def: McpServerDef): string {
  return def.transport === 'stdio' ? [def.command, ...(def.args ?? [])].join(' ') : def.url ?? '';
}

export interface McpServerFormProps {
  value: McpServerDef;
  /** Repo files carry only the portable fields, so harness scoping and timeout are hidden there. */
  portableOnly?: boolean;
  /** Ids already used in the same store, so an edit cannot collide with another row. */
  takenIds?: string[];
  /** Lets "Test connection" spawn the server in the session's working directory. */
  sessionId?: string;
  onSave: (def: McpServerDef) => void;
  onCancel: () => void;
}

export function McpServerForm({ value, portableOnly, takenIds = [], sessionId, onSave, onCancel }: McpServerFormProps) {
  const [draft, setDraft] = useState<McpServerDef>(value);
  const [envText, setEnvText] = useState(formatPairs(value.env));
  const [headerText, setHeaderText] = useState(formatPairs(value.headers));
  const [probe, setProbe] = useState<McpInspectResult | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    setDraft(value);
    setEnvText(formatPairs(value.env));
    setHeaderText(formatPairs(value.headers));
    setProbe(null);
  }, [value]);

  const built = useMemo((): McpServerDef => {
    const def: McpServerDef = { id: draft.id.trim(), transport: draft.transport, ...(draft.description ? { description: draft.description } : {}) };
    if (draft.transport === 'stdio') {
      def.command = draft.command?.trim();
      if (draft.args?.length) def.args = draft.args;
      def.env = parsePairs(envText);
    } else {
      def.url = draft.url?.trim();
      def.headers = parsePairs(headerText);
    }
    if (!portableOnly) {
      if (draft.harnesses?.length) def.harnesses = draft.harnesses;
      if (draft.timeoutMs) def.timeoutMs = draft.timeoutMs;
      if (draft.disabled) def.disabled = true;
    }
    return def;
  }, [draft, envText, headerText, portableOnly]);

  const idTaken = !!built.id && takenIds.some((x) => x !== value.id && x === built.id);
  const idValid = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(built.id);
  const complete = built.transport === 'stdio' ? !!built.command : /^https?:\/\//i.test(built.url ?? '');
  const error = !built.id ? 'A name is required.' : !idValid ? 'Use letters, digits, dot, dash or underscore.' : idTaken ? 'That name is already used here.' : !complete ? (built.transport === 'stdio' ? 'A command is required.' : 'An http:// or https:// URL is required.') : null;

  const test = async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await invoke('mcp:inspect', { def: built, sessionId }));
    } finally {
      setProbing(false);
    }
  };

  const toggleHarness = (id: HarnessId) => {
    const cur = draft.harnesses ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setDraft({ ...draft, harnesses: next.length ? next : undefined });
  };

  return (
    <div className="mcp-form">
      <div className="row gap8">
        <Field label="Name" hint="The agent sees tools as mcp__<name>__<tool>.">
          <input value={draft.id} placeholder="github" onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        </Field>
        <Field label="Transport">
          <div className="segmented">
            {(['stdio', 'http', 'sse'] as McpTransport[]).map((t) => (
              <button key={t} type="button" className={`segment ${draft.transport === t ? 'active' : ''}`} onClick={() => setDraft({ ...draft, transport: t })}>
                {t}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <div className="row gap8">
            <Field label="Command" hint="A .cmd shim such as npx is resolved and wrapped for Windows automatically.">
              <input value={draft.command ?? ''} placeholder="npx" onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
            </Field>
            <Field label="Arguments" hint="Space separated.">
              <input value={(draft.args ?? []).join(' ')} placeholder="-y @modelcontextprotocol/server-filesystem ." onChange={(e) => setDraft({ ...draft, args: e.target.value.split(/\s+/).filter(Boolean) })} />
            </Field>
          </div>
          <Field label="Environment" hint="One KEY=value per line. Use ${VAR} for anything secret — the value is kept in the OS keychain, never in the file.">
            <textarea rows={3} className="mono" value={envText} placeholder="GITHUB_TOKEN=${GITHUB_TOKEN}" onChange={(e) => setEnvText(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <input value={draft.url ?? ''} placeholder="https://mcp.example.com/mcp" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </Field>
          <Field label="Headers" hint="One Name=value per line. Use ${VAR} for anything secret.">
            <textarea rows={3} className="mono" value={headerText} placeholder="Authorization=Bearer ${EXAMPLE_TOKEN}" onChange={(e) => setHeaderText(e.target.value)} />
          </Field>
        </>
      )}

      <Field label="Description" hint="Shown in the lists; optional.">
        <input value={draft.description ?? ''} placeholder="Issues and pull requests" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </Field>

      {!portableOnly && (
        <div className="row gap8">
          <Field label="Harnesses" hint="Leave all off to offer this server to every harness that can take it.">
            <div className="mcp-chips">
              {MCP_TARGET_HARNESSES.map((h) => (
                <button key={h.id} type="button" className={`mcp-chip ${draft.harnesses?.includes(h.id) ? 'active' : ''}`} title={h.name} onClick={() => toggleHarness(h.id)}>
                  {h.name}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Tool timeout" hint="Milliseconds; passed through where the harness supports it.">
            <input type="number" min={0} step={1000} value={draft.timeoutMs ?? ''} placeholder="30000" onChange={(e) => setDraft({ ...draft, timeoutMs: Number(e.target.value) || undefined })} />
          </Field>
        </div>
      )}

      <SecretFields def={built} />

      {probe && <ProbeResult result={probe} />}

      <div className="row gap8">
        <Button variant="primary" size="sm" disabled={!!error} onClick={() => onSave(built)}>
          Save
        </Button>
        <Button size="sm" icon="bolt" disabled={!!error || probing} onClick={() => void test()}>
          {probing ? 'Connecting…' : 'Test connection'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="spacer" />
        {error && <span className="mcp-error small">{error}</span>}
      </div>
    </div>
  );
}

/** Values for the `${VAR}` references in a definition, stored in the OS keychain. */
function SecretFields({ def }: { def: McpServerDef }) {
  const vars = referencedVars(def);
  const [stored, setStored] = useState<Record<string, boolean>>({});
  const [entry, setEntry] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void Promise.all(vars.map(async (v) => [v, await invoke('secrets:has', { providerId: `mcp:${v}` })] as const)).then((pairs) => {
      if (alive) setStored(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
    // The set of names is what matters, not the array identity.
  }, [vars.join(' ')]);

  if (!vars.length) return null;
  const save = async (name: string) => {
    const value = entry[name] ?? '';
    if (value) await invoke('secrets:set', { providerId: `mcp:${name}`, apiKey: value });
    else await invoke('secrets:clear', { providerId: `mcp:${name}` });
    setEntry({ ...entry, [name]: '' });
    setStored({ ...stored, [name]: !!value });
  };

  return (
    <Field label="Values" hint="Each ${VAR} is read from your environment first, then from the app's encrypted store. Nothing typed here is written to the repo or the settings file.">
      <div className="mcp-secrets">
        {vars.map((name) => (
          <div key={name} className="mcp-secret-row">
            <code className="mono">{`\${${name}}`}</code>
            {stored[name] ? <Badge tone="green">stored</Badge> : <Badge tone="neutral">from environment</Badge>}
            <input type="password" placeholder={stored[name] ? 'Replace stored value' : 'Value'} value={entry[name] ?? ''} onChange={(e) => setEntry({ ...entry, [name]: e.target.value })} />
            <Button size="sm" variant="ghost" onClick={() => void save(name)}>
              {entry[name] ? 'Save' : stored[name] ? 'Clear' : 'Save'}
            </Button>
          </div>
        ))}
      </div>
    </Field>
  );
}

function ProbeResult({ result }: { result: McpInspectResult }) {
  if (!result.ok) {
    return (
      <div className="mcp-probe bad">
        <Icon name="alert" size={13} /> {result.error ?? 'Could not connect'}
      </div>
    );
  }
  return (
    <div className="mcp-probe good">
      <div className="mcp-probe-head">
        <Icon name="check" size={13} /> Connected in {result.durationMs} ms{result.serverInfo ? ` · ${result.serverInfo.name}${result.serverInfo.version ? ` ${result.serverInfo.version}` : ''}` : ''} · {result.tools.length} tool{result.tools.length === 1 ? '' : 's'}
      </div>
      <div className="mcp-probe-tools">
        {result.tools.slice(0, 40).map((t) => (
          <div key={t.name} className="mcp-probe-tool">
            <code className="mono">{t.name}</code>
            {t.description && <span className="muted small">{t.description}</span>}
          </div>
        ))}
        {result.tools.length > 40 && <div className="muted small">…and {result.tools.length - 40} more.</div>}
      </div>
    </div>
  );
}

export function ProbeBadge({ result }: { result: McpInspectResult | null }) {
  if (!result) return null;
  return result.ok ? <Badge tone="green">{result.tools.length} tools</Badge> : <Badge tone="red">failed</Badge>;
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="mcp-loading">
      <Spinner size={14} /> {label}
    </div>
  );
}
