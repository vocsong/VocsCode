/** Settings → Session defaults & Vesta/utility background models. */
import React, { useEffect, useState } from 'react';
import { BUILTIN_BRANCH_PREFIXES, branchPrefixOptions, normalizeBranchPrefix } from '../../../../shared/branch-prefix';
import { AUTO_COMPACTION_PRESETS } from '../../../../shared/compaction';
import { HARNESSES, PERMISSION_MODE_LABELS } from '../../../../shared/harness-meta';
import type { AppSettings, HarnessId, ModelInfo, ProviderConfig } from '../../../../shared/types';
import { invoke } from '../../api';
import { rememberEffort } from '../../sessionActions';
import { ModelPicker } from '../ModelPicker';
import { SettingsGroup, SettingsNote } from '../SettingsPrimitives';
import { Button, Field, Icon, Toggle } from '../ui';

export function SessionDefaultsSection({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="settings-section">
      <SettingsGroup id="sessions-defaults" title="New sessions" icon="sessionPlus" description="Choose how agents start in a project with no remembered preferences.">
        <SettingsNote>These defaults do not change existing sessions. Each project keeps its remembered New Session choices.</SettingsNote>
        <Field
          label="Default harness"
          hint="Used by folders that have no remembered choices yet: the New Session dialog keeps each project's own harness, model, permission mode and worktree setting."
        >
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
          <select value={settings.defaultEffort ?? ''} onChange={(e) => void rememberEffort((e.target.value || undefined) as AppSettings['defaultEffort']).catch(() => undefined)}>
            <option value="">Harness default</option>
            {['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </SettingsGroup>
      <SettingsGroup id="sessions-context" title="Context management" icon="layers" description="This app-wide setting also applies to existing sessions at their next idle boundary.">
        <Field
          label="Automatically compact context at"
          hint="Checked after each turn. Vocs Code can request compaction from Claude, Codex, Pi and Native; other harnesses keep their own behavior, and any harness may compact earlier. Percentage presets require a reported context window."
        >
          <select
            value={settings.autoCompactionThreshold ?? ''}
            onChange={(e) => update({ autoCompactionThreshold: (e.target.value || undefined) as AppSettings['autoCompactionThreshold'] })}
          >
            <option value="">Harness default</option>
            {AUTO_COMPACTION_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </Field>
      </SettingsGroup>
      <SettingsGroup id="sessions-goals" title="Goal defaults" icon="target" description="Auto-continue and iteration defaults apply to new goals. The /goal preference also updates existing sessions.">
        <Toggle checked={settings.goalDefaults.autoContinue} onChange={(v) => update({ goalDefaults: { ...settings.goalDefaults, autoContinue: v } })} label="Auto-continue goals after each turn" />
        <Field label="Iteration guard">
          <input type="number" min={1} max={500} value={settings.goalDefaults.maxIterations} onChange={(e) => update({ goalDefaults: { ...settings.goalDefaults, maxIterations: Number(e.target.value) || 25 } })} />
        </Field>
        <Toggle
          checked={settings.goalDefaults.preferHarness}
          onChange={(v) => update({ goalDefaults: { ...settings.goalDefaults, preferHarness: v } })}
          label="Prefer a harness's own /goal when it has one — the command goes to the harness instead of the app's goal engine"
        />
      </SettingsGroup>
      <SettingsGroup id="sessions-branches" title="Worktree branches" icon="branch">
        <BranchPrefixFields settings={settings} update={update} />
      </SettingsGroup>
    </div>
  );
}

/** Session defaults → Worktree branches: the saved prefixes every project's New Session dialog offers after the built-in ones. */
function BranchPrefixFields({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const custom = settings.customBranchPrefixes ?? [];
  const [draft, setDraft] = useState('');
  const prefix = normalizeBranchPrefix(draft);
  const taken = !!prefix && branchPrefixOptions(custom).includes(prefix);
  const add = () => {
    if (!prefix || taken) return;
    update({ customBranchPrefixes: [prefix, ...custom] });
    setDraft('');
  };
  return (
    <>
      <p className="muted small">
        A session isolated in a git worktree starts on a new branch named <code>prefix/session-name</code>. {BUILTIN_BRANCH_PREFIXES.map((p) => `${p}/`).join(', ')} are always offered; the prefixes
        below are offered in every project too. A custom prefix typed in the New Session dialog is added here when its session starts.
      </p>
      {custom.map((p) => (
        <div key={p} className="shortcut-row">
          <code className="shortcut-row-main">{p}/</code>
          <Button size="sm" variant="ghost" icon="trash" title={`Remove ${p}/`} aria-label={`Remove ${p}/`} onClick={() => update({ customBranchPrefixes: custom.filter((c) => c !== p) })} />
        </div>
      ))}
      <div className="row gap8 shortcut-add">
        <input
          aria-label="New branch prefix"
          value={draft}
          placeholder="e.g. bug or team/feat"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <Button size="sm" variant="primary" disabled={!prefix || taken} onClick={add}>
          Add
        </Button>
      </div>
      {draft.trim() && !prefix && <p className="muted small">Not a valid branch prefix: use letters, digits, ".", "_" or "-", with "/" between parts.</p>}
      {taken && <p className="muted small">{prefix}/ is already offered.</p>}
    </>
  );
}

/** Vesta & utility → the two background models: chores (session titles) and Vesta, plus its on/off switch. */
export function BackgroundModelFields({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Vesta runs on pi, so its model comes from pi's catalog rather than the app's providers.
  const [piModels, setPiModels] = useState<ModelInfo[]>([]);
  const [piError, setPiError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void invoke('providers:list', undefined)
      .then(setProviders)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    void invoke('harness:models', { harness: 'pi' })
      .then((r) => {
        setPiModels(r?.models ?? []);
        setPiError(r?.error);
      })
      .catch((e) => setPiError(e instanceof Error ? e.message : String(e)));
  }, []);
  const models = providers.filter((p) => p.enabled).flatMap((p) => p.models);
  return (
    <div className="settings-section">
      <SettingsGroup id="assistant-models" title="Utility model" icon="bolt" description="Small, fast chores shouldn’t need your most powerful model.">
        <Field label="Utility model" hint="A fast model for background tasks. After each completed turn, it uses an excerpt of the reply to refresh automatic session titles. Opening titles and worktree names can still use the session's model when unset.">
          {error && <div className="info-line info-error"><Icon name="alert" size={13} /> <span>Provider list unavailable: {error}</span></div>}
          <div className="onboarding-model-picker">
            <ModelPicker
              models={models}
              selected={settings.utilityModel}
              clearOption={{ label: 'Use the session model' }}
              onSelect={(m) => update({ utilityModel: m ? { provider: m.provider, model: m.id } : undefined })}
            />
          </div>
        </Field>
      </SettingsGroup>
      <SettingsGroup id="assistant-vesta" title="Vesta" icon="sparkles" description="Your floating assistant for the workspace itself.">
        <p className="muted small">
          The floating assistant. It runs on pi — the same coding agent as the Pi harness — and drives the app itself to set up MCP servers, start sessions
          and tidy branches. pi only ever sees the app's capability list: every change Vesta wants to make is shown as a proposal you approve first. Drag it
          anywhere; click it to collapse.
        </p>
        <Toggle checked={settings.agent?.enabled !== false} onChange={(v) => update({ agent: { ...(settings.agent ?? {}), enabled: v } })} label="Show Vesta" />
        {!piModels.length && piError && <div className="info-line info-error"><Icon name="alert" size={13} /> <span>{piError} Install pi under Harnesses to use Vesta.</span></div>}
        <Field label="Vesta's model" hint="A pi model from ~/.pi/agent. Picking correctly among its capabilities is harder than naming a session, so a small model may struggle.">
          <div className="onboarding-model-picker">
            <ModelPicker
              models={piModels}
              selected={settings.agentModel}
              clearOption={{ label: "Use pi's default model" }}
              emptyText={piError ?? 'No pi models available'}
              onSelect={(m) => update({ agentModel: m ? { provider: m.provider, model: m.id } : undefined })}
            />
          </div>
        </Field>
      </SettingsGroup>
    </div>
  );
}
