/** Settings → Harnesses & ACP agents configuration. */
import React, { useState } from 'react';
import { HARNESSES } from '../../../../shared/harness-meta';
import { harnessStatus } from '../../../../shared/harness-setup';
import type { AcpAgentPreset, AppSettings } from '../../../../shared/types';
import { invoke } from '../../api';
import { useStore } from '../../store';
import { SettingsGroup } from '../SettingsPrimitives';
import { Badge, Button, Field, Spinner, Toggle } from '../ui';

export function HarnessesSection({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const availability = useStore((s) => s.availability);
  const refresh = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  const [installing, setInstalling] = useState<string | null>(null);
  const install = async (id: 'pi' | 'dsh' | 'codex' | 'claude') => {
    setInstalling(id);
    try {
      const r = await invoke('harness:install', { id });
      toast(r.ok ? `Installer finished for ${id}; rechecking the selected runtime.` : `Install failed: ${r.log.slice(-400)}`, r.ok ? 'success' : 'error');
      await refresh();
    } catch (e) {
      toast(`Install failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally { setInstalling(null); }
  };
  const bin = (key: keyof AppSettings['binaries'], label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input value={settings.binaries[key] ?? ''} placeholder="auto-detect" onChange={(e) => update({ binaries: { ...settings.binaries, [key]: e.target.value } })} onBlur={() => void refresh()} />
    </Field>
  );
  return (
    <div className="settings-section">
      <h2>Harnesses</h2>
      <p className="muted">Each harness is a separate agent runtime. Vocs Code detects binaries on PATH, in its private runtime folder, or bundled with the app. Working bundled Claude/Codex runtimes do not need another CLI or SDK install.</p>
      <div className="row gap8"><Button onClick={() => useStore.getState().openOnboarding()}>Setup guide</Button><Button variant="ghost" icon="refresh" onClick={() => void refresh()}>Recheck runtimes</Button></div>
      <div id="harnesses-installed" className="harness-table">
        {HARNESSES.map((h) => {
          const av = availability[h.id];
          return (
            <div key={h.id} className="harness-row">
              <div className="harness-row-main">
                <div className="row gap8">
                  <strong>{h.name}</strong>
                  <span className="muted small">{h.vendor}</span>
                  <Badge tone={harnessStatus(h.id, av).tone}>{harnessStatus(h.id, av).label}</Badge>
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
                <Button size="sm" onClick={() => useStore.getState().openOnboarding(h.id)}>Set up {h.name}</Button>
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
      <SettingsGroup id="harnesses-config" title="Claude runtime" icon="cpu">
        <Field label="Runtime" hint="Both system and bundled runtimes can use Claude Code sign-in. Use the setup guide to sign in with the selected binary; an API key is a separate billing choice.">
          <select value={settings.claude.runtime} onChange={(e) => update({ claude: { ...settings.claude, runtime: e.target.value as AppSettings['claude']['runtime'] } })}>
            <option value="auto">Auto (system first, then bundled)</option>
            <option value="system">System CLI only</option>
            <option value="bundled">Bundled runtime only</option>
          </select>
        </Field>
        <Toggle checked={settings.claude.useProviderKey} onChange={(v) => update({ claude: { ...settings.claude, useProviderKey: v } })} label="Pass the stored Anthropic API key to Anthropic's own endpoint" />
        <p className="muted small">Claude Code runs against any provider that publishes an Anthropic-format endpoint. OpenRouter and DeepSeek do, so once their key is stored their catalogs appear for this harness automatically and the endpoint follows the model you pick. Anything else can be added under Providers with Kind <strong>Anthropic-compatible</strong>. This toggle only affects Anthropic's own endpoint: on sends the stored API key, off keeps the Claude Code login.</p>
        {bin('claude', 'claude path override')}
      </SettingsGroup>
      <SettingsGroup title="Codex runtime" icon="cpu">
        <Field label="Runtime">
          <select value={settings.codex.runtime} onChange={(e) => update({ codex: { ...settings.codex, runtime: e.target.value as AppSettings['codex']['runtime'] } })}>
            <option value="auto">Auto (system first, then bundled)</option>
            <option value="system">System CLI only</option>
            <option value="bundled">Bundled binary only</option>
          </select>
        </Field>
        {bin('codex', 'codex path override')}
      </SettingsGroup>
      <SettingsGroup title="Pi runtime" icon="puzzle">
        {bin('pi', 'pi path override')}
        <Field label="Extra pi arguments" hint="Space separated, appended to every pi session launch (e.g. --no-skills). Vesta's own pi run is hermetic and ignores these.">
          <input value={settings.pi.extraArgs.join(' ')} onChange={(e) => update({ pi: { extraArgs: e.target.value.split(/\s+/).filter(Boolean) } })} />
        </Field>
      </SettingsGroup>
      <SettingsGroup title="Other runtime paths" icon="folder" description="Leave blank to use automatic detection.">
        {bin('dsh', 'dsh path override')}
        {bin('npx', 'npx path override')}
        {bin('gemini', 'gemini path override')}
        {bin('agy', 'Antigravity CLI (agy) path override')}
      </SettingsGroup>
    </div>
  );
}

export function AcpAgentsSection({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
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
            <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${a.name}`} onClick={() => setDraft({ ...a })} />
            {!a.builtin && <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${a.name}`} onClick={() => save(settings.acpAgents.filter((x) => x.id !== a.id))} />}
          </div>
          <div className="muted small pad-h">{a.description}</div>
        </div>
      ))}
      {draft ? (
        <div className="provider-card">
          <div className="provider-body">
            <div className="row gap8">
              <input aria-label="Agent ID" placeholder="id" value={draft.id} disabled={!!settings.acpAgents.find((x) => x.id === draft.id && x.builtin)} onChange={(e) => setDraft({ ...draft, id: e.target.value.replace(/[^a-z0-9-]/gi, '').toLowerCase() })} />
              <input aria-label="Agent name" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="row gap8">
              <input aria-label="Agent command" placeholder="command" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
              <input aria-label="Agent arguments" placeholder="args (space separated)" value={draft.args.join(' ')} onChange={(e) => setDraft({ ...draft, args: e.target.value.split(/\s+/).filter(Boolean) })} />
            </div>
            <input aria-label="Agent description" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
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
