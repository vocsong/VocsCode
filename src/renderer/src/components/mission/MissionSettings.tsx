/** Mission foundations: edit approved choices, never start agents or infer runtime availability. */
import React, { useEffect, useState } from 'react';
import type { AppSettings, EffortLevel, HarnessId, ModelInfo } from '../../../../shared/types';
import { HARNESS_BY_ID, HARNESSES } from '../../../../shared/harness-meta';
import {
  applyMissionProjectOverride, createDefaultMissionConfig, MISSION_ACCOUNT_LIMIT_MAX_ENTRIES, MISSION_ACCOUNT_LIMIT_MAX_TURNS, MISSION_LIMIT_MAXIMUMS, MISSION_PRESET_STATUS_LABELS,
  validateMissionConfig, validateMissionProjectOverride, validatePresetEligibility,
  type ExecutionPreset, type MissionCapabilityResolver, type MissionConfig, type MissionNumericLimits, type MissionProjectOverride, type TierId
} from '../../../../shared/mission-config';
import { invoke } from '../../api';
import { useStore } from '../../store';
import { ModelPicker } from '../ModelPicker';
import { Badge, Button, Field, Toggle } from '../ui';
import './MissionSettings.css';

type Projects = Record<string, MissionProjectOverride>;
const EMPTY_MODELS: ModelInfo[] = [];
const LIMIT_LABELS: Record<keyof MissionNumericLimits, string> = {
  maxConcurrentWorkersPerMission: 'Workers per Mission',
  maxConcurrentAgentTurnsGlobal: 'Agent-turn slots app-wide (including leads and tools)',
  maxConcurrentHeavyChecksGlobal: 'Heavy checks app-wide',
  maxDelegationDepth: 'Delegation depth',
  maxTaskAttemptsBeforeLeadDiagnosis: 'Task attempts before lead diagnosis',
  progressCheckpointEveryTurns: 'Turns per progress checkpoint',
  maxNoProgressCheckpoints: 'No-progress checkpoints',
  maxBudgetUsd: 'Observed Mission cost threshold (USD)',
  maxTokens: 'Observed Mission token threshold'
};

function readDraft(settings: AppSettings): { mission: MissionConfig; projects: Projects; error?: string } {
  try {
    const mission = settings.mission === undefined ? createDefaultMissionConfig() : validateMissionConfig(settings.mission);
    if (settings.missionProjects !== undefined && (!settings.missionProjects || typeof settings.missionProjects !== 'object' || Array.isArray(settings.missionProjects))) {
      throw new Error('missionProjects: Expected a project override map.');
    }
    const projects = Object.fromEntries(Object.entries(settings.missionProjects ?? {}).map(([root, raw]) => {
      const project = validateMissionProjectOverride(raw);
      applyMissionProjectOverride(mission, project);
      return [root, project];
    }));
    return { mission, projects };
  } catch (error) {
    return { mission: createDefaultMissionConfig(), projects: {}, error: `Mission configuration is disabled: ${(error as Error).message}` };
  }
}

function Limits({ value, onChange, ceiling }: {
  value: Partial<MissionNumericLimits>; onChange: (next: Partial<MissionNumericLimits>) => void; ceiling?: MissionNumericLimits;
}) {
  return <div className="mission-limits">
    {(Object.keys(LIMIT_LABELS) as Array<keyof MissionNumericLimits>).map((key) => {
      const optional = key === 'maxBudgetUsd' || key === 'maxTokens';
      const max = ceiling?.[key] ?? MISSION_LIMIT_MAXIMUMS[key];
      return <div key={key}>
        {ceiling && <Toggle label={`Override ${LIMIT_LABELS[key]}`} checked={value[key] !== undefined} onChange={(checked) => {
          const next = { ...value };
          if (checked) next[key] = ceiling[key] ?? NaN;
          else delete next[key];
          onChange(next);
        }} />}
        <Field label={LIMIT_LABELS[key]} hint={key === 'maxDelegationDepth' ? 'MVP: lead at depth 0, workers at depth 1.' : ceiling ? `Global ceiling: ${ceiling[key] ?? 'none'}. Projects may only tighten it.` : optional ? 'Leave blank for no cap.' : undefined}>
          <input aria-label={LIMIT_LABELS[key]} type="number" min={key === 'maxBudgetUsd' ? 0.01 : 1} max={max} step={key === 'maxBudgetUsd' ? 'any' : 1}
            disabled={!!ceiling && value[key] === undefined} value={Number.isNaN(value[key]) ? '' : value[key] ?? ''}
            onChange={(event) => {
              const next = { ...value };
              if (optional && !event.target.value) delete next[key];
              else next[key] = event.target.value ? Number(event.target.value) : NaN;
              onChange(next);
            }} />
        </Field>
      </div>;
    })}
  </div>;
}

function AccountLimits({ value, connections, onChange }: {
  value: Record<string, number>; connections: string[]; onChange: (next: Record<string, number>) => void;
}) {
  const [connection, setConnection] = useState('');
  const [slots, setSlots] = useState('');
  return <section className="mission-card" aria-label="Account capacity">
    <h4>Account capacity</h4>
    <p className="field-hint">App-wide across Mission leads and workers, including tools and approval waits. Keys are exact connection IDs (or provider IDs when no separate connection is selected). A full account queues work; it never selects another account or model. Existing leases drain normally.</p>
    {Object.entries(value).map(([id, limit]) => <div key={id} className="mission-membership">
      <Field label={`Account slots: ${id}`}><input aria-label={`Account slots: ${id}`} type="number" min={1} max={MISSION_ACCOUNT_LIMIT_MAX_TURNS} step={1} value={Number.isNaN(limit) ? '' : limit} onChange={(e) => onChange({ ...value, [id]: e.target.value ? Number(e.target.value) : NaN })} /></Field>
      <Button size="sm" variant="ghost" onClick={() => { const next = { ...value }; delete next[id]; onChange(next); }}>Remove account limit: {id}</Button>
    </div>)}
    <Field label="Account capacity connection"><select aria-label="Account capacity connection" value={connection} onChange={(e) => setConnection(e.target.value)}>
      <option value="">Select an existing connection</option>{connections.filter((id) => !Object.hasOwn(value, id)).map((id) => <option key={id} value={id}>{id}</option>)}
    </select></Field>
    <Field label="Account-turn slots app-wide"><input aria-label="Account-turn slots app-wide" type="number" min={1} max={MISSION_ACCOUNT_LIMIT_MAX_TURNS} step={1} value={slots} onChange={(e) => setSlots(e.target.value)} /></Field>
    <Button size="sm" disabled={!connection || !Number.isSafeInteger(Number(slots)) || Number(slots) < 1 || Number(slots) > MISSION_ACCOUNT_LIMIT_MAX_TURNS || Object.keys(value).length >= MISSION_ACCOUNT_LIMIT_MAX_ENTRIES} onClick={() => {
      onChange({ ...value, [connection]: Number(slots) }); setConnection(''); setSlots('');
    }}>Add account limit</Button>
    <p className="field-hint">Optional: at most {MISSION_ACCOUNT_LIMIT_MAX_ENTRIES} explicit connections; blank means only the global capacity applies. Configure these app-wide, not as project overrides.</p>
  </section>;
}

function PresetEditor({ initial, settings, onApply, onCancel }: {
  initial: ExecutionPreset; settings: AppSettings; onApply: (preset: ExecutionPreset) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [picking, setPicking] = useState(!initial.model.model);
  const [error, setError] = useState('');
  const catalog = useStore((s) => s.modelCatalog[draft.harnessId]);
  const ensure = useStore((s) => s.ensureModelCatalog);
  useEffect(() => { void ensure(draft.harnessId); }, [draft.harnessId, ensure]);
  const models = catalog?.models ?? EMPTY_MODELS;
  const selected = models.find((m) => m.provider === draft.model.provider && m.id === draft.model.model);
  const efforts = HARNESS_BY_ID[draft.harnessId].capabilities.effort && selected?.supportsReasoning !== false ? selected?.supportedEfforts ?? [] : [];
  const providers = [...new Set([...models.map((m) => m.provider), ...settings.providers.map((p) => p.id), draft.model.provider].filter(Boolean))];
  const update = (patch: Partial<ExecutionPreset>) => { setDraft({ ...draft, ...patch }); setError(''); };
  return <section className="mission-card" aria-label="Preset editor">
    <h3>{initial.name ? 'Edit preset' : 'New preset'}</h3>
    <Field label="Preset name"><input aria-label="Preset name" value={draft.name} maxLength={200} onChange={(e) => update({ name: e.target.value })} /></Field>
    <Field label="Harness"><select aria-label="Harness" value={draft.harnessId} onChange={(e) => {
      update({ harnessId: e.target.value as HarnessId, model: { provider: '', model: '' }, reasoning: { kind: 'default' }, runtimeVariantId: undefined });
      setPicking(true);
    }}>{HARNESSES.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
    {draft.harnessId === 'acp' && <Field label="ACP runtime"><select aria-label="ACP runtime" value={draft.runtimeVariantId ?? ''} onChange={(e) => update({ runtimeVariantId: e.target.value || undefined })}>
      <option value="">Select configured ACP agent</option>
      {settings.acpAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      {draft.runtimeVariantId && !settings.acpAgents.some((a) => a.id === draft.runtimeVariantId) && <option value={draft.runtimeVariantId}>{draft.runtimeVariantId} (unverified)</option>}
    </select></Field>}
    <Field label="Provider / billing path" hint="An existing provider identity, not an API key. Changing the provider requires reselecting the model.">
      <select aria-label="Provider / billing path" value={draft.model.provider} onChange={(e) => {
        update({ model: { provider: e.target.value, model: '' }, reasoning: { kind: 'default' } }); setPicking(true);
      }}><option value="">Select provider or choose a catalog model</option>{providers.map((id) => <option key={id} value={id}>{id}</option>)}</select>
    </Field>
    <div className="mission-model">
      <span>Model: {draft.model.model ? `${draft.model.provider}/${draft.model.model}` : 'Not selected'}</span>
      <Button size="sm" onClick={() => setPicking(!picking)}>{picking ? 'Close model picker' : 'Choose model'}</Button>
    </div>
    {picking && <ModelPicker models={draft.model.provider ? models.filter((m) => m.provider === draft.model.provider) : models}
      loading={catalog?.loading ?? true} error={catalog?.error} selected={draft.model.model ? draft.model : undefined}
      emptyText="No catalog models. Configure a provider, or enter its exact model ID."
      onSelect={(model) => { if (model) { update({ model: { provider: model.provider, model: model.id }, reasoning: { kind: 'default' } }); setPicking(false); } }}
      onSelectCustom={draft.model.provider ? (id) => { update({ model: { provider: draft.model.provider, model: id }, reasoning: { kind: 'default' } }); setPicking(false); } : undefined} />}
    <Field label="Connection ID (optional)" hint="Reference an existing account identity only. Blank uses the provider connection; no automatic billing-path fallback.">
      <input aria-label="Connection ID (optional)" value={draft.model.connectionId ?? ''} onChange={(e) => update({ model: { ...draft.model, connectionId: e.target.value || undefined } })} />
    </Field>
    <Field label="Reasoning" hint="Default lets the provider/runtime decide; it does not disable reasoning. Only advertised efforts are selectable.">
      <select aria-label="Reasoning" value={draft.reasoning.kind === 'default' ? '' : draft.reasoning.value} onChange={(e) => update({ reasoning: e.target.value ? { kind: 'explicit', value: e.target.value as EffortLevel } : { kind: 'default' } })}>
        <option value="">Default</option>{efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        {draft.reasoning.kind === 'explicit' && !efforts.includes(draft.reasoning.value) && <option value={draft.reasoning.value} disabled>{draft.reasoning.value} (not advertised)</option>}
      </select>
    </Field>
    <Toggle label="Preset enabled" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
    <Field label="Preset selection guidance" hint="Routing guidance, not task prompts, role instructions or permissions."><textarea aria-label="Preset selection guidance" value={draft.guidance ?? ''} maxLength={8_000} onChange={(e) => update({ guidance: e.target.value })} /></Field>
    <p className="field-hint">Configured choices are unverified until runtime, account, tools and Mission-control checks succeed.</p>
    {error && <p role="alert">{error}</p>}
    <div className="row gap6"><Button onClick={() => {
      if (draft.reasoning.kind === 'explicit' && !efforts.includes(draft.reasoning.value)) { setError('Choose Default or an advertised reasoning effort.'); return; }
      if (draft.harnessId === 'acp' && !draft.runtimeVariantId) { setError('Select an existing ACP runtime.'); return; }
      try { onApply(draft); } catch (e) { setError((e as Error).message); }
    }}>Apply preset</Button><Button variant="ghost" onClick={onCancel}>Cancel preset edit</Button></div>
  </section>;
}

export function MissionSettings({ settings }: { settings: AppSettings }) {
  const [draft, setDraft] = useState(() => readDraft(settings));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<ExecutionPreset | null>(null);
  const [projectRoot, setProjectRoot] = useState('');
  const catalog = useStore((s) => s.modelCatalog);
  const mission = draft.mission;
  const projects = draft.projects;
  // Catalog/favorite updates must not throw away unsaved work in this form.
  useEffect(() => { if (!dirty && !busy) setDraft(readDraft(settings)); }, [settings.mission, settings.missionProjects, dirty, busy]);
  const capabilities: MissionCapabilityResolver = (preset) => {
    const models = catalog[preset.harnessId]?.models;
    return models ? { source: 'catalog', modelInfo: models.find((m) => m.provider === preset.model.provider && m.id === preset.model.model) } : undefined;
  };
  const change = (config: MissionConfig, overrides = projects) => {
    setDraft({ mission: config, projects: overrides }); setDirty(true); setMessage(''); setError('');
  };
  const setProject = (project: MissionProjectOverride | undefined) => {
    const next = { ...projects };
    if (project) next[projectRoot] = project;
    else delete next[projectRoot];
    change(mission, next);
  };
  const project = projects[projectRoot];
  const editableProject = project ?? { schemaVersion: 1 as const, revision: 1 };
  const projectPools = mission.tiers.map((tier) => ({ ...tier, presetIds: project?.tiers?.find((t) => t.id === tier.id)?.presetIds ?? tier.presetIds }));
  const projectLead = project?.defaultLeadPresetId === null ? undefined : project?.defaultLeadPresetId ?? mission.defaultLeadPresetId;
  const hasLead = (id: string | undefined, pool: string[]) => !!id && pool.includes(id) && mission.presets.some((p) => p.id === id && p.enabled);
  const revokeDefault = (config: MissionConfig, overrides: Projects, id: string) => {
    if (config.defaultLeadPresetId === id) delete config.defaultLeadPresetId;
    for (const override of Object.values(overrides)) if (override.defaultLeadPresetId === id) override.defaultLeadPresetId = null;
  };
  const chooseMembership = (tierId: TierId, presetId: string, checked: boolean, scope: 'global' | 'project') => {
    const updatePool = (ids: string[]) => checked ? [...ids, presetId] : ids.filter((id) => id !== presetId);
    if (scope === 'global') {
      const config = structuredClone(mission);
      const overrides = structuredClone(projects);
      const tier = config.tiers.find((t) => t.id === tierId)!;
      tier.presetIds = updatePool(tier.presetIds);
      if (tierId === 5 && !checked) {
        if (config.defaultLeadPresetId === presetId) delete config.defaultLeadPresetId;
        for (const override of Object.values(overrides)) {
          if (!override.tiers?.some((t) => t.id === 5) && override.defaultLeadPresetId === presetId) override.defaultLeadPresetId = null;
        }
      }
      change(config, overrides);
    } else {
      const tiers = projectPools.map((t) => t.id === tierId ? { ...t, presetIds: updatePool(t.presetIds) } : t);
      const next = { ...editableProject, tiers: [...(project?.tiers ?? []).filter((t) => t.id !== tierId), { id: tierId, presetIds: tiers.find((t) => t.id === tierId)!.presetIds }] };
      if (tierId === 5 && !hasLead(projectLead, tiers.find((t) => t.id === 5)!.presetIds)) next.defaultLeadPresetId = null;
      setProject(next);
    }
  };
  const membership = (tierId: TierId, ids: string[], scope: 'global' | 'project', disabled = false) => <>
    {!ids.length && <p>Unavailable pool — no presets. No fallback.</p>}
    {!!ids.length && !ids.some((id) => mission.presets.some((p) => p.id === id && p.enabled)) && <p>Unavailable pool — all presets are disabled.</p>}
    {mission.presets.map((preset) => <div key={preset.id} className="mission-membership">
      <label><input type="checkbox" aria-label={`${scope === 'project' ? 'Project ' : ''}T${tierId}: ${preset.name}`} disabled={disabled} checked={ids.includes(preset.id)} onChange={(e) => chooseMembership(tierId, preset.id, e.target.checked, scope)} /> {preset.name}</label>
      {tierId === 5 && ids.includes(preset.id) && (scope === 'project' ? projectLead : mission.defaultLeadPresetId) === preset.id && <Badge>Default principal engineer</Badge>}
    </div>)}
  </>;
  const leadSelect = (scope: 'global' | 'project') => {
    const ids = (scope === 'global' ? mission.tiers : projectPools).find((t) => t.id === 5)!.presetIds;
    const value = scope === 'global' ? mission.defaultLeadPresetId ?? '' : project?.defaultLeadPresetId === null ? '__none' : project?.defaultLeadPresetId ?? '__inherit';
    return <Field label={scope === 'global' ? 'Default principal engineer (T5)' : 'Project principal engineer (T5)'}>
      <select aria-label={scope === 'global' ? 'Default principal engineer (T5)' : 'Project principal engineer (T5)'} value={value} onChange={(e) => {
        if (scope === 'global') change({ ...mission, defaultLeadPresetId: e.target.value || undefined });
        else setProject({ ...editableProject, defaultLeadPresetId: e.target.value === '__inherit' ? undefined : e.target.value === '__none' ? null : e.target.value });
      }}>
        {scope === 'project' && <option value="__inherit">Inherit global default</option>}
        <option value={scope === 'global' ? '' : '__none'}>Unconfigured — no default</option>
        {mission.presets.filter((p) => p.enabled && ids.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        {value && !['__none', '__inherit'].includes(value) && !hasLead(value, ids) && <option value={value} disabled>Invalid selection — choose another default or clear it</option>}
      </select>
    </Field>;
  };
  const save = async () => {
    setError(''); setMessage(''); setBusy(true);
    try {
      const config = validateMissionConfig(mission, capabilities);
      const nextProjects: Projects = {};
      for (const [root, raw] of Object.entries(projects)) {
        const value = validateMissionProjectOverride(raw);
        applyMissionProjectOverride(config, value);
        nextProjects[root] = value;
      }
      // Revisions describe saved generations, not each keystroke. Never change a running snapshot.
      const previous = readDraft(settings);
      config.revision = previous.mission.revision + 1;
      for (const preset of config.presets) {
        const before = previous.mission.presets.find((p) => p.id === preset.id);
        preset.revision = before ? before.revision + (JSON.stringify(preset) === JSON.stringify(before) ? 0 : 1) : 1;
      }
      for (const [root, override] of Object.entries(nextProjects)) {
        const before = previous.projects[root];
        override.revision = before ? before.revision + (JSON.stringify(override) === JSON.stringify(before) ? 0 : 1) : 1;
      }
      const saved = await invoke('settings:update', { mission: config, missionProjects: nextProjects });
      useStore.getState().setSettings(saved);
      setDraft(readDraft(saved)); setDirty(false); setMessage('Mission settings saved. Runtime eligibility remains unverified.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="settings-section mission-settings">
    <h2>Mission</h2>
    <p>Configure execution presets and five tier pools. These settings do not start a Mission; launch is not enabled in this phase.</p>
    <p className="field-hint">A preset pins its harness, model, provider/connection and reasoning as one choice. Catalog entries do not prove runtime availability or lead capability. No automatic model, effort or billing-path fallback.</p>
    {draft.error && <div role="alert"><p>{draft.error}</p><Button onClick={() => { change(createDefaultMissionConfig(), {}); }}>Replace invalid Mission settings</Button></div>}
    <fieldset disabled={busy || !!draft.error} className="mission-form">
      <div className="mission-toolbar"><h3>Preset library</h3><Button disabled={!!editor} onClick={() => setEditor({ id: `preset-${crypto.randomUUID()}`, revision: 1, name: '', harnessId: settings.defaultHarness, model: { provider: '', model: '' }, reasoning: { kind: 'default' }, enabled: true })}>New preset</Button></div>
      {!mission.presets.length && <p>No presets configured. Add an exact execution choice to begin.</p>}
      {mission.presets.map((preset) => {
        const eligibility = validatePresetEligibility(preset, { capabilities: catalog[preset.harnessId] ? capabilities : undefined });
        const pools = mission.tiers.filter((t) => t.presetIds.includes(preset.id));
        return <section key={preset.id} className="mission-card" aria-label={`Preset ${preset.name}`}>
          <div className="mission-toolbar"><strong>{preset.name}</strong><Badge>{MISSION_PRESET_STATUS_LABELS[eligibility.status]}</Badge></div>
          <p>{HARNESS_BY_ID[preset.harnessId].name} · {preset.model.provider}/{preset.model.model} · Connection: {preset.model.connectionId ?? preset.model.provider} · Reasoning: {preset.reasoning.kind === 'default' ? 'Default' : preset.reasoning.value}</p>
          {preset.runtimeVariantId && <p>Runtime: {preset.runtimeVariantId}</p>}
          <p className="field-hint">{eligibility.reasons.join(' ')}</p>
          {pools.length > 1 && <p role="note">Overlapping membership ({pools.map((t) => `T${t.id}`).join(', ')}) does not create a capability difference.</p>}
          <div className="row gap6"><Button size="sm" disabled={!!editor} onClick={() => setEditor(structuredClone(preset))}>Edit {preset.name}</Button>
            <Button size="sm" variant="ghost" disabled={!!editor} onClick={() => {
              const config = structuredClone(mission); const overrides = structuredClone(projects);
              config.presets = config.presets.filter((p) => p.id !== preset.id);
              for (const tier of config.tiers) tier.presetIds = tier.presetIds.filter((id) => id !== preset.id);
              for (const override of Object.values(overrides)) for (const tier of override.tiers ?? []) tier.presetIds = tier.presetIds.filter((id) => id !== preset.id);
              revokeDefault(config, overrides, preset.id); change(config, overrides);
            }}>Delete {preset.name}</Button></div>
        </section>;
      })}
      {editor && <PresetEditor key={editor.id} initial={editor} settings={settings} onCancel={() => setEditor(null)} onApply={(preset) => {
        const config = structuredClone(mission); const overrides = structuredClone(projects);
        const index = config.presets.findIndex((p) => p.id === preset.id);
        if (index < 0) config.presets.push(preset); else config.presets[index] = preset;
        if (!preset.enabled) revokeDefault(config, overrides, preset.id);
        validateMissionConfig(config, capabilities);
        change(config, overrides); setEditor(null);
      }} />}
      <h3>Five tier pools</h3>
      <p className="field-hint">Tier IDs and ordering are fixed. Labels and guidance are yours, not measured rankings.</p>
      {mission.tiers.map((tier) => <section key={tier.id} className="mission-card" aria-label={`Tier ${tier.id}`}>
        <h4>T{tier.id} — {tier.label}</h4>
        <Field label={`T${tier.id} label`}><input aria-label={`T${tier.id} label`} value={tier.label} maxLength={200} onChange={(e) => change({ ...mission, tiers: mission.tiers.map((t) => t.id === tier.id ? { ...t, label: e.target.value } : t) })} /></Field>
        <Field label={`T${tier.id} guidance`}><textarea aria-label={`T${tier.id} guidance`} value={tier.guidance ?? ''} maxLength={8_000} onChange={(e) => change({ ...mission, tiers: mission.tiers.map((t) => t.id === tier.id ? { ...t, guidance: e.target.value } : t) })} /></Field>
        {membership(tier.id, tier.presetIds, 'global')}
        {tier.id === 5 && leadSelect('global')}
      </section>)}
      {!mission.defaultLeadPresetId && <p role="note">Mission launch is unconfigured — no default principal engineer. No replacement is selected automatically.</p>}
      <h3>Concurrency and progress limits</h3>
      <p className="field-hint">Optional cost/token thresholds cover the whole Mission: lead, workers, repeated attempts and restarts. They pause automation at observed usage, not a guaranteed financial ceiling: in-flight work and delayed or estimated telemetry can overshoot. Missing usage after work pauses rather than counting as zero. No default monetary or time budget; healthy long work is not stopped for elapsed time.</p>
      <Limits value={mission.limits} onChange={(limits) => change({ ...mission, limits: limits as MissionConfig['limits'] })} />
      <AccountLimits value={mission.limits.accountLimits ?? {}} connections={[...new Set([...settings.providers.map((p) => p.id), ...mission.presets.map((p) => p.model.connectionId ?? p.model.provider)])]} onChange={(accountLimits) => change({ ...mission, limits: { ...mission.limits, accountLimits } })} />
      <h3>Project overrides</h3>
      <p className="field-hint">Use the same global preset library. Overrides cannot grant permissions, redefine presets, or increase a global ceiling.</p>
      <Field label="Project folder"><select aria-label="Project folder" value={projectRoot} onChange={(e) => setProjectRoot(e.target.value)}>
        <option value="">Select configured folder</option>{settings.folders.map((root) => <option key={root} value={root}>{root}</option>)}
      </select></Field>
      {!settings.folders.length && <p>Add a project folder in the sidebar to configure overrides.</p>}
      {projectRoot && settings.folders.includes(projectRoot) && <section className="mission-card" aria-label="Project overrides">
        <p>{project ? 'Project overrides configured' : 'Inheriting global configuration'}</p>
        <Button variant="ghost" onClick={() => setProject(undefined)} disabled={!project}>Reset project overrides</Button>
        {projectPools.map((tier) => {
          const overriding = !!project?.tiers?.some((t) => t.id === tier.id);
          return <section key={tier.id} className="mission-project-tier">
            <Toggle label={`Override T${tier.id} membership`} checked={overriding} onChange={(checked) => {
              const tiers = (project?.tiers ?? []).filter((t) => t.id !== tier.id);
              if (checked) tiers.push({ id: tier.id, presetIds: [...tier.presetIds] });
              setProject({ ...editableProject, tiers });
            }} />
            {membership(tier.id, tier.presetIds, 'project', !overriding)}
          </section>;
        })}
        {leadSelect('project')}
        {!projectLead && <p>Project Mission launch is unconfigured.</p>}
        {(['allowedProviderIds', 'allowedConnectionIds'] as const).map((key) => {
          const label = key === 'allowedProviderIds' ? 'providers' : 'connections';
          const options = [...new Set([...mission.presets.map((p) => key === 'allowedProviderIds' ? p.model.provider : p.model.connectionId ?? p.model.provider), ...(project?.[key] ?? [])])];
          return <section key={key}>
            <Toggle label={`Restrict project ${label}`} checked={project?.[key] !== undefined} onChange={(checked) => setProject({ ...editableProject, [key]: checked ? [...options] : undefined })} />
            {project?.[key] !== undefined && <>
              {!project[key]!.length && <p>No {label} permitted — all presets are unavailable in this project.</p>}
              {options.map((id) => <label key={id} className="mission-membership"><input type="checkbox" aria-label={`Permit ${label}: ${id}`} checked={project[key]!.includes(id)} onChange={(e) => setProject({ ...editableProject, [key]: e.target.checked ? [...project[key]!, id] : project[key]!.filter((v) => v !== id) })} />{id}</label>)}
            </>}
          </section>;
        })}
        {mission.presets.filter((p) => projectPools.some((tier) => tier.presetIds.includes(p.id))).map((p) => {
          const status = validatePresetEligibility(p, { restrictions: project, capabilities });
          const pools = projectPools.filter((tier) => tier.presetIds.includes(p.id));
          return <div key={p.id}>
            <p>{p.name}: {MISSION_PRESET_STATUS_LABELS[status.status]}{status.status === 'unavailable' ? ` — ${status.reasons.join(' ')}` : ''}</p>
            {pools.length > 1 && <p role="note">Project overlapping membership for {p.name} ({pools.map((tier) => `T${tier.id}`).join(', ')}) does not create a capability difference.</p>}
          </div>;
        })}
        <h4>Project ceilings</h4><Limits value={project?.limits ?? {}} ceiling={mission.limits} onChange={(limits) => setProject({ ...editableProject, limits })} />
      </section>}
      <div className="mission-actions"><Button disabled={!dirty || !!editor} onClick={() => void save()}>{busy ? 'Saving…' : 'Save Mission settings'}</Button>
        <Button variant="ghost" disabled={!dirty && !editor} onClick={() => { setDraft(readDraft(settings)); setDirty(false); setEditor(null); setError(''); setMessage(''); }}>Discard changes</Button>
        {dirty && <span>Unsaved changes</span>}
      </div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
