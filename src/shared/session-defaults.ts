/** What the New Session dialog opens on for one project folder: the folder's own remembered
 *  choices where it has them, the app-wide defaults (Settings) everywhere else. */
import type { AppSettings, EffortLevel, FolderSessionDefaults, HarnessId, ModelRef, PermissionMode } from './types';

/** The dialog's initial state for a folder; `effort: ''` is the select's "Default" option. */
export interface NewSessionDefaults {
  harness: HarnessId;
  model?: ModelRef;
  effort: EffortLevel | '';
  permissionMode: PermissionMode;
  useWorktree: boolean;
  acpAgent?: string;
}

/** The folder's record, or undefined when this project has no remembered choices yet. */
export function folderSessionDefaults(settings: AppSettings, root: string | null | undefined): FolderSessionDefaults | undefined {
  return (root ? settings.folderSessionDefaults?.[root] : undefined) ?? undefined;
}

/**
 * The model remembered for one harness in one folder: the folder's own entry first, then the
 * app-wide entry, the way the dialog's model column and its per-harness fallback line up.
 */
export function rememberedModel(settings: AppSettings, root: string | null | undefined, harness: HarnessId): ModelRef | undefined {
  const folder = folderSessionDefaults(settings, root);
  // Per harness, not per map: a folder that has recorded one harness's model still follows the
  // app-wide model for the harnesses it has never used.
  return folder?.modelByHarness?.[harness] ?? settings.defaultModelByHarness[harness];
}

/**
 * Resolve every field the dialog asks for. Fields fall back to the app-wide default one by one, so
 * a folder that only ever changed its permission mode keeps the global harness and model.
 *
 * Worktree isolation is the exception: it has no app-wide default left (see FolderSessionDefaults),
 * so a folder with no record — or one that never asked for a worktree — starts without isolation.
 */
export function resolveNewSessionDefaults(settings: AppSettings, root: string | null | undefined): NewSessionDefaults {
  const folder = folderSessionDefaults(settings, root);
  const harness = folder?.harness ?? settings.defaultHarness;
  return {
    harness,
    model: rememberedModel(settings, root, harness),
    effort: (folder?.effort ?? settings.defaultEffort) ?? '',
    permissionMode: folder?.permissionMode ?? settings.defaultPermissionMode,
    useWorktree: folder?.useWorktree ?? false,
    acpAgent: folder?.acpAgent ?? settings.acpAgents[0]?.id
  };
}

/**
 * The folder's record with the given choices merged in, ready to be written to
 * `AppSettings.folderSessionDefaults[root]`. Records are read-modified-written as a whole because
 * they are stored as one map in settings.json, like folderStyles and mcpProjectState.
 */
export function withFolderSessionDefaults(
  settings: AppSettings | null | undefined,
  root: string,
  patch: FolderSessionDefaults
): Record<string, FolderSessionDefaults> {
  const map = settings?.folderSessionDefaults ?? {};
  return { ...map, [root]: { ...map[root], ...patch } };
}
