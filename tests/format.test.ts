import { describe, expect, it } from 'vitest';
import { basename, fmtCost, fmtTokens } from '../src/renderer/src/format';
import { quoteWin } from '../src/main/harness/spawn';

describe('renderer format helpers', () => {
  it('basename handles Windows and POSIX separators', () => {
    expect(basename('C:\\Users\\vocs\\code\\Vocs-Desk')).toBe('Vocs-Desk');
    expect(basename('C:\\Users\\vocs\\code\\Vocs-Desk\\')).toBe('Vocs-Desk');
    expect(basename('/home/vocs/code/proj')).toBe('proj');
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
});
