/**
 * Settings → Pi. Manages base pi's global configuration only: the curated settings.json keys,
 * the three prompt files, and enable/disable for the resources pi loads from its agent dir.
 * Third-party packages and pi-subagents agents are pi's own business and stay untouched.
 */
import React, { useEffect, useState } from 'react';
import type { PiPreferences, PiPreferencesPatch, PiPromptName, PiResourceItem, PiResourceType, PiSetup } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { Badge, Button, Field, Spinner, Toggle } from './ui';

const TYPE_ORDER: PiResourceType[] = ['extensions', 'skills', 'prompts', 'themes'];
const TYPE_LABELS: Record<PiResourceType, string> = {
  extensions: 'Extensions',
  skills: 'Skills',
  prompts: 'Prompt templates',
  themes: 'Themes'
};
const TYPE_HINTS: Record<PiResourceType, string> = {
  extensions: 'Modules pi loads and runs in-process. Only install ones you trust.',
  skills: 'SKILL.md folders the agent can pull in on demand.',
  prompts: 'Markdown templates exposed as /commands in the pi CLI.',
  themes: 'Terminal themes for pi\u2019s own TUI.'
};
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const TRANSPORTS: [string, string][] = [
  ['auto', 'Auto'],
  ['sse', 'SSE'],
  ['websocket', 'WebSocket'],
  ['websocket-cached', 'WebSocket (cached)']
];
const TRUST_LEVELS: [string, string][] = [
  ['ask', 'Ask in the terminal'],
  ['always', 'Always trust'],
  ['never', 'Never trust']
];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Absolute paths are noise in the list; show them relative to the agent dir. */
function relativeTo(agentDir: string, p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const prefix = agentDir.endsWith(sep) ? agentDir : agentDir + sep;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

export function PiSection() {
  const [setup, setSetup] = useState<PiSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [promptName, setPromptName] = useState<PiPromptName>('AGENTS.md');
  const [drafts, setDrafts] = useState<Partial<Record<PiPromptName, string>>>({});
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<string | null>(null);
  const toast = useStore((s) => s.toast);
  const setView = useStore((s) => s.setView);

  const reload = (): void => {
    invoke('pi:setup', undefined)
      .then((s) => {
        setSetup(s);
        setLoadError(null);
      })
      .catch((e) => setLoadError(errorMessage(e)));
  };
  useEffect(reload, []);

  const apply = async (next: Promise<PiSetup>): Promise<void> => {
    try {
      setSetup(await next);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const savePref = (key: keyof PiPreferences, value: PiPreferences[keyof PiPreferences] | null): void => {
    void apply(invoke('pi:preferences', { [key]: value } as PiPreferencesPatch));
  };

  const promptFile = setup?.promptFiles.find((f) => f.name === promptName);
  const draft = drafts[promptName] ?? promptFile?.content ?? '';
  const dirty = !!promptFile && draft !== promptFile.content;
  const locked = !setup || !!setup.settingsError;

  const savePrompt = async (): Promise<void> => {
    setSavingPrompt(true);
    try {
      const next = await invoke('pi:prompt:write', { name: promptName, content: draft });
      setDrafts((d) => {
        const copy = { ...d };
        delete copy[promptName];
        return copy;
      });
      setSetup(next);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSavingPrompt(false);
    }
  };

  return (
    <div className="settings-section">
      <h2>Pi</h2>
      <p className="muted">
        Base pi&rsquo;s global configuration, shared with the pi CLI. Every Vocs Code pi session reads it at startup; changes apply to the next session.
      </p>

      {loadError && (
        <div className="info-line info-error">
          <span>{loadError}</span>
          <Button size="sm" variant="ghost" onClick={reload}>
            Retry
          </Button>
        </div>
      )}

      {!setup && !loadError && <Spinner />}

      {setup && (
        <>
          <div className="pi-head">
            <code className="mono small">{setup.agentDir}</code>
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon="folder" onClick={() => void invoke('pi:reveal', {})}>
              Open folder
            </Button>
            <Button size="sm" variant="ghost" icon="refresh" onClick={reload}>
              Refresh
            </Button>
          </div>

          {setup.settingsError && (
            <div className="info-line info-error">
              <span>{setup.settingsError}</span>
            </div>
          )}

          <h3>Preferences</h3>
          <p className="muted small">
            Written to <code>{setup.settingsPath}</code>. Fields left on &ldquo;pi default&rdquo; keep whatever pi itself has; other keys in the file are preserved.
          </p>
          <Field label="Startup thinking level" hint="Used when a session has no effort level of its own.">
            <select disabled={locked} value={setup.preferences.defaultThinkingLevel ?? ''} onChange={(e) => savePref('defaultThinkingLevel', e.target.value || null)}>
              <option value="">pi default</option>
              {THINKING_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Project trust" hint="In Vocs Code, pi runs non-interactively, so this decides whether a project's own .pi settings and resources load.">
            <select disabled={locked} value={setup.preferences.defaultProjectTrust ?? ''} onChange={(e) => savePref('defaultProjectTrust', e.target.value || null)}>
              <option value="">pi default (ask)</option>
              {TRUST_LEVELS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Transport" hint="Preferred transport for providers that support several.">
            <select disabled={locked} value={setup.preferences.transport ?? ''} onChange={(e) => savePref('transport', e.target.value || null)}>
              <option value="">pi default (auto)</option>
              {TRANSPORTS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="HTTP proxy" hint="Applied as HTTP_PROXY/HTTPS_PROXY to pi's provider calls. Empty restores the environment default.">
            <input
              disabled={locked}
              placeholder="http://proxy:8080"
              value={proxyDraft ?? setup.preferences.httpProxy ?? ''}
              onChange={(e) => setProxyDraft(e.target.value)}
              onBlur={() => {
                if (proxyDraft === null) return;
                const v = proxyDraft.trim();
                setProxyDraft(null);
                if (v !== (setup.preferences.httpProxy ?? '')) savePref('httpProxy', v || null);
              }}
            />
          </Field>
          <Toggle
            checked={setup.preferences.showCacheMissNotices ?? false}
            onChange={(v) => savePref('showCacheMissNotices', v)}
            label="Show notices for cache misses, compaction and provider recovery"
          />
          <Toggle
            checked={setup.preferences.enableSkillCommands ?? true}
            onChange={(v) => savePref('enableSkillCommands', v)}
            label="Register skills as /skill:name commands"
          />

          <h3>Compaction and retry</h3>
          <Toggle checked={setup.preferences.compactionEnabled ?? true} onChange={(v) => savePref('compactionEnabled', v)} label="Auto-compaction" />
          <div className="pi-inline">
            <Field label="Reserve tokens" hint="Kept for the model's reply.">
              <input
                type="number"
                min={1024}
                disabled={locked}
                defaultValue={setup.preferences.compactionReserveTokens ?? ''}
                placeholder="16384"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.preferences.compactionReserveTokens) savePref('compactionReserveTokens', Number(v));
                }}
              />
            </Field>
            <Field label="Keep recent tokens" hint="Never summarized.">
              <input
                type="number"
                min={1024}
                disabled={locked}
                defaultValue={setup.preferences.compactionKeepRecentTokens ?? ''}
                placeholder="20000"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.preferences.compactionKeepRecentTokens) savePref('compactionKeepRecentTokens', Number(v));
                }}
              />
            </Field>
          </div>
          <Toggle checked={setup.preferences.retryEnabled ?? true} onChange={(v) => savePref('retryEnabled', v)} label="Retry transient provider errors" />
          <div className="pi-inline">
            <Field label="Max retries">
              <input
                type="number"
                min={0}
                max={10}
                disabled={locked}
                defaultValue={setup.preferences.retryMaxRetries ?? ''}
                placeholder="3"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.preferences.retryMaxRetries) savePref('retryMaxRetries', Number(v));
                }}
              />
            </Field>
            <Field label="Base delay (ms)">
              <input
                type="number"
                min={100}
                max={60000}
                disabled={locked}
                defaultValue={setup.preferences.retryBaseDelayMs ?? ''}
                placeholder="2000"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.preferences.retryBaseDelayMs) savePref('retryBaseDelayMs', Number(v));
                }}
              />
            </Field>
          </div>

          <h3>System prompt files</h3>
          <p className="muted small">
            Global instruction files in the agent dir. <code>AGENTS.md</code> adds project-agnostic instructions, <code>APPEND_SYSTEM.md</code> appends to pi&rsquo;s system prompt, and <code>SYSTEM.md</code> replaces it entirely. Saving an empty file removes it.
          </p>
          <div className="pi-tabs">
            {setup.promptFiles.map((f) => (
              <button key={f.name} type="button" className={`pi-tab ${promptName === f.name ? 'active' : ''}`} onClick={() => setPromptName(f.name)}>
                {f.name}
                {f.truncated ? <Badge tone="amber">too large</Badge> : !f.exists ? <Badge tone="neutral">not set</Badge> : null}
              </button>
            ))}
          </div>
          {promptFile?.truncated ? (
            <div className="info-line info-warn">
              <span>This file is larger than 512 KB; edit it in an external editor.</span>
              <Button size="sm" variant="ghost" icon="edit" onClick={() => void invoke('pi:openInEditor', { path: promptFile.path })}>
                Open
              </Button>
            </div>
          ) : (
            <>
              <textarea className="pi-prompt-editor" spellCheck={false} disabled={locked} value={draft} onChange={(e) => setDrafts((d) => ({ ...d, [promptName]: e.target.value }))} placeholder={`${promptName} is not set`} />
              <div className="pi-prompt-actions">
                <span className="muted small mono">{promptFile?.path}</span>
                <span className="spacer" />
                <Button size="sm" variant="ghost" disabled={!dirty || locked} onClick={() => setDrafts((d) => ({ ...d, [promptName]: promptFile?.content ?? '' }))}>
                  Revert
                </Button>
                <Button size="sm" disabled={!dirty || locked || savingPrompt} onClick={() => void savePrompt()}>
                  {savingPrompt ? <Spinner /> : 'Save'}
                </Button>
              </div>
            </>
          )}

          <h3>Resources</h3>
          <p className="muted small">
            What pi will load from <code>{setup.agentDir}</code>. Toggling writes pi&rsquo;s own <code>+</code>/<code>-</code> patterns into settings.json, the same way <code>pi config</code> does. Packages installed with <code>pi install</code> are managed by pi and not listed here.
          </p>
          {setup.resources.length === 0 && <p className="muted small">No resources found yet. Add folders under extensions/, skills/, prompts/ or themes/.</p>}
          {TYPE_ORDER.map((type) => {
            const items = setup.resources.filter((r) => r.type === type);
            if (!items.length) return null;
            return (
              <div key={type} className="pi-resource-group">
                <h4>
                  {TYPE_LABELS[type]} <span className="muted small">{items.length}</span>
                  {type === 'skills' && (
                    <Button size="sm" variant="ghost" onClick={() => setView('skills')}>
                      Manage skills
                    </Button>
                  )}
                </h4>
                <p className="muted small">{TYPE_HINTS[type]}</p>
                {items.map((r) => (
                  <ResourceRow key={`${r.type}:${r.path}`} resource={r} agentDir={setup.agentDir} disabled={locked} onToggle={(enabled) => void apply(invoke('pi:resource', { type: r.type, path: r.path, enabled }))} onOpen={() => void openResource(r.path, toast)} />
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

async function openResource(path: string, toast: (text: string, kind?: 'info' | 'error') => void): Promise<void> {
  const res = await invoke('pi:openInEditor', { path });
  if (!res.ok && res.error) toast(res.error, 'error');
}

function ResourceRow({ resource, agentDir, disabled, onToggle, onOpen }: { resource: PiResourceItem; agentDir: string; disabled: boolean; onToggle: (enabled: boolean) => void; onOpen: () => void }) {
  return (
    <div className={`pi-resource ${resource.enabled ? '' : 'disabled'}`}>
      <Toggle checked={resource.enabled} onChange={onToggle} disabled={disabled} />
      <div className="pi-resource-main">
        <div className="row gap8">
          <strong>{resource.name}</strong>
          {resource.forced && <Badge tone="neutral">pinned</Badge>}
        </div>
        {resource.description && <div className="muted small">{resource.description}</div>}
        <div className="muted small mono">{relativeTo(agentDir, resource.path)}</div>
      </div>
      <span className="spacer" />
      <Button size="sm" variant="ghost" icon="edit" title="Open in editor" disabled={disabled} onClick={onOpen} />
    </div>
  );
}
