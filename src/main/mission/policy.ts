/** Resolve a delivery boundary from repository instructions, never from model prose.
 * Ambiguous publishing rules are blockers, not permission to guess a remote or target. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { MissionCheck, MissionDeliveryPolicy } from '../../shared/mission';
import { readMissionRemoteEndpoint, runMissionGit } from './git-boundary';

export interface MissionPolicyOptions {
  /** Actual host-captured integrated paths, supplied again before any delivery effect. */
  changedPaths?: readonly string[];
  /** Host-retained user ceiling: reread checks/holds without contacting a publishing target. */
  localOnly?: boolean;
  runGit?(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
}
const token = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const check = z.strictObject({
  id: token, name: z.string().trim().min(1).max(500), kind: z.enum(['build', 'test', 'behavior']),
  command: z.string().trim().min(1).max(16_384),
  criterionIds: z.array(token).min(1), required: z.boolean(), heavy: z.boolean(),
  testReport: z.strictObject({ format: z.enum(['vitest-json', 'node-tap']), path: z.string().min(1).max(2_000).optional(), minimumTests: z.number().int().positive(), maximumSkipped: z.number().int().nonnegative() }).optional(),
  timeoutMs: z.number().int().min(1).max(60 * 60_000),
}).superRefine((value, ctx) => {
  if (value.kind === 'test' && !value.testReport) ctx.addIssue({ code: 'custom', message: 'Test checks require a machine-readable execution-count parser.' });
});
const manifest = z.strictObject({
  version: z.literal(1), endpoint: z.enum(['local_commit', 'open_pr', 'merge_pr']),
  targetBranch: token.optional(), remote: token.optional(), mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(),
  allowPush: z.boolean().default(false), allowMerge: z.boolean().default(false), requireIndependentReview: z.boolean().default(true),
  holdConditions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]), holdIsEndpoint: z.boolean().default(false), checks: z.array(check).max(100),
}).superRefine((value, ctx) => {
  if (value.endpoint !== 'local_commit' && (!value.remote || !value.targetBranch || !value.allowPush)) ctx.addIssue({ code: 'custom', message: 'Remote delivery requires an explicit remote, target and push grant.' });
  if (value.endpoint === 'merge_pr' && !value.allowMerge) ctx.addIssue({ code: 'custom', message: 'Merge endpoint requires an explicit merge grant.' });
});
const roots = ['AGENTS.md', 'CLAUDE.md', '.vocs-code/INSTRUCTIONS.md'];
const MAX_INSTRUCTION_BYTES = 512 * 1024;
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
async function readOwned(root: string, name: string): Promise<string | undefined> {
  const file = path.resolve(root, name);
  if (!inside(root, file)) throw new Error('Project policy cannot read outside its project.');
  let stat;
  try { stat = await fs.lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, await fs.realpath(file))) throw new Error(`Project policy file is not an owned regular file: ${name}`);
  if (stat.size > MAX_INSTRUCTION_BYTES) throw new Error(`Project policy file exceeds the explicit 512 KiB limit: ${name}`);
  const text = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(text) > MAX_INSTRUCTION_BYTES) throw new Error(`Project policy file grew beyond its limit: ${name}`);
  return text;
}
const projectBuild = (name: 'typecheck' | 'build'): MissionCheck => ({ id: `project-${name}`, name: `Project ${name}`, kind: 'build', command: `npm run ${name}`, criterionIds: [`project-${name}`], required: true, heavy: true, timeoutMs: 30 * 60_000 });
const projectTest = (command: string, format: 'vitest-json' | 'node-tap'): MissionCheck => ({ id: 'project-test', name: 'Project tests', kind: 'test', command, criterionIds: ['project-test'], required: true, heavy: true, testReport: { format, minimumTests: 1, maximumSkipped: 0 }, timeoutMs: 30 * 60_000 });
const CONVENTIONAL = { typecheck: projectBuild('typecheck'), vitest: projectTest('npm --silent test -- --reporter=json', 'vitest-json'), nodeTest: projectTest('npm --silent test -- --test-reporter=tap', 'node-tap'), build: projectBuild('build') };
function conventionalChecks(scripts: Record<string, unknown>): MissionCheck[] {
  const checks: MissionCheck[] = [];
  for (const name of ['typecheck', 'test', 'build'] as const) {
    if (typeof scripts[name] !== 'string' || !(scripts[name] as string).trim()) continue;
    const script = scripts[name] as string;
    if (name === 'test') {
      if (/\bvitest\b/.test(script)) checks.push(structuredClone(CONVENTIONAL.vitest));
      else if (/\bnode\b.*(?:^|\s)--test(?:\s|$)/.test(script)) checks.push(structuredClone(CONVENTIONAL.nodeTest));
      continue;
    }
    checks.push(structuredClone(CONVENTIONAL[name]));
  }
  return checks;
}

/** A conventional npm gate needs the project's locked dependencies installed in its fresh
 * verification worktree; verification prepares them itself. Manifest checks arrange their own
 * setup, so only an exact conventional gate qualifies. */
export function isConventionalMissionCheck(check: MissionCheck): boolean {
  return Object.values(CONVENTIONAL).some((template) => isDeepStrictEqual(template, check));
}

/** Committed dependency inputs a fresh checkout needs before its npm scripts can run. Only files
 * in the inspected tree count; the original checkout's ignored node_modules never does. */
export interface MissionProjectDependencies {
  /** A committed npm lockfile, which `npm ci` reproduces exactly. */
  npmLockfile?: string;
  /** Another package manager's lockfile when no npm lockfile exists. */
  foreignLockfile?: { file: string; manager: string };
  /** package.json declares packages (or workspaces) that must be installed first. */
  declared: boolean;
}
const NPM_LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'];
const FOREIGN_LOCKFILES: ReadonlyArray<readonly [string, string]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'Yarn'], ['bun.lock', 'Bun'], ['bun.lockb', 'Bun']];
async function projectDependencies(root: string, manifest: unknown): Promise<MissionProjectDependencies> {
  const regular = async (name: string) => {
    try { const stat = await fs.lstat(path.join(root, name)); return stat.isFile() && !stat.isSymbolicLink(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
  };
  let npmLockfile: string | undefined, foreignLockfile: MissionProjectDependencies['foreignLockfile'];
  for (const name of NPM_LOCKFILES) if (!npmLockfile && await regular(name)) npmLockfile = name;
  if (!npmLockfile) for (const [file, manager] of FOREIGN_LOCKFILES) if (!foreignLockfile && await regular(file)) foreignLockfile = { file, manager };
  const value = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest as Record<string, unknown> : {};
  const listed = (entry: unknown) => !!entry && typeof entry === 'object' && Object.keys(entry).length > 0;
  const packages = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((key) => listed(value[key]));
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces.length > 0 : listed(value.workspaces);
  return { ...(npmLockfile ? { npmLockfile } : {}), ...(foreignLockfile ? { foreignLockfile } : {}), declared: packages || workspaces };
}
/** Reads the tree's own package.json and lockfiles (for verification, the isolated worktree). */
export async function inspectMissionProjectDependencies(root: string): Promise<MissionProjectDependencies> {
  const real = await fs.realpath(root);
  const text = await readOwned(real, 'package.json');
  return projectDependencies(real, text === undefined ? undefined : JSON.parse(text));
}
/** Why conventional npm gates cannot get their dependencies, as an actionable blocker. */
export function missionDependencySetupIssue(dependencies: MissionProjectDependencies): string | undefined {
  if (dependencies.npmLockfile || !dependencies.declared) return undefined;
  const manifest = 'add .vocs-code/mission-delivery.json with explicit setup and check commands';
  return dependencies.foreignLockfile
    ? `Project dependencies are locked by ${dependencies.foreignLockfile.manager} (${dependencies.foreignLockfile.file}). Mission prepares only a committed npm lockfile for its conventional checks; ${manifest}.`
    : `package.json declares dependencies but no npm lockfile (package-lock.json or npm-shrinkwrap.json) is committed, so the conventional checks cannot reproduce them in a fresh verification worktree. Commit a lockfile, or ${manifest}.`;
}
/** The optional manifest is a repository instruction, not an application-wide credential or grant.
 * Its command entries still pass the Mission execution/permission boundary before being run. */
export async function resolveMissionDeliveryPolicy(projectRoot: string, options: MissionPolicyOptions = {}): Promise<MissionDeliveryPolicy> {
  const root = await fs.realpath(projectRoot);
  const run = options.runGit ?? (async (cwd: string, args: string[]) => {
    // A configured remote name is not a safe network argument until its effective endpoint is
    // admitted. Keep this in the default process boundary, not the policy-parser test seam.
    if (args[0] === 'ls-remote') args = [...args.slice(0, 2), await readMissionRemoteEndpoint(cwd, args[2]), ...args.slice(3)];
    const result = await runMissionGit(cwd, args, { timeoutMs: 30_000 });
    return result.truncated || result.timedOut ? { code: 1, stdout: '', stderr: 'Git policy probe did not complete.' } : result;
  });
  const policy: MissionDeliveryPolicy = { endpoint: 'local_commit', allowPush: false, allowMerge: false, requireIndependentReview: true, holdConditions: [], holdIsEndpoint: false, checks: [], provenance: [], conflicts: [], fallback: true };
  const sources = new Map<string, string>();
  for (const name of roots) {
    const text = await readOwned(root, name);
    if (text !== undefined) sources.set(name, text);
  }
  // Follow local instruction links to the testing/release policy, but not arbitrary repository
  // documentation or external URLs. Missing referenced policy is visible, never silently omitted.
  for (const [name, text] of [...sources]) for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (!/(?:testing|releasing|verification|delivery)[^/]*\.md$/i.test(match[1]) || /^[a-z]+:/i.test(match[1])) continue;
    const relative = path.relative(root, path.resolve(root, path.dirname(name), match[1]));
    if (sources.has(relative)) continue;
    const body = await readOwned(root, relative);
    if (body === undefined) policy.conflicts.push(`Referenced project policy is missing: ${relative}`);
    else sources.set(relative, body);
  }
  for (const [name, text] of sources) policy.provenance.push({ source: `${name} (sha256:${createHash('sha256').update(text).digest('hex')})`, text });
  // Examples are not executable delivery instructions. Retain them in provenance, but never
  // mine fenced examples or an explicitly labelled example sentence for publishing authority.
  const prose = (value: string) => value.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '').split('\n').filter((line) => !/^\s*(?:example|for example|e\.g\.)\b/i.test(line)).join('\n');
  const primary = roots.map((name) => prose(sources.get(name) ?? '')).join('\n');
  const allInstructions = [...sources.values()].map(prose).join('\n');
  const prohibitions = [...primary.matchAll(/\b(?:do not|don't|must not|never)\s+(?:automatically\s+)?(?:push|publish|open|create|merge)\b[^.\n]*/gi)].map((m) => m[0]).filter((clause) => !/\b(?:until|before)\b.*\b(?:pass|passes|verification|verified|tests?|checks?)\b/i.test(clause));
  const noMerge = prohibitions.some((clause) => /\bmerge\b/i.test(clause));
  const noPublish = prohibitions.some((clause) => /\b(?:push|publish)\b|\b(?:open|create)\b.*\b(?:PR|pull request)\b/i.test(clause));
  const positive = prohibitions.reduce((body, clause) => body.replace(clause, ''), primary);
  const structured = await readOwned(root, '.vocs-code/mission-delivery.json');
  if (structured !== undefined) {
    let parsed: z.infer<typeof manifest>;
    try { parsed = manifest.parse(JSON.parse(structured)); } catch { throw new Error('Invalid .vocs-code/mission-delivery.json. Delivery is blocked until its version, checks and explicit grants are valid.'); }
    const { version: _version, ...resolved } = parsed;
    Object.assign(policy, resolved, { fallback: false });
    policy.provenance.push({ source: '.vocs-code/mission-delivery.json', text: structured });
  } else {
    const targets = new Set([...positive.matchAll(/\b(?:open|create)\s+(?:a\s+)?(?:pull request|PR)\s+(?:into|against|to)\s+`?([A-Za-z0-9][A-Za-z0-9._/-]*)`?/gi)].map((m) => m[1].replace(/\.$/, '')));
    const remoteRequired = /\b(?:open|create|deliver)\s+(?:a\s+)?(?:pull request|PR)\b/i.test(positive);
    if (targets.size > 1) policy.conflicts.push('Project instructions name conflicting pull-request targets.');
    if (remoteRequired) {
      policy.targetBranch = targets.size === 1 ? [...targets][0] : undefined;
      if (!policy.targetBranch) policy.conflicts.push('Project instructions require a pull request but do not unambiguously name its target.');
      const remotes = await run(root, ['remote']);
      const names = remotes.code === 0 ? remotes.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
      policy.remote = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : undefined;
      if (!policy.remote || !token.safeParse(policy.remote).success) policy.conflicts.push('Project instructions require publishing but no unambiguous configured Git remote is available.');
      policy.allowPush = true;
      policy.fallback = false;
      policy.allowMerge = /\bmerge\s+(?:the|your|that)\s+(?:PR|pull request)\s+(?:yourself|once|after|into)\b/i.test(primary) && !noMerge;
      policy.endpoint = policy.allowMerge ? 'merge_pr' : 'open_pr';
      if (/\bsquash[- ]merge/i.test(allInstructions)) policy.mergeMethod = 'squash';
    }
    let scripts: Record<string, unknown> = {}, packageValue: unknown;
    const packageText = await readOwned(root, 'package.json');
    if (packageText !== undefined) {
      try { const value = JSON.parse(packageText); packageValue = value; if (value && typeof value.scripts === 'object' && value.scripts !== null && !Array.isArray(value.scripts)) scripts = value.scripts; }
      catch { policy.conflicts.push('Project package.json cannot be read to resolve required checks.'); }
    }
    policy.checks = conventionalChecks(scripts);
    if (typeof scripts.test === 'string' && !policy.checks.some((c) => c.kind === 'test')) policy.conflicts.push('The project test runner needs an explicit execution-count parser in .vocs-code/mission-delivery.json; an exit code alone is not test execution evidence.');
    // Verification worktrees hold committed files only. The host installs a committed npm lockfile
    // for these gates; any other dependency setup is the project's to declare in a manifest.
    const setupIssue = policy.checks.length ? missionDependencySetupIssue(await projectDependencies(root, packageValue)) : undefined;
    if (setupIssue) policy.conflicts.push(setupIssue);
    policy.provenance.push({ source: 'Mission local convention', text: 'Present npm typecheck, test and build scripts are baseline gates. Before them, the host installs a committed npm lockfile with npm ci in each fresh verification worktree. No publishing rule means local commit only; the plan must add behavior-specific verification and substantive review.' });
  }
  // Conditional project holds are evaluated on captured paths, not the model's assertion that
  // a change is harmless. Conservatively require review for host/control-plane code where a
  // repository explicitly calls out permission/secrets changes. A manifest may be stricter.
  const reviewHoldAllowed = /\b(?:leave|keep)\s+(?:the\s+)?(?:PR|pull request)\s+open\s+for\s+review\b/i.test(primary);
  const sensitiveRule = /\b(?:permission gating|permissions? handling|secrets? handling|credentials? handling)\b/i.test(primary);
  const sensitivePaths = (options.changedPaths ?? []).filter((file) => {
    // Filename heuristics cannot prove code is unrelated to permissions or secrets. Unknown
    // source/configuration changes retain the documented review hold; only inert documentation
    // and raster assets are exempt, never instruction files that themselves carry authority.
    const normalized = file.replaceAll('\\', '/');
    return [...sources.keys()].some((source) => source.replaceAll('\\', '/').toLowerCase() === normalized.toLowerCase())
      || /(?:^|[\/_.-])(?:permissions?|secrets?|credentials?|auth|authentication|authorization|login|ipc|handlers)(?:[\/_.-]|$)/i.test(normalized)
      || /(?:^|\/)(?:AGENTS|CLAUDE|INSTRUCTIONS)\.md$/i.test(normalized) || normalized.startsWith('.vocs-code/')
      || !/\.(?:md|txt|png|jpe?g|webp|gif|ico)$/i.test(normalized);
  });
  if (reviewHoldAllowed && sensitiveRule) {
    if (structured === undefined) policy.holdIsEndpoint = true;
    if (sensitivePaths.length) policy.holdConditions.push('Repository policy requires human review when permission/secrets impact cannot be excluded from the captured change scope.');
  }
  if (policy.allowMerge && noMerge) policy.conflicts.push('The resolved merge grant contradicts a repository no-merge instruction.');
  if (policy.allowPush && noPublish) policy.conflicts.push('The resolved publishing grant contradicts a repository no-publish instruction.');
  if (!options.localOnly && policy.endpoint !== 'local_commit' && policy.targetBranch && policy.remote && token.safeParse(policy.targetBranch).success && token.safeParse(policy.remote).success) {
    const valid = await run(root, ['check-ref-format', '--branch', policy.targetBranch]);
    if (valid.code !== 0) policy.conflicts.push('The resolved target is not a valid Git branch.');
    else {
      const head = await run(root, ['ls-remote', '--refs', policy.remote, `refs/heads/${policy.targetBranch}`]);
      const matches = head.code === 0 ? head.stdout.split(/\r?\n/).filter((line) => line.split(/\s+/)[1] === `refs/heads/${policy.targetBranch}`).map((line) => line.split(/\s+/)[0]) : [];
      if (matches.length === 1 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(matches[0])) policy.targetHead = matches[0];
      else policy.conflicts.push('The actual remote target head could not be established; delivery must not guess it.');
    }
  }
  return policy;
}
