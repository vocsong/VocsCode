/** The option lists the desktop header and the web control sheets both render (docs/REMOTE-ACCESS.md
 *  §4), so a new permission mode or effort level appears in one place rather than two. */
import { HARNESS_BY_ID, PERMISSION_MODE_LABELS, effortOptionsFor } from '../../shared/harness-meta';
import type { EffortLevel, ModelInfo, PermissionMode, SessionMeta } from '../../shared/types';

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

/** Permission modes this session's harness accepts. */
export function permissionOptions(session: SessionMeta): SessionControlOption<PermissionMode>[] {
  return HARNESS_BY_ID[session.config.harness].capabilities.permissionModes.map((mode) => ({
    value: mode,
    label: PERMISSION_MODE_LABELS[mode].label,
    hint: PERMISSION_MODE_LABELS[mode].description
  }));
}
