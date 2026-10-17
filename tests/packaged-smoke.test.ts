import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

function packagedJob(): string {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const start = workflow.indexOf('  packaged-smoke:\n');
  expect(start, 'release CI must launch the packaged app, not only the out/ build').toBeGreaterThanOrEqual(0);
  const body = workflow.slice(start + '  packaged-smoke:\n'.length);
  const next = body.search(/^  [\w-]+:\n/m);
  return body.slice(0, next < 0 ? undefined : next);
}

describe('packaged-app release gate', () => {
  it('builds and checks an unpublished Windows package after the release-tier E2E gate', () => {
    const job = packagedJob();
    expect(job).toContain('needs: [gate, e2e]');
    expect(job).toMatch(/github\.event_name == 'workflow_dispatch' \|\|\s*\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'\) \|\|\s*\(github\.event_name == 'pull_request' && github\.base_ref == 'master'\)/);
    expect(job).toContain('runs-on: windows-latest');
    expect(job).toContain('timeout-minutes:');
    expect(job).toContain('npm ci --include=dev');
    expect(job).toContain('npm run dist:dir -- --publish never');
    expect(job).toContain('node scripts/e2e-guard.mjs tests/e2e.packaged.test.ts');
    expect(job).toContain('HARNESS_E2E_EXE: ${{ github.workspace }}/dist/win-unpacked/Vocs Code.exe');
    expect(job).toContain('if: failure()');
    expect(job).toContain('uses: actions/upload-artifact@v4');
    expect(job).toContain('path: tests/artifacts/packaged-smoke/');
    expect(job).not.toContain('--publish always');
  });
});
