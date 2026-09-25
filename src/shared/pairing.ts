/** Remote-access pairing links (docs/REMOTE-ACCESS.md §6.3). The relay serves the web client at
 *  `/app` on its own origin and the page claims codes against that origin, so a link must open
 *  the relay this desktop is connected to — a link to any other origin can never pair. */

/** The production relay: web client, API and sockets on one origin. Desktops always use it unless
 *  VOCS_CODE_RELAY_URL overrides it (src/main/remote/relay-url.ts). */
export const DEFAULT_REMOTE_ORIGIN = 'https://code.vocs.io';

/** Code alphabet from relay/src/core.ts: 8 symbols, no ambiguous glyphs (I/L/O/0/1). */
export const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/** The web-client origin for a configured relay URL (ws/wss map to http/https; any path is
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

/** The link a browser (or a phone scanning its QR code) opens to prefill `code`. */
export function pairingLink(relayUrl: string | undefined, code: string): string {
  return `${remoteOrigin(relayUrl)}/app?code=${encodeURIComponent(code)}`;
}

/** SHA-256 hex of a desktop's one-time "Connect with GitHub" secret: the only part of it that
 *  leaves the desktop before the owner grants it. */
export const CONNECT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The page a desktop opens for "Connect with GitHub": sign in, then add this computer. */
export function connectLink(relayUrl: string | undefined, nonceHash: string): string {
  return `${remoteOrigin(relayUrl)}/app?connect=${nonceHash}`;
}

/** A short code derived from the connect hash, shown by both the desktop and the page, so the
 *  person adding a computer can see it is the one in front of them and not a link someone sent. */
export function connectCheckCode(nonceHash: string): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[parseInt(nonceHash.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
