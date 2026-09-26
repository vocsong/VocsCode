/** Hash routes for the web shell (docs/REMOTE-ACCESS.md §4): a session is a deep link
 *  `#/h/<host>/s/<session>`; `#/` is home. The pairing code and the Connect-with-GitHub hash are
 *  query parameters (`?code=`, `?connect=`) that the shell reads once and scrubs from the address
 *  bar, so neither lingers in history. Routing never reloads the page. */
import { CONNECT_HASH_PATTERN, PAIRING_CODE_PATTERN } from '@shared/pairing';

export type Route =
  | { name: 'home' }
  | { name: 'session'; host: string; session: string }
  | { name: 'pair' }
  | { name: 'connect'; nonceHash: string };

/** The pairing link's code, when this URL carries exactly one valid one. */
export function pairingCodeFromUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  const codes = params.getAll('code');
  if (codes.length !== 1) return null;
  const code = (codes[0] ?? '').trim().toUpperCase();
  return PAIRING_CODE_PATTERN.test(code) ? code : null;
}

/** The Connect-with-GitHub hash, when this URL carries exactly one valid one. */
export function connectHashFromUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  const hashes = params.getAll('connect');
  if (hashes.length !== 1) return null;
  const hash = hashes[0] ?? '';
  return CONNECT_HASH_PATTERN.test(hash) ? hash : null;
}

/** Removes the given query parameters, keeping the hash and any `?relay=` override. */
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

export function readRoute(): Route {
  const hash = window.location.hash;
  if (hash === '#/pair') return { name: 'pair' };
  const match = /^#\/h\/([^/]+)\/s\/([^/]+)$/.exec(hash);
  if (match) return { name: 'session', host: decodeURIComponent(match[1]!), session: decodeURIComponent(match[2]!) };
  return { name: 'home' };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'pair':
      return '#/pair';
    case 'session':
      return `#/h/${encodeURIComponent(route.host)}/s/${encodeURIComponent(route.session)}`;
    default:
      return '#/';
  }
}

/** Navigates without a page load; `replace` keeps the back button out of it. */
export function navigate(route: Route, replace = false): void {
  const href = routeHref(route);
  if (window.location.hash === href) return;
  if (replace) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${href}`);
  else window.location.hash = href;
  // `replaceState` never fires hashchange, and jsdom does not fire it for a programmatic hash
  // assignment; dispatch it so the shell's route state follows immediately in every environment
  // (a browser fires its own event too, which is then a no-op).
  window.dispatchEvent(new Event('hashchange'));
}
