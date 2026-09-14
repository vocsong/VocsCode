/**
 * Settings → Pi. Manages pi's global configuration: curated settings.json keys, prompt files,
 * base-pi resources, installed packages (install/remove/update plus per-resource filters) and
 * pi-subagents' agents/subagents.json. Package commands shell out to the user's own pi binary.
 */
import React, { useEffect, useState } from 'react';
import type { PiPackageItem, PiPreferences, PiPreferencesPatch, PiPromptName, PiResourceItem, PiResourceType, PiSetup, PiSubagentsPatch, PiSubagentsSettings } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { askConfirm, Badge, Button, Field, Icon, Spinner, Toggle } from './ui';

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
  const [promptName, setPromptName] = useState<PiPromptName>('SYSTEM.md');
  const [drafts, setDrafts] = useState<Partial<Record<PiPromptName, string>>>({});
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState('');
  const [packageBusy, setPackageBusy] = useState(false);
  const [packageLog, setPackageLog] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);
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
  const saveSubagent = (key: keyof PiSubagentsSettings, value: PiSubagentsSettings[keyof PiSubagentsSettings] | null): void => {
    void apply(invoke('pi:subagents', { [key]: value } as PiSubagentsPatch));
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

  /** Runs one pi package command and refreshes the file-derived state afterwards. */
  const runPackage = async (action: 'install' | 'remove' | 'update', source?: string): Promise<void> => {
    setPackageBusy(true);
    setPackageLog(null);
    try {
      const res =
        action === 'install'
          ? await invoke('pi:package:install', { source: source! })
          : action === 'remove'
            ? await invoke('pi:package:remove', { source: source! })
            : await invoke('pi:package:update', source ? { source } : {});
      const done = action === 'install' ? 'installed' : action === 'remove' ? 'removed' : 'updated';
      setPackageLog(res.ok ? { ok: true, text: `${source ?? 'All packages'} ${done}.` } : { ok: false, text: res.error ?? 'pi command failed.', detail: res.log });
      reload();
    } catch (e) {
      setPackageLog({ ok: false, text: errorMessage(e) });
    } finally {
      setPackageBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    const source = installSource.trim();
    if (!source) return;
    const ok = await askConfirm({
      title: 'Install pi package?',
      body: `pi will fetch "${source}" and load the code it contains into every pi session, including Vocs Code sessions. Only install sources you trust.`,
      confirmLabel: 'Install'
    });
    if (!ok) return;
    setInstallSource('');
    await runPackage('install', source);
  };

  const remove = async (pkg: PiPackageItem): Promise<void> => {
    const ok = await askConfirm({
      title: 'Remove pi package?',
      body:
        pkg.kind === 'local'
          ? `"${pkg.source}" will be removed from settings.json. The folder itself is left on disk.`
          : `"${pkg.source}" will be removed from settings.json and its fetched files deleted from disk.`,
      confirmLabel: 'Remove',
      danger: true
    });
    if (ok) await runPackage('remove', pkg.source);
  };

  return (
    <div className="settings-section">
      <h2>Pi</h2>
      <div className="info-line info-warn">
        <Icon name="alert" size={13} />
        <span>
          These are your machine&rsquo;s <strong>global pi settings</strong>
          {setup ? (
            <>
              {' '}
              in <code>{setup.agentDir}</code>
            </>
          ) : null}
          , shared with the pi CLI and every other tool using that install. Anything you change here affects <strong>all</strong> pi sessions, not only Vocs Code, and applies the next time pi starts.
        </span>
      </div>
      <p className="muted">Pi&rsquo;s configuration files, packages and resources.</p>

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
            Global instruction files in the agent dir. <code>SYSTEM.md</code> replaces pi&rsquo;s system prompt entirely, <code>APPEND_SYSTEM.md</code> appends to it, and <code>AGENTS.md</code> adds project-agnostic instructions. Saving an empty file removes it.
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
            What pi loads from <code>{setup.agentDir}</code> outside packages. Toggling writes pi&rsquo;s own <code>+</code>/<code>-</code> patterns into settings.json, the same way <code>pi config</code> does.
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
                  <ResourceRow key={`${r.type}:${r.path}`} resource={r} baseDir={setup.agentDir} disabled={locked} onToggle={(enabled) => void apply(invoke('pi:resource', { type: r.type, path: r.path, enabled }))} onOpen={() => void openResource(r.path, toast)} />
                ))}
              </div>
            );
          })}

          <h3>Packages</h3>
          <p className="muted small">
            Packages from <code>settings.json</code> — git repositories, npm packages or local folders — and the resources they provide. Installing runs third-party code in every pi session, so only add sources you trust. Removal deletes the fetched files.
          </p>
          {!setup.piAvailable && (
            <div className="info-line info-warn">
              <span>pi isn&rsquo;t on this machine, so packages can&rsquo;t be installed, removed or updated. Install pi under Settings → Harnesses first.</span>
            </div>
          )}
          <div className="pi-package-install">
            <input
              value={installSource}
              onChange={(e) => setInstallSource(e.target.value)}
              disabled={packageBusy || !setup.piAvailable}
              placeholder="git:github.com/user/repo, npm:@scope/pkg or ./local/path"
              aria-label="Package source"
            />
            <Button size="sm" disabled={!installSource.trim() || packageBusy || !setup.piAvailable} onClick={() => void install()}>
              {packageBusy ? <Spinner /> : 'Install'}
            </Button>
            <Button size="sm" variant="ghost" disabled={packageBusy || !setup.piAvailable} onClick={() => void runPackage('update')}>
              Update all
            </Button>
          </div>
          {packageLog && (
            <div className={packageLog.ok ? 'info-line' : 'info-line info-error'}>
              <span>{packageLog.text}</span>
              {packageLog.detail && <pre className="pi-package-log">{packageLog.detail.slice(-4000)}</pre>}
            </div>
          )}
          {setup.packages.length === 0 && <p className="muted small">No packages installed.</p>}
          {setup.packages.map((pkg) => (
            <div key={pkg.source} className="provider-card pi-package">
              <div className="provider-head">
                <span className="provider-name">{pkg.name ?? pkg.source}</span>
                {pkg.name && <span className="muted small mono">{pkg.source}</span>}
                <Badge tone="neutral">{pkg.kind}</Badge>
                {!pkg.installed && <Badge tone="amber">not fetched</Badge>}
                {!pkg.autoload && <Badge tone="purple">autoload off</Badge>}
                <span className="spacer" />
                {pkg.installed && pkg.path.startsWith(setup.agentDir) && (
                  <Button size="sm" variant="ghost" icon="folder" title="Reveal in file manager" onClick={() => void invoke('pi:reveal', { path: pkg.path })} />
                )}
                <Button size="sm" variant="ghost" disabled={packageBusy || !setup.piAvailable} onClick={() => void runPackage('update', pkg.source)}>
                  Update
                </Button>
                <Button size="sm" variant="ghost" icon="trash" title="Remove package" disabled={packageBusy || !setup.piAvailable} onClick={() => void remove(pkg)} />
              </div>
              <div className="provider-body">
                {pkg.error && <div className="muted small">{pkg.error}</div>}
                {!pkg.error && pkg.resources.length === 0 && <div className="muted small">No extensions, skills, prompts or themes in this package.</div>}
                {pkg.resources.map((r) => (
                  <ResourceRow
                    key={`${r.type}:${r.path}`}
                    resource={r}
                    baseDir={pkg.path}
                    disabled={locked || packageBusy}
                    onToggle={(enabled) => void apply(invoke('pi:package:resource', { source: pkg.source, type: r.type, path: r.path, enabled }))}
                    onOpen={() => void openResource(r.path, toast)}
                  />
                ))}
              </div>
            </div>
          ))}

          <h3>Subagents</h3>
          <p className="muted small">
            pi-subagents&rsquo; global settings in <code>{setup.agentDir}/subagents.json</code> and the custom agents it loads from <code>agents/</code>. Built-in agents (general-purpose, Explore, Plan) are unaffected unless you disable them.
          </p>
          {setup.subagentsError && (
            <div className="info-line info-error">
              <span>{setup.subagentsError}</span>
            </div>
          )}
          <Toggle checked={setup.subagents.reportUsage ?? false} onChange={(v) => saveSubagent('reportUsage', v)} label="Report subagent spend to the parent session (Vocs Code analytics and /cost)" />
          <Toggle checked={setup.subagents.showCost ?? false} onChange={(v) => saveSubagent('showCost', v)} label="Show estimated cost next to subagent token counts" />
          <Toggle checked={setup.subagents.showModel ?? false} onChange={(v) => saveSubagent('showModel', v)} label="Show each agent's model in the subagent widget" />
          <div className="pi-inline">
            <Field label="Max subagent depth" hint="0 or 1 disables nesting; default 2.">
              <input
                type="number"
                min={0}
                max={16}
                defaultValue={setup.subagents.maxSubagentDepth ?? ''}
                placeholder="2"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.subagents.maxSubagentDepth) saveSubagent('maxSubagentDepth', Number(v));
                }}
              />
            </Field>
            <Field label="Max concurrent agents" hint="Background pool; default 4.">
              <input
                type="number"
                min={1}
                max={1024}
                defaultValue={setup.subagents.maxConcurrent ?? ''}
                placeholder="4"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.subagents.maxConcurrent) saveSubagent('maxConcurrent', Number(v));
                }}
              />
            </Field>
            <Field label="Max foreground agents" hint="0 = unlimited.">
              <input
                type="number"
                min={0}
                max={1024}
                defaultValue={setup.subagents.maxConcurrentForeground ?? ''}
                placeholder="0"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.subagents.maxConcurrentForeground) saveSubagent('maxConcurrentForeground', Number(v));
                }}
              />
            </Field>
            <Field label="Default max turns" hint="Per agent; 0 = provider default.">
              <input
                type="number"
                min={0}
                max={10000}
                defaultValue={setup.subagents.defaultMaxTurns ?? ''}
                placeholder="0"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') return;
                  if (Number(v) !== setup.subagents.defaultMaxTurns) saveSubagent('defaultMaxTurns', Number(v));
                }}
              />
            </Field>
          </div>
          <Toggle checked={setup.subagents.backgroundByDefault ?? false} onChange={(v) => saveSubagent('backgroundByDefault', v)} label="Start new agents in the background by default" />
          <Toggle checked={setup.subagents.worktreeIsolation ?? false} onChange={(v) => saveSubagent('worktreeIsolation', v)} label="Run isolated agents in git worktrees" />
          <Toggle checked={setup.subagents.rememberAgents ?? true} onChange={(v) => saveSubagent('rememberAgents', v)} label="Persist subagent sessions so @handle can resume them" />
          <Toggle checked={setup.subagents.strictAgentFiles ?? false} onChange={(v) => saveSubagent('strictAgentFiles', v)} label="Fail on malformed agent files instead of skipping them" />
          <Toggle checked={setup.subagents.disableDefaultAgents ?? false} onChange={(v) => saveSubagent('disableDefaultAgents', v)} label="Disable the built-in agents (general-purpose, Explore, Plan)" />
          <Field label="Fallback agent type" hint="Used when a requested type does not resolve. Empty keeps general-purpose; “none” fails instead.">
            <input
              defaultValue={setup.subagents.fallbackSubagent ?? ''}
              placeholder="general-purpose"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === (setup.subagents.fallbackSubagent ?? '')) return;
                saveSubagent('fallbackSubagent', v || null);
              }}
            />
          </Field>

          <div className="pi-resource-group">
            <h4>
              Custom agents <span className="muted small">{setup.agents.length}</span>
            </h4>
            {setup.agents.length === 0 && <p className="muted small">No agent files in {setup.agentDir}/agents.</p>}
            {setup.agents.map((a) => (
              <div className="pi-resource" key={a.path}>
                <div className="pi-resource-main">
                  <div className="row gap8">
                    <strong>{a.name}</strong>
                    {a.model && <Badge tone="neutral">{a.model}</Badge>}
                  </div>
                  {a.description && <div className="muted small">{a.description}</div>}
                  <div className="muted small mono">{relativeTo(setup.agentDir, a.path)}</div>
                </div>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon="edit" title="Open in editor" onClick={() => void openResource(a.path, toast)} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

async function openResource(path: string, toast: (text: string, kind?: 'info' | 'error') => void): Promise<void> {
  const res = await invoke('pi:openInEditor', { path });
  if (!res.ok && res.error) toast(res.error, 'error');
}

function ResourceRow({ resource, baseDir, disabled, onToggle, onOpen }: { resource: PiResourceItem; baseDir: string; disabled: boolean; onToggle: (enabled: boolean) => void; onOpen: () => void }) {
  return (
    <div className={`pi-resource ${resource.enabled ? '' : 'disabled'}`}>
      <Toggle checked={resource.enabled} onChange={onToggle} disabled={disabled} />
      <div className="pi-resource-main">
        <div className="row gap8">
          <strong>{resource.name}</strong>
          {resource.forced && <Badge tone="neutral">pinned</Badge>}
        </div>
        {resource.description && <div className="muted small">{resource.description}</div>}
        <div className="muted small mono">{relativeTo(baseDir, resource.path)}</div>
      </div>
      <span className="spacer" />
      <Button size="sm" variant="ghost" icon="edit" title="Open in editor" disabled={disabled} onClick={onOpen} />
    </div>
  );
}
