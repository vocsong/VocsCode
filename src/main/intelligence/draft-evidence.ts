import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../../shared/analytics/text';
import type { EvidenceSource } from '../../shared/intelligence';
import { validateWorkspaceFileTarget } from '../workspace-files';
import { normalizeRoot } from './registry';

const MAX_SOURCES = 6;
const PRIVATE_COMPONENT = /^(?:\.git|\.vocs-code|node_modules|\.env(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$|\.(?:pem|key|p12|pfx)$/i;

/** A citation names an exact physical file within this checkout, never a suffix or a linked path. */
async function hasDraftFile(cwd: string, rel: string, signal?: AbortSignal): Promise<boolean> {
  const components = rel.split('/');
  if (components.length > 20 || components.some((name) => PRIVATE_COMPONENT.test(name))) return false;
  try {
    let current = await fs.realpath(cwd);
    for (let i = 0; i < components.length; i++) {
      signal?.throwIfAborted();
      current = path.join(current, components[i]);
      const stat = await fs.lstat(current);
      if (i === components.length - 1 ? !stat.isFile() : !stat.isDirectory()) return false;
    }
    return normalizeRoot(await fs.realpath(current)) === normalizeRoot(current);
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/** Check addresses, not whether the cited source logically proves the submitted claim. */
export async function checkDraftEvidence(
  cwd: string,
  sources: EvidenceSource[] | undefined,
  resolveCommit: ((cwd: string, revision: string) => Promise<string | null>) | undefined,
  signal?: AbortSignal
): Promise<EvidenceSource[]> {
  if (!sources?.length || sources.length > MAX_SOURCES) throw new Error('A wiki draft needs one to six file, doc, or commit citations.');
  const checked: EvidenceSource[] = [];
  for (const { type, ref, note } of sources) {
    signal?.throwIfAborted();
    if (ref.length > 300 || redactSecrets(ref) !== ref || (note && (note.length > 200 || redactSecrets(note) !== note))) {
      throw new Error('A draft citation is too long or contains credential-like text.');
    }
    if (type === 'commit') {
      const revision = /^[a-f0-9]{7,64}$/i.test(ref) ? await resolveCommit?.(cwd, ref).catch(() => null) : null;
      if (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) throw new Error('A draft needs a commit SHA that resolves in this checkout.');
      checked.push({ type, ref: revision, revision, ...(note ? { note } : {}) });
    } else if (type === 'file' || type === 'doc') {
      const rel = validateWorkspaceFileTarget(ref);
      if (!(await hasDraftFile(cwd, rel, signal))) throw new Error('A draft citation must name a regular, unlinked file in this checkout.');
      checked.push({ type, ref: rel, ...(note ? { note } : {}) });
    } else {
      throw new Error('A transcript or other non-code source alone cannot support a wiki draft. Cite files, docs, or commits from this checkout.');
    }
  }
  signal?.throwIfAborted();
  return checked;
}
