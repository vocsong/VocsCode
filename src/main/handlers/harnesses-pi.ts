/**
 * Harness availability/catalog/login/install, global skills, app instructions, and base-pi config handlers.
 */
import path from 'node:path';
import { z } from 'zod';
import { HARNESSES } from '../../shared/harness-meta';
import type { HarnessAvailability, HarnessId } from '../../shared/types';
import { AppInstructions } from '../app-instructions';
import { listHarnessModels } from '../harness/registry';
import { assertHarnessId, openHarnessLogin, readHarnessSetup, withAppCredentials } from '../harness-setup';
import { enrichModelsFromProviders } from '../models/static-models';
import { PiConfigStore, runPiCommand } from '../pi-config';
import { clearRuntimeProbeCache, HARNESS_PACKAGES, type ToolName } from '../runtime';
import { providerSecrets } from '../secret-ids';
import { copySkill, createSkill, deleteSkill, listSkills, locateSkillPath, readSkillDoc } from '../skills';
import type { HandlerContext } from './types';

/** The CLI whose catalog `harness:models` reads, so a switched runtime misses the model cache. */
const HARNESS_BINARY: Partial<Record<HarnessId, ToolName>> = { claude: 'claude', codex: 'codex', 'codex-exec': 'codex', pi: 'pi', antigravity: 'agy' };

export function registerHarnessesPiHandlers(ctx: HandlerContext): void {
  const { deps, handle, launchEditor, modelCatalog } = ctx;
  const { settings, secrets, runtime } = deps;

  const piConfig =
    deps.piConfig ??
    new PiConfigStore({
      log: deps.log,
      piBinary: () => runtime.resolve('pi')?.path ?? null,
      runPi: (args) => {
        const piPath = runtime.resolve('pi')?.path;
        if (!piPath) return Promise.resolve({ ok: false, code: null, log: '', error: 'pi is not installed — install it from Settings → Harnesses first.' });
        // cwd is the app's userData, never a project: pi install writes global settings, and a
        // repo's .pi/ must not influence the command.
        return runPiCommand(args, { piPath, cwd: deps.desktop.userDataPath(), log: deps.log });
      }
    });
  // Built on first use, like piConfig's runner: hosts and tests wire up only what they exercise,
  // and a registry that never touches the channels must not need a userData path.
  let defaultAppInstructions: AppInstructions | undefined;
  const appInstructions = (): AppInstructions => (defaultAppInstructions ??= deps.appInstructions ?? new AppInstructions(deps.desktop.userDataPath(), deps.log));

  const availabilityCache = new Map<HarnessId, { at: number; value: HarnessAvailability }>();
  let availabilityGeneration = 0;
  const invalidateAvailability = () => { availabilityGeneration++; availabilityCache.clear(); clearRuntimeProbeCache(); };

  handle('harness:setup', async ({ harness }) => {
    assertHarnessId(harness);
    invalidateAvailability();
    return readHarnessSetup(runtime, settings.get(), harness);
  });
  handle('harness:login', async (input) => {
    const { harness, device } = z.strictObject({ harness: z.enum(['claude', 'codex', 'pi', 'antigravity']), device: z.boolean().optional() }).parse(input);
    const result = await openHarnessLogin(runtime, harness, device);
    invalidateAvailability();
    await modelCatalog().clear(harness);
    return result;
  });
  handle('harness:antigravityQuota', () => runtime.antigravityQuota());
  handle('harness:availability', async (req) => {
    if (req?.id !== undefined) assertHarnessId(req.id);
    if (req?.refresh) invalidateAvailability();
    const generation = availabilityGeneration;
    const ids: HarnessId[] = req?.id ? [req.id] : HARNESSES.map((h) => h.id);
    const out: Partial<Record<HarnessId, HarnessAvailability>> = {};
    await Promise.all(
      ids.map(async (id) => {
        const cached = availabilityCache.get(id);
        if (cached && Date.now() - cached.at < 60_000 && !(req && 'id' in req && req.id)) {
          out[id] = cached.value;
          return;
        }
        const value = withAppCredentials(id, await runtime.availability(id), settings.get());
        if (generation === availabilityGeneration) availabilityCache.set(id, { at: Date.now(), value });
        deps.analytics.noteHarnessVersion(id, value.version);
        deps.log('debug', `harness ${id}: ${value.available ? 'available' : 'unavailable'}${value.version ? ` ${value.version}` : ''}${value.binaryPath ? ` at ${value.binaryPath}` : ''}${value.detail ? ` — ${value.detail}` : ''}`);
        out[id] = value;
      })
    );
    return out;
  });
  handle('harness:models', async ({ harness, refresh }) => {
    assertHarnessId(harness);
    const current = settings.get();
    // Discovery spawns the CLI or calls the vendor, so a clean catalog is reused for a week unless
    // the user asks for a recheck. The fingerprint is what discovery reads besides keys (a key
    // change clears the cache): a new endpoint, override or binary misses instead of going stale.
    const binary = HARNESS_BINARY[harness];
    const fingerprint = JSON.stringify([harness, current.modelOverrides, current.providers, current.binaries, current.claude, binary ? runtime.resolve(binary)?.path ?? null : null]);
    const result = await modelCatalog().get(
      harness,
      fingerprint,
      () => listHarnessModels({ harness, settings: current, runtime, getApiKey: providerSecrets((id) => secrets.get(id)) }),
      { refresh: refresh === true }
    );
    return { ...result, models: enrichModelsFromProviders(result.models, current.providers) };
  });
  handle('harness:install', async ({ id }) => {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(HARNESS_PACKAGES, id)) throw new Error('Unsupported harness installer');
    deps.log('info', `installing ${id} into the app runtime directory`);
    const r = await runtime.install(id);
    invalidateAvailability();
    // A new runtime can list models the old one did not.
    await modelCatalog().clear();
    // npm's output is the renderer's to show in full; the log keeps the verdict and the tail of a failure.
    if (r.ok) deps.log('info', `installed ${id}`);
    else deps.log('warn', `install of ${id} failed: ${r.log.trim().split('\n').slice(-5).join(' | ').slice(0, 600)}`);
    return r;
  });
  handle('harness:checkUpdates', async (req) => {
    const ids: HarnessId[] = req && 'ids' in req && req.ids?.length ? req.ids : ['claude', 'codex', 'pi', 'acp'];
    const updates = await runtime.checkUpdates(ids);
    for (const [id, u] of Object.entries(updates)) {
      deps.log(
        'debug',
        `harness ${id}: ${u.current ?? 'unknown'} installed, ${u.latest ?? u.error ?? 'unknown'} published${u.newer ? ' (update available)' : ''}${u.reason ? ` — ${u.reason}` : ''}`
      );
    }
    return updates;
  });

  handle('skills:list', () => listSkills());
  handle('skills:read', ({ path: p }) => readSkillDoc(p));
  // Only paths main itself listed (a skills root or one of its skill folders) may be revealed.
  handle('skills:reveal', async ({ path: p }) => {
    if (locateSkillPath(p)) await deps.desktop.openPath(path.resolve(p));
  });
  handle('skills:openInEditor', async ({ path: p, line }) => {
    const target = path.resolve(p);
    const loc = locateSkillPath(path.dirname(target));
    if (!loc || loc.kind !== 'skill' || path.basename(target) !== 'SKILL.md') return { ok: false, error: 'Path is not a known skill document' };
    return launchEditor(target, line);
  });
  handle('skills:create', (req) => createSkill(req));
  handle('skills:copy', (req) => copySkill(req));
  handle('skills:delete', ({ path: p }) => deleteSkill(p));

  // Base-pi global config. Resource toggles and prompt writes are validated inside PiConfigStore
  // (path containment, type/name allowlists), so a tampered renderer cannot touch other files.
  handle('instructions:read', () => appInstructions().read());
  handle('instructions:write', ({ scope, content }) => appInstructions().write(scope, content));
  handle('pi:setup', () => piConfig.read());
  handle('pi:preferences', (patch) => piConfig.updatePreferences(patch));
  handle('pi:resource', ({ type, path: p, enabled }) => piConfig.setResourceEnabled(type, p, enabled));
  handle('pi:prompt:write', ({ name, content }) => piConfig.writePrompt(name, content));
  handle('pi:package:install', ({ source }) => piConfig.installPackage(source));
  handle('pi:package:remove', ({ source }) => piConfig.removePackage(source));
  handle('pi:package:update', ({ source }) => piConfig.updatePackages(source));
  handle('pi:package:resource', ({ source, type, path: p, enabled }) => piConfig.setPackageResourceEnabled(source, type, p, enabled));
  handle('pi:subagents', (patch) => piConfig.updateSubagents(patch));
  handle('pi:openInEditor', async ({ path: p, line }) => {
    const target = piConfig.resolveAgentPath(p);
    if (!target) return { ok: false, error: 'Path is outside the pi agent dir' };
    return launchEditor(target, line);
  });
  handle('pi:reveal', async ({ path: p }) => {
    const target = p ? piConfig.resolveAgentPath(p) : piConfig.paths().agentDir;
    if (target) await deps.desktop.openPath(target);
  });
}
