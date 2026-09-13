/**
 * Unit cover for the screenshot comparison the themes e2e relies on. The decoder is hand-rolled
 * (no image dependency), and a silent bug in it would weaken every pixel assertion in that suite
 * without failing anything — so it is checked here, offline, against a real committed PNG.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodePng, type Frame, pixelDelta } from './e2e-ui';

const ICON = path.join(__dirname, '..', 'resources', 'icons', 'vocs-code.png');

/** A solid RGBA frame, the shape decodePng produces. */
function solid(width: number, height: number, rgb: [number, number, number]): Frame {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = rgb[0];
    pixels[i * 4 + 1] = rgb[1];
    pixels[i * 4 + 2] = rgb[2];
    pixels[i * 4 + 3] = 255;
  }
  return { width, height, channels: 4, pixels };
}

describe('e2e screenshot comparison', () => {
  it('decodes a real PNG to plausible pixels', async () => {
    const frame = decodePng(await fs.readFile(ICON));
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBe(frame.width); // the app icon is square
    expect(frame.pixels.length).toBe(frame.width * frame.height * frame.channels);
    // A real icon is not one flat colour: the un-filtering step has to actually run.
    const distinct = new Set<number>();
    for (let i = 0; i < frame.width * frame.height; i++) distinct.add(frame.pixels[i * frame.channels]!);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('reports zero delta for a frame against itself', async () => {
    const frame = decodePng(await fs.readFile(ICON));
    expect(pixelDelta(frame, frame)).toBe(0);
  });

  it('ignores drift within tolerance but counts anything larger', () => {
    const base = solid(10, 10, [100, 100, 100]);
    expect(pixelDelta(base, solid(10, 10, [102, 98, 100]))).toBe(0); // ±2 is antialiasing noise
    expect(pixelDelta(base, solid(10, 10, [103, 100, 100]))).toBe(1); // every pixel differs
    // A single changed pixel is a fraction, not a boolean.
    const one = solid(10, 10, [100, 100, 100]);
    one.pixels[0] = 200;
    expect(pixelDelta(base, one)).toBeCloseTo(0.01, 5);
  });

  it('refuses to compare frames of different sizes', () => {
    expect(() => pixelDelta(solid(4, 4, [0, 0, 0]), solid(5, 4, [0, 0, 0]))).toThrow(/size mismatch/);
  });
});
