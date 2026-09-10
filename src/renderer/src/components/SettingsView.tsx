/** Settings screen: harness detection and install, runtimes, providers and API keys. */
import React, { useEffect, useState } from 'react';
import type { AcpAgentPreset, AppSettings, DoctorReport, HarnessId, ProviderConfig } from '../../../shared/types';
import type { ShellKind, ShellOption, TerminalSettings } from '../../../shared/terminal';
import { HARNESSES, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { parseModelOverrideKey } from '../../../shared/model-overrides';
import { invoke } from '../api';
import { invoke, isMac, platform } from '../api';
import { useStore } from '../store';
import { Badge, Button, Field, Icon, Kbd, Spinner, Toggle } from './ui';

type Section = 'general' | 'terminal' | 'providers' | 'harnesses' | 'acp' | 'about';

export function SettingsView() {
  const settings = useStore((s) => s.settings)!;
  const setView = useStore((s) => s.setView);
  const [section, setSection] = useState<Section>('general');
  const update = (patch: Partial<AppSettings>) => void invoke('settings:update', patch);
  return (
    <div className="settings">
      <div className="settings-nav">
        <div className="settings-title">
          <Button variant="ghost" size="sm" icon="chevronRight" className="rot180" onClick={() => setView('chat')} title="Back" />
          Settings
        </div>
        {(
          [
            ['general', 'General', 'settings'],
            ['terminal', 'Terminal', 'terminal'],
            ['providers', 'Providers & keys', 'bolt'],
            ['harnesses', 'Harnesses', 'shield'],
            ['acp', 'ACP agents', 'fork'],
            ['about', 'About & doctor', 'info']
          ] as [Section, string, string][]
        ).map(([id, label, icon]) => (
          <button key={id} type="button" className={`settings-link ${section === id ? 'active' : ''}`} onClick={() => setSection(id)}>
            <Icon name={icon} size={14} /> {label}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {section === 'general' && <General settings={settings} update={update} />}
        {section === 'terminal' && <TerminalSection settings={settings} update={update} />}
        {section === 'providers' && <Providers settings={settings} />}
        {section === 'harnesses' && <Harnesses settings={settings} update={update} />}
        {section === 'acp' && <AcpAgents settings={settings} update={update} />}
        {section === 'about' && <About />}
      </div>
    </div>
  );
}

function General({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="settings-section">
      <h2>General</h2>
      <Field label="Theme">
        <select value={settings.theme} onChange={(e) => update({ theme: e.target.value as AppSettings['theme'] })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>
      <Field label="Default harness">
        <select value={settings.defaultHarness} onChange={(e) => update({ defaultHarness: e.target.value as HarnessId })}>
          {HARNESSES.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Default permission mode">
        <select value={settings.defaultPermissionMode} onChange={(e) => update({ defaultPermissionMode: e.target.value as AppSettings['defaultPermissionMode'] })}>
          {Object.entries(PERMISSION_MODE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Default reasoning effort">
        <select value={settings.defaultEffort ?? ''} onChange={(e) => update({ defaultEffort: (e.target.value || undefined) as AppSettings['defaultEffort'] })}>
          <option value="">Harness default</option>
          {['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Toggle checked={settings.notifications} onChange={(v) => update({ notifications: v })} label="Desktop notifications when a turn finishes or approval is needed (only while the window is unfocused)" />
      <h3>Goal defaults</h3>
      <Toggle checked={settings.goalDefaults.autoContinue} onChange={(v) => update({ goalDefaults: { ...settings.goalDefaults, autoContinue: v } })} label="Auto-continue goals after each turn" />
      <Field label="Iteration guard">
        <input type="number" min={1} max={500} value={settings.goalDefaults.maxIterations} onChange={(e) => update({ goalDefaults: { ...settings.goalDefaults, maxIterations: Number(e.target.value) || 25 } })} />
      </Field>
      <h3>Editor</h3>
      <Field label="Editor command" hint="Used by “Open in editor”. VS Code (code) supports jumping to a line.">
        <input value={settings.binaries.editor ?? ''} placeholder="code" onChange={(e) => update({ binaries: { ...settings.binaries, editor: e.target.value } })} />
      </Field>
    </div>
  );
}

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];
const SCROLLBACKS = [1_000, 5_000, 10_000, 20_000, 50_000, 100_000];

function TerminalSection({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const t = settings.terminal;
  const [shells, setShells] = useState<ShellOption[]>([]);
  useEffect(() => {
    void invoke('terminal:shells', undefined).then(setShells).catch(() => undefined);
  }, []);
  const patch = (p: Partial<TerminalSettings>) => update({ terminal: { ...t, ...p } });
  const known = t.shell === 'auto' || t.shell === 'custom' || shells.some((s) => s.kind === t.shell);
  const mod = isMac ? '⌘' : 'Ctrl';
  return (
    <div className="settings-section">
      <h2>Terminal</h2>
      <p className="muted small">Each tab in the Terminal panel is a real pseudo-terminal: interactive programs, colors, Ctrl+C and your shell profile all work, and tabs keep running while you use the rest of the app.</p>
      <Field label="Default shell" hint="New terminals start this shell in the session's working directory. Auto picks PowerShell on Windows and your login shell elsewhere.">
        <select value={t.shell} onChange={(e) => patch({ shell: e.target.value as ShellKind })}>
          <option value="auto">Auto</option>
          {shells.map((s) => (
            <option key={s.kind} value={s.kind}>
              {s.name} — {s.path}
            </option>
          ))}
          {!known && <option value={t.shell}>{t.shell} (not found on this machine)</option>}
          <option value="custom">Custom…</option>
        </select>
      </Field>
      {t.shell === 'custom' && (
        <div className="row gap12">
          <Field label="Shell executable">
            <input value={t.customShellPath} placeholder={platform === 'win32' ? 'C:\\tools\\nu.exe' : '/usr/local/bin/nu'} onChange={(e) => patch({ customShellPath: e.target.value })} spellCheck={false} />
          </Field>
          <Field label="Arguments" hint="Space separated.">
            <input value={t.customShellArgs.join(' ')} onChange={(e) => patch({ customShellArgs: e.target.value.split(/\s+/).filter(Boolean) })} spellCheck={false} />
          </Field>
        </div>
      )}
      <div className="row gap12">
        <Field label="Font size">
          <select value={t.fontSize} onChange={(e) => patch({ fontSize: Number(e.target.value) })}>
            {(FONT_SIZES.includes(t.fontSize) ? FONT_SIZES : [...FONT_SIZES, t.fontSize].sort((a, b) => a - b)).map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scrollback">
          <select value={t.scrollback} onChange={(e) => patch({ scrollback: Number(e.target.value) })}>
            {(SCROLLBACKS.includes(t.scrollback) ? SCROLLBACKS : [...SCROLLBACKS, t.scrollback].sort((a, b) => a - b)).map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} lines
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cursor">
          <select value={t.cursorStyle} onChange={(e) => patch({ cursorStyle: e.target.value as TerminalSettings['cursorStyle'] })}>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar</option>
          </select>
        </Field>
      </div>
      <Toggle checked={t.cursorBlink} onChange={(v) => patch({ cursorBlink: v })} label="Blinking cursor" />
      <Toggle checked={t.restoreOnStartup} onChange={(v) => patch({ restoreOnStartup: v })} label="Restore terminals on startup: tabs come back with their scrollback, and the shell starts again when you open one" />
      <h3>Shortcuts</h3>
      <p className="muted small">
        <Kbd>{mod}+`</Kbd> focus the terminal (again to return to the composer) · <Kbd>{mod}+Shift+`</Kbd> new terminal · <Kbd>{mod}+F</Kbd> find · <Kbd>Ctrl+Shift+C</Kbd> / <Kbd>Ctrl+Shift+V</Kbd> copy / paste
        {!isMac && (
          <>
            {' '}
            · <Kbd>Ctrl+C</Kbd> copies while text is selected, otherwise interrupts · <Kbd>Ctrl+V</Kbd> pastes
          </>
        )}{' '}
        · right-click copies the selection or pastes · double-click a tab to rename it.
      </p>
    </div>
  );
}

function Providers({ settings }: { settings: AppSettings }) {
  const toast = useStore((s) => s.toast);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState({ id: '', name: '', baseUrl: '', envKey: '' });

  const save = async (p: ProviderConfig, patch: Partial<ProviderConfig>) => {
    await invoke('providers:save', { ...p, ...patch });
  };
  const saveKey = async (p: ProviderConfig) => {
    const k = keys[p.id];
    if (!k?.trim()) return;
    setBusy({ ...busy, [p.id]: 'saving' });
    await invoke('secrets:set', { providerId: p.id, apiKey: k.trim() });
    setKeys({ ...keys, [p.id]: '' });
    setBusy({ ...busy, [p.id]: '' });
    toast(`Saved key for ${p.name}`, 'success');
  };
  const test = async (p: ProviderConfig) => {
    setBusy({ ...busy, [p.id]: 'testing' });
    const r = await invoke('providers:test', { id: p.id });
    setBusy({ ...busy, [p.id]: '' });
    toast(`${p.name}: ${r.detail}`, r.ok ? 'success' : 'error');
  };
  const refresh = async (p: ProviderConfig) => {
    setBusy({ ...busy, [p.id]: 'refreshing' });
    const r = await invoke('providers:refreshModels', { id: p.id });
    setBusy({ ...busy, [p.id]: '' });
    toast(r.error ? `${p.name}: ${r.error}` : `${p.name}: ${r.models.length} models`, r.error ? 'error' : 'success');
  };
  return (
    <div className="settings-section">
      <h2>Providers & API keys</h2>
      <p className="muted">Keys are encrypted with the OS keychain (DPAPI on Windows) and only sent to the provider you configure. Harnesses that bring their own login (Claude Code, Codex, pi, dsh) keep using it; keys here are a fallback and power the native loop.</p>
      {settings.providers.map((p) => (
        <div key={p.id} className={`provider-card ${p.enabled ? '' : 'disabled'}`}>
          <div className="provider-head">
            <Toggle checked={p.enabled} onChange={(v) => void save(p, { enabled: v })} />
            <span className="provider-name">{p.name}</span>
            <Badge tone="neutral">{p.kind}</Badge>
            {p.hasApiKey ? <Badge tone="green">key stored</Badge> : p.envKey && <Badge tone="neutral">env: {p.envKey}</Badge>}
            <span className="spacer" />
            <span className="muted small">{p.models.length ? `${p.models.length} models` : 'catalog: built-in'}</span>
            {!p.builtin && (
              <Button variant="ghost" size="sm" icon="trash" onClick={() => void invoke('providers:delete', { id: p.id })} title="Remove provider" />
            )}
          </div>
          {p.enabled && (
            <div className="provider-body">
              <div className="row gap8">
                <input type="password" placeholder={p.hasApiKey ? 'Replace stored key…' : p.kind === 'ollama' || p.kind === 'lmstudio' ? 'No key needed' : 'Paste API key'} value={keys[p.id] ?? ''} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void saveKey(p)} />
                <Button size="sm" onClick={() => void saveKey(p)} disabled={!keys[p.id]?.trim()}>
                  Save key
                </Button>
                {p.hasApiKey && (
                  <Button size="sm" variant="ghost" onClick={() => void invoke('secrets:clear', { providerId: p.id })}>
                    Clear
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void test(p)}>
                  {busy[p.id] === 'testing' ? <Spinner /> : 'Test'}
                </Button>
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refresh(p)}>
                  {busy[p.id] === 'refreshing' ? <Spinner /> : 'Models'}
                </Button>
              </div>
              <div className="row gap8">
                <Field label="Base URL" inline>
                  <input value={p.baseUrl ?? ''} onChange={(e) => void save(p, { baseUrl: e.target.value })} />
                </Field>
              </div>
            </div>
          )}
        </div>
      ))}
      {adding ? (
        <div className="provider-card">
          <div className="provider-head"><span className="provider-name">New OpenAI-compatible provider</span></div>
          <div className="provider-body">
            <div className="row gap8">
              <input placeholder="id (letters, dashes)" value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value.replace(/[^a-z0-9-]/gi, '').toLowerCase() })} />
              <input placeholder="Display name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
            </div>
            <div className="row gap8">
              <input placeholder="Base URL (…/v1)" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} />
              <input placeholder="Env var for key (optional)" value={custom.envKey} onChange={(e) => setCustom({ ...custom, envKey: e.target.value })} />
            </div>
            <div className="row gap8">
              <Button
                variant="primary"
                size="sm"
                disabled={!custom.id || !custom.baseUrl}
                onClick={async () => {
                  await invoke('providers:save', { id: custom.id, kind: 'openai-compatible', name: custom.name || custom.id, baseUrl: custom.baseUrl, envKey: custom.envKey || undefined, hasApiKey: false, models: [], enabled: true });
                  setAdding(false);
                  setCustom({ id: '', name: '', baseUrl: '', envKey: '' });
                }}
              >
                Add provider
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button icon="plus" onClick={() => setAdding(true)}>
          Add OpenAI-compatible provider
        </Button>
      )}
      <ModelOverrides settings={settings} />
    </div>
  );
}

/**
 * Capability corrections. Each harness derives `supportsImages` from a different and sometimes
 * wrong source, so the user gets the last word on a per-model basis.
 */
function ModelOverrides({ settings }: { settings: AppSettings }) {
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState({ provider: '', model: '', supportsImages: true });
  const entries = Object.entries(settings.modelOverrides ?? {});

  const set = async (provider: string, model: string, supportsImages: boolean | null) => {
    try {
      await invoke('models:setOverride', { provider, model, supportsImages });
    } catch (e) {
      toast(`Could not save the override: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <>
      <h3>Model capability overrides</h3>
      <p className="muted">
        Harnesses advertise which models accept images, and they get it wrong — a hand-written entry in a harness catalog, a stale model list, or a name-based guess for an
        OpenAI-compatible endpoint. An override corrects one model here. It changes what this app believes and warns about; it cannot stop a harness that strips attachments
        on its own (Pi does, from <code>~/.pi/agent/models.json</code>).
      </p>
      {entries.length === 0 && <p className="muted small">No overrides. Attach an image to a model listed as text-only and the composer offers to add one.</p>}
      {entries.map(([key, o]) => {
        const { provider, model } = parseModelOverrideKey(key);
        return (
          <div key={key} className="row gap8 override-row">
            <code className="small">{key}</code>
            <Badge tone={o.supportsImages ? 'green' : 'neutral'}>{o.supportsImages ? 'accepts images' : 'text only'}</Badge>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => void set(provider, model, !o.supportsImages)}>
              Flip
            </Button>
            <Button size="sm" variant="ghost" icon="trash" title="Remove override" onClick={() => void set(provider, model, null)} />
          </div>
        );
      })}
      <div className="row gap8">
        <input placeholder="provider (e.g. deepseek)" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value.trim() })} />
        <input placeholder="model id" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value.trim() })} />
        <select value={draft.supportsImages ? 'yes' : 'no'} onChange={(e) => setDraft({ ...draft, supportsImages: e.target.value === 'yes' })}>
          <option value="yes">accepts images</option>
          <option value="no">text only</option>
        </select>
        <Button
          size="sm"
          disabled={!draft.provider || !draft.model}
          onClick={async () => {
            await set(draft.provider, draft.model, draft.supportsImages);
            setDraft({ provider: '', model: '', supportsImages: true });
          }}
        >
          Add
        </Button>
      </div>
    </>
  );
}

function Harnesses({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const availability = useStore((s) => s.availability);
  const refresh = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  const [installing, setInstalling] = useState<string | null>(null);
  const install = async (id: 'pi' | 'dsh' | 'codex' | 'claude') => {
    setInstalling(id);
    const r = await invoke('harness:install', { id });
    setInstalling(null);
    toast(r.ok ? `Installed ${id}` : `Install failed: ${r.log.slice(-400)}`, r.ok ? 'success' : 'error');
    void refresh();
  };
  const bin = (key: keyof AppSettings['binaries'], label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input value={settings.binaries[key] ?? ''} placeholder="auto-detect" onChange={(e) => update({ binaries: { ...settings.binaries, [key]: e.target.value } })} onBlur={() => void refresh()} />
    </Field>
  );
  return (
    <div className="settings-section">
      <h2>Harnesses</h2>
      <p className="muted">Each harness is a separate agent runtime. Vocs Code detects binaries on PATH, in its private runtime folder, or bundled with the app.</p>
      <div className="harness-table">
        {HARNESSES.map((h) => {
          const av = availability[h.id];
          return (
            <div key={h.id} className="harness-row">
              <div className="harness-row-main">
                <div className="row gap8">
                  <strong>{h.name}</strong>
                  <span className="muted small">{h.vendor}</span>
                  {av ? av.available ? <Badge tone={av.authenticated === false ? 'amber' : 'green'}>{av.authenticated === false ? 'installed, not logged in' : 'ready'}</Badge> : <Badge tone="red">not found</Badge> : <Spinner size={11} />}
                </div>
                <div className="muted small">{h.description}</div>
                {av && (
                  <div className="muted small mono">
                    {av.version ? `${av.version} · ` : ''}
                    {av.binaryPath ?? av.detail}
                    {av.detail && av.binaryPath ? ` · ${av.detail}` : ''}
                  </div>
                )}
                {av && !av.available && av.installHint && <code className="small">{av.installHint}</code>}
              </div>
              <div className="harness-row-actions">
                {h.id === 'pi' && <Button size="sm" onClick={() => void install('pi')} disabled={installing !== null}>{installing === 'pi' ? <Spinner /> : 'Install/update pi'}</Button>}
                {h.id === 'acp' && <Button size="sm" onClick={() => void install('dsh')} disabled={installing !== null}>{installing === 'dsh' ? <Spinner /> : 'Install/update dsh'}</Button>}
                {(h.id === 'codex') && <Button size="sm" onClick={() => void install('codex')} disabled={installing !== null}>{installing === 'codex' ? <Spinner /> : 'Install/update codex'}</Button>}
                {h.id === 'claude' && <Button size="sm" onClick={() => void install('claude')} disabled={installing !== null}>{installing === 'claude' ? <Spinner /> : 'Install/update claude'}</Button>}
                {h.docsUrl && <Button size="sm" variant="ghost" icon="external" onClick={() => void invoke('app:openExternal', { url: h.docsUrl! })}>Docs</Button>}
              </div>
            </div>
          );
        })}
      </div>
      <h3>Claude</h3>
      <Field label="Runtime" hint="System uses your Claude Code login (~/.claude); bundled is the runtime shipped with the Agent SDK and needs an API key or shared credentials.">
        <select value={settings.claude.runtime} onChange={(e) => update({ claude: { ...settings.claude, runtime: e.target.value as AppSettings['claude']['runtime'] } })}>
          <option value="auto">Auto (system first, then bundled)</option>
          <option value="system">System CLI only</option>
          <option value="bundled">Bundled runtime only</option>
        </select>
      </Field>
      <Toggle checked={settings.claude.useProviderKey} onChange={(v) => update({ claude: { ...settings.claude, useProviderKey: v } })} label="Pass the stored Anthropic API key to Claude Code instead of inheriting its login" />
      {bin('claude', 'claude path override')}
      <h3>Codex</h3>
      <Field label="Runtime">
        <select value={settings.codex.runtime} onChange={(e) => update({ codex: { ...settings.codex, runtime: e.target.value as AppSettings['codex']['runtime'] } })}>
          <option value="auto">Auto (system first, then bundled)</option>
          <option value="system">System CLI only</option>
          <option value="bundled">Bundled binary only</option>
        </select>
      </Field>
      {bin('codex', 'codex path override')}
      <h3>Pi</h3>
      {bin('pi', 'pi path override')}
      <Field label="Extra pi arguments" hint="Space separated, appended to every pi launch (e.g. --no-skills).">
        <input value={settings.pi.extraArgs.join(' ')} onChange={(e) => update({ pi: { extraArgs: e.target.value.split(/\s+/).filter(Boolean) } })} />
      </Field>
      <h3>DeepSeek Harness / npx</h3>
      {bin('dsh', 'dsh path override')}
      {bin('npx', 'npx path override')}
      {bin('gemini', 'gemini path override')}
    </div>
  );
}

function AcpAgents({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const [draft, setDraft] = useState<AcpAgentPreset | null>(null);
  const save = (list: AcpAgentPreset[]) => update({ acpAgents: list });
  return (
    <div className="settings-section">
      <h2>ACP agents</h2>
      <p className="muted">Any program speaking the Agent Client Protocol over stdio can be a harness. DeepSeek Harness (dsh) ships a first-class ACP profile; the other presets wrap Claude, Codex, pi and Gemini so you can compare the same agent across harness surfaces.</p>
      {settings.acpAgents.map((a) => (
        <div key={a.id} className="provider-card">
          <div className="provider-head">
            <span className="provider-name">{a.name}</span>
            {a.builtin && <Badge tone="neutral">built-in</Badge>}
            <span className="spacer" />
            <code className="small">{[a.command, ...a.args].join(' ')}</code>
            <Button size="sm" variant="ghost" icon="edit" onClick={() => setDraft({ ...a })} />
            {!a.builtin && <Button size="sm" variant="ghost" icon="trash" onClick={() => save(settings.acpAgents.filter((x) => x.id !== a.id))} />}
          </div>
          <div className="muted small pad-h">{a.description}</div>
        </div>
      ))}
      {draft ? (
        <div className="provider-card">
          <div className="provider-body">
            <div className="row gap8">
              <input placeholder="id" value={draft.id} disabled={!!settings.acpAgents.find((x) => x.id === draft.id && x.builtin)} onChange={(e) => setDraft({ ...draft, id: e.target.value.replace(/[^a-z0-9-]/gi, '').toLowerCase() })} />
              <input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="row gap8">
              <input placeholder="command" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
              <input placeholder="args (space separated)" value={draft.args.join(' ')} onChange={(e) => setDraft({ ...draft, args: e.target.value.split(/\s+/).filter(Boolean) })} />
            </div>
            <input placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <div className="row gap8">
              <Button
                variant="primary"
                size="sm"
                disabled={!draft.id || !draft.command}
                onClick={() => {
                  const exists = settings.acpAgents.some((x) => x.id === draft.id);
                  save(exists ? settings.acpAgents.map((x) => (x.id === draft.id ? { ...x, ...draft } : x)) : [...settings.acpAgents, { ...draft, builtin: false }]);
                  setDraft(null);
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button icon="plus" onClick={() => setDraft({ id: '', name: '', description: '', command: '', args: [] })}>
          Add ACP agent
        </Button>
      )}
    </div>
  );
}

function About() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [info, setInfo] = useState<{ version: string; platform: string; userData: string; isPackaged: boolean } | null>(null);
  useEffect(() => {
    void invoke('app:info', undefined).then(setInfo);
    void invoke('app:doctor', undefined).then(setReport);
  }, []);
  return (
    <div className="settings-section">
      <h2>About</h2>
      <p>
        <strong>Vocs Code</strong> {info?.version} · Electron {report?.electron} · Node {report?.node} · {report?.platform}
      </p>
      <p className="muted small mono">{info?.userData}</p>
      <h3>Doctor</h3>
      {!report && <Spinner />}
      {report && (
        <table className="doctor">
          <tbody>
            {Object.entries(report.harnesses).map(([id, av]) => (
              <tr key={id}>
                <td>{HARNESSES.find((h) => h.id === id)?.name}</td>
                <td>{av.available ? <Badge tone={av.authenticated === false ? 'amber' : 'green'}>{av.authenticated === false ? 'not logged in' : 'ok'}</Badge> : <Badge tone="red">missing</Badge>}</td>
                <td className="mono small muted">{av.version ?? ''} {av.binaryPath ?? av.detail ?? ''}</td>
              </tr>
            ))}
            {report.providers.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.hasKey ? <Badge tone="green">key stored</Badge> : p.envKeyPresent ? <Badge tone="blue">env key</Badge> : <Badge tone="neutral">no key</Badge>}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
