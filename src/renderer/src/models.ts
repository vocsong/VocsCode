/** Session model pickers combine process-reported metadata with newly discovered catalog entries. */
import { useEffect, useMemo } from 'react';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import type { HarnessId, ModelInfo, SessionMeta } from '../../shared/types';
import { useStore, type ModelCatalogEntry } from './store';

/** Stable fallback so the returned array is never a fresh reference (React #185 infinite loop). */
const EMPTY: never[] = [];

export interface SessionModels {
  models: ModelInfo[];
  loading: boolean;
  error?: string;
}

/**
 * A process reports a snapshot on startup. Keep its metadata for matching models, but append newly
 * discovered models so an old session does not hide models already available in New Session.
 * Before the first message, the shared catalog supplies the entire list.
 */
export function pickSessionModels(reported: ModelInfo[] | undefined, catalog: ModelCatalogEntry | undefined, harness?: HarnessId): SessionModels {
  if (reported?.length) {
    // Claude/Codex are endpoint-pinned; Pi retains launch-time provider credentials. A global
    // probe may discover providers usable only in NEW sessions, not this process.
    if (harness && HARNESS_BY_ID[harness].capabilities.modelSource === 'acp-config') return { models: reported, loading: false };
    const pinned = harness === 'claude' || harness === 'codex' || harness === 'codex-exec' || harness === 'pi';
    const providers = new Set(reported.map((m) => m.provider));
    const known = new Set(reported.map((m) => JSON.stringify([m.provider, m.id])));
    const added = catalog?.models.filter((m) => (!pinned || providers.has(m.provider)) && !known.has(JSON.stringify([m.provider, m.id]))) ?? EMPTY;
    return { models: added.length ? [...reported, ...added] : reported, loading: false, ...(catalog?.error ? { error: catalog.error } : {}) };
  }
  return { models: catalog?.models ?? EMPTY, loading: catalog?.loading ?? true, error: catalog?.error };
}

export function useSessionModels(session: SessionMeta): SessionModels {
  const harness = session.config.harness;
  const reported = useStore((s) => s.models[session.id]);
  const catalog = useStore((s) => s.modelCatalog[harness]);
  const ensureModelCatalog = useStore((s) => s.ensureModelCatalog);

  useEffect(() => {
    if (!catalog) void ensureModelCatalog(harness);
  }, [catalog, ensureModelCatalog, harness]);

  return useMemo(() => pickSessionModels(reported, catalog, harness), [reported, catalog, harness]);
}
