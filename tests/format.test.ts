import { describe, expect, it } from 'vitest';
import { basename, fmtCost, fmtRate, fmtTokens, speedOfTurns } from '../src/renderer/src/format';
import { quoteWin } from '../src/main/harness/spawn';

describe('renderer format helpers', () => {
  it('basename handles Windows and POSIX separators', () => {
    expect(basename('C:\\Users\\alice\\code\\Vocs Code')).toBe('Vocs Code');
    expect(basename('C:\\Users\\alice\\code\\Vocs Code\\')).toBe('Vocs Code');
    expect(basename('/home/alice/code/proj')).toBe('proj');
    expect(basename('proj')).toBe('proj');
  });
  it('formats cost and tokens', () => {
    expect(fmtCost(0)).toBe('$0.00');
    expect(fmtCost(0.0002)).toBe('$0.0002');
    expect(fmtCost(1.5)).toBe('$1.50');
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(1400)).toBe('1.4k');
    expect(fmtTokens(2_500_000)).toBe('2.50M');
  });
});

describe('quoteWin', () => {
  it('quotes arguments with spaces and escapes embedded quotes', () => {
    expect(quoteWin('plain')).toBe('plain');
    expect(quoteWin('C:\\Program Files\\x.cmd')).toBe('"C:\\Program Files\\x.cmd"');
    expect(quoteWin('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWin('trail\\ ')).toBe('"trail\\ "');
    expect(quoteWin('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
  });

  it('rejects cmd.exe expansion and command-separator characters', () => {
    expect(() => quoteWin('100% complete')).toThrow(/percent/);
    expect(() => quoteWin('line\nnext')).toThrow(/newline/);
    expect(() => quoteWin('line\rnext')).toThrow(/newline/);
  });
});

describe('fmtRate / speedOfTurns', () => {
  it('formats tokens per second and hides incomplete samples', () => {
    expect(fmtRate(100, 2_000)).toBe('50.0 tok/s');
    expect(fmtRate(1_500, 10_000)).toBe('150 tok/s');
    expect(fmtRate(0, 2_000)).toBe('');
    expect(fmtRate(100, 0)).toBe('');
    expect(fmtRate(undefined, undefined)).toBe('');
  });

  it('sums only completed turns that report both output tokens and duration', () => {
    const turns = [
      { status: 'completed', durationMs: 2_000, usage: { outputTokens: 100 } },
      { status: 'completed', durationMs: 3_000 },
      { status: 'interrupted', durationMs: 1_000, usage: { outputTokens: 900 } },
      { status: 'completed', durationMs: 2_000, usage: { outputTokens: 60 } }
    ];
    expect(speedOfTurns(turns)).toEqual({ tokens: 160, ms: 4_000 });
    expect(speedOfTurns([])).toEqual({ tokens: 0, ms: 0 });
  });
});
