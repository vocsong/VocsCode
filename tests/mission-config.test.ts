import { describe, expect, it, vi } from 'vitest';
import {
  applyMissionProjectOverride,
  checkMissionPresetAdherence,
  checkMissionPresetRevocation,
  createDefaultMissionConfig,
  DEFAULT_MISSION_CONFIG,
  MISSION_LIMIT_MAXIMUMS,
  resolveMissionConfig,
  resolveMissionDispatchPreset,
  validateMissionConfig,
  validateMissionProjectOverride,
  validatePresetEligibility,
  type ExecutionPreset,
  type MissionCapabilityResolver,
  type MissionConfig,
  type MissionEffectivePreset,
  type MissionPresetCapabilities,
  type MissionProjectOverride
} from '../src/shared/mission-config';
import type { EffortLevel } from '../src/shared/types';

function preset(id = 'lead', connectionId = 'subscription-a'): ExecutionPreset {
  return {
    id, revision: 1, name: id, harnessId: 'pi', model: { provider: 'provider-a', model: 'shared/model', connectionId },
    reasoning: { kind: 'explicit', value: 'high' }, enabled: true
  };
}

function config(): MissionConfig {
  const result = createDefaultMissionConfig();
  result.presets = [preset(), preset('alternative', 'api-b'), { ...preset('standard'), reasoning: { kind: 'explicit', value: 'low' } }];
  result.tiers[2].presetIds = ['standard'];
  result.tiers[4].presetIds = ['lead', 'alternative'];
  result.defaultLeadPresetId = 'lead';
  return result;
}

/** Scripted evidence, not a claim that any real runtime has been Mission-certified. */
const available: MissionCapabilityResolver = (p) => ({
  source: 'runtime', runtime: { available: true, authenticated: true }, connectionAvailable: true, modelAvailable: true,
  modelInfo: { id: p.model.model, provider: p.model.provider, displayName: 'Test model', supportsReasoning: true, supportedEfforts: ['low', 'high'] },
  harnessCapabilities: { effort: true, interrupt: true }, controlProtocol: true, worktreeCwd: true,
  completionObservation: true, cancellationObservation: true, projectAllowed: true, missionTools: true,
  delegationControl: true, tools: ['read', 'write']
});

function evidence(patch: Partial<MissionPresetCapabilities>): MissionCapabilityResolver {
  return (p) => ({ ...available(p)!, ...patch });
}

function project(patch: Partial<MissionProjectOverride> = {}): MissionProjectOverride {
  return { schemaVersion: 1, revision: 1, ...patch };
}

function effective(p = preset()): MissionEffectivePreset {
  return { harnessId: p.harnessId, model: { ...p.model }, reasoning: { ...p.reasoning } };
}

describe('Mission configuration save boundary', () => {
  it('starts explicitly unconfigured with five distinct empty pools and every specified limit', () => {
    const saved = validateMissionConfig(DEFAULT_MISSION_CONFIG);
    expect(saved).toEqual({
      schemaVersion: 1, revision: 1, presets: [],
      tiers: [
        { id: 1, label: 'Routine', presetIds: [] }, { id: 2, label: 'Focused', presetIds: [] },
        { id: 3, label: 'Standard', presetIds: [] }, { id: 4, label: 'Advanced', presetIds: [] },
        { id: 5, label: 'Frontier', presetIds: [] }
      ],
      limits: { maxConcurrentWorkersPerMission: 4, maxConcurrentAgentTurnsGlobal: 10, maxConcurrentHeavyChecksGlobal: 1,
        maxDelegationDepth: 1, maxTaskAttemptsBeforeLeadDiagnosis: 3, progressCheckpointEveryTurns: 20, maxNoProgressCheckpoints: 3 }
    });
    expect(saved.defaultLeadPresetId).toBeUndefined();
    expect(saved.limits.maxBudgetUsd).toBeUndefined();
    expect(saved.limits.maxTokens).toBeUndefined();
    saved.tiers[0].presetIds.push('not-shared');
    expect(saved.tiers[1].presetIds).toEqual([]);
    expect(createDefaultMissionConfig()).toEqual(DEFAULT_MISSION_CONFIG);
    expect(Object.isFrozen(DEFAULT_MISSION_CONFIG.tiers[0].presetIds)).toBe(true);
  });

  it.each([null, [], 'config', 1, {}, new Date()])('rejects non-configuration input %j', (value) => {
    expect(() => validateMissionConfig(value)).toThrow();
  });

  it.each([0, 2, '1', undefined])('refuses missing/unknown schema versions (%s)', (schemaVersion) => {
    expect(() => validateMissionConfig({ ...config(), schemaVersion })).toThrow(/schema version/i);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])('rejects invalid revisions %s at both levels', (revision) => {
    expect(() => validateMissionConfig({ ...config(), revision })).toThrow(/revision/);
    expect(() => validateMissionConfig({ ...config(), presets: [{ ...preset(), revision }] })).toThrow(/revision/);
  });

  it.each([
    { harnessId: 'made-up' }, { harnessId: 'toString' }, { harnessId: '__proto__' },
    { id: '' }, { name: '  ' }, { enabled: 'true' }, { runtimeVariantId: 'https://user:password@host' },
    { model: { provider: '', model: 'a' } }, { model: { provider: 'provider-a', model: '' } },
    { model: { provider: 'provider-a', model: 'a\nb' } }, { model: { provider: 'provider-a', model: 'https://host/model' } },
    { model: { provider: 'provider-a', model: 'a', connectionId: '' } },
    { reasoning: { kind: 'explicit', value: 'ultra' } }, { reasoning: { kind: 'explicit', value: 'off' } },
    { reasoning: { kind: 'explicit' } }, { reasoning: { kind: 'default', value: 'high' } },
    { reasoning: { kind: 'default', value: undefined } }, { reasoning: { kind: 'tier', value: 5 } }
  ])('rejects invalid preset fields %j', (patch) => {
    const base = config();
    expect(() => validateMissionConfig({ ...base, presets: [{ ...base.presets[0], ...patch }, ...base.presets.slice(1)] })).toThrow();
  });

  it.each(['apiKey', 'token', 'headers', 'env', 'baseUrl', 'permissionMode', 'instructions', 'ownedFiles'])('rejects %s rather than stripping sensitive/extra fields', (field) => {
    const base = config();
    const secret = 'must-not-appear-in-the-error';
    for (const invalid of [
      { ...base, [field]: secret },
      { ...base, presets: [{ ...preset(), [field]: secret }] },
      { ...base, presets: [{ ...preset(), model: { ...preset().model, [field]: secret } }] },
      { ...base, presets: [{ ...preset(), reasoning: { kind: 'default', [field]: secret } }] },
      { ...base, tiers: base.tiers.map((t) => ({ ...t, [field]: secret })) },
      { ...base, limits: { ...base.limits, [field]: secret } }
    ]) {
      expect(() => validateMissionConfig(invalid)).toThrow(/Unknown fields/);
      expect(() => validateMissionConfig(invalid)).not.toThrow(secret);
    }
  });

  it('rejects inherited data, symbol keys, duplicate presets, duplicate/missing tiers and dangling references', () => {
    const base = config();
    expect(() => validateMissionConfig(Object.create(base))).toThrow(/plain object/);
    expect(() => validateMissionConfig({ ...base, [Symbol('hidden')]: 'secret' })).toThrow(/Unknown fields/);
    expect(() => validateMissionConfig({ ...base, presets: [...base.presets, base.presets[0]] })).toThrow(/unique/);
    for (const tiers of [base.tiers.slice(1), [...base.tiers, base.tiers[0]], base.tiers.map(() => base.tiers[4])]) {
      expect(() => validateMissionConfig({ ...base, tiers })).toThrow(/Exactly one/);
    }
    for (const invalid of ['5', 0, 6, 1.5]) {
      expect(() => validateMissionConfig({ ...base, tiers: [{ ...base.tiers[0], id: invalid }, ...base.tiers.slice(1)] })).toThrow(/tier from 1 through 5/);
    }
    base.tiers[0].presetIds = ['missing'];
    expect(() => validateMissionConfig(base)).toThrow(/reference/);
    base.tiers[0].presetIds = ['lead', 'lead'];
    expect(() => validateMissionConfig(base)).toThrow(/Duplicate references/);
  });

  it('allows empty T1-T4, overlapping memberships, and distinct presets for the same model', () => {
    const base = config();
    base.tiers[2].presetIds = [];
    expect(validateMissionConfig(base, available).tiers.slice(0, 4).map((t) => t.presetIds)).toEqual([[], [], [], []]);
    base.tiers[0].presetIds = ['lead'];
    const saved = validateMissionConfig(base, available);
    expect(saved.tiers[0].presetIds).toEqual(['lead']);
    expect(saved.tiers[4].presetIds).toEqual(['lead', 'alternative']);
    expect(saved.presets).toHaveLength(3);
    expect(saved.presets.map((p) => p.model.connectionId)).toEqual(['subscription-a', 'api-b', 'subscription-a']);
    expect(saved.presets.map((p) => p.reasoning)).toEqual([
      { kind: 'explicit', value: 'high' }, { kind: 'explicit', value: 'high' }, { kind: 'explicit', value: 'low' }
    ]);
  });

  it('validates bounded app-wide exact account maps without adding defaults or project overrides', () => {
    const base = config();
    expect(createDefaultMissionConfig().limits.accountLimits).toBeUndefined();
    base.limits.accountLimits = { 'subscription-a': 1, 'api-b': 4 };
    expect(validateMissionConfig(base).limits.accountLimits).toEqual({ 'subscription-a': 1, 'api-b': 4 });
    for (const accountLimits of [[], null, { 'https://secret.invalid': 2 }, { account: 0 }, { account: 129 }, { account: 1.5 }, { account: '2' }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`account-${i}`, 1]))]) {
      expect(() => validateMissionConfig({ ...base, limits: { ...base.limits, accountLimits } })).toThrow(/accountLimits/);
    }
    expect(() => validateMissionProjectOverride(project({ limits: { accountLimits: { 'subscription-a': 2 } } as never }))).toThrow(/Unknown fields/);
    expect(applyMissionProjectOverride(base, project({ limits: { maxTokens: 200 } })).limits.accountLimits).toEqual(base.limits.accountLimits);
  });

  it('requires a chosen default to be enabled and T5; clearing it saves an unconfigured library', () => {
    const base = config();
    for (const defaultLeadPresetId of ['missing', 'standard', '', null]) {
      expect(() => validateMissionConfig({ ...base, defaultLeadPresetId })).toThrow();
    }
    base.presets[0].enabled = false;
    expect(() => validateMissionConfig(base)).toThrow(/enabled T5/);
    delete base.defaultLeadPresetId;
    expect(validateMissionConfig(base).defaultLeadPresetId).toBeUndefined();
  });

  it.each(Object.keys(MISSION_LIMIT_MAXIMUMS) as Array<keyof typeof MISSION_LIMIT_MAXIMUMS>)('bounds %s without coercion/clamping', (key) => {
    for (const invalid of [0, -1, NaN, Infinity, '4', MISSION_LIMIT_MAXIMUMS[key] + 1, ...(key === 'maxBudgetUsd' ? [] : [1.5])]) {
      expect(() => validateMissionConfig({ ...config(), limits: { ...config().limits, [key]: invalid } })).toThrow(`limits.${key}`);
    }
    expect(validateMissionConfig({ ...config(), limits: { ...config().limits, [key]: MISSION_LIMIT_MAXIMUMS[key] } }).limits[key]).toBe(MISSION_LIMIT_MAXIMUMS[key]);
  });

  it('requires all mandatory guards and keeps depth one fixed, while optional caps remain optional', () => {
    const base = config();
    expect(() => validateMissionConfig({ ...base, limits: { ...base.limits, maxConcurrentAgentTurnsGlobal: undefined } })).toThrow(/maxConcurrentAgentTurnsGlobal/);
    expect(() => validateMissionConfig({ ...base, limits: { ...base.limits, maxDelegationDepth: 2 } })).toThrow(/maxDelegationDepth/);
    const saved = validateMissionConfig({ ...base, limits: { ...base.limits, maxBudgetUsd: 0.25, maxTokens: 10_000 } });
    expect(saved.limits.maxBudgetUsd).toBe(0.25);
    expect(saved.limits.maxTokens).toBe(10_000);
  });

  it('returns editable detached data, with no mutation/freezing of the caller or capability cache', () => {
    const base = config();
    base.presets[0].guidance = '';
    base.tiers[0].guidance = '';
    const info = available(base.presets[0])!;
    const saved = validateMissionConfig(base, () => info);
    saved.presets[0].model.connectionId = 'edited';
    saved.tiers[4].presetIds.pop();
    expect(base.presets[0].model.connectionId).toBe('subscription-a');
    expect(base.tiers[4].presetIds).toEqual(['lead', 'alternative']);
    expect(Object.isFrozen(base.presets[0])).toBe(false);
    expect(Object.isFrozen(info.modelInfo)).toBe(false);
  });
});

describe('honest Mission capability states and effort support', () => {
  it('distinguishes Configured from Unverified, without treating a catalog as live proof', () => {
    expect(validatePresetEligibility(preset()).status).toBe('configured');
    expect(validatePresetEligibility(preset(), { capabilities: () => undefined }).status).toBe('unverified');
    expect(validatePresetEligibility(preset(), { capabilities: evidence({ source: 'catalog' }) })).toMatchObject({ status: 'unverified', eligible: false });
    expect(validatePresetEligibility(preset(), { capabilities: available, role: 'lead' })).toEqual({ status: 'available', eligible: true, reasons: [] });
    expect(() => resolveMissionConfig(config())).toThrow(/Configured/);
    expect(() => resolveMissionConfig(config(), undefined, undefined, evidence({ source: 'catalog' }))).toThrow(/Unverified/);
  });

  it.each([
    { runtime: { available: false } }, { runtime: { available: true, authenticated: false } },
    { connectionAvailable: false }, { modelAvailable: false }, { projectAllowed: false }
  ])('reports an unavailable runtime/account/model/rule without inventing a fallback %j', (patch) => {
    const caps = evidence(patch);
    expect(validatePresetEligibility(preset(), { capabilities: caps })).toMatchObject({ status: 'unavailable', eligible: false });
    expect(() => resolveMissionConfig(config(), undefined, undefined, caps)).toThrow(/Unavailable/);
    // Offline or temporarily unavailable configurations are still editable/savable.
    expect(validateMissionConfig(config(), caps).defaultLeadPresetId).toBe('lead');
  });

  it.each(['controlProtocol', 'worktreeCwd', 'completionObservation', 'cancellationObservation', 'delegationControl', 'missionTools'] as const)(
    'requires affirmative %s evidence for a lead', (field) => {
      expect(validatePresetEligibility(preset(), { role: 'lead', capabilities: evidence({ [field]: undefined }) }).status).toBe('unverified');
      expect(validatePresetEligibility(preset(), { role: 'lead', capabilities: evidence({ [field]: false }) }).status).toBe('unsupported');
      expect(() => resolveMissionConfig(config(), undefined, undefined, evidence({ [field]: false }))).toThrow(/Unsupported/);
    }
  );

  it('does not promote worker support to lead support; task tools and interruption are checked separately', () => {
    const workerOnly = evidence({ missionTools: false });
    expect(validatePresetEligibility(preset(), { role: 'worker', capabilities: workerOnly }).eligible).toBe(true);
    expect(validatePresetEligibility(preset(), { role: 'lead', capabilities: workerOnly }).status).toBe('unsupported');
    expect(validatePresetEligibility(preset(), { capabilities: available, requiredTools: ['deploy'] }).status).toBe('unsupported');
    expect(validatePresetEligibility(preset(), { capabilities: evidence({ tools: undefined }), requiredTools: ['read'] }).status).toBe('unverified');
    expect(validatePresetEligibility(preset(), { capabilities: evidence({ harnessCapabilities: { effort: true, interrupt: false } }) }).status).toBe('unsupported');
  });

  it('passes exact connection, variant and reasoning identity to injected evidence', () => {
    const base = config();
    base.presets[1].runtimeVariantId = 'runtime-b';
    const resolver = vi.fn<MissionCapabilityResolver>((p) => {
      if (p.model.connectionId === 'api-b') return { ...available(p)!, connectionAvailable: false };
      return available(p);
    });
    expect(resolveMissionConfig(base, undefined, 'lead', resolver).leadPreset.model.connectionId).toBe('subscription-a');
    expect(() => resolveMissionConfig(base, undefined, 'alternative', resolver)).toThrow(/connection\/account/);
    expect(resolver.mock.calls.at(-1)?.[0]).toEqual(base.presets[1]);
    expect(Object.isFrozen(resolver.mock.calls.at(-1)?.[0].model)).toBe(true);
  });

  it('does not use another provider/model capability row as support', () => {
    const caps = evidence({ modelInfo: { id: 'other', provider: 'other-provider', displayName: 'wrong row', supportsReasoning: true, supportedEfforts: ['high'] } });
    expect(validatePresetEligibility(preset(), { capabilities: caps }).status).toBe('unsupported');
    expect(() => validateMissionConfig(config(), caps)).toThrow(/different model\/provider/);
  });

  it('rejects known unsupported efforts at save and dispatch instead of quietly selecting Default', () => {
    const base = config();
    base.presets[0].reasoning = { kind: 'explicit', value: 'max' };
    expect(() => validateMissionConfig(base, available)).toThrow(/explicit effort/);
    expect(() => resolveMissionConfig(base, undefined, undefined, available)).toThrow(/explicit effort/);
    base.presets[0].harnessId = 'cursor';
    expect(() => validateMissionConfig(base)).toThrow(/explicit effort/);
    const modelWithoutEffort = evidence({ modelInfo: { id: 'shared/model', provider: 'provider-a', displayName: 'non-reasoning', supportsReasoning: false } });
    expect(() => validateMissionConfig(config(), modelWithoutEffort)).toThrow(/explicit effort/);
  });

  it('does not invent effort choices when supportedEfforts are absent or empty', () => {
    for (const supportedEfforts of [undefined, [] as EffortLevel[]]) {
      const caps = evidence({ modelInfo: { id: 'shared/model', provider: 'provider-a', displayName: 'test', supportsReasoning: true, supportedEfforts } });
      expect(validatePresetEligibility(preset(), { capabilities: caps }).status).toBe(supportedEfforts ? 'unsupported' : 'unverified');
      expect(() => resolveMissionConfig(config(), undefined, undefined, caps)).toThrow();
    }
  });

  it('Default is valid without a selectable effort, remains Default at T5, and never becomes app/model high or off', () => {
    const base = config();
    base.presets = [{ ...preset(), harnessId: 'cursor', reasoning: { kind: 'default' } }];
    base.tiers[2].presetIds = [];
    base.tiers[4].presetIds = ['lead'];
    const caps = evidence({
      harnessCapabilities: { effort: false, interrupt: true },
      modelInfo: { id: 'shared/model', provider: 'provider-a', displayName: 'model', supportsReasoning: false, supportedEfforts: [], defaultEffort: 'high' }
    });
    expect(validateMissionConfig(base, caps).presets[0].reasoning).toEqual({ kind: 'default' });
    expect(resolveMissionConfig(base, undefined, undefined, caps).leadPreset.reasoning).toEqual({ kind: 'default' });
  });
});

describe('project overrides and immutable launch resolution', () => {
  it('applies global -> project -> explicit T5 selection without changing the source configuration', () => {
    const base = config();
    const override = project({ revision: 4, tiers: [{ id: 3, presetIds: [] }, { id: 4, presetIds: ['standard'] }],
      defaultLeadPresetId: 'alternative', limits: { maxConcurrentWorkersPerMission: 2 } });
    const merged = applyMissionProjectOverride(base, override);
    expect(merged.tiers.map((t) => t.presetIds)).toEqual([[], [], [], ['standard'], ['lead', 'alternative']]);
    expect(merged.defaultLeadPresetId).toBe('alternative');
    expect(merged.limits.maxConcurrentWorkersPerMission).toBe(2);
    const pinned = resolveMissionConfig(base, override, 'lead', available);
    expect(pinned.leadPreset.id).toBe('lead');
    expect(pinned.defaultLeadPresetId).toBe('lead');
    expect(pinned.projectRevision).toBe(4);
    expect(base).toEqual(config());
    expect(override.defaultLeadPresetId).toBe('alternative');
  });

  it('never automatically repairs a missing, removed, disabled, lower-tier or unavailable default', () => {
    const base = config();
    delete base.defaultLeadPresetId;
    expect(() => resolveMissionConfig(base, undefined, undefined, available)).toThrow(/unconfigured/);
    expect(() => resolveMissionConfig(base, undefined, 'standard', available)).toThrow(/enabled T5/);
    expect(resolveMissionConfig(base, undefined, 'alternative', available).leadPreset.id).toBe('alternative');
    expect(() => resolveMissionConfig(config(), project({ tiers: [{ id: 5, presetIds: ['alternative'] }] }), undefined, available)).toThrow(/enabled T5/);
    expect(resolveMissionConfig(config(), project({ tiers: [{ id: 5, presetIds: ['alternative'] }] }), 'alternative', available).leadPreset.id).toBe('alternative');
    expect(() => resolveMissionConfig(config(), undefined, undefined, (p) => p.id === 'lead' ? { ...available(p)!, runtime: { available: false } } : available(p))).toThrow(/Unavailable/);
  });

  it('can explicitly empty T5 and clear the default for saving, but not launch it', () => {
    const override = project({ tiers: [{ id: 5, presetIds: [] }], defaultLeadPresetId: null });
    const merged = applyMissionProjectOverride(config(), override);
    expect(merged.tiers[4].presetIds).toEqual([]);
    expect(merged.defaultLeadPresetId).toBeUndefined();
    expect(() => resolveMissionConfig(config(), override, undefined, available)).toThrow(/unconfigured/);
    expect(() => resolveMissionConfig(config(), override, 'lead', available)).toThrow(/enabled T5/);
  });

  it.each([
    { presets: [preset('injected')] }, { permissionMode: 'full-auto' }, { apiKey: 'secret' }, { revision: 0 }, { schemaVersion: 2 },
    { tiers: [{ id: 6, presetIds: [] }] }, { tiers: [{ id: 1, presetIds: [] }, { id: 1, presetIds: [] }] },
    { tiers: [{ id: 1, presetIds: ['lead', 'lead'] }] }, { tiers: [{ id: 1, presetIds: [], label: 'new label' }] },
    { allowedProviderIds: ['provider-a', 'provider-a'] }, { allowedConnectionIds: ['https://account'] },
    { limits: { maxBudgetUsd: null } }
  ])('rejects malformed or authority-expanding override data %j', (patch) => {
    expect(() => validateMissionProjectOverride({ ...project(), ...patch })).toThrow();
  });

  it('requires existing library references and forbids project/global ceiling expansion', () => {
    expect(() => applyMissionProjectOverride(config(), null as never)).toThrow(/plain object/);
    expect(() => applyMissionProjectOverride(config(), project({ tiers: [{ id: 1, presetIds: ['invented'] }] }))).toThrow(/reference/);
    expect(() => applyMissionProjectOverride(config(), project({ defaultLeadPresetId: 'standard' }))).toThrow(/enabled T5/);
    expect(() => applyMissionProjectOverride(config(), project({ limits: { maxConcurrentAgentTurnsGlobal: 11 } }))).toThrow(/tighten/);
    const capped = config();
    capped.limits.maxBudgetUsd = 4;
    expect(() => applyMissionProjectOverride(capped, project({ limits: { maxBudgetUsd: 5 } }))).toThrow(/tighten/);
    expect(applyMissionProjectOverride(config(), project({ limits: { maxBudgetUsd: 5 } })).limits.maxBudgetUsd).toBe(5);
  });

  it('cannot widen provider/account restrictions through an explicit lead override', () => {
    const override = project({ allowedProviderIds: ['provider-a'], allowedConnectionIds: ['subscription-a'] });
    expect(resolveMissionConfig(config(), override, 'lead', available).restrictions).toEqual({ allowedProviderIds: ['provider-a'], allowedConnectionIds: ['subscription-a'] });
    expect(() => resolveMissionConfig(config(), override, 'alternative', available)).toThrow(/connection is not permitted/);
    expect(() => resolveMissionConfig(config(), project({ allowedProviderIds: [] }), 'lead', available)).toThrow(/provider is not permitted/);
    expect(() => resolveMissionConfig(config(), project({ allowedConnectionIds: [] }), 'lead', available)).toThrow(/connection is not permitted/);
    const implicit = preset();
    delete implicit.model.connectionId;
    expect(validatePresetEligibility(implicit, { capabilities: available, restrictions: { allowedConnectionIds: ['provider-a'] } }).eligible).toBe(true);
  });

  it('clones and freezes every snapshot field while preserving historical values after later settings edits', () => {
    const base = config();
    base.presets[0].guidance = 'original guidance';
    base.tiers[4].guidance = 'original tier';
    const override = project({ revision: 2, allowedConnectionIds: ['subscription-a'], tiers: [{ id: 1, presetIds: ['standard'] }] });
    const pinned = resolveMissionConfig(base, override, undefined, available);
    const serialized = JSON.stringify(pinned);
    base.revision++;
    base.presets[0].name = 'renamed';
    base.presets[0].revision++;
    base.presets[0].model.connectionId = 'api-b';
    base.presets[0].reasoning = { kind: 'default' };
    base.tiers[4].presetIds = [];
    base.limits.maxConcurrentWorkersPerMission = 1;
    override.tiers![0].presetIds.pop();
    override.allowedConnectionIds = [];
    expect(JSON.stringify(pinned)).toBe(serialized);
    expect(pinned.leadPreset).not.toBe(pinned.presets[0]);
    for (const value of [pinned, pinned.presets, pinned.presets[0], pinned.presets[0].model, pinned.presets[0].reasoning,
      pinned.tiers, pinned.tiers[4], pinned.tiers[4].presetIds, pinned.limits, pinned.leadPreset, pinned.restrictions, pinned.restrictions.allowedConnectionIds]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => { (pinned.leadPreset.model as ExecutionPreset['model']).model = 'replacement'; }).toThrow();
  });
});

describe('dispatch membership, live revocation and atomic preset adherence', () => {
  it('dispatches only the exact pinned tier/preset and enforces minimum tier and fixed lead identity', () => {
    const base = config();
    const pinned = resolveMissionConfig(base, undefined, undefined, available);
    expect(resolveMissionDispatchPreset(pinned, { tierId: 3, presetId: 'standard' }, base, { capabilities: available })).toEqual(base.presets[2]);
    expect(resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'alternative', role: 'worker' }, base, { capabilities: available })).toEqual(base.presets[1]);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 1, presetId: 'standard' }, base, { capabilities: available })).toThrow(/Empty pools/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 3, presetId: 'standard', minimumTierId: 4 }, base, { capabilities: available })).toThrow(/minimum tier/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'alternative', role: 'lead' }, base, { capabilities: available })).toThrow(/handover/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'lead' }, base)).toThrow(/Configured/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'lead', model: preset('lead', 'api-b').model } as never, base, { capabilities: available })).toThrow(/Unknown fields/);
  });

  it('cannot bypass fixed lead identity or lead capabilities through the eligibility-options role', () => {
    const base = config();
    const pinned = resolveMissionConfig(base, undefined, undefined, available);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'alternative' }, base,
      { role: 'lead', capabilities: available })).toThrow(/handover/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'alternative', role: 'worker' }, base,
      { role: 'lead', capabilities: available })).toThrow(/role/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 3, presetId: 'standard' }, base,
      { role: 'admin' as never, capabilities: available })).toThrow(/role/);
  });

  it('keeps ordinary edits and tier changes out of old attempts; rechecks the original combination', () => {
    const base = config();
    const pinned = resolveMissionConfig(base, undefined, undefined, available);
    base.presets[2] = { ...preset('standard', 'api-b'), revision: 2, name: 'replacement', harnessId: 'claude', reasoning: { kind: 'default' } };
    base.tiers[2].presetIds = [];
    const resolver = vi.fn(available);
    const selected = resolveMissionDispatchPreset(pinned, { tierId: 3, presetId: 'standard' }, base, { capabilities: resolver });
    expect(selected).toEqual(config().presets[2]);
    expect(resolver.mock.calls.at(-1)?.[0]).toEqual(config().presets[2]);
    expect(Object.isFrozen(selected.model)).toBe(true);
    expect(selected).not.toBe(pinned.presets[2]);
  });

  it('blocks new dispatch after disabling/deleting a preset or revoking its original account', () => {
    const base = config();
    const pinned = resolveMissionConfig(base, undefined, undefined, available);
    base.presets[2].enabled = false;
    expect(checkMissionPresetRevocation(pinned.presets[2], base).revoked).toBe(true);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 3, presetId: 'standard' }, base, { capabilities: available })).toThrow(/disabled or removed/);
    base.presets.pop();
    base.tiers[2].presetIds = [];
    expect(checkMissionPresetRevocation(pinned.presets[2], base).revoked).toBe(true);
    expect(pinned.presets[2].enabled).toBe(true);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'lead', role: 'lead' }, config(), { capabilities: evidence({ connectionAvailable: false }) })).toThrow(/unavailable or revoked/);
  });

  it('enforces both historical and live provider restrictions; a later widening never widens this snapshot', () => {
    const base = config();
    const pinned = resolveMissionConfig(base, project({ allowedConnectionIds: ['subscription-a'] }), undefined, available);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'lead' }, base,
      { capabilities: available, restrictions: { allowedProviderIds: [] } })).toThrow(/provider is not permitted/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 5, presetId: 'alternative' }, base,
      { capabilities: available, restrictions: { allowedConnectionIds: ['subscription-a', 'api-b'] } })).toThrow(/connection is not permitted/);
    expect(checkMissionPresetRevocation(pinned.leadPreset, base, { allowedConnectionIds: ['api-b'] }).revoked).toBe(true);
  });

  it('rechecks reasoning and requested tools before each dispatch', () => {
    const base = config();
    const pinned = resolveMissionConfig(base, undefined, undefined, available);
    const noLow = evidence({ modelInfo: { id: 'shared/model', provider: 'provider-a', displayName: 'updated', supportsReasoning: true, supportedEfforts: ['high'] } });
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 3, presetId: 'standard' }, base, { capabilities: noLow })).toThrow(/explicit effort/);
    expect(() => resolveMissionDispatchPreset(pinned, { tierId: 3, presetId: 'standard' }, base, { capabilities: available, requiredTools: ['deploy'] })).toThrow(/required task tool/);
    expect(pinned.presets[2].reasoning).toEqual({ kind: 'explicit', value: 'low' });
  });

  it.each([
    { harnessId: 'claude' as const }, { runtimeVariantId: 'other-runtime' },
    { model: { ...preset().model, provider: 'provider-b' } }, { model: { ...preset().model, model: 'other-model' } },
    { model: { ...preset().model, connectionId: 'api-b' } }, { reasoning: { kind: 'explicit' as const, value: 'low' as const } },
    { reasoning: { kind: 'default' as const } }
  ])('reports incompatible effective substitutions, including billing identity %j', (patch) => {
    const result = checkMissionPresetAdherence(preset(), { ...effective(), ...patch });
    expect(result.status).toBe('mismatch');
    expect(result.mismatches).toHaveLength(1);
  });

  it('never treats absent effective values as successful adherence', () => {
    expect(checkMissionPresetAdherence(preset(), effective())).toEqual({ status: 'matched', mismatches: [], unknown: [] });
    const absent = checkMissionPresetAdherence(preset(), {});
    expect(absent.status).toBe('unknown');
    expect(absent.unknown).toEqual(['harnessId', 'model.provider', 'model.model', 'model.connectionId', 'reasoning']);
    expect(checkMissionPresetAdherence(preset(), { ...effective(), model: { provider: 'provider-a', model: 'shared/model' } }).status).toBe('unknown');
    const ordinaryRef = preset();
    delete ordinaryRef.model.connectionId;
    expect(checkMissionPresetAdherence(ordinaryRef, effective(ordinaryRef)).status).toBe('matched');
    const variant = { ...preset(), runtimeVariantId: 'acp-variant' };
    expect(checkMissionPresetAdherence(variant, effective(variant)).unknown).toContain('runtimeVariantId');
  });

  it('accepts a runtime-reported effort for Default without redefining Default as reasoning off', () => {
    const defaultPreset: ExecutionPreset = { ...preset(), reasoning: { kind: 'default' } };
    expect(checkMissionPresetAdherence(defaultPreset, effective()).status).toBe('matched');
    expect(defaultPreset.reasoning).toEqual({ kind: 'default' });
    expect(checkMissionPresetAdherence(defaultPreset, { ...effective(), reasoning: undefined }).status).toBe('unknown');
    expect(checkMissionPresetAdherence(defaultPreset, { ...effective(), reasoning: { kind: 'unknown' } as never }).status).toBe('unknown');
  });
});
