/** One session's model list: the harness's own list once it reports one, its harness catalog before that. */
import { useEffect } from 'react';
import type { ModelInfo, SessionMeta } from '../../shared/types';
import { useStore, type ModelCatalogEntry } from './store';

/** Stable fallback so the returned array is never a fresh reference (React #185 infinite loop). */
const EMPTY: never[] = [];

export interface SessionModels {
  models: ModelInfo[];
  loading: boolean;
  error?: string;
}

/**
 * A harness reports its models over its own process, which is only spawned on the first message, so
 * a brand-new session has nothing to show. The catalog stands in until then; an absent catalog entry
 * means the fetch has not resolved yet, which reads as loading rather than as an empty list.
 */
export function pickSessionModels(reported: ModelInfo[] | undefined, catalog: ModelCatalogEntry | undefined): SessionModels {
  if (reported?.length) return { models: reported, loading: false };
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

  return pickSessionModels(reported, catalog);
}
