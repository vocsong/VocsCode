/** The in-house QR encoder (src/shared/qr.ts) that renders the remote pairing link. Two
 *  independent checks per symbol: jsQR (a third-party decoder) must read back the exact text, and
 *  every Reed–Solomon block read back out of the matrix must have all-zero syndromes — a decoder
 *  silently correcting a few encoder mistakes would hide exactly the bugs this test exists for. */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { encodeQr, forEachDataModule, functionModules, maskApplies, qrByteCapacity, qrDataCodewords, qrSize, qrSvgPath, type QrCode, type QrErrorCorrection } from '../src/shared/qr';

const jsQR = createRequire(import.meta.url)('jsqr') as (data: Uint8ClampedArray, width: number, height: number) => { data: string; version: number } | null;

const LEVELS: QrErrorCorrection[] = ['L', 'M', 'Q', 'H'];

/** Renders modules as RGBA pixels with a quiet zone, the way a camera frame would present them. */
function decode(code: QrCode, scale = 3): { data: string; version: number } | null {
  const quiet = 4;
  const width = (code.size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
      }
    }
  }
  return jsQR(pixels, width, width);
}

// An independent GF(256) for the syndrome check (log/antilog tables, not the encoder's multiply).
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Reads the codeword stream back out of the matrix: unmask, then the placement zigzag. */
function codewordsOf(code: QrCode): number[] {
  const bits: number[] = [];
  forEachDataModule(code.version, functionModules(code.version), (x, y) => {
    bits.push(Number(code.modules[y][x] !== maskApplies(code.mask, x, y)));
  });
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  return out;
}

/** De-interleaves into blocks from the block structure implied by the version's capacities. */
function blocksOf(code: QrCode, codewords: number[], numBlocks: number): number[][] {
  const dataTotal = qrDataCodewords(code.version, code.errorCorrection);
  const total = Math.floor(codewords.length);
  const eccPerBlock = (total - dataTotal) / numBlocks;
  const shortData = Math.floor(dataTotal / numBlocks);
  const longBlocks = dataTotal % numBlocks;
  const dataLen = (i: number) => shortData + (i >= numBlocks - longBlocks ? 1 : 0);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) {
    for (let b = 0; b < numBlocks; b++) if (i < dataLen(b)) blocks[b].push(codewords[k++]);
  }
  for (let i = 0; i < eccPerBlock; i++) for (let b = 0; b < numBlocks; b++) blocks[b].push(codewords[k++]);
  return blocks;
}

/** A block is error-free iff its codeword polynomial vanishes at α^0 … α^(ecc-1). */
function syndromesZero(block: number[], ecc: number): boolean {
  for (let i = 0; i < ecc; i++) {
    let value = 0;
    for (const c of block) value = mul(value, EXP[i]) ^ c;
    if (value !== 0) return false;
  }
  return true;
}

/** Numbers of blocks for the syndrome check, taken from the standard's table (versions 1–40). */
const BLOCKS: Record<QrErrorCorrection, number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
};

/** ISO/IEC 18004 Table C.1: the 15-bit format information (after the 0x5412 mask) by level and
 *  mask. A decoder corrects small errors here, so the bits must match exactly. */
const FORMAT: Record<QrErrorCorrection, number[]> = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
  Q: [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed],
  H: [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b]
};

/** ISO/IEC 18004 Table D.1: the 18-bit version information for versions 7–40. */
const VERSION_INFO = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d, 0x0f928, 0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9, 0x177ec,
  0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75, 0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64, 0x27541, 0x28c69
];

/** Both copies of the format information, bit i at the standard's position i. */
function formatBitsOf(code: QrCode): [number, number] {
  const m = (x: number, y: number) => (code.modules[y][x] ? 1 : 0);
  const s = code.size;
  const first = [0, 1, 2, 3, 4, 5, 7, 8].map((y) => m(8, y)).concat([m(7, 8)], [5, 4, 3, 2, 1, 0].map((x) => m(x, 8)));
  const second = Array.from({ length: 8 }, (_, i) => m(s - 1 - i, 8)).concat(Array.from({ length: 7 }, (_, i) => m(8, s - 7 + i)));
  const pack = (bits: number[]) => bits.reduce((acc, bit, i) => acc | (bit << i), 0);
  return [pack(first), pack(second)];
}

function versionBitsOf(code: QrCode): [number, number] {
  const s = code.size;
  let right = 0;
  let below = 0;
  for (let i = 0; i < 18; i++) {
    const a = s - 11 + (i % 3);
    const b = Math.floor(i / 3);
    right |= (code.modules[b][a] ? 1 : 0) << i;
    below |= (code.modules[a][b] ? 1 : 0) << i;
  }
  return [right, below];
}

function payload(length: number, seed: number): string {
  // Printable ASCII, varied per version so masks and runs differ.
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(33 + ((i * 7 + seed * 13) % 94));
  return text;
}

describe('QR encoder', () => {
  it('matches the standard capacities at the known reference points', () => {
    // ISO/IEC 18004 Table 7 byte-mode capacities.
    expect(qrByteCapacity(1, 'L')).toBe(17);
    expect(qrByteCapacity(1, 'H')).toBe(7);
    expect(qrByteCapacity(3, 'M')).toBe(42);
    expect(qrByteCapacity(10, 'Q')).toBe(151);
    expect(qrByteCapacity(40, 'L')).toBe(2953);
    expect(qrByteCapacity(40, 'H')).toBe(1273);
    expect(qrSize(1)).toBe(21);
    expect(qrSize(40)).toBe(177);
  });

  it('encodes every version and error-correction level decodably, with error-free Reed–Solomon blocks', () => {
    for (const level of LEVELS) {
      for (let version = 1; version <= 40; version++) {
        const text = payload(qrByteCapacity(version, level), version);
        const code = encodeQr(text, { errorCorrection: level, minVersion: version });
        expect(code.version).toBe(version);
        expect(code.size).toBe(qrSize(version));
        const numBlocks = BLOCKS[level][version - 1];
        const codewords = codewordsOf(code);
        const blocks = blocksOf(code, codewords, numBlocks);
        const ecc = (codewords.length - qrDataCodewords(version, level)) / numBlocks;
        for (const block of blocks) expect(syndromesZero(block, ecc), `v${version}-${level} Reed–Solomon block`).toBe(true);
        expect(formatBitsOf(code), `v${version}-${level} format information`).toEqual([FORMAT[level][code.mask], FORMAT[level][code.mask]]);
        expect(code.modules[code.size - 8][8]).toBe(true); // the always-dark module
        if (version >= 7) expect(versionBitsOf(code), `v${version} version information`).toEqual([VERSION_INFO[version - 7], VERSION_INFO[version - 7]]);
        // A decoder confirms format, version, mask and data encoding end to end.
        if (version <= 20 || version % 5 === 0) {
          const decoded = decode(code, version > 20 ? 2 : 3);
          expect(decoded?.data, `v${version}-${level} decode`).toBe(text);
          expect(decoded?.version).toBe(version);
        }
      }
    }
  }, 120_000);

  it('produces a decodable symbol with every one of the eight masks', () => {
    for (let mask = 0; mask < 8; mask++) {
      const code = encodeQr('https://code.vocs.io/app?code=ABCD2345', { mask, minVersion: 7 });
      expect(code.mask).toBe(mask);
      expect(decode(code)?.data).toBe('https://code.vocs.io/app?code=ABCD2345');
    }
  });

  it('fits a pairing link in a small symbol and round-trips UTF-8', () => {
    const link = encodeQr('https://code.vocs.io/app?code=ABCD2345');
    expect(link.version).toBe(3);
    expect(decode(link)?.data).toBe('https://code.vocs.io/app?code=ABCD2345');
    const unicode = 'Vocs — ペアリング ✓';
    expect(decode(encodeQr(unicode))?.data).toBe(unicode);
    expect(() => encodeQr('x'.repeat(3000))).toThrow(RangeError);
  });

  it('renders an SVG path of the dark modules inside the quiet zone', () => {
    const code = encodeQr('ABCD2345');
    const path = qrSvgPath(code);
    const dark = code.modules.flat().filter(Boolean).length;
    const covered = [...path.matchAll(/h(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(covered).toBe(dark);
    expect(path.startsWith('M4 4h7')).toBe(true); // top-left finder, offset by the quiet zone
  });
});
