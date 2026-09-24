/** Reads a rendered pairing QR code back the way a phone would: rasterize the SVG path the UI
 *  drew (one unit per module) and decode the pixels with jsQR, an independent decoder. */
import jsQR from 'jsqr';

/** `d` is a path of `M{x} {y}h{n}v1h-{n}z` runs in a `extent`×`extent` viewBox. */
export function decodeQrPath(d: string, extent: number, scale = 4): string | null {
  const width = extent * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y, run] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let dx = 0; dx < Number(run) * scale; dx++) {
      for (let dy = 0; dy < scale; dy++) {
        const offset = ((Number(y) * scale + dy) * width + Number(x) * scale + dx) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
    }
  }
  return jsQR(pixels, width, width)?.data ?? null;
}
