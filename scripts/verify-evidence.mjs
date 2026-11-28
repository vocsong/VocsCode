import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const version = 1;
const header = ['version', 'task', 'entries'];
const notes = ['decisions', 'holds', 'next'];
const entryFields = ['criterion', 'required', 'check', 'inputs'];
const statuses = ['PASS', 'FAIL', 'BLOCKED', 'NOT RUN'];
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isTextList = (value) => Array.isArray(value) && value.every(isText);
const hasFields = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));

function requireThat(condition, where, message) {
  if (!condition) throw new Error(`${where}: ${message}`);
}

function fingerprints(inputs, where) {
  let previous = '';
  for (const [i, input] of inputs.entries()) {
    const at = `${where}[${i}]`;
    requireThat(hasFields(input, ['id', 'sha256']) && isText(input.id)
      && typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.sha256), at, 'expected an id and a lowercase SHA-256');
    requireThat(previous < input.id, at, 'fingerprint ids must be unique and sorted');
    previous = input.id;
  }
  return inputs;
}

function indexEntries(document, label, readInputs, isRecord = false) {
  requireThat(hasFields(document, isRecord ? [...header, ...notes] : header) && document.version === version
    && isText(document.task) && Array.isArray(document.entries), label, 'expected version 1, a task, and entries' + (isRecord ? ' with decisions, holds, and next' : ''));
  if (isRecord) {
    for (const key of notes) requireThat(isTextList(document[key]), `${label}.${key}`, 'expected an array of non-blank strings');
  }
  const entries = new Map();
  const fields = isRecord ? [...entryFields, 'status', 'evidenceRefs'] : entryFields;
  for (const [i, entry] of document.entries.entries()) {
    const at = `${label}.entries[${i}]`;
    requireThat(hasFields(entry, fields) && isText(entry.criterion) && typeof entry.required === 'boolean'
      && isText(entry.check) && Array.isArray(entry.inputs) && entry.inputs.length > 0, at, 'invalid entry fields (criterion, required, exact check, or inputs)');
    requireThat(!entries.has(entry.criterion), at, 'duplicate criterion');
    if (isRecord) {
      requireThat(statuses.includes(entry.status), `${at}.status`, 'expected PASS, FAIL, BLOCKED, or NOT RUN');
      requireThat(isTextList(entry.evidenceRefs) && (entry.evidenceRefs.length > 0 || !['PASS', 'FAIL'].includes(entry.status)),
        `${at}.evidenceRefs`, 'expected an array of references (at least one for PASS or FAIL)');
    }
    entries.set(entry.criterion, { ...entry, inputs: readInputs(entry.inputs, `${at}.inputs`) });
  }
  requireThat(isRecord || [...entries.values()].some((entry) => entry.required), label, 'expected at least one required criterion');
  return entries;
}

function problemFor(before, now) {
  if (!before) return 'MISSING from record';
  if (!now) return 'MISSING from current inputs';
  if (before.required !== now.required) return 'STALE (required flag changed)';
  if (before.check !== now.check) return 'STALE (exact check changed)';
  if (before.inputs.length !== now.inputs.length || before.inputs.some(({ id }, i) => id !== now.inputs[i].id)) {
    return 'STALE (material input set changed)';
  }
  const changed = before.inputs.find(({ sha256 }, i) => sha256 !== now.inputs[i].sha256);
  if (changed) return `STALE (input ${JSON.stringify(changed.id)} changed)`;
  if (before.status !== 'PASS') return before.status;
}

/** Compare parsed JSON data against a caller-supplied, fingerprinted current snapshot. No I/O. */
export function validateEvidence(record, current) {
  try {
    const oldEntries = indexEntries(record, 'record', fingerprints, true);
    const newEntries = indexEntries(current, 'current', fingerprints);
    const required = new Set();
    for (const entry of [...newEntries.values(), ...oldEntries.values()]) {
      if (entry.required) required.add(entry.criterion);
    }
    const problems = record.task === current.task ? [] : ['STALE: task changed'];
    for (const criterion of required) {
      const problem = problemFor(oldEntries.get(criterion), newEntries.get(criterion));
      if (problem) problems.push(`${JSON.stringify(criterion)}: ${problem}`);
    }
    return { exitCode: problems.length ? 1 : 0, required: required.size, problems };
  } catch (error) {
    return { exitCode: 2, required: 0, problems: [error.message] };
  }
}

function readBytes(file, where) {
  try {
    if (statSync(file).isFile()) return readFileSync(file);
  } catch (error) {
    throw new Error(`${where}: cannot read file (${error.code ?? 'read error'})`);
  }
  throw new Error(`${where}: expected a regular file`);
}

function readJson(file, label) {
  const bytes = readBytes(file, label);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label}: invalid UTF-8 JSON`);
  }
}

function snapshot(file) {
  const plan = readJson(file, 'current');
  const base = dirname(resolve(file));
  const entries = indexEntries(plan, 'current', (inputs, where) => {
    const hashed = inputs.map((input, i) => {
      const at = `${where}[${i}]`;
      const hash = createHash('sha256');
      if (hasFields(input, ['path']) && isText(input.path)) {
        return { id: `file:${input.path}`, sha256: hash.update(readBytes(resolve(base, input.path), at)).digest('hex') };
      }
      requireThat(hasFields(input, ['name', 'value']) && isText(input.name)
        && typeof input.value === 'string' && input.value.isWellFormed(), at, 'expected {path} or {name, value} with a Unicode string value');
      return { id: `value:${input.name}`, sha256: hash.update(input.value, 'utf8').digest('hex') };
    });
    hashed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return fingerprints(hashed, where);
  });
  return { version, task: plan.task, entries: [...entries.values()] };
}

function main(args) {
  const [mode, first, second] = args;
  try {
    if (mode === 'snapshot' && args.length === 2) {
      console.log(JSON.stringify(snapshot(first), null, 2));
      return 0;
    }
    if (mode === 'verify' && args.length === 3) {
      const { exitCode, required, problems } = validateEvidence(readJson(first, 'record'), snapshot(second));
      if (exitCode === 0) console.log(`PASS: ${required} required check${required === 1 ? '' : 's'}`);
      else console.error(problems.join('\n'));
      return exitCode;
    }
    console.error('usage: node verify-evidence.mjs verify <record.json> <current.json>\n'
      + '       node verify-evidence.mjs snapshot <current.json>');
  } catch (error) {
    console.error(error.message);
  }
  return 2;
}

function isMainByPath() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (import.meta.main ?? isMainByPath()) process.exitCode = main(process.argv.slice(2));
