/**
 * Retired Mission feature: on startup, remove the coordination data it left in userData. Its
 * worktrees and delivery checkouts can hold unmerged work, so those are reported, never removed.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { errorMessage } from './util/async';

/** Coordination state only: the journal/snapshot store and process-ownership receipts. */
const REMOVED = ['missions', 'mission-process-ownership'];
/** Git worktrees and delivery checkouts: possibly the user's work. */
const KEPT = ['mission-workspaces', 'mission-delivery'];

export interface LegacyMissionCleanup {
  removed: string[];
  kept: string[];
}

export async function retireLegacyMissionData(
  userData: string,
  log: (level: 'info' | 'warn', message: string) => void = () => undefined
): Promise<LegacyMissionCleanup> {
  const result: LegacyMissionCleanup = { removed: [], kept: [] };
  for (const name of REMOVED) {
    const dir = path.join(userData, name);
    if (!(await exists(dir))) continue;
    try {
      await fs.rm(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch (e) {
      log('warn', `retired Mission data could not be removed (${dir}): ${errorMessage(e)}`);
    }
  }
  for (const name of KEPT) {
    const dir = path.join(userData, name);
    const entries = await fs.readdir(dir).catch(() => []);
    if (entries.length) result.kept.push(dir);
  }
  if (result.removed.length) log('info', `removed retired Mission data: ${result.removed.join(', ')}`);
  if (result.kept.length) {
    log('warn', `the retired Mission feature left worktrees or delivery checkouts that may hold unmerged work; they were kept: ${result.kept.join(', ')}. Review them, then delete the folders and any mission/* branches by hand.`);
  }
  return result;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
