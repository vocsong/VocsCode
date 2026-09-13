import { describe, expect, it } from 'vitest';
import { MAX_CAPTURE_BYTES, runCapture } from '../src/main/runtime';

describe('runCapture output limits', () => {
  it('caps large stdout without retaining an unbounded string', async () => {
    const result = await runCapture(process.execPath, ['-e', `process.stdout.write('x'.repeat(${MAX_CAPTURE_BYTES + 1024}))`], { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_CAPTURE_BYTES);
    expect(result.truncated).toBe(true);
  });

  it('caps stdout and stderr independently', async () => {
    const result = await runCapture(
      process.execPath,
      ['-e', `process.stdout.write('o'.repeat(${MAX_CAPTURE_BYTES + 1})); process.stderr.write('e'.repeat(${MAX_CAPTURE_BYTES + 1}))`],
      { timeoutMs: 30_000 }
    );
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_CAPTURE_BYTES);
    expect(Buffer.byteLength(result.stderr)).toBe(MAX_CAPTURE_BYTES);
    expect(result.truncated).toBe(true);
  });
});
