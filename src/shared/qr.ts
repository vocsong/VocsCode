/** A small QR Code encoder (ISO/IEC 18004, byte mode) for the remote-access pairing link
 *  (docs/REMOTE-ACCESS.md §6.3): a phone scans the code shown in Settings → Remote access and
 *  opens the web client with the pairing code filled in. Written in-house rather than taken as a
 *  runtime dependency; tests/qr.test.ts decodes every version and error-correction level with an
 *  independent decoder and checks each Reed–Solomon block for zero errors.
 *
 *  The construction follows the standard directly: data codewords → per-block Reed–Solomon
 *  error correction over GF(256) → interleaving → zigzag placement around the function patterns →
 *  the mask with the lowest penalty score → format and version information. */

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  version: number;
  errorCorrection: QrErrorCorrection;
  mask: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  /** Row-major, `true` = dark. */
  modules: boolean[][];
}

const LEVEL_INDEX: Record<QrErrorCorrection, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format-information bits for each level (not in L, M, Q, H order). */
const LEVEL_FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Error-correction codewords per block and number of blocks, by level then version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

export function qrSize(version: number): number {
  return version * 4 + 17;
}

/** Modules left for data and error correction once every function pattern is drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords a version holds at a level (total codewords minus error correction). */
export function qrDataCodewords(version: number, level: QrErrorCorrection): number {
  const l = LEVEL_INDEX[level];
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[l][version] * NUM_ERROR_CORRECTION_BLOCKS[l][version];
}

/** Byte-mode character-count field width. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** The largest byte-mode payload a version holds at a level. */
export function qrByteCapacity(version: number, level: QrErrorCorrection): number {
  return Math.floor((qrDataCodewords(version, level) * 8 - 4 - countBits(version)) / 8);
}

/** Centre coordinates of the alignment patterns along one axis. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = qrSize(version) - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// --- Reed–Solomon over GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ---

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial coefficients (highest degree first, leading 1 omitted) for `degree`. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/** Splits data codewords into blocks, appends each block's error correction and interleaves. */
function interleaveWithEcc(data: number[], version: number, level: QrErrorCorrection): number[] {
  const l = LEVEL_INDEX[level];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[l][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[l][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // placeholder so every block has the same length
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// --- function patterns ---

/** Which modules are function patterns (finders, separators, timing, alignment, format and
 *  version areas) for a version: everything the data zigzag must skip. */
export function functionModules(version: number): boolean[][] {
  const size = qrSize(version);
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(align[i] + dx, align[j] + dy);
    }
  }
  // Format information (both copies) and the always-dark module.
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return fn;
}

function drawFunctionPatterns(modules: boolean[][], version: number): void {
  const size = modules.length;
  const set = (x: number, y: number, dark: boolean) => {
    if (x >= 0 && x < size && y >= 0 && y < size) modules[y][x] = dark;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
}

function drawFormatBits(modules: boolean[][], level: QrErrorCorrection, mask: number): void {
  const size = modules.length;
  const data = (LEVEL_FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
  };
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

/** Visits every non-function module in placement order: two-column strips from the right edge,
 *  alternating upward and downward, skipping the vertical timing column. */
export function forEachDataModule(version: number, fn: boolean[][], visit: (x: number, y: number) => void): void {
  const size = qrSize(version);
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) visit(x, y);
      }
    }
  }
}

export function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError(`invalid QR mask ${mask}`);
  }
}

/** The standard penalty (rules N1–N4) that decides which mask reads most reliably. */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // A finder-like 1:1:3:1:1 pattern with four light modules on one side.
      for (let j = 0; j + 10 < size; j++) {
        const seq = Array.from({ length: 11 }, (_, k) => get(i, j + k));
        const core = seq[4] && !seq[5] && seq[6] && seq[7] && seq[8] && !seq[9] && seq[10];
        const coreRev = seq[0] && !seq[1] && seq[2] && seq[3] && seq[4] && !seq[5] && seq[6];
        if (core && !seq[0] && !seq[1] && !seq[2] && !seq[3]) score += 40;
        if (coreRev && !seq[7] && !seq[8] && !seq[9] && !seq[10]) score += 40;
      }
    }
  };
  line((i, j) => modules[i][j]);
  line((i, j) => modules[j][i]);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x + 1 < size && y + 1 < size) {
        const c = modules[y][x];
        if (modules[y][x + 1] === c && modules[y + 1][x] === c && modules[y + 1][x + 1] === c) score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes `text` (UTF-8) in byte mode at the smallest version that fits. */
export function encodeQr(text: string, options: { errorCorrection?: QrErrorCorrection; minVersion?: number; mask?: number } = {}): QrCode {
  const level = options.errorCorrection ?? 'M';
  const bytes = [...new TextEncoder().encode(text)];
  let version = Math.max(QR_MIN_VERSION, options.minVersion ?? QR_MIN_VERSION);
  while (version <= QR_MAX_VERSION && bytes.length > qrByteCapacity(version, level)) version++;
  if (version > QR_MAX_VERSION) throw new RangeError('text too long for a QR code');

  // Mode 0100 (byte), character count, data, terminator, byte padding, then 0xEC/0x11 fill.
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const capacityBits = qrDataCodewords(version, level) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacityBits / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const codewords = interleaveWithEcc(data, version, level);
  const size = qrSize(version);
  const fn = functionModules(version);
  const base = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  drawFunctionPatterns(base, version);
  let bit = 0;
  forEachDataModule(version, fn, (x, y) => {
    // Remainder modules past the last codeword stay light.
    base[y][x] = bit < codewords.length * 8 && ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) !== 0;
    bit++;
  });

  const render = (mask: number): boolean[][] => {
    const modules = base.map((row) => [...row]);
    forEachDataModule(version, fn, (x, y) => {
      if (maskApplies(mask, x, y)) modules[y][x] = !modules[y][x];
    });
    drawFormatBits(modules, level, mask);
    return modules;
  };
  if (options.mask !== undefined) return { version, errorCorrection: level, mask: options.mask, size, modules: render(options.mask) };
  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = render(mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { mask, modules, score };
  }
  return { version, errorCorrection: level, mask: best!.mask, size, modules: best!.modules };
}

/** An SVG path (one unit per module, `quiet` modules of margin) of the dark modules. */
export function qrSvgPath(code: QrCode, quiet = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      // Merge horizontal runs into one rectangle to keep the path short.
      let run = 1;
      while (x + run < code.size && code.modules[y][x + run]) run++;
      parts.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
      x += run - 1;
    }
  }
  return parts.join('');
}
