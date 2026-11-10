/** The option lists the desktop header and the web control sheets both render (docs/REMOTE-ACCESS.md
 *  §4), so a new permission mode or effort level appears in one place rather than two. */
import { HARNESS_BY_ID, PERMISSION_MODE_LABELS, effortOptionsFor } from '../../shared/harness-meta';
import type { EffortLevel, ModelInfo, ModelRef, PermissionMode, SessionMeta } from '../../shared/types';

export interface SessionControlOption<T> {
  value: T;
  label: string;
  /** One line under the label; the permission descriptions already read that way. */
  hint?: string;
}

/** Effort levels this session's harness and current model accept, in display order. */
export function effortOptions(session: SessionMeta, model?: ModelInfo): SessionControlOption<EffortLevel>[] {
  return effortOptionsFor(HARNESS_BY_ID[session.config.harness], model).map((value) => ({ value, label: value }));
}

/** The model menu's short list, in catalog order: the starred models this catalog lists (or its first
 *  `fallback` models when none are), plus the current model. A current model the catalog no longer
 *  lists leads as a bare row so the selection stays visible. */
export function quickModels(models: ModelInfo[], favorites: ModelRef[], current: ModelRef | undefined, fallback = 4): ModelInfo[] {
  const is = (m: ModelInfo, ref: ModelRef) => m.provider === ref.provider && m.id === ref.model;
  const starred = models.filter((m) => favorites.some((f) => is(m, f)));
  const base = new Set(starred.length ? starred : models.slice(0, fallback));
  const list = models.filter((m) => base.has(m) || (!!current && is(m, current)));
  if (current && !models.some((m) => is(m, current))) list.unshift({ id: current.model, provider: current.provider, displayName: current.model });
  return list;
}

/** Permission modes this session's harness accepts. */
export function permissionOptions(session: SessionMeta): SessionControlOption<PermissionMode>[] {
  return HARNESS_BY_ID[session.config.harness].capabilities.permissionModes.map((mode) => ({
    value: mode,
    label: PERMISSION_MODE_LABELS[mode].label,
    hint: PERMISSION_MODE_LABELS[mode].description
  }));
}
