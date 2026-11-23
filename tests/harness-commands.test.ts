/** The rules the composer's `/` popover and send path use to offer and route a harness's own commands. */
import { describe, expect, it } from 'vitest';
import { harnessCommandNames, harnessRoutedText, MAX_HARNESS_COMMANDS, normalizeHarnessCommands, slashEntries, type HarnessCommand } from '../src/shared/harness-commands';

const APP = [
  { name: 'model', description: 'Switch model', args: '<provider/model>' },
  { name: 'compact', description: 'Compact' },
  { name: 'goal', description: 'Goal' },
  { name: 'pr', description: 'Open a PR', args: '<branch>' }
];

describe('normalizeHarnessCommands', () => {
  it('drops unusable names and duplicates, strips a leading slash and flattens text', () => {
    const list = normalizeHarnessCommands([
      { name: '/review', description: 'Review\n  the   diff', argumentHint: '[pr]' },
      { name: 'Review', description: 'duplicate, different case' },
      { name: 'has space' },
      { name: '' },
      { name: 'skill:pdf', aliases: ['pdf', 'skill:pdf', 'bad alias'] }
    ] as HarnessCommand[]);
    expect(list).toEqual([
      { name: 'review', description: 'Review the diff', argumentHint: '[pr]' },
      { name: 'skill:pdf', aliases: ['pdf'] }
    ]);
    expect(harnessCommandNames(list)).toEqual(['review', 'skill:pdf', 'pdf']);
  });

  it('caps a huge list so one session push stays bounded', () => {
    const many = Array.from({ length: MAX_HARNESS_COMMANDS + 50 }, (_, i) => ({ name: `c${i}`, description: 'x'.repeat(1000) }));
    const list = normalizeHarnessCommands(many);
    expect(list).toHaveLength(MAX_HARNESS_COMMANDS);
    expect(list[0].description!.length).toBeLessThanOrEqual(240);
  });
});

describe('slashEntries', () => {
  const harness: HarnessCommand[] = [
    { name: 'review', description: 'Review a PR', kind: 'command' },
    { name: 'skill:pdf', description: 'PDF tools', kind: 'skill' },
    { name: 'security-review', kind: 'command' },
    { name: 'pr', description: 'My PR skill', kind: 'skill' },
    { name: 'compact', kind: 'command' },
    { name: 'goal', kind: 'command' }
  ];

  it('lists app commands first, so Tab on /m stays /model', () => {
    const rows = slashEntries({ query: 'm', app: APP, harness: [{ name: 'mcp-thing' }] });
    expect(rows.map((r) => `${r.source}:${r.label}`)).toEqual(['app:/model', 'harness:/mcp-thing']);
  });

  it('puts the harness’s commands first on a bare /, where the app’s would push them out of view', () => {
    const rows = slashEntries({ query: '', app: APP, harness: [{ name: 'review' }] });
    expect(rows[0]).toEqual(expect.objectContaining({ source: 'harness', label: '/review' }));
    expect(rows.slice(1).every((r) => r.source === 'app')).toBe(true);
  });

  it('matches a harness command by prefix, then by a `:` segment, then by substring', () => {
    expect(slashEntries({ query: 'pdf', app: APP, harness }).map((r) => r.label)).toEqual(['/skill:pdf']);
    expect(slashEntries({ query: 'rev', app: APP, harness }).map((r) => r.label)).toEqual(['/review', '/security-review']);
  });

  it('offers a harness command an app command shadows as //name, and drops delegated duplicates', () => {
    const rows = slashEntries({ query: 'pr', app: APP, harness, delegated: ['compact'] });
    expect(rows).toEqual([
      expect.objectContaining({ source: 'app', insert: 'pr' }),
      expect.objectContaining({ source: 'harness', insert: '/pr', label: '/pr', shadowed: true })
    ]);
    expect(slashEntries({ query: 'comp', app: APP, harness, delegated: ['compact'] }).map((r) => r.source)).toEqual(['app']);
  });

  it('hands /goal to the harness row when the harness owns the goal', () => {
    const rows = slashEntries({ query: 'goal', app: APP, harness, nativeGoal: 'goal' });
    expect(rows).toEqual([expect.objectContaining({ source: 'harness', insert: 'goal' })]);
    expect(rows[0].shadowed).toBeUndefined();
  });
});

describe('harnessRoutedText', () => {
  const names = APP.map((c) => c.name);
  it('takes one slash off //name when an app command owns name', () => {
    expect(harnessRoutedText('//pr main', names)).toBe('/pr main');
    expect(harnessRoutedText('//PR', names)).toBe('/PR');
  });
  it('leaves everything else alone', () => {
    expect(harnessRoutedText('// TODO fix this', names)).toBeNull();
    expect(harnessRoutedText('//review', names)).toBeNull();
    expect(harnessRoutedText('/pr main', names)).toBeNull();
    expect(harnessRoutedText('//prx', names)).toBeNull();
  });
});
