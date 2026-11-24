/** URL parameters the web app reads once: the Connect-with-Vocs hash a desktop puts in
 *  `/dashboard?connect=`. It is scrubbed from the address bar so it never lingers in history. */
import { CONNECT_HASH_PATTERN } from '@shared/pairing';

/** The Connect-with-Vocs hash, when this URL carries exactly one valid one. */
export function connectHashFromUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  const hashes = params.getAll('connect');
  if (hashes.length !== 1) return null;
  const hash = hashes[0] ?? '';
  return CONNECT_HASH_PATTERN.test(hash) ? hash : null;
}

/** Removes the given query parameters, keeping the rest of the URL. */
export function scrubParams(names: string[]): void {
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  for (const name of names) {
    if (!params.has(name)) continue;
    params.delete(name);
    changed = true;
  }
  if (!changed) return;
  const search = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
}
