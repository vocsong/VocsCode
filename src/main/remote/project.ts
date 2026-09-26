/** What a paired browser must not receive (docs/REMOTE-ACCESS.md §5). A `SessionMeta` carries
 *  desktop-only bookkeeping and bulky fields: the project's knowledge digest can be tens of
 *  kilobytes and is the project's own context, `harnessCommands` describes the local CLI, and the
 *  pending-priming flags only drive the desktop session lifecycle. Everything a web shell renders
 *  (title, status, usage, config, cwd) is kept. */
import type { SessionMeta } from '../../shared/types';

/** Stripped from every meta a remote client can see, whether returned or pushed. */
const OMITTED = ['knowledgeDigest', 'pendingKnowledgeDigest', 'pendingForkContext', 'harnessCommands'] as const;

/** A copy of one session without the remote-hidden fields. */
export function projectSessionMeta(meta: SessionMeta): SessionMeta {
  const projected = { ...meta };
  for (const key of OMITTED) delete projected[key];
  return projected;
}

const isSessionMeta = (value: unknown): value is SessionMeta =>
  !!value && typeof value === 'object' && 'config' in value && 'usage' in value && 'harnessRef' in value;

/** Projects a result or push payload: a meta, a list of them, or anything else untouched. */
export function projectRemoteValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => (isSessionMeta(entry) ? projectSessionMeta(entry) : entry)) as unknown as T;
  if (isSessionMeta(value)) return projectSessionMeta(value) as unknown as T;
  return value;
}
