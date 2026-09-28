import path from 'node:path';

/** Vitest's JSON reporter is the evidence that every requested suite ran a passing assertion. */
export function validateE2eReport(reportText, files, childStatus, cwd = process.cwd()) {
  const problems = [];
  let parsed;
  if (!reportText) {
    problems.push('no JSON report');
  } else {
    try {
      parsed = JSON.parse(reportText);
    } catch (error) {
      problems.push(`invalid JSON report: ${error.message}`);
    }
  }

  const results = Array.isArray(parsed?.testResults) ? parsed.testResults : [];
  const tests = results.flatMap((file) =>
    Array.isArray(file?.assertionResults)
      ? file.assertionResults.map((test) => ({ ...test, file: file.name }))
      : []
  );
  const skipped = tests.filter((test) => ['pending', 'skipped', 'todo'].includes(test.status));
  const failed = tests.filter((test) => test.status === 'failed');
  const passed = tests.filter((test) => test.status === 'passed');

  if (childStatus !== 0) problems.push(`vitest exited with status ${childStatus ?? 'unknown'}`);
  if (failed.length) problems.push(`${failed.length} test(s) failed`);
  for (const test of skipped) problems.push(`skipped: ${test.file} > ${test.fullName ?? test.title}`);
  for (const test of tests) {
    if (!['passed', 'failed', 'pending', 'skipped', 'todo'].includes(test.status)) {
      problems.push(`unexpected test status: ${test.file} > ${test.fullName ?? test.title} (${test.status})`);
    }
  }
  for (const file of files) {
    const abs = path.resolve(cwd, file);
    const collected = tests.filter((test) => typeof test.file === 'string' && path.resolve(cwd, test.file) === abs);
    if (!collected.length) problems.push(`no tests collected: ${file}`);
    if (!collected.some((test) => test.status === 'passed')) problems.push(`no passed tests: ${file}`);
  }

  return { passed: passed.length, failed: failed.length, skipped: skipped.length, problems };
}
