import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { IntelligenceView } from '../../../../shared/intelligence';
import { invoke } from '../../api';

export type KnowledgeSection = 'knowledge' | 'memory' | 'collections' | 'evidence' | 'sources';
type TaskOwner = KnowledgeSection | 'load';
type Work = (current: () => boolean) => Promise<IntelligenceView | void>;
export type RunIntelligence = (work: Work) => Promise<boolean>;

export interface IntelligenceSectionProps {
  sessionId: string;
  view: IntelligenceView;
  busy: boolean;
  run: RunIntelligence;
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}

export async function readIntelligence(sessionId: string): Promise<IntelligenceView> {
  const view = await invoke('intelligence:view', { sessionId });
  if (!view) throw new Error('Memory and collections are unavailable in this run.');
  return view;
}

/** Captures the lifetime of a keyed session subtree, including across Strict Mode effect replays. */
export function useScopeGuard() {
  const lifetime = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    lifetime.current = Symbol();
    return () => { lifetime.current = null; };
  }, []);
  return useCallback(() => {
    const scope = lifetime.current;
    return () => scope !== null && scope === lifetime.current;
  }, []);
}

/** Serialize reads and writes so an older refresh cannot overwrite a mutation's returned view. */
export function useIntelligence(sessionId: string) {
  const [view, setView] = useState<IntelligenceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<TaskOwner, string>>>({});
  const pending = useRef(false);
  const capture = useScopeGuard();
  useLayoutEffect(() => () => { pending.current = false; }, []);

  const run = useCallback(async (owner: TaskOwner, work: Work) => {
    const current = capture();
    if (!current() || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setErrors((previous) => previous[owner] ? { ...previous, [owner]: undefined } : previous);
    try {
      const next = await work(current);
      if (!current()) return false;
      if (next) setView(next);
      return true;
    } catch (error) {
      if (current()) setErrors((previous) => ({ ...previous, [owner]: errorMessage(error) }));
      return false;
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [capture]);

  const refresh = useCallback(() => run('load', () => readIntelligence(sessionId)), [run, sessionId]);
  return { view, busy, errors, run, refresh };
}

export type IntelligenceController = ReturnType<typeof useIntelligence>;
