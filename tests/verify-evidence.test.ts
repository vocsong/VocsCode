import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The standalone .mjs ships without a declaration file.
import { validateEvidence } from '../scripts/verify-evidence.mjs';

const entry = {
  criterion: 'sample-size',
  required: true,
  check: 'node size.mjs sample.txt 3',
  inputs: [
    { id: 'file:sample.txt', sha256: 'a'.repeat(64) },
    { id: 'value:expected', sha256: 'b'.repeat(64) },
  ],
};
const current = { version: 1, task: 'Check a sample file', entries: [entry] };
const notes = { decisions: ['Use the size check.'], holds: [], next: [] };
const recorded = { ...entry, status: 'PASS', evidenceRefs: ['size.log'] };
const record = { ...current, ...notes, entries: [recorded] };

function withCurrent(overrides: Partial<typeof entry>) {
  return { ...current, entries: [{ ...entry, ...overrides }] };
}

function withRecord(overrides: Partial<typeof recorded>) {
  return { ...record, entries: [{ ...recorded, ...overrides }] };
}

describe('portable verification records', () => {
  it('passes an exact required match even if a valid optional check was not run', () => {
    const optional = { ...entry, criterion: 'optional', required: false };
    const result = validateEvidence(
      { ...record, entries: [{ ...optional, status: 'NOT RUN', evidenceRefs: [] }, recorded] },
      { ...current, entries: [entry, optional] },
    );
    expect(result).toEqual({ exitCode: 0, required: 1, problems: [] });
  });

  it.each(['FAIL', 'BLOCKED', 'NOT RUN'])('reports %s even if the prose claims success', (status) => {
    const evidenceRefs = status === 'FAIL' ? ['failure.log'] : [];
    expect(validateEvidence({ ...withRecord({ status, evidenceRefs }), next: ['All checks passed.'] }, current))
      .toMatchObject({ exitCode: 1, problems: [`"sample-size": ${status}`] });
  });

  it('does not silently omit a required criterion from either side', () => {
    expect(validateEvidence({ ...record, entries: [] }, current))
      .toMatchObject({ exitCode: 1, problems: ['"sample-size": MISSING from record'] });
    expect(validateEvidence(record, { ...current, entries: [{ ...entry, criterion: 'new' }] }))
      .toMatchObject({ exitCode: 1, problems: ['"new": MISSING from record', '"sample-size": MISSING from current inputs'] });
    expect(validateEvidence(withRecord({ required: false }), current))
      .toMatchObject({ exitCode: 1, problems: ['"sample-size": STALE (required flag changed)'] });
    expect(validateEvidence(record, withCurrent({ required: false }))).toMatchObject({ exitCode: 2 });
  });

  it('rejects stale content, a changed input set (even with the same digests), and a changed check', () => {
    const [file, value] = entry.inputs;
    expect(validateEvidence(record, withCurrent({ inputs: [file, { ...value, sha256: 'c'.repeat(64) }] })))
      .toMatchObject({ exitCode: 1, problems: ['"sample-size": STALE (input "value:expected" changed)'] });
    expect(validateEvidence(record, withCurrent({ inputs: [{ ...file, id: 'file:other.txt' }, value] })))
      .toMatchObject({ exitCode: 1, problems: ['"sample-size": STALE (material input set changed)'] });
    expect(validateEvidence(record, withCurrent({ inputs: [file] })))
      .toMatchObject({ exitCode: 1, problems: ['"sample-size": STALE (material input set changed)'] });
    expect(validateEvidence(record, withCurrent({ check: `${entry.check} --strict` })))
      .toMatchObject({ exitCode: 1, problems: ['"sample-size": STALE (exact check changed)'] });
    expect(validateEvidence(record, { ...current, task: 'Another task' }))
      .toMatchObject({ exitCode: 1, problems: ['STALE: task changed'] });
  });

  it.each([
    ['unsupported version', { ...record, version: 2 }],
    ['unknown status', withRecord({ status: 'SKIPPED' })],
    ['missing PASS reference', withRecord({ evidenceRefs: [] })],
    ['invalid hash', withRecord({ inputs: [{ id: 'file:sample.txt', sha256: 'bad' }] })],
    ['unsorted input set', withRecord({ inputs: [...entry.inputs].reverse() })],
    ['duplicate input', withRecord({ inputs: [entry.inputs[0], entry.inputs[0]] })],
    ['duplicate criterion', { ...record, entries: [recorded, recorded] }],
  ])('rejects a malformed record: %s', (_, badRecord) => {
    expect(validateEvidence(badRecord, current)).toMatchObject({ exitCode: 2 });
  });

  it('checks a real pass, stale input, and real failure with a standalone copy of the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-evidence-'));
    const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 5000 });
      if (result.error) throw result.error;
      return [result.status, result.stdout.trim(), result.stderr.trim()] as const;
    };
    const cli = (...args: string[]) => run('verify-evidence.mjs', ...args);
    const snapshot = () => {
      const [code, stdout, stderr] = cli('snapshot', 'current.json');
      expect([code, stderr]).toEqual([0, '']);
      const result: typeof current = JSON.parse(stdout);
      expect(result.entries[0].inputs.map(({ id }) => id))
        .toEqual(['file:sample.txt', 'file:size.mjs', 'value:expected']);
      return result;
    };
    try {
      copyFileSync(new URL('../scripts/verify-evidence.mjs', import.meta.url), join(dir, 'verify-evidence.mjs'));
      writeFileSync(join(dir, 'size.mjs'), `import { appendFileSync, readFileSync } from 'node:fs';
const size = readFileSync(process.argv[2]).length;
const expected = Number(process.argv[3]);
console.log('bytes=' + size + ', expected=' + expected);
appendFileSync('runs.txt', 'run\\n');
process.exitCode = size === expected ? 0 : 1;
`);
      const setCurrent = (value: string) => save('current.json', { ...current, entries: [{ ...entry, inputs: [
        { name: 'expected', value }, { path: 'size.mjs' }, { path: 'sample.txt' },
      ] }] });
      setCurrent('3');
      const verify = (name: string) => cli('verify', name, 'current.json');
      const capture = (name: string, expected: [number, string, string]) => {
        const inputs = snapshot();
        const [code, stdout, stderr] = run('size.mjs', 'sample.txt', '3');
        expect([code, stdout, stderr]).toEqual(expected);
        writeFileSync(join(dir, `${name}.log`), stdout);
        save(`${name}.json`, { ...inputs, ...notes, entries: inputs.entries.map((row) => ({
          ...row, status: code === 0 ? 'PASS' : 'FAIL', evidenceRefs: [`${name}.log`],
        })) });
      };

      writeFileSync(join(dir, 'sample.txt'), 'abc');
      capture('pass', [0, 'bytes=3, expected=3', '']);
      expect(verify('pass.json')).toEqual([0, 'PASS: 1 required check', '']);
      setCurrent('4');
      expect(verify('pass.json')).toEqual([1, '', '"sample-size": STALE (input "value:expected" changed)']);
      setCurrent('3');

      writeFileSync(join(dir, 'sample.txt'), 'abcd');
      expect(verify('pass.json')).toEqual([1, '', '"sample-size": STALE (input "file:sample.txt" changed)']);
      capture('fail', [1, 'bytes=4, expected=3', '']);
      expect(verify('fail.json')).toEqual([1, '', '"sample-size": FAIL']);

      writeFileSync(join(dir, 'corrupt.json'), '{');
      expect(verify('corrupt.json')).toEqual([2, '', 'record: invalid UTF-8 JSON']);
      rmSync(join(dir, 'sample.txt'));
      expect(verify('pass.json')).toEqual([2, '', 'current.entries[0].inputs[2]: cannot read file (ENOENT)']);
      expect(readFileSync(join(dir, 'runs.txt'), 'utf8')).toBe('run\nrun\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
