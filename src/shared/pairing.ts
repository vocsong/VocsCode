/** Connect with Vocs links. The relay serves the page that adds a computer on its own origin, so a
 *  link must open the relay this desktop is connected to. */

/** The production relay: dashboard, API and sockets on one origin. Desktops always use it unless
 *  VOCS_CODE_RELAY_URL overrides it (src/main/remote/relay-url.ts). */
export const DEFAULT_REMOTE_ORIGIN = 'https://code.vocs.io';

/** The relay's web origin for a configured relay URL (ws/wss map to http/https; any path is
 *  dropped because the relay's routes live at the origin root). */
export function remoteOrigin(relayUrl: string | undefined): string {
  if (!relayUrl?.trim()) return DEFAULT_REMOTE_ORIGIN;
  try {
    const url = new URL(relayUrl.trim());
    const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    if (protocol !== 'https:' && protocol !== 'http:') return DEFAULT_REMOTE_ORIGIN;
    return `${protocol}//${url.host}`;
  } catch {
    return DEFAULT_REMOTE_ORIGIN;
  }
}

/** SHA-256 hex of a desktop's one-time "Connect with Vocs" secret: the only part of it that
 *  leaves the desktop before the owner grants it. */
export const CONNECT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The page a desktop opens for "Connect with Vocs": sign in, then add this computer. Released
 *  desktops open `/app?connect=`, which the relay redirects here. */
export function connectLink(relayUrl: string | undefined, nonceHash: string): string {
  return `${remoteOrigin(relayUrl)}/dashboard?connect=${nonceHash}`;
}

/** A short code derived from the connect hash, shown by both the desktop and the page, so the
 *  person adding a computer can see it is the one in front of them and not a link someone sent. */
export function connectCheckCode(nonceHash: string): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[parseInt(nonceHash.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
