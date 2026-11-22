/** Graphify graph provider: local AST snapshot builds, revision-scoped cache reads and failure recovery. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { defaultGraphifyRun, graphifyEnv, GRAPHIFY_CACHE_DIR, GraphifyProvider, TESTED_GRAPHIFY_VERSION, type GraphifyDeps, type GraphifyRunResult, type GraphScope } from '../src/main/intelligence/graphify';

const FIXTURE = path.resolve('tests', 'fixtures', 'graphify', 'graph.json');
const FIXTURE_TEXT = fs.readFileSync(FIXTURE, 'utf8');
const REVISION = '3f9c2ab7d1e04c5a9b8f6e2d7c1a0b4e5f6a7b8c';
const UNREADABLE = 'The Graphify artifact could not be read.';

type RunOpts = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };
type RunCall = { command: string; args: string[]; opts: RunOpts };

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocs-graphify-'));
  temps.push(dir);
  return dir;
}

function project(name = 'repo'): GraphScope {
  const root = path.join(tempDir(), name);
  fs.mkdirSync(root, { recursive: true });
  return { projectRoot: root, cwd: root };
}

const cacheDir = (scope: GraphScope): string => path.join(scope.projectRoot, '.vocs-code', 'graphify');

function writeArtifact(scope: GraphScope, content: string = FIXTURE_TEXT, folder = 'graphify-out'): string {
  const dir = path.join(cacheDir(scope), folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'graph.json');
  fs.writeFileSync(file, content);
  return file;
}

/** What a real `graphify extract --out <dir>` leaves behind. */
function writeExtractOutput(args: string[], content: string = FIXTURE_TEXT): void {
  const out = path.join(args[args.indexOf('--out') + 1], 'graphify-out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'graph.json'), content);
}

const ok: GraphifyRunResult = { code: 0, stdout: 'done', stderr: '' };

function harness(deps: Partial<GraphifyDeps> = {}, behave: (call: RunCall) => GraphifyRunResult | Promise<GraphifyRunResult> = (call) => (writeExtractOutput(call.args), ok)) {
  const calls: RunCall[] = [];
  const logs: string[] = [];
  const provider = new GraphifyProvider({
    command: () => 'graphify',
    run: async (command, args, opts) => {
      const call = { command, args, opts };
      calls.push(call);
      return behave(call);
    },
    log: (level, message) => logs.push(`${level} ${message}`),
    ...deps
  });
  return { provider, calls, logs };
}

/** A provider over a project that already holds the fixture graph. */
function indexed(deps: Partial<GraphifyDeps> = {}) {
  const scope = project();
  writeArtifact(scope);
  return { scope, ...harness(deps) };
}

describe('GraphifyProvider health and indexing', () => {
  it('does not expose credentials, provider config or startup variables to the parser', () => {
    expect(graphifyEnv({ Path: 'safe-bin', SystemRoot: 'system', GRAPHIFY_BACKEND: 'cloud', HOME: 'profile', GH_TOKEN: 'secret', VOCS_MEMORY_GATEWAY_TOKEN: 'secret', PYTHONPATH: 'inject', HTTPS_PROXY: 'proxy' })).toEqual({
      Path: 'safe-bin', SystemRoot: 'system', GRAPHIFY_BACKEND: 'none', PYTHONNOUSERSITE: '1'
    });
  });

  it('will not give an unsupported Graphify release the checkout', async () => {
    const scope = project();
    const { provider, calls } = harness({ requireVersion: TESTED_GRAPHIFY_VERSION }, () => ({ ...ok, stdout: 'graphify 0.9.999' }));
    expect(await provider.index(scope)).toMatchObject({ indexed: false, error: expect.stringContaining(`graphifyy==${TESTED_GRAPHIFY_VERSION}`) });
    expect(calls.map((call) => call.args)).toEqual([['--version']]);
    expect(fs.existsSync(cacheDir(scope))).toBe(false);
  });

  it('automatically indexes one committed revision per checkout and preserves its prior cache on failure', async () => {
    const scope = project();
    const other = { ...scope, cwd: path.join(scope.cwd, 'linked-worktree') };
    const cacheRoot = path.join(tempDir(), 'private');
    let head = REVISION;
    const update = 'ab'.repeat(20);
    const extract = vi.fn((call: RunCall) => {
      if (call.args.includes('--version')) return { ...ok, stdout: `graphify ${TESTED_GRAPHIFY_VERSION}` };
      expect(call.args).toEqual(['-I', '-S', 'launch.py', 'extract', call.opts.cwd, '--code-only', '--exclude', '.vocs-code', '--out', expect.any(String)]);
      expect(call.opts.cwd).not.toBe(scope.cwd);
      const graph = JSON.parse(FIXTURE_TEXT);
      graph.nodes[0].source_file = path.join(call.opts.cwd, 'src', 'auth', 'login.ts');
      writeExtractOutput(call.args, head === update ? 'corrupt' : JSON.stringify(graph));
      return ok;
    });
    const snapshot = vi.fn(async (_checkout: string, _revision: string, dir: string) => fs.writeFileSync(path.join(dir, 'sample.ts'), 'export function handleLogin() {}'));
    const { provider } = harness({ cacheRoot, requireVersion: TESTED_GRAPHIFY_VERSION, commandArgs: ['-I', '-S', 'launch.py'], headRevision: async () => head, snapshot }, extract);
    const { signal } = new AbortController();
    expect(await provider.query(scope, 'handlelogin')).toEqual([]);
    expect(extract).not.toHaveBeenCalled();
    await provider.refresh(scope, signal);
    await provider.refresh(scope, signal);
    expect(snapshot.mock.calls.map(([cwd, commit]) => [cwd, commit])).toEqual([[scope.cwd, REVISION]]);
    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, revision: REVISION, stale: false });
    expect(await provider.query(scope, 'handlelogin')).toMatchObject([{ node: { file: 'src/auth/login.ts' } }]);
    expect(await provider.query(other, 'handlelogin')).toEqual([]);
    head = update;
    await provider.refresh(scope, signal);
    await provider.refresh(scope, signal);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, revision: REVISION, stale: true, error: expect.any(String) });
    expect(await provider.query(scope, 'handlelogin', { revision: update })).toEqual([]);
    expect(await provider.status(scope, false)).toMatchObject({ enabled: false, indexed: false });
    expect(fs.statSync(provider.artifactPath({ ...scope, cwd: scope.cwd })).isFile()).toBe(true);
  });

  it('discards a completed staging artifact if its desktop job was cancelled', async () => {
    const scope = project();
    const cacheRoot = path.join(tempDir(), 'private');
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const exit = new Promise<void>((resolve) => { finish = resolve; });
    const { provider } = harness({
      cacheRoot, requireVersion: TESTED_GRAPHIFY_VERSION, headRevision: async () => REVISION,
      snapshot: async (_checkout, _revision, dir) => fs.writeFileSync(path.join(dir, 'sample.ts'), 'export const symbol = 1;')
    }, async (call) => {
      if (call.args.includes('--version')) return { ...ok, stdout: `graphify ${TESTED_GRAPHIFY_VERSION}` };
      started();
      await exit;
      writeExtractOutput(call.args);
      return ok;
    });
    const job = provider.index(scope);
    await running;
    const cancel = provider.cancel();
    finish();
    await cancel;
    expect(await job).toMatchObject({ indexed: false, indexing: false });
    expect(await provider.query(scope, 'handlelogin')).toEqual([]);
  });

  // Optional real upstream CLI contract. The packaged path uses the isolated launcher instead.
  if (process.env.VOCS_CODE_GRAPHIFY_TEST_EXE) it('builds and queries the pinned CLI cache, then detects a changed revision', async () => {
    const scope = project('Graphify pilot & fixture');
    const cacheRoot = path.join(tempDir(), 'profile', 'graphs');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: scope.cwd, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(scope.cwd, 'pilot.ts'), 'export function pilotLoad() { return "fixture"; }\nexport function caller() { return pilotLoad(); }\n');
    git('add', 'pilot.ts');
    const commit = (message: string, ...args: string[]) => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message, ...args);
    commit('fixture');
    const provider = new GraphifyProvider({
      command: () => process.env.VOCS_CODE_GRAPHIFY_TEST_EXE ?? null,
      cacheRoot,
      requireVersion: TESTED_GRAPHIFY_VERSION,
      headRevision: async () => git('rev-parse', 'HEAD'),
      log: () => undefined
    });
    const indexed = await provider.index(scope);
    expect(indexed).toMatchObject({ indexed: true, version: TESTED_GRAPHIFY_VERSION, revision: git('rev-parse', 'HEAD'), stale: false });
    expect(indexed.error).toBeUndefined();
    expect(indexed.nodes).toBeGreaterThan(1);
    expect((await provider.query(scope, 'pilotload')).map((match) => match.node.label)).toContain('pilotLoad()');
    expect(provider.artifactPath(scope)).toContain(cacheRoot);
    expect(fs.existsSync(path.join(scope.cwd, '.vocs-code'))).toBe(false);
    commit('new revision', '--allow-empty');
    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, stale: true });
    expect(await provider.clear(scope)).toBe(true);
    expect(await provider.query(scope, 'pilotload')).toEqual([]);
  }, 30_000);

  it('exposes the cache location under the git-excluded app folder', () => {
    const scope = project();
    const { provider } = harness();
    expect(GRAPHIFY_CACHE_DIR).toBe('.vocs-code/graphify');
    expect(provider.id).toBe('graphify');
    expect(provider.artifactPath(scope)).toBe(path.join(scope.projectRoot, '.vocs-code', 'graphify', 'graphify-out', 'graph.json'));
  });

  it('reports a missing install, refuses to index without one, and answers nothing', async () => {
    const scope = project();
    const { provider, calls } = harness({ command: () => null });

    expect(await provider.status(scope, true)).toEqual({ provider: 'graphify', enabled: true, installed: false, indexed: false, indexing: false });
    expect(await provider.index(scope)).toEqual({ provider: 'graphify', enabled: true, installed: false, indexed: false, indexing: false, error: 'Graphify is not installed.' });
    expect(calls).toHaveLength(0);
    // Refusing leaves the project untouched: not even the cache folder is created.
    expect(fs.existsSync(path.join(scope.projectRoot, '.vocs-code'))).toBe(false);
    expect(await provider.query(scope, 'session')).toEqual([]);
    // Not being installed is a state, not a remembered failure.
    expect((await provider.status(scope, false)).error).toBeUndefined();
  });

  it('runs one AST-only extract with no LLM backend and reports the resulting index', async () => {
    const base = tempDir();
    const scope: GraphScope = { projectRoot: path.join(base, 'my proj & co'), cwd: path.join(base, 'work tree & co') };
    fs.mkdirSync(scope.projectRoot, { recursive: true });
    fs.mkdirSync(scope.cwd, { recursive: true });
    const { provider, calls } = harness();

    const result = await provider.index(scope);

    expect(calls).toHaveLength(1);
    const [{ command, args, opts }] = calls;
    expect(command).toBe('graphify');
    // The checkout path holds a space and `&` and still arrives as one argument; the cache stays
    // under the project root even when the checkout indexed is a different folder.
    expect(args).toEqual(['extract', scope.cwd, '--code-only', '--exclude', '.vocs-code', '--out', cacheDir(scope)]);
    expect(args[1]).toContain(' & ');
    expect(opts.cwd).toBe(scope.cwd);
    expect(opts.timeoutMs).toBe(10 * 60_000);
    expect(opts.env.GRAPHIFY_BACKEND).toBe('none');
    expect(opts.env.PATH ?? opts.env.Path).toBe(process.env.PATH ?? process.env.Path);
    // Nothing that could install hooks, write instruction files or switch a model on.
    const words = args.filter((arg) => arg !== scope.cwd && arg !== cacheDir(scope));
    expect(words).toEqual(['extract', '--code-only', '--exclude', '.vocs-code', '--out']);
    expect(words.some((arg) => /install|hook|backend|model|llm|force/i.test(arg))).toBe(false);

    const expected = {
      provider: 'graphify',
      enabled: true,
      installed: true,
      indexed: true,
      indexing: false,
      version: '0.9.115',
      revision: REVISION,
      indexedAt: new Date(fs.statSync(provider.artifactPath(scope)).mtimeMs).toISOString(),
      nodes: 14,
      edges: 16
    };
    expect(result).toEqual(expected);
    // `enabled` is the caller's opt-in, passed straight through.
    expect(await provider.status(scope, false)).toEqual({ ...expected, enabled: false });
  });

  it('shares one run between concurrent index calls for the same project', async () => {
    const scope = project();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, calls } = harness({}, async (call) => {
      await gate;
      writeExtractOutput(call.args);
      return ok;
    });

    const first = provider.index(scope);
    const second = provider.index(scope);
    expect(second).toBe(first);
    expect(provider.indexing(scope.projectRoot)).toBe(true);
    expect(await provider.status(scope, true)).toMatchObject({ indexing: true, indexed: false });

    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).toMatchObject({ indexed: true, indexing: false, nodes: 14 });
    expect(provider.indexing(scope.projectRoot)).toBe(false);

    // Once it has finished, the next request is a fresh run.
    await provider.index(scope);
    expect(calls).toHaveLength(2);
  });

  it('reports the end of stderr when a run fails and keeps answering from the earlier artifact', async () => {
    const scope = project();
    const stderr = `${'noise '.repeat(120)}Traceback: parser crashed on src/auth/login.ts`;
    let fail = false;
    const { provider, calls } = harness({}, (call) => {
      if (fail) return { code: 1, stdout: '', stderr };
      writeExtractOutput(call.args);
      return ok;
    });
    expect((await provider.index(scope)).error).toBeUndefined();

    fail = true;
    const failed = await provider.index(scope);
    expect(failed.error).toBe(`Graphify exited with code 1: …${stderr.slice(-300)}`);
    expect(failed.error).toContain('Traceback: parser crashed on src/auth/login.ts');
    expect(failed).toMatchObject({ indexed: true, nodes: 14, edges: 16, revision: REVISION });
    // The failure stays visible on later status reads, and the old graph still answers.
    expect((await provider.status(scope, true)).error).toBe(failed.error);
    expect((await provider.query(scope, 'session store')).map((match) => match.node.id)).toEqual(['auth_session_session_store']);

    fail = false;
    expect((await provider.index(scope)).error).toBeUndefined();
    expect((await provider.status(scope, true)).error).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it('reports a timeout as a timeout', async () => {
    const scope = project();
    const { provider, calls } = harness({ timeoutMs: 5000 }, () => ({ code: null, stdout: '', stderr: 'still parsing', timedOut: true }));

    const result = await provider.index(scope);

    expect(calls[0].opts.timeoutMs).toBe(5000);
    expect(result.error).toBe('Graphify indexing timed out after 5 s.');
    expect(result.indexed).toBe(false);
  });

  it('turns a run that throws, or exits cleanly without a graph, into a status error', async () => {
    const scope = project();
    const thrown = harness({}, () => { throw new Error('spawn EACCES'); });
    expect(await thrown.provider.index(scope)).toMatchObject({ indexed: false, indexing: false, error: 'Graphify could not be started: spawn EACCES' });

    const empty = harness({}, () => ok);
    expect(await empty.provider.index(scope)).toMatchObject({ indexed: false, error: 'Graphify finished without writing a graph.' });
  });

  it('treats a corrupt artifact as not indexed', async () => {
    for (const content of ['{"nodes": [', '{"hello": 1}', '[]', '']) {
      const scope = project();
      writeArtifact(scope, content);
      const { provider } = harness();

      expect(await provider.status(scope, true)).toEqual({ provider: 'graphify', enabled: true, installed: true, indexed: false, indexing: false, error: UNREADABLE });
      expect(await provider.query(scope, 'session')).toEqual([]);
      expect(await provider.neighbors(scope, 'auth_tokens_sign_token')).toBeNull();
      expect(await provider.trace(scope, 'auth_login_handle_login', 'db_pool_get_connection')).toBeNull();
    }
  });

  it('refuses an artifact over 256 MB without reading it', async () => {
    const scope = project();
    const artifact = writeArtifact(scope);
    const { provider } = harness();
    const realLstat = fs.promises.lstat.bind(fs.promises);
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike) => {
      const stat = await realLstat(target);
      if (String(target) === artifact) Object.defineProperty(stat, 'size', { value: 256 * 1024 * 1024 + 1 });
      return stat;
    }) as never);
    const readFile = vi.spyOn(fs.promises, 'readFile');
    try {
      expect(await provider.status(scope, true)).toMatchObject({ indexed: false, error: 'The Graphify artifact is larger than 256 MB and was not loaded.' });
      expect(await provider.query(scope, 'session')).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      lstat.mockRestore();
      readFile.mockRestore();
    }
    // The real file is small, so with the real size it loads.
    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, nodes: 14 });
  });

  it('flags the index stale only when HEAD is known and differs from the indexed commit', async () => {
    const stale = async (head: string | null): Promise<boolean | undefined> => {
      const { scope, provider } = indexed({ headRevision: async () => head });
      return (await provider.status(scope, true)).stale;
    };

    expect(await stale('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe(true);
    expect(await stale(REVISION)).toBe(false);
    expect(await stale(REVISION.toUpperCase())).toBe(false);
    expect(await stale(REVISION.slice(0, 7))).toBe(false);
    // Too short to identify a commit, so it is not accepted as a match.
    expect(await stale(REVISION.slice(0, 6))).toBe(true);
    expect(await stale(null)).toBeUndefined();

    // No HEAD lookup injected, a lookup that throws, and an artifact with no recorded commit.
    const plain = indexed();
    expect((await plain.provider.status(plain.scope, true)).stale).toBeUndefined();
    const throwing = indexed({ headRevision: async () => { throw new Error('not a git repository'); } });
    expect(await throwing.provider.status(throwing.scope, true)).toMatchObject({ indexed: true, revision: REVISION });
    expect((await throwing.provider.status(throwing.scope, true)).stale).toBeUndefined();
    const scope = project();
    const { built_at_commit: _dropped, ...withoutCommit } = JSON.parse(FIXTURE_TEXT);
    writeArtifact(scope, JSON.stringify(withoutCommit));
    const unknown = await harness({ headRevision: async () => REVISION }).provider.status(scope, true);
    expect(unknown.revision).toBeUndefined();
    expect(unknown.stale).toBeUndefined();
  });

  it('passes the checkout to the HEAD lookup', async () => {
    const scope = project();
    const cwd = path.join(scope.projectRoot, 'worktree');
    fs.mkdirSync(cwd);
    writeArtifact(scope);
    const headRevision = vi.fn(async (_cwd: string) => REVISION);
    await harness({ headRevision }).provider.status({ projectRoot: scope.projectRoot, cwd }, true);
    expect(headRevision).toHaveBeenCalledExactlyOnceWith(cwd, undefined);
  });

  it('clears the cache folder and only the cache folder', async () => {
    const { scope, provider } = indexed();
    const sibling = path.join(scope.projectRoot, '.vocs-code', 'keep.txt');
    fs.writeFileSync(sibling, 'not a cache');
    expect((await provider.status(scope, true)).indexed).toBe(true);

    expect(await provider.clear(scope)).toBe(true);
    expect(fs.existsSync(cacheDir(scope))).toBe(false);
    expect(fs.readFileSync(sibling, 'utf8')).toBe('not a cache');
    expect(await provider.status(scope, true)).toEqual({ provider: 'graphify', enabled: true, installed: true, indexed: false, indexing: false });
    expect(await provider.query(scope, 'session')).toEqual([]);
    expect(await provider.clear(scope)).toBe(false);
  });

  it('never reads or empties a cache folder that is a link to somewhere else', async () => {
    const scope = project();
    const elsewhere = path.join(tempDir(), 'other-project-cache');
    fs.mkdirSync(path.join(elsewhere, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'graphify-out', 'graph.json'), FIXTURE_TEXT);
    fs.mkdirSync(path.join(scope.projectRoot, '.vocs-code'), { recursive: true });
    fs.symlinkSync(elsewhere, cacheDir(scope), 'junction');
    const { provider, calls } = harness();

    expect((await provider.status(scope, true)).indexed).toBe(false);
    expect(await provider.query(scope, 'session')).toEqual([]);
    // Indexing would write through the link, so it is refused before anything runs.
    expect((await provider.index(scope)).error).toBe('The Graphify cache folder is a link to somewhere else; remove it, then index again.');
    expect(calls).toHaveLength(0);

    expect(await provider.clear(scope)).toBe(true);
    expect(fs.existsSync(cacheDir(scope))).toBe(false);
    expect(fs.readFileSync(path.join(elsewhere, 'graphify-out', 'graph.json'), 'utf8')).toBe(FIXTURE_TEXT);
  });

  it('never throws from a public method', async () => {
    const scope = project();
    writeArtifact(scope);
    const { provider } = harness({
      command: () => { throw new Error('PATH lookup exploded'); },
      log: () => { /* quiet */ }
    });

    expect(await provider.status(scope, true)).toMatchObject({ installed: false, indexed: true });
    expect((await provider.index(scope)).error).toBe('Graphify is not installed.');
    expect(await provider.query(scope, undefined as never)).toEqual([]);
    expect(await provider.query(scope, '  ! ? ')).toEqual([]);
    expect(await provider.neighbors(scope, undefined as never)).toBeNull();
    expect(await provider.trace(scope, '', '')).toBeNull();
    expect(await provider.clear({ projectRoot: path.join(scope.projectRoot, 'missing'), cwd: scope.cwd })).toBe(false);
  });
});

describe('GraphifyProvider queries', () => {
  it('requires every term to match and ranks a label hit above id and file hits', async () => {
    const { scope, provider } = indexed();

    // "store" appears in one node only; "session" alone matches four.
    const both = await provider.query(scope, 'Session, STORE!');
    expect(both.map((match) => match.node.id)).toEqual(['auth_session_session_store']);
    expect(both[0].score).toBe(1);
    expect(both[0].why).toBe('matched "session store" in label, id, file');
    expect(both[0].node).toEqual({ id: 'auth_session_session_store', label: 'SessionStore', type: 'code', file: 'src/auth/session.ts', location: 'L30', community: 0 });
    expect(await provider.query(scope, 'session invoice')).toEqual([]);
    // One-character tokens are dropped, so they neither match nor exclude.
    expect((await provider.query(scope, 'a session store')).map((match) => match.node.id)).toEqual(['auth_session_session_store']);

    const auth = await provider.query(scope, 'auth');
    expect(auth.map((match) => [match.node.id, match.score])).toEqual([
      // label + id + file
      ['docs_auth_md', 1],
      // id + file, most connected first, then by id
      ['auth_session_issue_session', 0.5],
      ['auth_login_handle_login', 0.5],
      ['auth_tokens_sign_token', 0.5],
      ['auth_login_validate_user', 0.5],
      ['auth_session_session_store', 0.5],
      ['auth_tokens_verify_token', 0.5],
      ['docs_auth_md_session_lifetime', 0.5],
      // file only
      ['concept_token_rotation', 0.167]
    ]);
    expect(auth[0].why).toBe('matched "auth" in label, id, file');
    expect(auth[1].why).toBe('matched "auth" in id, file');
    expect(auth[8].why).toBe('matched "auth" in file');
    expect(auth[0].node.type).toBe('document');
    expect(auth[8].node).toEqual({ id: 'concept_token_rotation', label: 'Token rotation', type: 'concept', file: 'docs/auth.md', community: 1 });

    expect((await provider.query(scope, 'auth', { limit: 3 })).map((match) => match.node.id)).toEqual(['docs_auth_md', 'auth_session_issue_session', 'auth_login_handle_login']);
    expect(await provider.query(scope, 'auth', { limit: 0 })).toHaveLength(1);
    expect(await provider.query(scope, 'auth', { limit: 500 })).toHaveLength(9);
  });

  it('attaches each match its edges, extracted first, with the other end and the direction', async () => {
    const { scope, provider } = indexed();

    const [match] = await provider.query(scope, 'issueSession');

    expect(match.node.id).toBe('auth_session_issue_session');
    expect(match.why).toBe('matched "issuesession" in label');
    // In the file the ambiguous edge comes first; it is served last.
    expect(match.edges).toEqual([
      { from: 'auth_login_handle_login', to: 'auth_session_issue_session', relation: 'calls', confidence: 'extracted', score: 1, file: 'src/auth/login.ts', otherId: 'auth_login_handle_login', otherLabel: 'handleLogin()', direction: 'in' },
      { from: 'auth_session_issue_session', to: 'auth_tokens_sign_token', relation: 'calls', confidence: 'extracted', score: 1, file: 'src/auth/session.ts', otherId: 'auth_tokens_sign_token', otherLabel: 'signToken()', direction: 'out' },
      { from: 'auth_session_issue_session', to: 'auth_session_session_store', relation: 'uses', confidence: 'extracted', score: 1, file: 'src/auth/session.ts', otherId: 'auth_session_session_store', otherLabel: 'SessionStore', direction: 'out' },
      { from: 'docs_auth_md_session_lifetime', to: 'auth_session_issue_session', relation: 'describes', confidence: 'inferred', score: 0.8, file: 'docs/auth.md', otherId: 'docs_auth_md_session_lifetime', otherLabel: 'Session lifetime', direction: 'in' },
      { from: 'auth_session_issue_session', to: 'util_log_log_event', relation: 'indirect_call', confidence: 'ambiguous', score: 0.3, file: 'src/auth/session.ts', otherId: 'util_log_log_event', otherLabel: 'logEvent()', direction: 'out' }
    ]);
  });

  it('finds a neighborhood by id or by label, and nothing for an unknown node', async () => {
    const { scope, provider } = indexed();

    const byId = await provider.neighbors(scope, 'auth_tokens_sign_token');
    expect(byId?.node).toEqual({ id: 'auth_tokens_sign_token', label: 'signToken()', type: 'code', file: 'src/auth/tokens.ts', location: 'L5', community: 1 });
    expect(byId?.edges.map((edge) => [edge.direction, edge.otherId, edge.otherLabel, edge.relation, edge.confidence])).toEqual([
      ['in', 'auth_session_issue_session', 'issueSession()', 'calls', 'extracted'],
      ['in', 'auth_tokens_verify_token', 'verifyToken()', 'indirect_call', 'inferred'],
      ['in', 'concept_token_rotation', 'Token rotation', 'related_to', 'ambiguous']
    ]);

    expect(await provider.neighbors(scope, '  SIGNTOKEN()  ')).toEqual(byId);
    expect((await provider.neighbors(scope, 'auth_tokens_sign_token', { limit: 1 }))?.edges).toHaveLength(1);
    expect(await provider.neighbors(scope, 'signToken')).toBeNull();
    expect(await provider.neighbors(scope, 'no_such_node')).toBeNull();
  });

  it('traces the shortest path regardless of edge direction', async () => {
    const { scope, provider } = indexed();

    // Two three-hop routes exist; the one made only of extracted edges is found first.
    const calls = await provider.trace(scope, 'auth_login_handle_login', 'db_pool_get_connection');
    expect(calls?.nodes.map((node) => node.id)).toEqual(['auth_login_handle_login', 'auth_login_validate_user', 'db_users_find_user', 'db_pool_get_connection']);
    expect(calls?.edges).toEqual([
      { from: 'auth_login_handle_login', to: 'auth_login_validate_user', relation: 'calls', confidence: 'extracted', score: 1, file: 'src/auth/login.ts' },
      { from: 'auth_login_validate_user', to: 'db_users_find_user', relation: 'calls', confidence: 'extracted', score: 1, file: 'src/auth/login.ts' },
      { from: 'db_users_find_user', to: 'db_pool_get_connection', relation: 'calls', confidence: 'extracted', score: 1, file: 'src/db/users.ts' }
    ]);

    // Resolved by label, and walked against the direction of the second edge.
    const related = await provider.trace(scope, 'Token rotation', 'issuesession()');
    expect(related?.nodes.map((node) => node.label)).toEqual(['Token rotation', 'signToken()', 'issueSession()']);
    expect(related?.edges.map((edge) => [edge.from, edge.to, edge.confidence])).toEqual([
      ['concept_token_rotation', 'auth_tokens_sign_token', 'ambiguous'],
      ['auth_session_issue_session', 'auth_tokens_sign_token', 'extracted']
    ]);

    expect(await provider.trace(scope, 'auth_login_handle_login', 'auth_login_handle_login')).toEqual({
      nodes: [{ id: 'auth_login_handle_login', label: 'handleLogin()', type: 'code', file: 'src/auth/login.ts', location: 'L12', community: 0 }],
      edges: []
    });
    // A disconnected island, a path longer than the depth allowed, and an unresolved end.
    expect(await provider.trace(scope, 'auth_login_handle_login', 'billing_invoice_render_invoice')).toBeNull();
    expect(await provider.trace(scope, 'auth_login_handle_login', 'db_pool_get_connection', { maxDepth: 2 })).toBeNull();
    expect((await provider.trace(scope, 'auth_login_handle_login', 'db_pool_get_connection', { maxDepth: 3 }))?.nodes).toHaveLength(4);
    expect(await provider.trace(scope, 'auth_login_handle_login', 'no_such_node')).toBeNull();
  });

  it('reads the legacy `edges` key like `links`', async () => {
    const scope = project();
    const { links, ...rest } = JSON.parse(FIXTURE_TEXT);
    writeArtifact(scope, JSON.stringify({ ...rest, edges: links }));
    const { provider } = harness();

    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, nodes: 14, edges: 16 });
    expect((await provider.neighbors(scope, 'billing_invoice_render_invoice'))?.edges.map((edge) => edge.otherId)).toEqual(['billing_invoice_format_total']);
  });

  it('falls back to a graph.json directly in the cache folder, preferring the current layout', async () => {
    const scope = project();
    const { nodes, ...rest } = JSON.parse(FIXTURE_TEXT);
    writeArtifact(scope, JSON.stringify({ ...rest, nodes: nodes.slice(0, 5) }), '.');
    const { provider } = harness();
    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, nodes: 5 });

    writeArtifact(scope);
    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, nodes: 14 });
  });

  it('skips malformed nodes and dangling links instead of failing the graph', async () => {
    const scope = project();
    const spokes = Array.from({ length: 9 }, (_, i) => ({ id: `spoke_${i + 1}`, label: `Spoke ${i + 1}`, file_type: 'code', source_file: 'wheel.py' }));
    writeArtifact(scope, JSON.stringify({
      directed: true,
      some_future_key: { anything: true },
      nodes: [
        { id: 'hub', label: 'Hub', file_type: 'code', source_file: 'wheel.py', community: 'not-a-number', brand_new_field: [1, 2] },
        ...spokes,
        { id: 'a_init', label: '__init__()' },
        { id: 'b_init', label: '__init__()' },
        { id: 'bare' },
        { label: 'no id' },
        { id: 42, label: 'numeric id' },
        { id: 'hub', label: 'Duplicate hub' },
        'junk',
        null
      ],
      links: [
        { source: 'hub', target: 'spoke_1', relation: 'calls', confidence: 'GUESSED' },
        { source: 'hub', target: 'spoke_2' },
        { source: 'hub', target: 'spoke_3', relation: 'calls', confidence: 'INFERRED', confidence_score: 'high' },
        ...spokes.slice(3).map((spoke) => ({ source: spoke.id, target: 'hub', relation: 'imports', confidence: 'EXTRACTED', confidence_score: 1 })),
        { source: 'hub', target: 'ghost', relation: 'calls', confidence: 'EXTRACTED' },
        { source: 1, target: 2 },
        'junk',
        null
      ]
    }));
    const { provider } = harness();

    expect(await provider.status(scope, true)).toEqual({
      provider: 'graphify',
      enabled: true,
      installed: true,
      indexed: true,
      indexing: false,
      indexedAt: new Date(fs.statSync(provider.artifactPath(scope)).mtimeMs).toISOString(),
      nodes: 13,
      edges: 9
    });

    const [hub] = await provider.query(scope, 'hub');
    expect(hub.node).toEqual({ id: 'hub', label: 'Hub', type: 'code', file: 'wheel.py' });
    // A match carries at most six edges; the neighborhood has them all.
    expect(hub.edges).toHaveLength(6);
    expect(hub.edges.every((edge) => edge.confidence === 'extracted' && edge.direction === 'in')).toBe(true);
    const all = await provider.neighbors(scope, 'hub');
    expect(all?.edges.map((edge) => [edge.otherId, edge.relation, edge.confidence, edge.score])).toEqual([
      ...spokes.slice(3).map((spoke) => [spoke.id, 'imports', 'extracted', 1]),
      ['spoke_3', 'calls', 'inferred', undefined],
      // An unknown or missing confidence is the weakest kind.
      ['spoke_1', 'calls', 'ambiguous', undefined],
      ['spoke_2', 'related', 'ambiguous', undefined]
    ]);

    // A label two nodes share resolves to neither; the id still does. A bare node is labelled by its id.
    expect(await provider.neighbors(scope, '__init__()')).toBeNull();
    expect((await provider.neighbors(scope, 'a_init'))?.node).toEqual({ id: 'a_init', label: '__init__()' });
    expect(await provider.neighbors(scope, 'bare')).toEqual({ node: { id: 'bare', label: 'bare' }, edges: [] });
  });

  it('loads at most 400 000 nodes and drops edges to the rest', async () => {
    const scope = project();
    const total = 400_003;
    const nodes = Array.from({ length: total }, (_, i) => `{"id":"n${i}"}`).join(',');
    writeArtifact(scope, `{"nodes":[${nodes}],"links":[{"source":"n0","target":"n1"},{"source":"n0","target":"n${total - 1}"}]}`);
    const { provider } = harness();

    expect(await provider.status(scope, true)).toMatchObject({ indexed: true, nodes: 400_000, edges: 1 });
    expect(await provider.neighbors(scope, `n${total - 1}`)).toBeNull();
    expect((await provider.neighbors(scope, 'n0'))?.edges.map((edge) => edge.otherId)).toEqual(['n1']);
  });

  it('parses an artifact once and again only after it changes', async () => {
    const { scope, provider } = indexed();
    const readFile = vi.spyOn(fs.promises, 'readFile');
    try {
      const [first, second] = await Promise.all([provider.query(scope, 'invoice'), provider.status(scope, true)]);
      expect(first.map((match) => match.node.id)).toEqual(['billing_invoice_render_invoice', 'billing_invoice_format_total']);
      expect(second.nodes).toBe(14);
      await provider.neighbors(scope, 'docs_auth_md');
      expect(readFile).toHaveBeenCalledTimes(1);

      const graph = JSON.parse(FIXTURE_TEXT);
      graph.nodes.push({ id: 'billing_invoice_send_invoice', label: 'sendInvoice()', file_type: 'code', source_file: 'src/billing/invoice.ts' });
      writeArtifact(scope, JSON.stringify(graph));
      expect((await provider.query(scope, 'invoice')).map((match) => match.node.id)).toEqual(['billing_invoice_render_invoice', 'billing_invoice_send_invoice', 'billing_invoice_format_total']);
      expect(readFile).toHaveBeenCalledTimes(2);
    } finally {
      readFile.mockRestore();
    }
  });
});

describe('defaultGraphifyRun', () => {
  const scripts = tempDir();
  const script = (name: string, source: string): string => {
    const file = path.join(scripts, name);
    fs.writeFileSync(file, source);
    return file;
  };

  it('spawns the real process without a shell, so the provider indexes a path holding a space and `&`', async () => {
    const extract = script('extract.mjs', [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'const args = process.argv.slice(2);',
      "const out = path.join(args[args.indexOf('--out') + 1], 'graphify-out');",
      'fs.mkdirSync(out, { recursive: true });',
      `fs.copyFileSync(${JSON.stringify(FIXTURE)}, path.join(out, 'graph.json'));`,
      'process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), backend: process.env.GRAPHIFY_BACKEND }));'
    ].join('\n'));
    const scope = project('real proj & co');
    let result: GraphifyRunResult | undefined;
    const provider = new GraphifyProvider({
      command: () => process.execPath,
      // Node needs the script ahead of Graphify's own argument list; everything else is the default runner.
      run: async (command, args, opts) => (result = await defaultGraphifyRun(command, [extract, ...args], opts)),
      log: () => { /* quiet */ }
    });

    const status = await provider.index(scope);

    expect(result?.code).toBe(0);
    expect(result?.stderr).toBe('');
    expect(result?.timedOut).toBeUndefined();
    const seen = JSON.parse(result?.stdout ?? '{}');
    expect(seen.args).toEqual(['extract', scope.cwd, '--code-only', '--exclude', '.vocs-code', '--out', cacheDir(scope)]);
    expect(fs.realpathSync.native(seen.cwd)).toBe(fs.realpathSync.native(scope.cwd));
    expect(seen.backend).toBe('none');
    expect(status).toMatchObject({ indexed: true, version: '0.9.115', revision: REVISION, nodes: 14, edges: 16 });
    expect(status.error).toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')('launches a .cmd shim with the same argument fidelity, and fails closed on what cmd.exe cannot carry', async () => {
    const echo = script('echo-args.mjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const shimDir = path.join(scripts, 'shim dir');
    fs.mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, 'graphify.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
    const args = ['extract', path.join(scripts, 'my proj & co'), '--code-only', '--out', path.join(scripts, 'my proj & co', '.vocs-code', 'graphify')];

    const result = await defaultGraphifyRun(shim, args, { cwd: scripts, env: process.env, timeoutMs: 60_000 });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);

    // A percent sign would be expanded by cmd.exe; the run is refused rather than altered.
    const refused = await defaultGraphifyRun(shim, ['extract', path.join(scripts, '100% real')], { cwd: scripts, env: process.env, timeoutMs: 60_000 });
    expect(refused.code).toBeNull();
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('percent signs');
  });

  it('captures the exit code and both streams of a failing run', async () => {
    const failing = script('fail.mjs', "process.stdout.write('partial'); process.stderr.write('bad things happened'); process.exitCode = 3;");

    expect(await defaultGraphifyRun(process.execPath, [failing], { cwd: scripts, env: process.env, timeoutMs: 60_000 })).toEqual({ code: 3, stdout: 'partial', stderr: 'bad things happened' });
  });

  it('keeps only the last 64 KB of output', async () => {
    const noisy = script('noisy.mjs', "process.stdout.write('a'.repeat(300 * 1024) + 'END');");

    const result = await defaultGraphifyRun(process.execPath, [noisy], { cwd: scripts, env: process.env, timeoutMs: 60_000 });

    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(64 * 1024);
    expect(result.stdout.endsWith('aaaEND')).toBe(true);
  });

  it('kills a run that outlives its timeout', async () => {
    const sleeper = script('sleep.mjs', "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);");
    const started = Date.now();

    const result = await defaultGraphifyRun(process.execPath, [sleeper], { cwd: scripts, env: process.env, timeoutMs: 2000 });

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('timed out after 2000 ms');
    expect(Date.now() - started).toBeLessThan(30_000);
    const pid = Number(result.stdout);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 10_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive()).toBe(false);
  });

  it('reports an executable that cannot be started instead of throwing', async () => {
    const result = await defaultGraphifyRun(path.join(scripts, 'no-such-graphify-binary'), ['extract'], { cwd: scripts, env: process.env, timeoutMs: 60_000 });

    expect(result.code).toBeNull();
    expect(result.timedOut).toBeUndefined();
    expect(result.stderr).toMatch(/ENOENT/);
  });
});
