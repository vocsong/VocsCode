/** Mission configuration is data, not an execution grant. Main must recheck live eligibility at dispatch. */
import { HARNESS_BY_ID, HARNESSES, isEffortLevel } from './harness-meta';
import type { EffortLevel, HarnessAvailability, HarnessCapabilities, HarnessId, ModelInfo, ModelRef } from './types';

export type TierId = 1 | 2 | 3 | 4 | 5;
export type ReasoningSelection = { kind: 'default' } | { kind: 'explicit'; value: EffortLevel };

/** `provider` already identifies an app provider configuration; an additional account must stay distinct. */
export type MissionModelRef = ModelRef & { connectionId?: string };

export interface ExecutionPreset {
  id: string;
  revision: number;
  name: string;
  harnessId: HarnessId;
  runtimeVariantId?: string;
  model: MissionModelRef;
  /** Default leaves reasoning to the selected runtime, never to an app-wide effort fallback. */
  reasoning: ReasoningSelection;
  enabled: boolean;
  guidance?: string;
}

export interface MissionTier {
  id: TierId;
  label: string;
  guidance?: string;
  presetIds: string[];
}

export interface MissionLimits {
  maxConcurrentWorkersPerMission: number;
  maxConcurrentAgentTurnsGlobal: number;
  maxConcurrentHeavyChecksGlobal: number;
  maxDelegationDepth: number;
  maxTaskAttemptsBeforeLeadDiagnosis: number;
  progressCheckpointEveryTurns: number;
  maxNoProgressCheckpoints: number;
  /** Optional observed whole-Mission thresholds, not guaranteed provider-side ceilings. */
  maxBudgetUsd?: number;
  maxTokens?: number;
  /** App-wide turn capacity by exact connectionId (or provider when absent). No account fallback. */
  accountLimits?: Record<string, number>;
}

export type MissionNumericLimits = Omit<MissionLimits, 'accountLimits'>;
export const MISSION_ACCOUNT_LIMIT_MAX_ENTRIES = 64;
export const MISSION_ACCOUNT_LIMIT_MAX_TURNS = 128;

export interface MissionConfig {
  schemaVersion: 1;
  revision: number;
  presets: ExecutionPreset[];
  tiers: MissionTier[];
  /** Absent is an intentionally unconfigured launch, including on a fresh install. */
  defaultLeadPresetId?: string;
  limits: MissionLimits;
}

export interface MissionProviderRestrictions {
  /** Absent means no additional restriction; an empty list denies every provider/connection. */
  allowedProviderIds?: readonly string[];
  /** Matches connectionId, or provider when no separate connection is configured. */
  allowedConnectionIds?: readonly string[];
}

/** Project settings reference the global library, never redefine a preset or widen its permissions. */
export interface MissionProjectOverride extends MissionProviderRestrictions {
  schemaVersion: 1;
  revision: number;
  /** Replace only the listed pools. Unlisted tiers inherit, and [] deliberately empties a pool. */
  tiers?: Array<Pick<MissionTier, 'id' | 'presetIds'>>;
  /** Undefined inherits; null explicitly unconfigures the principal engineer. */
  defaultLeadPresetId?: string | null;
  /** Projects may tighten limits, never increase the global ceilings. */
  limits?: Partial<MissionNumericLimits>;
}

export type MissionReadonly<T> = T extends readonly (infer U)[]
  ? readonly MissionReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: MissionReadonly<T[K]> } : T;

/** Pins values, not pointers back into Settings. Availability is deliberately not cached as authority. */
export interface ResolvedMissionConfig extends MissionReadonly<MissionConfig> {
  /** The effective launch selection, after an optional explicit T5 override. */
  readonly defaultLeadPresetId: string;
  readonly leadPreset: MissionReadonly<ExecutionPreset>;
  readonly projectRevision?: number;
  readonly restrictions: MissionReadonly<MissionProviderRestrictions>;
}

export type MissionPresetStatus = 'configured' | 'available' | 'unverified' | 'unsupported' | 'unavailable';
export const MISSION_PRESET_STATUS_LABELS: Record<MissionPresetStatus, string> = {
  configured: 'Configured', available: 'Available', unverified: 'Unverified', unsupported: 'Unsupported', unavailable: 'Unavailable'
};

/**
 * Evidence collected by the host for this exact harness/runtime/model/connection/reasoning choice.
 * Catalog metadata can disprove a selection, but cannot certify a live Mission driver. Missing
 * facts stay unknown. `projectAllowed` includes permission/data rules, not just provider membership.
 */
export interface MissionPresetCapabilities {
  source: 'catalog' | 'runtime';
  runtime?: Pick<HarnessAvailability, 'available' | 'authenticated'>;
  connectionAvailable?: boolean;
  modelAvailable?: boolean;
  modelInfo?: ModelInfo;
  harnessCapabilities?: Partial<Pick<HarnessCapabilities, 'effort' | 'interrupt'>>;
  controlProtocol?: boolean;
  worktreeCwd?: boolean;
  completionObservation?: boolean;
  cancellationObservation?: boolean;
  projectAllowed?: boolean;
  /** A successful Mission-tool handshake, not merely generic MCP support. Required for a lead. */
  missionTools?: boolean;
  /** Verified suppression/ownership of competing goal and delegation loops. Required for all actors. */
  delegationControl?: boolean;
  /** Complete set of usable tools when known. An omitted list does not prove requested tools exist. */
  tools?: readonly string[];
}

/** Read already-collected evidence. This pure resolver must not probe, mutate settings, or supply credentials. */
export type MissionCapabilityResolver = (preset: MissionReadonly<ExecutionPreset>) => MissionPresetCapabilities | undefined;

export interface MissionEligibilityOptions {
  role?: 'lead' | 'worker';
  capabilities?: MissionCapabilityResolver;
  restrictions?: MissionProviderRestrictions;
  requiredTools?: readonly string[];
}

export interface MissionPresetEligibility {
  status: MissionPresetStatus;
  /** Only Available is dispatchable. Configured/Unverified are not approvals. */
  eligible: boolean;
  reasons: string[];
}

export const MISSION_TIER_IDS: readonly TierId[] = Object.freeze([1, 2, 3, 4, 5]);

/** MVP safety bounds, not claims about optimal concurrency. Depth one is a product invariant. */
export const MISSION_LIMIT_MAXIMUMS: Readonly<Required<MissionNumericLimits>> = Object.freeze({
  maxConcurrentWorkersPerMission: 32,
  maxConcurrentAgentTurnsGlobal: 128,
  maxConcurrentHeavyChecksGlobal: 16,
  maxDelegationDepth: 1,
  maxTaskAttemptsBeforeLeadDiagnosis: 100,
  progressCheckpointEveryTurns: 1_000,
  maxNoProgressCheckpoints: 100,
  maxBudgetUsd: 1_000_000,
  maxTokens: 1_000_000_000_000
});

/** No invented models, no automatically populated pools, and no default spend cap. */
export const DEFAULT_MISSION_CONFIG: MissionReadonly<MissionConfig> = freeze({
  schemaVersion: 1,
  revision: 1,
  presets: [],
  tiers: [
    { id: 1, label: 'Routine', presetIds: [] },
    { id: 2, label: 'Focused', presetIds: [] },
    { id: 3, label: 'Standard', presetIds: [] },
    { id: 4, label: 'Advanced', presetIds: [] },
    { id: 5, label: 'Frontier', presetIds: [] }
  ],
  limits: {
    maxConcurrentWorkersPerMission: 4,
    maxConcurrentAgentTurnsGlobal: 10,
    maxConcurrentHeavyChecksGlobal: 1,
    maxDelegationDepth: 1,
    maxTaskAttemptsBeforeLeadDiagnosis: 3,
    progressCheckpointEveryTurns: 20,
    maxNoProgressCheckpoints: 3
  }
} satisfies MissionConfig);

/** Error messages identify a field but never interpolate rejected values (which may contain a secret). */
export class MissionConfigError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'MissionConfigError';
  }
}

function fail(path: string, message: string): never {
  throw new MissionConfigError(path, message);
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail(path, 'Expected a plain object.');
  }
  // Reject instead of stripping: presets must never become an accidental secret/config store.
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail(path, 'Unknown fields are not allowed; credentials, endpoints, prompts and permissions belong in their existing stores.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string, max = 200, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(path, `Expected ${allowEmpty ? '' : 'nonempty '}text of at most ${max} characters.`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail(path, 'Expected a stable identifier, not a URL, credential or display name.');
  return result;
}

function revision(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(path, 'Expected a positive safe integer revision.');
  return value;
}

function schemaVersion(value: unknown, path: string): 1 {
  if (value !== 1) fail(path, 'Unsupported schema version; this configuration cannot be executed.');
  return 1;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1_000) fail(path, 'Expected an array with at most 1000 entries.');
  return Array.from(value);
}

function ids(value: unknown, path: string): string[] {
  const result = array(value, path).map((entry, i) => id(entry, `${path}[${i}]`));
  if (new Set(result).size !== result.length) fail(path, 'Duplicate references are not allowed.');
  return result;
}

function tierId(value: unknown, path: string): TierId {
  if (!MISSION_TIER_IDS.includes(value as TierId)) fail(path, 'Expected a tier from 1 through 5.');
  return value as TierId;
}

function modelRef(value: unknown, path: string): MissionModelRef {
  const raw = object(value, path, ['provider', 'model', 'connectionId']);
  const model = text(raw.model, `${path}.model`, 512);
  if (/\s/.test(model) || model.includes('://')) fail(`${path}.model`, 'Expected a model identifier, not a URL or whitespace.');
  return {
    provider: id(raw.provider, `${path}.provider`), model,
    ...(raw.connectionId === undefined ? {} : { connectionId: id(raw.connectionId, `${path}.connectionId`) })
  };
}

function reasoning(value: unknown, path: string): ReasoningSelection {
  const raw = object(value, path, ['kind', 'value']);
  if (raw.kind === 'default' && !Object.hasOwn(raw, 'value')) return { kind: 'default' };
  if (raw.kind === 'explicit' && isEffortLevel(raw.value)) return { kind: 'explicit', value: raw.value };
  return fail(path, 'Use Default or an explicit supported EffortLevel; Default is not disabled reasoning.');
}

function preset(value: unknown, path: string): ExecutionPreset {
  const raw = object(value, path, ['id', 'revision', 'name', 'harnessId', 'runtimeVariantId', 'model', 'reasoning', 'enabled', 'guidance']);
  if (!HARNESSES.some((h) => h.id === raw.harnessId)) fail(`${path}.harnessId`, 'Unknown harness. Select an existing harness.');
  if (typeof raw.enabled !== 'boolean') fail(`${path}.enabled`, 'Expected a boolean.');
  return {
    id: id(raw.id, `${path}.id`), revision: revision(raw.revision, `${path}.revision`), name: text(raw.name, `${path}.name`),
    harnessId: raw.harnessId as HarnessId,
    ...(raw.runtimeVariantId === undefined ? {} : { runtimeVariantId: id(raw.runtimeVariantId, `${path}.runtimeVariantId`) }),
    model: modelRef(raw.model, `${path}.model`), reasoning: reasoning(raw.reasoning, `${path}.reasoning`), enabled: raw.enabled,
    ...(raw.guidance === undefined ? {} : { guidance: text(raw.guidance, `${path}.guidance`, 8_000, true) })
  };
}

function limits(value: unknown, path: string, partial: true): Partial<MissionNumericLimits>;
function limits(value: unknown, path: string, partial?: false): MissionLimits;
function limits(value: unknown, path: string, partial = false): Partial<MissionLimits> {
  const raw = object(value, path, [...Object.keys(MISSION_LIMIT_MAXIMUMS), ...(partial ? [] : ['accountLimits'])]);
  const result: Partial<MissionLimits> = {};
  if (raw.accountLimits !== undefined) {
    const map = raw.accountLimits;
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.getPrototypeOf(map) !== Object.prototype && Object.getPrototypeOf(map) !== null) fail(`${path}.accountLimits`, 'Expected an explicit connection-to-capacity map.');
    const keys = Reflect.ownKeys(map);
    if (keys.length > MISSION_ACCOUNT_LIMIT_MAX_ENTRIES) fail(`${path}.accountLimits`, `At most ${MISSION_ACCOUNT_LIMIT_MAX_ENTRIES} account limits are allowed.`);
    result.accountLimits = Object.fromEntries(keys.map((connection, index) => {
      const name = id(connection, `${path}.accountLimits[${index}]`);
      const capacity = (map as Record<string, unknown>)[name];
      if (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > MISSION_ACCOUNT_LIMIT_MAX_TURNS) fail(`${path}.accountLimits[${index}]`, `Expected an integer between 1 and ${MISSION_ACCOUNT_LIMIT_MAX_TURNS}.`);
      return [name, capacity];
    }));
  }
  for (const key of Object.keys(MISSION_LIMIT_MAXIMUMS) as Array<keyof MissionNumericLimits>) {
    const v = raw[key];
    if (v === undefined && (partial || key === 'maxBudgetUsd' || key === 'maxTokens')) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MISSION_LIMIT_MAXIMUMS[key]
      || (key !== 'maxBudgetUsd' && !Number.isSafeInteger(v))) {
      fail(`${path}.${key}`, `Expected a positive ${key === 'maxBudgetUsd' ? 'number' : 'integer'} no greater than ${MISSION_LIMIT_MAXIMUMS[key]}.`);
    }
    result[key] = v;
  }
  return result;
}

function assertReferences(config: MissionConfig): void {
  const library = new Map(config.presets.map((p) => [p.id, p]));
  if (library.size !== config.presets.length) fail('presets', 'Preset ids must be unique.');
  for (const tier of config.tiers) {
    if (tier.presetIds.some((p) => !library.has(p))) fail(`tiers.${tier.id}.presetIds`, 'Every reference must name a preset in the library.');
  }
  if (config.defaultLeadPresetId !== undefined) {
    const lead = library.get(config.defaultLeadPresetId);
    if (!lead?.enabled || !config.tiers.find((t) => t.id === 5)!.presetIds.includes(lead.id)) {
      fail('defaultLeadPresetId', 'Select an enabled T5 preset, or clear the default to leave Mission unconfigured.');
    }
  }
}

/**
 * Validate a save/import boundary and return a detached, editable copy. Empty tiers and an unset
 * default are valid saved state. Known incompatibilities fail; missing/offline runtime evidence
 * does not prevent saving, and must still be displayed via validatePresetEligibility.
 */
export function validateMissionConfig(value: unknown, capabilities?: MissionCapabilityResolver): MissionConfig {
  const raw = object(value, 'mission', ['schemaVersion', 'revision', 'presets', 'tiers', 'defaultLeadPresetId', 'limits']);
  const tiers = array(raw.tiers, 'tiers').map((entry, i): MissionTier => {
    const row = object(entry, `tiers[${i}]`, ['id', 'label', 'guidance', 'presetIds']);
    return {
      id: tierId(row.id, `tiers[${i}].id`), label: text(row.label, `tiers[${i}].label`), presetIds: ids(row.presetIds, `tiers[${i}].presetIds`),
      ...(row.guidance === undefined ? {} : { guidance: text(row.guidance, `tiers[${i}].guidance`, 8_000, true) })
    };
  });
  if (tiers.length !== 5 || new Set(tiers.map((t) => t.id)).size !== 5) fail('tiers', 'Exactly one each of tiers 1, 2, 3, 4 and 5 is required.');
  const result: MissionConfig = {
    schemaVersion: schemaVersion(raw.schemaVersion, 'schemaVersion'), revision: revision(raw.revision, 'revision'),
    presets: array(raw.presets, 'presets').map((p, i) => preset(p, `presets[${i}]`)), tiers,
    ...(raw.defaultLeadPresetId === undefined ? {} : { defaultLeadPresetId: id(raw.defaultLeadPresetId, 'defaultLeadPresetId') }),
    limits: limits(raw.limits, 'limits')
  };
  assertReferences(result);
  for (const p of result.presets) {
    // Disabled presets still cannot store known-invalid effort values. Availability is separate.
    const check = validatePresetEligibility({ ...p, enabled: true }, { capabilities, role: p.id === result.defaultLeadPresetId ? 'lead' : 'worker' });
    if (check.status === 'unsupported') fail(`presets.${p.id}`, check.reasons.join(' '));
  }
  return result;
}

/** A fresh mutable default for settings forms; never edit the frozen shared constant. */
export function createDefaultMissionConfig(): MissionConfig {
  return validateMissionConfig(DEFAULT_MISSION_CONFIG);
}

/** Validate project data without importing presets, secrets or permission overrides from a repository. */
export function validateMissionProjectOverride(value: unknown): MissionProjectOverride {
  const raw = object(value, 'project', ['schemaVersion', 'revision', 'tiers', 'defaultLeadPresetId', 'limits', 'allowedProviderIds', 'allowedConnectionIds']);
  const result: MissionProjectOverride = { schemaVersion: schemaVersion(raw.schemaVersion, 'project.schemaVersion'), revision: revision(raw.revision, 'project.revision') };
  if (raw.tiers !== undefined) {
    result.tiers = array(raw.tiers, 'project.tiers').map((entry, i) => {
      const row = object(entry, `project.tiers[${i}]`, ['id', 'presetIds']);
      return { id: tierId(row.id, `project.tiers[${i}].id`), presetIds: ids(row.presetIds, `project.tiers[${i}].presetIds`) };
    });
    if (new Set(result.tiers.map((t) => t.id)).size !== result.tiers.length) fail('project.tiers', 'Each tier may be overridden only once.');
  }
  if (raw.defaultLeadPresetId !== undefined) result.defaultLeadPresetId = raw.defaultLeadPresetId === null ? null : id(raw.defaultLeadPresetId, 'project.defaultLeadPresetId');
  if (raw.limits !== undefined) result.limits = limits(raw.limits, 'project.limits', true);
  if (raw.allowedProviderIds !== undefined) result.allowedProviderIds = ids(raw.allowedProviderIds, 'project.allowedProviderIds');
  if (raw.allowedConnectionIds !== undefined) result.allowedConnectionIds = ids(raw.allowedConnectionIds, 'project.allowedConnectionIds');
  return result;
}

/** Resolve editable project defaults without requiring a launch-capable T5. No silent default repair. */
export function applyMissionProjectOverride(global: MissionReadonly<MissionConfig>, project?: MissionProjectOverride): MissionConfig {
  const result = validateMissionConfig(global);
  if (project === undefined) return result;
  const override = validateMissionProjectOverride(project);
  for (const tier of override.tiers ?? []) result.tiers.find((t) => t.id === tier.id)!.presetIds = [...tier.presetIds];
  if (override.defaultLeadPresetId === null) delete result.defaultLeadPresetId;
  else if (override.defaultLeadPresetId !== undefined) result.defaultLeadPresetId = override.defaultLeadPresetId;
  for (const key of Object.keys(override.limits ?? {}) as Array<keyof MissionNumericLimits>) {
    const v = override.limits![key]!;
    if (result.limits[key] !== undefined && v > result.limits[key]!) fail(`project.limits.${key}`, 'A project may tighten a global ceiling, not increase it.');
    result.limits[key] = v;
  }
  assertReferences(result);
  return result;
}

function restrictionReasons(p: MissionReadonly<ExecutionPreset>, restrictions?: MissionProviderRestrictions): string[] {
  const reasons: string[] = [];
  if (restrictions?.allowedProviderIds && !restrictions.allowedProviderIds.includes(p.model.provider)) reasons.push('The provider is not permitted for this project.');
  if (restrictions?.allowedConnectionIds && !restrictions.allowedConnectionIds.includes(p.model.connectionId ?? p.model.provider)) reasons.push('The provider connection is not permitted for this project.');
  return reasons;
}

/**
 * UI/read-only eligibility check. Available requires affirmative runtime evidence for every
 * required boundary. A generic harness capability or a catalog row alone never certifies a lead.
 */
export function validatePresetEligibility(value: MissionReadonly<ExecutionPreset>, options: MissionEligibilityOptions = {}): MissionPresetEligibility {
  const finish = (status: MissionPresetStatus, reasons: string[]): MissionPresetEligibility => ({ status, eligible: status === 'available', reasons });
  let p: ExecutionPreset;
  try { p = preset(value, 'preset'); }
  catch (error) { return finish('unsupported', [error instanceof MissionConfigError ? error.message : 'Invalid preset.']); }
  const denied = restrictionReasons(p, options.restrictions);
  if (!p.enabled) denied.push('This preset is disabled.');
  const cap = options.capabilities?.(freeze(p));
  const unsupported: string[] = [];
  const unknown: string[] = [];
  if (p.reasoning.kind === 'explicit') {
    const effort = p.reasoning.value;
    if (!HARNESS_BY_ID[p.harnessId].capabilities.effort || cap?.harnessCapabilities?.effort === false || cap?.modelInfo?.supportsReasoning === false
      || (cap?.modelInfo?.supportedEfforts !== undefined && !cap.modelInfo.supportedEfforts.includes(effort))) {
      unsupported.push('The selected harness/model does not support the explicit effort; choose Default or an advertised effort.');
    } else if (cap?.harnessCapabilities?.effort !== true || !cap?.modelInfo?.supportedEfforts?.includes(effort)) {
      unknown.push('The explicit reasoning effort has not been verified for this harness/model.');
    }
  }
  if (cap?.modelInfo && (cap.modelInfo.id !== p.model.model || cap.modelInfo.provider !== p.model.provider)) {
    unsupported.push('Capability evidence refers to a different model/provider.');
  }
  if (cap?.runtime?.available === false) denied.push('The selected harness runtime is unavailable.');
  if (cap?.runtime?.authenticated === false || cap?.connectionAvailable === false) denied.push('The selected connection/account is unavailable or revoked.');
  if (cap?.modelAvailable === false) denied.push('The selected model is unavailable.');
  if (cap?.projectAllowed === false) denied.push('Project permission or data rules prohibit this selection.');
  const required: Array<[boolean | undefined, string]> = [
    [cap?.controlProtocol, 'Mission control protocol'], [cap?.worktreeCwd, 'worktree cwd'],
    [cap?.completionObservation, 'completion observation'], [cap?.cancellationObservation, 'cancellation observation'],
    [cap?.harnessCapabilities?.interrupt, 'interruption'], [cap?.delegationControl, 'competing delegation/goal control']
  ];
  if (options.role === 'lead') required.push([cap?.missionTools, 'principal-engineer Mission tools']);
  for (const [supported, name] of required) {
    if (supported === false) unsupported.push(`The runtime does not support ${name}.`);
    else if (supported !== true) unknown.push(`Unverified ${name}.`);
  }
  for (const tool of options.requiredTools ?? []) {
    if (cap?.tools === undefined) unknown.push('Required tools have not been verified.');
    else if (!cap.tools.includes(tool)) unsupported.push('A required task tool is not available in this runtime.');
  }
  if (unsupported.length) return finish('unsupported', unsupported);
  if (denied.length) return finish('unavailable', denied);
  if (!options.capabilities) return finish('configured', ['Configured only; runtime eligibility has not been checked.']);
  if (cap?.source !== 'runtime') unknown.push('No live runtime evidence; a catalog entry is not proof of availability.');
  if (cap?.runtime?.available !== true) unknown.push('Runtime presence has not been verified.');
  if (cap?.connectionAvailable !== true) unknown.push('Connection/account availability has not been verified.');
  if (cap?.modelAvailable !== true) unknown.push('Model availability has not been verified.');
  if (cap?.projectAllowed !== true) unknown.push('Project permission/data rules have not been verified.');
  return unknown.length ? finish('unverified', [...new Set(unknown)]) : finish('available', []);
}

/**
 * Launch boundary: global -> project -> explicit T5 choice. Throws rather than guessing a lead,
 * downgrading tiers, changing effort or switching billing paths. New settings do not mutate this
 * deeply frozen snapshot; dispatch still requires fresh live checks.
 */
export function resolveMissionConfig(
  global: MissionReadonly<MissionConfig>, project?: MissionProjectOverride, leadPresetId?: string, capabilities?: MissionCapabilityResolver
): ResolvedMissionConfig {
  const override = project === undefined ? undefined : validateMissionProjectOverride(project);
  // Apply the explicit choice before validating the merged default (a project can replace T5).
  const config = applyMissionProjectOverride(global, override && leadPresetId !== undefined ? { ...override, defaultLeadPresetId: leadPresetId } : override);
  if (leadPresetId !== undefined) config.defaultLeadPresetId = id(leadPresetId, 'leadPresetId');
  assertReferences(config);
  if (!config.defaultLeadPresetId) fail('defaultLeadPresetId', 'Mission is unconfigured. Select an enabled, eligible T5 principal engineer.');
  const lead = config.presets.find((p) => p.id === config.defaultLeadPresetId)!;
  const restrictions: MissionProviderRestrictions = {
    ...(override?.allowedProviderIds === undefined ? {} : { allowedProviderIds: [...override.allowedProviderIds] }),
    ...(override?.allowedConnectionIds === undefined ? {} : { allowedConnectionIds: [...override.allowedConnectionIds] })
  };
  const check = validatePresetEligibility(lead, { role: 'lead', capabilities, restrictions });
  if (!check.eligible) fail('defaultLeadPresetId', `${MISSION_PRESET_STATUS_LABELS[check.status]}: ${check.reasons.join(' ')}`);
  return freeze({ ...config, defaultLeadPresetId: config.defaultLeadPresetId, leadPreset: preset(lead, 'leadPreset'), restrictions,
    ...(override === undefined ? {} : { projectRevision: override.revision }) });
}

/**
 * Historical preset values survive ordinary edits. Disabling/deleting their ID or revoking the
 * provider/connection forbids new dispatch. This check does not claim to recall data already sent.
 */
export function checkMissionPresetRevocation(
  pinned: MissionReadonly<ExecutionPreset>, current: MissionReadonly<MissionConfig>, restrictions?: MissionProviderRestrictions
): { revoked: boolean; reasons: string[] } {
  const p = preset(pinned, 'preset');
  const live = validateMissionConfig(current).presets.find((candidate) => candidate.id === p.id);
  const reasons = restrictionReasons(p, restrictions);
  if (!live?.enabled) reasons.push('The preset has been disabled or removed from the live library.');
  return { revoked: reasons.length > 0, reasons };
}

export interface MissionPresetSelection {
  tierId: TierId;
  presetId: string;
  minimumTierId?: TierId;
  role?: 'lead' | 'worker';
}

/**
 * Synchronous dispatch preflight, called inside main's admission transaction with current facts.
 * Selects the whole pinned preset; callers cannot patch its harness, account or effort. Ordinary
 * tier/library edits do not rewrite old snapshots, but both pinned and live restrictions apply.
 */
export function resolveMissionDispatchPreset(
  snapshot: ResolvedMissionConfig, selection: MissionPresetSelection, current: MissionReadonly<MissionConfig>,
  options: MissionEligibilityOptions = {}
): MissionReadonly<ExecutionPreset> {
  schemaVersion(snapshot.schemaVersion, 'snapshot.schemaVersion');
  object(selection, 'selection', ['tierId', 'presetId', 'minimumTierId', 'role']);
  const tier = tierId(selection.tierId, 'selection.tierId');
  const selectedId = id(selection.presetId, 'selection.presetId');
  const role = selection.role ?? options.role ?? 'worker';
  if (role !== 'lead' && role !== 'worker') fail('selection.role', 'Expected lead or worker.');
  if (selection.role !== undefined && options.role !== undefined && selection.role !== options.role) fail('selection.role', 'Selection and eligibility roles must agree.');
  if (selection.minimumTierId !== undefined && tier < tierId(selection.minimumTierId, 'selection.minimumTierId')) fail('selection.tierId', 'Selection is below the task minimum tier.');
  if (role === 'lead' && (tier !== 5 || selectedId !== snapshot.defaultLeadPresetId)) fail('selection.presetId', 'The principal engineer is fixed to the selected T5 preset; replacement requires an explicit handover.');
  if (!snapshot.tiers.find((t) => t.id === tier)?.presetIds.includes(selectedId)) fail('selection.presetId', 'The preset is not in the selected snapshot tier. Empty pools never fall back.');
  const p = snapshot.presets.find((entry) => entry.id === selectedId);
  if (!p) fail('selection.presetId', 'The preset is missing from the snapshot.');
  const revoked = checkMissionPresetRevocation(p, current, options.restrictions);
  const reasons = [...revoked.reasons, ...restrictionReasons(p, snapshot.restrictions)];
  if (reasons.length) fail('selection.presetId', reasons.join(' '));
  const check = validatePresetEligibility(p, { ...options, role });
  if (!check.eligible) fail('selection.presetId', `${MISSION_PRESET_STATUS_LABELS[check.status]}: ${check.reasons.join(' ')}`);
  return freeze(preset(p, 'preset'));
}

/** Fields the host can actually observe; omission is unknown, never evidence of adherence. */
export interface MissionEffectivePreset {
  harnessId?: HarnessId;
  runtimeVariantId?: string;
  model?: Partial<MissionModelRef>;
  reasoning?: ReasoningSelection;
}

/** Compare reported execution without inferring a connection or an explicit effort from a model name. */
export function checkMissionPresetAdherence(requested: MissionReadonly<ExecutionPreset>, effective: MissionEffectivePreset): {
  status: 'matched' | 'unknown' | 'mismatch'; mismatches: string[]; unknown: string[];
} {
  const p = preset(requested, 'preset');
  const mismatches: string[] = [];
  const unknown: string[] = [];
  const compare = (field: string, expected: string, actual?: string) => {
    if (actual === undefined) unknown.push(field);
    else if (actual !== expected) mismatches.push(field);
  };
  compare('harnessId', p.harnessId, effective.harnessId);
  if (p.runtimeVariantId !== undefined) compare('runtimeVariantId', p.runtimeVariantId, effective.runtimeVariantId);
  else if (effective.runtimeVariantId !== undefined) mismatches.push('runtimeVariantId');
  compare('model.provider', p.model.provider, effective.model?.provider);
  compare('model.model', p.model.model, effective.model?.model);
  // An ordinary ModelRef's provider is already its configured connection. A separately selected
  // account, however, must be reported explicitly; a vendor/model name cannot prove that account.
  const connection = effective.model?.connectionId ?? (p.model.connectionId === undefined ? effective.model?.provider : undefined);
  compare('model.connectionId', p.model.connectionId ?? p.model.provider, connection);
  if (p.reasoning.kind === 'explicit') {
    if (effective.reasoning?.kind === 'explicit') compare('reasoning', p.reasoning.value, effective.reasoning.value);
    else if (effective.reasoning?.kind === 'default') mismatches.push('reasoning');
    else unknown.push('reasoning');
  } else if (effective.reasoning?.kind !== 'default'
    && !(effective.reasoning?.kind === 'explicit' && isEffortLevel(effective.reasoning.value))) unknown.push('reasoning');
  // Default accepts the runtime's reported effort; it never means reasoning must be off.
  return { status: mismatches.length ? 'mismatch' : unknown.length ? 'unknown' : 'matched', mismatches, unknown };
}

function freeze<T>(value: T): MissionReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as MissionReadonly<T>;
}
