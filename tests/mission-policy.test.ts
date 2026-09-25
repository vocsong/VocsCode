import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMissionDeliveryPolicy } from '../src/main/mission/policy';

const dirs: string[] = [];
async function project(files: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-policy-')); dirs.push(root);
  for (const [name, body] of Object.entries(files)) { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, body); }
  return root;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => fs.rm(p, { recursive: true, force: true }))); });
const sha = 'a'.repeat(40);
const git = () => vi.fn(async (_cwd: string, args: string[]) => ({ code: 0, stderr: '', stdout: args[0] === 'remote' ? 'origin\n' : args[0] === 'ls-remote' ? `${sha}\trefs/heads/integration\n` : '' }));

describe('Mission project delivery policy', () => {
  it('defaults to local delivery and actual counted test commands, never auto publishing', async () => {
    const root = await project({ 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run', build: 'vite build' } }) });
    const runGit = git(); const policy = await resolveMissionDeliveryPolicy(root, { runGit });
    expect(policy).toMatchObject({ endpoint: 'local_commit', fallback: true, allowPush: false, allowMerge: false, requireIndependentReview: true, conflicts: [] });
    expect(policy.checks.map((c) => c.id)).toEqual(['project-typecheck', 'project-test', 'project-build']);
    expect(policy.checks[1]).toMatchObject({ command: 'npm --silent test -- --reporter=json', testReport: { format: 'vitest-json', minimumTests: 1, maximumSkipped: 0 } });
    expect(runGit).not.toHaveBeenCalled();
  });
  it('follows explicit PR/merge instructions without hard-coding a branch or inventing a remote head', async () => {
    const root = await project({ 'AGENTS.md': 'Push the agent branch and open a PR into `integration`. By default, merge the PR yourself once verification passes. See [testing](docs/TESTING.md).', 'docs/TESTING.md': 'Changes are squash-merged after all required checks.' });
    const runGit = git(); const policy = await resolveMissionDeliveryPolicy(root, { runGit });
    expect(policy).toMatchObject({ endpoint: 'merge_pr', targetBranch: 'integration', remote: 'origin', targetHead: sha, allowPush: true, allowMerge: true, mergeMethod: 'squash', fallback: false, conflicts: [] });
    expect(policy.provenance.some((p) => p.source.startsWith(`docs${path.sep}TESTING.md`) && p.text.includes('squash'))).toBe(true);
    expect(runGit).toHaveBeenCalledWith(await fs.realpath(root), ['ls-remote', '--refs', 'origin', 'refs/heads/integration']);
  });
  it('rereads repository checks and holds without remote observation under a host local-only ceiling', async () => {
    const config = { version: 1, endpoint: 'merge_pr', remote: 'origin', targetBranch: 'integration', allowPush: true, allowMerge: true, requireIndependentReview: true, holdConditions: ['Human approval required'], checks: [{ id: 'build', name: 'Build', kind: 'build', command: 'npm run build', criterionIds: ['build'], required: true, heavy: true, timeoutMs: 60000 }] };
    const root = await project({ '.vocs-code/mission-delivery.json': JSON.stringify(config) });
    const runGit = git();
    const policy = await resolveMissionDeliveryPolicy(root, { runGit, localOnly: true });
    // The resolver still describes repository policy; the coordinator intersects it with the
    // durable genuine-user ceiling. Skipping a probe does not invent a fresh remote receipt.
    expect(policy).toMatchObject({ endpoint: 'merge_pr', targetBranch: 'integration', requireIndependentReview: true, checks: config.checks, holdConditions: config.holdConditions, conflicts: [] });
    expect(policy.targetHead).toBeUndefined(); expect(runGit).not.toHaveBeenCalled();
  });

  it('does not infer a merge grant from an instruction to open a PR', async () => {
    const root = await project({ 'AGENTS.md': 'Open a PR into `integration`. Never automatically merge.' });
    expect(await resolveMissionDeliveryPolicy(root, { runGit: git() })).toMatchObject({ endpoint: 'open_pr', allowPush: true, allowMerge: false, conflicts: [] });
  });
  it('does not pretend an unresolved publishing target or unsupported test report is the local endpoint', async () => {
    const root = await project({ 'AGENTS.md': 'Open a PR after finishing.', 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) });
    const policy = await resolveMissionDeliveryPolicy(root, { runGit: git() });
    expect(policy.endpoint).toBe('open_pr');
    expect(policy.conflicts).toEqual(expect.arrayContaining([expect.stringContaining('target'), expect.stringContaining('test runner')]));
    expect(policy.checks).toEqual([]);
  });
  it('keeps conflicting targets and missing referenced policy as visible blockers', async () => {
    const root = await project({ 'AGENTS.md': 'Open a PR into `one`. Create a PR into `two`. [Testing](docs/TESTING.md)' });
    const policy = await resolveMissionDeliveryPolicy(root, { runGit: git() });
    expect(policy.conflicts).toEqual(expect.arrayContaining([expect.stringContaining('conflicting'), expect.stringContaining('missing')]));
  });
  it('refuses to claim the target was observed on command failure or ambiguous output', async () => {
    const root = await project({ 'AGENTS.md': 'Open a PR into `integration`.' });
    const runGit = git(); runGit.mockImplementation(async (_cwd, args) => ({ code: args[0] === 'ls-remote' ? 1 : 0, stderr: 'not authenticated', stdout: args[0] === 'remote' ? 'origin' : '' }));
    const policy = await resolveMissionDeliveryPolicy(root, { runGit });
    expect(policy.targetHead).toBeUndefined();
    expect(policy.conflicts).toContain('The actual remote target head could not be established; delivery must not guess it.');
  });
  it('accepts strict machine-readable project rules and preserves exact commands', async () => {
    const config = { version: 1, endpoint: 'open_pr', targetBranch: 'integration', remote: 'origin', allowPush: true, holdIsEndpoint: true, checks: [{ id: 'integration', name: 'Live integration', kind: 'test', command: 'npm --silent run test:integration -- --reporter=json', criterionIds: ['live'], required: true, heavy: true, timeoutMs: 60000, testReport: { format: 'vitest-json', minimumTests: 8, maximumSkipped: 0 } }] };
    const root = await project({ '.vocs-code/mission-delivery.json': JSON.stringify(config) });
    const policy = await resolveMissionDeliveryPolicy(root, { runGit: git() });
    expect(policy).toMatchObject({ endpoint: 'open_pr', fallback: false, allowPush: true, allowMerge: false, holdIsEndpoint: true, conflicts: [] });
    expect(policy.checks).toEqual(config.checks);
  });
  it.each([
    { version: 2, endpoint: 'local_commit', checks: [] },
    { version: 1, endpoint: 'merge_pr', remote: 'origin', targetBranch: 'integration', allowPush: true, checks: [] },
    { version: 1, endpoint: 'local_commit', checks: [{ id: 'test', name: 'test', kind: 'test', command: 'echo passed', criterionIds: ['x'], required: true, heavy: true, timeoutMs: 1000 }] },
  ])('fails closed on invalid machine-readable policy %#', async (config) => {
    const root = await project({ '.vocs-code/mission-delivery.json': JSON.stringify(config) });
    await expect(resolveMissionDeliveryPolicy(root, { runGit: git() })).rejects.toThrow('Invalid .vocs-code/mission-delivery.json');
  });
  it('does not let a manifest silently override an explicit no-merge rule', async () => {
    const root = await project({ 'AGENTS.md': 'Never automatically merge.', '.vocs-code/mission-delivery.json': JSON.stringify({ version: 1, endpoint: 'merge_pr', remote: 'origin', targetBranch: 'integration', allowPush: true, allowMerge: true, checks: [] }) });
    expect((await resolveMissionDeliveryPolicy(root, { runGit: git() })).conflicts).toContain('The resolved merge grant contradicts a repository no-merge instruction.');
  });
  it('never turns negated instructions or fenced examples into a remote grant', async () => {
    const root = await project({ 'AGENTS.md': 'Never open a PR into `integration`.\n```text\nOpen a PR into `integration`.\n```\nExample: Open a PR into `integration`.' });
    const runGit = git();
    const policy = await resolveMissionDeliveryPolicy(root, { runGit });
    expect(policy).toMatchObject({ endpoint: 'local_commit', allowPush: false, allowMerge: false, conflicts: [] });
    expect(runGit).not.toHaveBeenCalled();
  });
  it('blocks a manifest that contradicts a no-publish instruction', async () => {
    const root = await project({ 'AGENTS.md': 'Do not publish any branch.', '.vocs-code/mission-delivery.json': JSON.stringify({ version: 1, endpoint: 'open_pr', remote: 'origin', targetBranch: 'integration', allowPush: true, checks: [] }) });
    expect((await resolveMissionDeliveryPolicy(root, { runGit: git() })).conflicts).toContain('The resolved publishing grant contradicts a repository no-publish instruction.');
  });
  it('tightens documented review holds for unknown code impact but not unrelated inert documentation', async () => {
    const root = await project({ 'AGENTS.md': 'Open a PR into integration. Merge the PR yourself once verification passes. Skip merging when touching permission gating or secrets handling; leave the PR open for review.' });
    const initial = await resolveMissionDeliveryPolicy(root, { runGit: git() });
    const docs = await resolveMissionDeliveryPolicy(root, { runGit: git(), changedPaths: ['docs/notes.md'] });
    const renderer = await resolveMissionDeliveryPolicy(root, { runGit: git(), changedPaths: ['src/renderer/Header.tsx'] });
    const sensitive = await resolveMissionDeliveryPolicy(root, { runGit: git(), changedPaths: ['src/main/handlers.ts'] });
    expect(initial).toMatchObject({ endpoint: 'merge_pr', targetBranch: 'integration', holdIsEndpoint: true, holdConditions: [] });
    expect(docs.holdConditions).toEqual([]);
    expect(renderer.holdConditions).toEqual(sensitive.holdConditions);
    expect(sensitive.holdConditions).toEqual(['Repository policy requires human review when permission/secrets impact cannot be excluded from the captured change scope.']);
    expect(sensitive.allowMerge).toBe(true); // Grant retained; the explicit hold still prevents use.
  });
  it('rejects policy escapes and explicit file size limits rather than truncating instructions', async () => {
    const escape = await project({ 'AGENTS.md': '[Testing](../TESTING.md)' });
    await expect(resolveMissionDeliveryPolicy(escape)).rejects.toThrow('outside');
    const oversized = await project({ 'AGENTS.md': 'x'.repeat(512 * 1024 + 1) });
    await expect(resolveMissionDeliveryPolicy(oversized)).rejects.toThrow('512 KiB');
  });
});
