/** Remote-access pairing links (docs/REMOTE-ACCESS.md §6.3). The relay serves the web client at
 *  `/app` on its own origin and the page claims codes against that origin, so a link must open
 *  the relay this desktop is connected to — a link to any other origin can never pair. */

/** The production web client, used until a relay URL is configured. */
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
