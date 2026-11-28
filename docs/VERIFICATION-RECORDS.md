# Portable verification records

A version 1 record stores what was checked, the inputs it applied to, and the observed result. Use
it to hand off evidence or decide what to rerun. Keep using your project's test runner or CI; the
verifier **never runs the stored check**, reads the referenced evidence, infers success from notes,
or authorizes any action. A match is a freshness and completeness check, not a signature or proof
that a check really ran. Trust the record producer and review the referenced artifacts separately.

## Standalone example

Copy [`verify-evidence.mjs`](../scripts/verify-evidence.mjs) into any directory. It needs Node.js 20+
and no packages. For this example, create `sample.txt` containing exactly `abc` (no newline), and
save this as `size.mjs`:

```js
import { readFileSync } from 'node:fs';
const actual = readFileSync(process.argv[2]).length;
const expected = Number(process.argv[3]);
console.log(`bytes=${actual}, expected=${expected}`);
process.exitCode = actual === expected ? 0 : 1;
```

Save the independently maintained requirements and material inputs as `current.json`:

```json
{
  "version": 1,
  "task": "Check a sample file",
  "entries": [{
    "criterion": "sample-size",
    "required": true,
    "check": "node size.mjs sample.txt 3",
    "inputs": [{ "name": "expected", "value": "3" }, { "path": "size.mjs" }, { "path": "sample.txt" }]
  }]
}
```

```sh
node verify-evidence.mjs snapshot current.json > inputs.json
node size.mjs sample.txt 3 > size.log
```

`snapshot` emits only fingerprints and check metadata, not a result. Capture fingerprints for the
inputs the runner actually used. Keep inputs unchanged through the run, or compare snapshots before
and after and discard the result if they differ. Copy the snapshot fields into `record.json` and
add the notes and observed outcomes. The example check exits `0` with `bytes=3, expected=3`, so the
record is (digests shown for files with LF line endings):

```json
{
  "version": 1,
  "task": "Check a sample file",
  "decisions": ["Measure bytes, not characters."],
  "holds": [],
  "next": ["Rerun after changing the sample."],
  "entries": [{
    "criterion": "sample-size",
    "required": true,
    "check": "node size.mjs sample.txt 3",
    "inputs": [
      { "id": "file:sample.txt", "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      { "id": "file:size.mjs", "sha256": "5b97185fd532285b43a4fa100122d986810ced50216bff999473ffe9cf32a463" },
      { "id": "value:expected", "sha256": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce" }
    ],
    "status": "PASS",
    "evidenceRefs": ["size.log"]
  }]
}
```

To re-evaluate without rerunning the check:

```sh
node verify-evidence.mjs verify record.json current.json
```

| Exit | Output |
| --- | --- |
| `0` | `PASS: 1 required check` (count varies), on stdout. |
| `1` | A required entry is missing, stale, or not `PASS`. Each problem goes to stderr. |
| `2` | Usage, malformed JSON/schema, unsupported version, or unreadable input. Diagnostic on stderr. |

If you change `sample.txt` to `abcd`, the old record reports `"sample-size": STALE (input "file:sample.txt" changed)`.
A new run prints `bytes=4, expected=3` and exits `1`; a fresh record of that run reports `"sample-size": FAIL`.

## Record and input rules

- Use UTF-8 JSON with exactly the fields shown. `task` and `criterion` are non-blank, stable identifiers;
  criteria are unique per document. `check` is the exact invocation or manual procedure, compared as
  text. `decisions`, `holds`, and `next` are note arrays (possibly empty); a note does not gate a pass.
- Each entry names at least one material input. Include the check implementation, relevant data,
  configuration, and any other material setting such as a runtime version. The CLI reads only
  caller-selected files; it resolves relative paths from `current.json`'s directory. Use stable
  relative paths with `/` for portability. `file:<path>` hashes raw file bytes and `value:<name>`
  hashes the exact UTF-8 string value. Fingerprint IDs are unique and sorted lexicographically by
  UTF-16 code unit, with lowercase hex SHA-256 digests. A path spelling change changes the ID.
- Supply a trusted current plan, not one reconstructed from the old record. At least one entry must
  be required now. Anything marked required in either document must exist and be required in both,
  match the same task, check and complete input set, and have recorded `PASS`. Optional results do
  not gate success, but malformed entries or unreadable files are still input errors.
- Record `PASS` for a check that ran and passed, `FAIL` for one that ran and failed, `BLOCKED` when a
  prerequisite prevents it from running, and `NOT RUN` for skipped or not yet attempted checks. A
  runner's green exit does not count if the required check was skipped or not collected. `PASS` and
  `FAIL` require at least one evidence reference (e.g. a run ID or sanitized log path); the others
  may have an empty array.
- Don't supply secrets in files, values, invocations, notes, or artifact references. A hash is not
  redaction. Keep only non-secret identifiers and references in the record, not raw logs.

For library use, import `validateEvidence(record, currentSnapshot)` from the same `.mjs` file. Both
arguments are parsed JSON objects; `currentSnapshot` has the shape emitted by `snapshot`. The pure
function returns `{ exitCode, required, problems }` without reading files or changing either argument.
