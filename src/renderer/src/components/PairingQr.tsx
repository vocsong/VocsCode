/** The pairing link as a QR code (docs/REMOTE-ACCESS.md §6.3): a phone camera opens the web
 *  client with the code filled in, and the desktop still has to approve the request. Always dark
 *  modules on white with the standard four-module quiet zone, whatever the theme, so it scans. */
import React, { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '../../../shared/qr';

const QUIET = 4;

export function PairingQr({ link, size = 176 }: { link: string; size?: number }) {
  const code = useMemo(() => encodeQr(link, { errorCorrection: 'M' }), [link]);
  const extent = code.size + QUIET * 2;
  return (
    <svg
      data-testid="remote-pair-qr"
      role="img"
      aria-label="QR code for the pairing link"
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      style={{ background: '#fff', borderRadius: 6, display: 'block' }}
    >
      <path d={qrSvgPath(code, QUIET)} fill="#000" />
    </svg>
  );
}
