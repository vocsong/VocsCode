import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fullRunReason } from '../scripts/test-changed-scope.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const prFiles = JSON.parse(readFileSync(path.join(root, 'scripts/pr-test-files.json'), 'utf8')) as string[];
const releaseCondition = /github\.event_name == 'workflow_dispatch' \|\|\s*\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'\) \|\|\s*\(github\.event_name == 'pull_request' && github\.base_ref == 'master'\)/;

function job(name: string) {
  const start = workflow.indexOf(`  ${name}:\n`);
  expect(start, `CI job ${name} exists`).toBeGreaterThanOrEqual(0);
  const body = workflow.slice(start + name.length + 4);
  const next = body.search(/^  [\w-]+:\n/m);
  return body.slice(0, next < 0 ? undefined : next);
}

describe('CI tier boundaries', () => {
  it('keeps the develop gate on typecheck, build, and a bounded allowlist with no-skip evidence', () => {
    const gate = job('gate');
    expect(gate).toContain('npm run typecheck');
    expect(gate).toContain('npm run test:pr');
    expect(readFileSync(path.join(root, 'scripts/test-pr.mjs'), 'utf8')).toContain('test-report-check.mjs');
    expect(gate).toContain('npm run build');
    expect(prFiles.length).toBeGreaterThanOrEqual(10);
    expect(new Set(prFiles).size).toBe(prFiles.length);
    expect(prFiles.every((file) => file.startsWith('tests/') && !file.startsWith('tests/e2e.'))).toBe(true);
    expect(prFiles.every((file) => existsSync(path.join(root, file)))).toBe(true);
    expect(prFiles).toEqual(expect.arrayContaining([
      'tests/review-fixes.test.ts', 'tests/mcp-oauth.test.ts', 'tests/mcp-oauth-transport-race.test.ts', 'tests/vocs-account.test.ts', 'tests/vocs-account-settings.test.tsx', 'tests/session-resume.test.ts',
      'tests/relay-core.test.ts', 'tests/qr.test.ts', 'tests/web-dashboard.test.tsx', 'tests/workspace-files.test.ts'
    ]));
    expect(gate).toMatch(releaseCondition);
    expect(gate).toContain('name: Full offline suite');
  });

  it.each(['e2e', 'windows-offline'])('runs full-tier job %s only for release-to-master or manual validation', (name) => {
    expect(job(name)).toMatch(releaseCondition);
  });

  it('keeps the full offline and no-provider E2E suites in their release-only jobs', () => {
    expect(job('gate')).toContain('npm test --');
    expect(job('e2e')).toContain('npm run test:e2e:ci');
    expect(job('windows-offline')).toContain('tests/local-control-windows.test.ts');
  });
});

const workflowDir = path.join(root, '.github/workflows');
const readWorkflow = (file: string) => readFileSync(path.join(workflowDir, file), 'utf8').replace(/\r\n/g, '\n');

/** Top-level jobs of a workflow, keyed by id, each mapped to its indented body. */
function jobsOf(file: string): Map<string, string> {
  const text = readWorkflow(file);
  const start = text.indexOf('\njobs:\n');
  expect(start, `${file} has a jobs: block`).toBeGreaterThanOrEqual(0);
  const jobs = new Map<string, string>();
  const parts = text.slice(start + '\njobs:\n'.length).split(/^ {2}([\w-]+):\n/m);
  for (let i = 1; i < parts.length; i += 2) jobs.set(parts[i], parts[i + 1]);
  return jobs;
}

function needsOf(body: string): string[] {
  const match = /^ {4}needs: *(\[[^\]]*\]|[\w-]+)/m.exec(body);
  if (!match) return [];
  return match[1].replace(/[[\]]/g, '').split(',').map((name) => name.trim()).filter(Boolean);
}

describe('release tag gate', () => {
  const gate = readWorkflow('verify-release-tag.yml');

  it.each([
    ['release.yml', ['build', 'publish']],
    ['deploy-relay.yml', ['deploy']]
  ])('%s runs verify-tag first and every build/deploy job needs it and builds its verified SHA', (file, expected) => {
    const jobs = jobsOf(file);
    const verify = jobs.get('verify-tag');
    expect(verify, `${file} has a verify-tag job`).toBeDefined();
    expect(verify).toContain('uses: ./.github/workflows/verify-release-tag.yml');
    expect(verify).toMatch(/permissions:\n {6}actions: read\n {6}contents: read\n/);
    const others = [...jobs.keys()].filter((name) => name !== 'verify-tag');
    expect(others).toEqual(expected);
    for (const name of others) {
      const body = jobs.get(name)!;
      expect(needsOf(body), `${file} job ${name} needs verify-tag`).toContain('verify-tag');
      // Every checkout builds the verified commit, never whatever the tag points at by then.
      const checkouts = body.match(/uses: actions\/checkout@.*(\n {8,}.*)*/g) ?? [];
      expect(checkouts.length).toBeGreaterThan(0);
      for (const step of checkouts) expect(step).toContain('ref: ${{ needs.verify-tag.outputs.sha }}');
    }
  });

  it('gates manual runs the same way: release.yml verifies the dispatched tag input', () => {
    const verify = jobsOf('release.yml').get('verify-tag')!;
    expect(verify).toContain('tag: ${{ inputs.tag || github.ref_name }}');
    expect(verify).not.toMatch(/^ {4}if:/m);
    expect(readWorkflow('release.yml')).toContain('workflow_dispatch:');
  });

  it('keeps the relay deploy behind its protected environment and on tags only', () => {
    const jobs = jobsOf('deploy-relay.yml');
    expect(jobs.get('deploy')).toContain('environment: relay-production');
    expect(jobs.get('deploy')).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    expect(jobs.get('verify-tag')).toContain('tag: ${{ github.ref_name }}');
    expect(readWorkflow('deploy-relay.yml')).toContain('workflow_dispatch:');
  });

  it('is callable only, with least-privilege token scopes', () => {
    expect(gate).toMatch(/^on:\n {2}workflow_call:\n/m);
    expect(gate).not.toMatch(/^ {2}(push|pull_request|workflow_dispatch|schedule):/m);
    expect(gate).not.toMatch(/: write$/m);
    expect(gate).toContain('value: ${{ jobs.verify.outputs.sha }}');
  });

  it('peels annotated tags and rejects a tag that moved after the run started', () => {
    expect(gate).toContain('repos/$REPO/git/ref/tags/$TAG');
    expect(gate).toContain('repos/$REPO/git/tags/$sha');
    expect(gate).toContain('[ "$type" != commit ]');
    expect(gate).toContain('Tag $TAG moved since this run started');
    // Workflow input reaches the script only through env, never interpolated into it.
    expect(gate).toContain('TAG: ${{ inputs.tag }}');
    expect(gate).not.toMatch(/run: \|[^]*\$\{\{ inputs\./);
  });

  it('requires the commit on master', () => {
    expect(gate).toContain("'+refs/heads/master:refs/remotes/origin/master' \"$SHA\"");
    expect(gate).toContain('git merge-base --is-ancestor "$SHA" refs/remotes/origin/master');
  });

  it('requires a successful CI run on the exact commit from a master push or a manual dispatch, waiting a bounded time', () => {
    expect(gate).toContain('repos/$REPO/actions/workflows/ci.yml/runs');
    expect(gate).toContain('-f head_sha="$SHA"');
    expect(gate).toContain('select((.event == "push" and .head_branch == "master") or .event == "workflow_dispatch")');
    expect(gate).toContain('select(.status == "completed" and .conclusion == "success")');
    // A successful run with a skipped job (a release-tier job guarded out) does not count.
    expect(gate).toContain('select(.conclusion != "success")');
    expect(gate).toMatch(/CI_WAIT_MINUTES: '\d+'/);
    expect(gate).toMatch(/timeout-minutes: \d+/);
    expect(readWorkflow('ci.yml')).toMatch(/^name: CI$/m);
  });
});

describe('draft-first release publication', () => {
  const release = readWorkflow('release.yml');
  const jobs = jobsOf('release.yml');

  it('serializes the whole workflow per tag without cancelling an in-flight publisher', () => {
    expect(release).toContain('group: release-${{ inputs.tag || github.ref_name }}');
    expect(release).toContain('cancel-in-progress: false');
  });

  it('builds read-only with updater metadata but no publication credential', () => {
    const build = jobs.get('build')!;
    expect(build).toContain('contents: read');
    expect(build).not.toContain('contents: write');
    expect(build).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|secrets\./);
    expect(build).toContain('--publish never');
    expect(build).not.toContain('--publish always');
    expect(build).toContain('node scripts/release-artifacts.mjs identity');
    expect(build).toContain('node scripts/release-artifacts.mjs stage');
    expect(build).toContain('persist-credentials: false');
    expect(build).toContain('name: release-${{ matrix.platform }}');
    expect(build).toContain('overwrite: true');
    expect(build).not.toContain('github.run_attempt');
    expect(build).toContain('if-no-files-found: error');
    expect(build).toContain('path: release-bundle/');
    for (const platform of ['windows', 'macos', 'linux']) expect(build).toContain(`platform: ${platform}`);
  });

  it('attests validated build bytes before transfer, with no release-write permission', () => {
    const build = jobs.get('build')!;
    expect(build).toContain('id-token: write');
    expect(build).toContain('attestations: write');
    expect(build).toContain('RELEASE_WORKFLOW_SHA: ${{ github.workflow_sha }}');
    expect(build.indexOf('node scripts/release-artifacts.mjs identity')).toBeLessThan(build.indexOf('npx electron-vite build'));
    expect(build.indexOf('node scripts/release-artifacts.mjs stage')).toBeLessThan(build.indexOf('uses: actions/attest-build-provenance@'));
    expect(build.indexOf('uses: actions/attest-build-provenance@')).toBeLessThan(build.indexOf('uses: actions/upload-artifact@'));
    expect(build).toContain('subject-path: release-bundle/*');
    expect(jobs.get('publish')).not.toMatch(/id-token: write|attestations: write/);
  });

  it('has one publisher that needs all build legs and the verified tag, and downloads three separate bundles', () => {
    const publish = jobs.get('publish')!;
    expect(publish).toBeDefined();
    expect(needsOf(publish)).toEqual(['verify-tag', 'build']);
    expect(publish).toContain('contents: write');
    expect(publish).toContain('node scripts/publish-release.mjs');
    expect(publish).toContain('GH_TOKEN: ${{ github.token }}');
    for (const platform of ['windows', 'macos', 'linux']) {
      expect(publish).toContain(`name: release-${platform}`);
      expect(publish).toContain(`path: release-bundles/${platform}`);
    }
    expect(publish).not.toMatch(/merge-multiple: true|--clobber|release create/);
  });

  it('keeps automatic tools from exposing an incomplete public release', () => {
    expect(readWorkflow('release-please.yml')).toContain('skip-github-release: true');
    const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    expect(builder).toMatch(/publish:\s*\n\s+provider: github\s*\n\s+releaseType: draft/);
    expect(prFiles).toEqual(expect.arrayContaining(['tests/release-artifacts.test.ts', 'tests/release-publish.test.ts']));
  });
});

describe('workflow action pins', () => {
  const files = readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file));

  const usesOf = (file: string) => [...readWorkflow(file).matchAll(/^\s*(?:- )?uses: *(.+)$/gm)].map((match) => match[1].trim());

  it('covers every workflow', () => {
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'release.yml', 'deploy-relay.yml', 'release-please.yml', 'verify-release-tag.yml']));
    expect(files.flatMap(usesOf).filter((use) => !use.startsWith('./')).length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)('%s pins every action to a full commit SHA with its version noted', (file) => {
    for (const use of usesOf(file)) {
      if (use.startsWith('./')) continue; // same-commit reusable workflow
      expect(use, `${file}: ${use}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });
});

describe('develop-tier local test scope', () => {
  it('is the command the verification bar names', () => {
    const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['test:changed']).toBe('node scripts/test-changed.mjs');
    const script = readFileSync(path.join(root, 'scripts/test-changed.mjs'), 'utf8');
    expect(script).toContain("'--changed', base");
    expect(script).toContain('tests/smoke.remote-live.test.ts');
    expect(readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('`npm run test:changed`');
  });

  it('follows the import graph for source, test and docs edits', () => {
    expect(fullRunReason(['src/main/session-manager.ts', 'tests/qr.test.ts', 'docs/TESTING.md', 'AGENTS.md'])).toBeUndefined();
    expect(fullRunReason(['src/renderer/src/package.json', 'scripts/tsconfig-notes.md'])).toBeUndefined();
  });

  it.each([
    'package.json', 'package-lock.json', 'tsconfig.test.json', 'relay/tsconfig.json',
    'vitest.config.ts', 'vitest.relay.config.ts', 'vite.config.web.ts', 'electron.vite.config.ts'
  ])('runs the whole offline suite when %s changes, which no test imports', (file) => {
    expect(fullRunReason(['src/shared/qr.ts', file])).toBe(file);
    expect(fullRunReason([file.replace(/\//g, '\\')])).toBe(file);
  });
});
