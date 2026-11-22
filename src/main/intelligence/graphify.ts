/**
 * Graphify as an optional graph provider (https://github.com/Graphify-Labs/graphify, Apache-2.0).
 *
 * Nothing here runs unless the user opted a project in and then asked for an index. What comes back
 * is derived evidence, never authority: a graph is a rebuildable picture of the code at one commit,
 * so every answer is served next to the health that says how far to trust it (missing, stale,
 * unreadable) and it ranks below the wiki, the project rules and the working tree.
 *
 * The build is AST-only (`extract --code-only` with every LLM backend switched off). The app
 * never runs install, hook, semantic or cloud commands, which could mutate instructions or send
 * project evidence off this machine.
 *
 * Queries read the produced `graph.json` directly rather than going through Graphify's MCP server or
 * a Python import. That keeps the engine out of the read path — a project that was indexed once
 * stays answerable when the tool is later uninstalled — and leaves one small parser to keep
 * defensive, because the node and link fields vary by release.
 *
 * The desktop keeps the cache in its own profile, keyed by checkout. A project cannot redirect
 * a rebuild to another checkout via links in its working tree.
 */
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphIndexStatus, GraphNode } from '../../shared/intelligence';
import { killTree, spawnTool } from '../harness/spawn';
import { errorMessage } from '../util/async';

/** Standalone/default path. The desktop supplies an app-owned cache root instead. */
export const GRAPHIFY_CACHE_DIR = '.vocs-code/graphify';
export const TESTED_GRAPHIFY_VERSION = '0.9.115';

export interface GraphScope {
  projectRoot: string;
  cwd: string;
}

export interface GraphifyRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface GraphifyDeps {
  /** Resolved executable, or null when Graphify is not installed. */
  command: () => string | null;
  /** Injected in tests. Default: spawn without a shell (`defaultGraphifyRun`). */
  run?: (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<GraphifyRunResult>;
  /** Current HEAD commit of a checkout, or null. Injected; default returns null. */
  headRevision?: (cwd: string) => Promise<string | null>;
  /** The owner controls what is being launched. Validate its reviewed release before indexing. */
  requireVersion?: string;
  /** App-private root; each project has its own hashed cache directory. */
  cacheRoot?: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Index wall-clock limit. Default 10 minutes. */
  timeoutMs?: number;
}

type MatchEdge = GraphEdge & { otherId: string; otherLabel: string; direction: 'out' | 'in' };

export interface GraphMatch {
  node: GraphNode;
  /** 0..1 */
  score: number;
  edges: MatchEdge[];
  why: string;
}

export interface GraphNeighborhood {
  node: GraphNode;
  edges: GraphMatch['edges'];
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** JSON.parse holds the whole file as one string; past this the load would stall the main process. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_NODES = 400_000;
/** Parsed graphs are large; a handful of projects is all one app session realistically queries. */
const MAX_CACHED_GRAPHS = 4;
const ERROR_TAIL_CHARS = 300;

const MAX_QUERY_TERMS = 8;
const DEFAULT_QUERY_LIMIT = 10;
const MAX_QUERY_LIMIT = 40;
const MATCH_EDGES = 6;
const DEFAULT_NEIGHBOR_LIMIT = 20;
const MAX_NEIGHBOR_LIMIT = 100;
const DEFAULT_TRACE_DEPTH = 6;
const MAX_TRACE_DEPTH = 10;

const LABEL_WEIGHT = 6;
const ID_WEIGHT = 4;
const FILE_WEIGHT = 2;

const NOT_INSTALLED = 'Graphify is not installed.';
const UNREADABLE = 'The Graphify artifact could not be read.';
const TOO_LARGE = 'The Graphify artifact is larger than 256 MB and was not loaded.';
const LINKED_CACHE = 'The Graphify cache folder is a link to somewhere else; remove it, then index again.';
const NO_ARTIFACT = 'Graphify finished without writing a graph.';

const isWin = process.platform === 'win32';

/* ------------------------------------------------------------------ */
/* Running the CLI                                                    */
/* ------------------------------------------------------------------ */

/** Keeps the end of a stream: when a build fails, the reason is in the last lines, not the first. */
function tailBuffer(): { push: (data: unknown) => void; text: () => string } {
  let chunks: Buffer[] = [];
  let bytes = 0;
  const compact = (): Buffer => {
    const all = Buffer.concat(chunks, bytes);
    const kept = all.subarray(Math.max(0, all.byteLength - MAX_OUTPUT_BYTES));
    chunks = [kept];
    bytes = kept.byteLength;
    return kept;
  };
  return {
    push(data) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES * 2) compact();
    },
    text: () => compact().toString('utf8')
  };
}

/**
 * Runs the CLI with no shell in between, so a checkout path with spaces or `&` reaches Graphify as
 * one argument. `spawnTool` is the repo's one place that knows how to launch a pip/npm `.cmd` shim
 * through cmd.exe with each argument quoted; it refuses an argument cmd.exe cannot carry safely
 * (a percent sign, a newline) instead of altering it, and that refusal lands here as a failed run.
 * Never rejects.
 */
export function defaultGraphifyRun(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<GraphifyRunResult> {
  return new Promise((resolve) => {
    const stdout = tailBuffer();
    const stderr = tailBuffer();
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (code: number | null, note?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (note) stderr.push(note);
      // A killed run's exit code describes the kill, not the build.
      resolve({ code: timedOut ? null : code, stdout: stdout.text(), stderr: stderr.text(), ...(timedOut ? { timedOut: true } : {}) });
    };
    let child: ChildProcess;
    try {
      child = spawnTool(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      settle(null, errorMessage(error));
      return;
    }
    child.stdout?.on('data', (data) => stdout.push(data));
    child.stderr?.on('data', (data) => stderr.push(data));
    child.on('error', (error) => settle(null, errorMessage(error)));
    child.on('close', (code) => settle(code));
    timer = setTimeout(() => {
      timedOut = true;
      const note = `\ntimed out after ${opts.timeoutMs} ms`;
      // On Windows this waits for `taskkill /T /F`, which is what reaches a shim's grandchild.
      void killTree(child)
        .catch(() => undefined)
        .then(() => {
          if (!isWin) {
            // SIGTERM is a request; a build that ignores it must not outlive its own timeout.
            const force = setTimeout(() => {
              try {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
              } catch {
                /* already gone */
              }
            }, 2000);
            force.unref();
          }
          // Grandchildren can hold the pipes open after the kill; settle rather than wait on `close`.
          settle(null, note);
        });
    }, opts.timeoutMs);
  });
}

/* ------------------------------------------------------------------ */
/* Reading graph.json                                                 */
/* ------------------------------------------------------------------ */

interface IndexedNode {
  node: GraphNode;
  /** Lowercased once at load so a query is three substring checks per node, not three allocations. */
  label: string;
  id: string;
  file: string;
  /** Indexes into `ParsedGraph.edges`, `extracted` first. */
  edges: number[];
}

interface ParsedGraph {
  version?: string;
  revision?: string;
  nodes: IndexedNode[];
  byId: Map<string, IndexedNode>;
  /** Ordered `extracted`, `inferred`, `ambiguous`; file order within each. */
  edges: GraphEdge[];
  /** Lowercased label → its node, or null when several nodes share it. Built on first use. */
  byLabel?: Map<string, IndexedNode | null>;
}

type Artifact = { file: string; mtimeMs: number; graph: ParsedGraph; error?: undefined } | { file: string; mtimeMs: number; graph?: undefined; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const CONFIDENCE_ORDER: Array<GraphEdge['confidence']> = ['extracted', 'inferred', 'ambiguous'];

function confidenceOf(value: unknown): GraphEdge['confidence'] {
  const known = typeof value === 'string' ? value.toLowerCase() : '';
  // An edge that does not say how it was found is the weakest kind, not the strongest.
  return known === 'extracted' || known === 'inferred' ? known : 'ambiguous';
}

/**
 * NetworkX node-link JSON into the two shapes queries need. Only the fields the contract names are
 * kept, so an artifact from a newer Graphify with extra fields still loads; a node without a string
 * id and an edge whose endpoint is unknown are dropped rather than failing the whole graph.
 * Returns null when the document is not a graph at all.
 */
function parseGraph(raw: unknown): ParsedGraph | null {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return null;
  const nodes: IndexedNode[] = [];
  const byId = new Map<string, IndexedNode>();
  for (const item of raw.nodes) {
    if (nodes.length >= MAX_NODES) break;
    if (!isRecord(item)) continue;
    const id = text(item.id);
    if (!id || byId.has(id)) continue;
    const node: GraphNode = { id, label: text(item.label) ?? id };
    const type = text(item.file_type);
    const file = text(item.source_file);
    const location = text(item.source_location);
    if (type) node.type = type;
    if (file) node.file = file;
    if (location) node.location = location;
    if (typeof item.community === 'number' && Number.isFinite(item.community)) node.community = item.community;
    const entry: IndexedNode = { node, label: node.label.toLowerCase(), id: id.toLowerCase(), file: (file ?? '').toLowerCase(), edges: [] };
    nodes.push(entry);
    byId.set(id, entry);
  }

  // Legacy artifacts name the list `edges`.
  const links = Array.isArray(raw.links) ? raw.links : Array.isArray(raw.edges) ? raw.edges : [];
  const byConfidence: Record<GraphEdge['confidence'], GraphEdge[]> = { extracted: [], inferred: [], ambiguous: [] };
  for (const item of links) {
    if (!isRecord(item)) continue;
    const from = text(item.source);
    const to = text(item.target);
    if (!from || !to || !byId.has(from) || !byId.has(to)) continue;
    const edge: GraphEdge = { from, to, relation: text(item.relation) ?? 'related', confidence: confidenceOf(item.confidence) };
    if (typeof item.confidence_score === 'number' && Number.isFinite(item.confidence_score)) edge.score = item.confidence_score;
    const file = text(item.source_file);
    if (file) edge.file = file;
    byConfidence[edge.confidence].push(edge);
  }
  // Sorting once here is what makes every adjacency list, and so every answer, extracted-first.
  const edges = CONFIDENCE_ORDER.flatMap((confidence) => byConfidence[confidence]);
  edges.forEach((edge, index) => {
    byId.get(edge.from)?.edges.push(index);
    if (edge.to !== edge.from) byId.get(edge.to)?.edges.push(index);
  });

  const meta = isRecord(raw.graph) ? raw.graph : {};
  const graph: ParsedGraph = { nodes, byId, edges };
  const version = text(meta.graphify_version);
  const revision = text(raw.built_at_commit);
  if (version) graph.version = version;
  if (revision) graph.revision = revision;
  return graph;
}

/** A short SHA matches the full one; anything under seven characters is too short to mean a commit. */
function sameRevision(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 7 && long.startsWith(short);
}

function queryTerms(query: string): string[] {
  const tokens = String(query ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length > 1))].slice(0, MAX_QUERY_TERMS);
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function edgesOf(graph: ParsedGraph, entry: IndexedNode, limit: number): MatchEdge[] {
  return entry.edges.slice(0, limit).map((index) => {
    const edge = graph.edges[index];
    const direction = edge.from === entry.node.id ? 'out' : 'in';
    const otherId = direction === 'out' ? edge.to : edge.from;
    return { ...edge, otherId, otherLabel: graph.byId.get(otherId)?.node.label ?? otherId, direction };
  });
}

/**
 * Exact id first, then a label only one node carries. A label shared by several nodes resolves to
 * nothing: picking one would answer a question about the wrong symbol, and `query` returns the ids
 * that disambiguate.
 */
function resolveNode(graph: ParsedGraph, ref: string): IndexedNode | null {
  if (typeof ref !== 'string') return null;
  const exact = graph.byId.get(ref) ?? graph.byId.get(ref.trim());
  if (exact) return exact;
  const label = ref.trim().toLowerCase();
  if (!label) return null;
  if (!graph.byLabel) {
    const byLabel = new Map<string, IndexedNode | null>();
    for (const entry of graph.nodes) byLabel.set(entry.label, byLabel.has(entry.label) ? null : entry);
    graph.byLabel = byLabel;
  }
  return graph.byLabel.get(label) ?? null;
}

/** Last lines of a failed run, without the colour codes a terminal tool prints. */
function outputTail(output: string): string {
  const clean = output
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .trim();
  return clean.length > ERROR_TAIL_CHARS ? `…${clean.slice(-ERROR_TAIL_CHARS)}` : clean;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

function rootKey(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return isWin ? resolved.toLowerCase() : resolved;
}

/* ------------------------------------------------------------------ */
/* Provider                                                           */
/* ------------------------------------------------------------------ */

/**
 * The engine needs the runtime search path and OS temp/dynamic loader environment, not the app's
 * providers, user config, Python startup overrides, proxy settings or session capabilities.
 */
export function graphifyEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|systemdrive|lang|lc_all|lc_ctype)$/i.test(key)) env[key] = value;
  }
  return { ...env, GRAPHIFY_BACKEND: 'none', PYTHONNOUSERSITE: '1' };
}

export class GraphifyProvider {
  readonly id = 'graphify';

  /** One build per project root; a second request joins the first instead of racing it on disk. */
  private readonly jobs = new Map<string, Promise<GraphIndexStatus>>();
  /** Why the last build of a project failed, kept until one succeeds or the cache is cleared. */
  private readonly failures = new Map<string, string>();
  /** Artifact path → what it parsed to at one mtime and size; insertion order is recency. */
  private readonly cache = new Map<string, { stamp: string; artifact: Artifact }>();
  private readonly loading = new Map<string, Promise<Artifact>>();

  constructor(private readonly deps: GraphifyDeps) {}

  /** Where this project's artifact lives: `<projectRoot>/.vocs-code/graphify/graphify-out/graph.json`. */
  artifactPath(scope: GraphScope): string {
    return path.join(this.cacheDir(scope), 'graphify-out', 'graph.json');
  }

  /** Health for the UI and for every query result. Never throws. `enabled` is the user's opt-in. */
  async status(scope: GraphScope, enabled: boolean): Promise<GraphIndexStatus> {
    const status: GraphIndexStatus = { provider: this.id, enabled, installed: false, indexed: false, indexing: false };
    try {
      const key = rootKey(scope.projectRoot);
      status.installed = this.command() !== null;
      status.indexing = this.jobs.has(key);
      const artifact = await this.load(scope);
      const graph = artifact?.graph;
      if (artifact && graph) {
        status.indexed = true;
        status.indexedAt = new Date(artifact.mtimeMs).toISOString();
        status.nodes = graph.nodes.length;
        status.edges = graph.edges.length;
        if (graph.version) status.version = graph.version;
        if (graph.revision) {
          status.revision = graph.revision;
          const head = await this.head(scope.cwd);
          // Without both commits there is nothing to compare, and "unknown" must not read as stale.
          if (head) status.stale = !sameRevision(head, graph.revision);
        }
      }
      // A failed build is the more useful thing to show: it explains why the artifact is old or absent.
      const error = this.failures.get(key) ?? artifact?.error;
      if (error) status.error = error;
    } catch (error) {
      this.deps.log('warn', `graphify status failed for ${scope.projectRoot}: ${errorMessage(error)}`);
      status.error = status.error ?? UNREADABLE;
    }
    return status;
  }

  /**
   * Builds or refreshes the index. A call made while one is running for the same project root gets
   * that run's promise. Never throws; a failure lands in `status.error`, and `indexed` still says
   * whether an earlier artifact is there to answer from.
   */
  index(scope: GraphScope): Promise<GraphIndexStatus> {
    const key = rootKey(scope.projectRoot);
    const running = this.jobs.get(key);
    if (running) return running;
    const job = (async (): Promise<GraphIndexStatus> => {
      let error: string | undefined;
      try {
        error = await this.build(scope);
      } catch (thrown) {
        error = `Graphify could not be started: ${outputTail(errorMessage(thrown))}`;
      } finally {
        this.jobs.delete(key);
      }
      // "Not installed" is a state the next status() re-derives; remembering it would outlive the install.
      if (error && error !== NOT_INSTALLED) {
        this.failures.set(key, error);
        this.deps.log('warn', `graphify index failed in ${scope.cwd}: ${error}`);
      } else if (!error) {
        this.failures.delete(key);
        this.deps.log('info', `graphify index updated in ${scope.cwd}`);
      }
      // Asking for an index is itself the opt-in.
      const status = await this.status(scope, true);
      return error && !status.error ? { ...status, error } : status;
    })();
    this.jobs.set(key, job);
    return job;
  }

  indexing(projectRoot: string): boolean {
    return this.jobs.has(rootKey(projectRoot));
  }

  /**
   * Lexical match over label, id and source file. Every term must hit somewhere in the node, so a
   * longer query narrows instead of widening. Returns [] when there is no usable artifact.
   */
  async query(scope: GraphScope, query: string, opts: { limit?: number } = {}): Promise<GraphMatch[]> {
    try {
      const terms = queryTerms(query);
      if (!terms.length) return [];
      const graph = await this.graph(scope);
      if (!graph) return [];
      const hits: Array<{ entry: IndexedNode; score: number; fields: number }> = [];
      for (const entry of graph.nodes) {
        let score = 0;
        let fields = 0;
        for (const term of terms) {
          let hit = 0;
          if (entry.label.includes(term)) {
            hit += LABEL_WEIGHT;
            fields |= 1;
          }
          if (entry.id.includes(term)) {
            hit += ID_WEIGHT;
            fields |= 2;
          }
          if (entry.file.includes(term)) {
            hit += FILE_WEIGHT;
            fields |= 4;
          }
          if (!hit) {
            score = 0;
            break;
          }
          score += hit;
        }
        if (score) hits.push({ entry, score, fields });
      }
      if (!hits.length) return [];
      // Equal text matches: the better-connected node is the more likely subject. The id keeps it stable.
      hits.sort((a, b) => b.score - a.score || b.entry.edges.length - a.entry.edges.length || (a.entry.node.id < b.entry.node.id ? -1 : 1));
      const top = hits[0].score;
      const quoted = terms.join(' ');
      return hits.slice(0, clampInt(opts.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT)).map(({ entry, score, fields }) => ({
        node: { ...entry.node },
        score: Math.round((score / top) * 1000) / 1000,
        edges: edgesOf(graph, entry, MATCH_EDGES),
        why: `matched "${quoted}" in ${['label', 'id', 'file'].filter((_, bit) => fields & (1 << bit)).join(', ')}`
      }));
    } catch (error) {
      this.deps.log('debug', `graphify query failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /** Node by exact id, else by a label exactly one node carries (case-insensitive); null otherwise. */
  async neighbors(scope: GraphScope, node: string, opts: { limit?: number } = {}): Promise<GraphNeighborhood | null> {
    try {
      const graph = await this.graph(scope);
      const entry = graph ? resolveNode(graph, node) : null;
      if (!graph || !entry) return null;
      return { node: { ...entry.node }, edges: edgesOf(graph, entry, clampInt(opts.limit, DEFAULT_NEIGHBOR_LIMIT, MAX_NEIGHBOR_LIMIT)) };
    } catch (error) {
      this.deps.log('debug', `graphify neighbors failed: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Shortest path between two nodes, ignoring edge direction: "how are these related" is the
   * question, and a caller and its callee are related whichever way the call points. Each edge keeps
   * its own `from`/`to`, so the direction is still readable in the answer.
   */
  async trace(scope: GraphScope, from: string, to: string, opts: { maxDepth?: number } = {}): Promise<GraphPath | null> {
    try {
      const graph = await this.graph(scope);
      if (!graph) return null;
      const start = resolveNode(graph, from);
      const end = resolveNode(graph, to);
      if (!start || !end) return null;
      if (start === end) return { nodes: [{ ...start.node }], edges: [] };
      const maxDepth = clampInt(opts.maxDepth, DEFAULT_TRACE_DEPTH, MAX_TRACE_DEPTH);
      const cameFrom = new Map<IndexedNode, { via: number; prev: IndexedNode }>();
      const seen = new Set<IndexedNode>([start]);
      let frontier = [start];
      for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
        const next: IndexedNode[] = [];
        for (const current of frontier) {
          for (const index of current.edges) {
            const edge = graph.edges[index];
            const other = graph.byId.get(edge.from === current.node.id ? edge.to : edge.from);
            if (!other || seen.has(other)) continue;
            seen.add(other);
            cameFrom.set(other, { via: index, prev: current });
            if (other === end) {
              const nodes: GraphNode[] = [];
              const edges: GraphEdge[] = [];
              for (let at: IndexedNode = end; at !== start; ) {
                const step = cameFrom.get(at) as { via: number; prev: IndexedNode };
                nodes.unshift({ ...at.node });
                edges.unshift({ ...graph.edges[step.via] });
                at = step.prev;
              }
              nodes.unshift({ ...start.node });
              return { nodes, edges };
            }
            next.push(other);
          }
        }
        frontier = next;
      }
      return null;
    } catch (error) {
      this.deps.log('debug', `graphify trace failed: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Deletes this project's cached artifact folder and nothing else. A build in progress is left
   * alone (it would only write the folder back), and a folder that turns out to be a link is
   * unlinked rather than followed, so clearing a cache can never empty the place it points at.
   */
  async clear(scope: GraphScope): Promise<boolean> {
    try {
      const key = rootKey(scope.projectRoot);
      if (this.jobs.has(key)) {
        this.deps.log('info', `graphify cache not cleared for ${scope.projectRoot}: an index is running`);
        return false;
      }
      const dir = this.cacheDir(scope);
      if ((await lstatOrNull(path.dirname(dir)))?.isSymbolicLink()) return false;
      this.forget(scope);
      this.failures.delete(key);
      const stat = await lstatOrNull(dir);
      if (!stat) return false;
      if (stat.isSymbolicLink()) await fs.unlink(dir).catch(() => fs.rmdir(dir));
      else await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (error) {
      this.deps.log('warn', `graphify cache could not be cleared for ${scope.projectRoot}: ${errorMessage(error)}`);
      return false;
    }
  }

  private cacheDir(scope: GraphScope): string {
    return this.deps.cacheRoot
      ? path.resolve(this.deps.cacheRoot, createHash('sha256').update(rootKey(scope.projectRoot)).digest('hex'))
      : path.resolve(scope.projectRoot, GRAPHIFY_CACHE_DIR);
  }

  private command(): string | null {
    try {
      return this.deps.command() || null;
    } catch (error) {
      this.deps.log('debug', `graphify lookup failed: ${errorMessage(error)}`);
      return null;
    }
  }

  private async head(cwd: string): Promise<string | null> {
    try {
      return (await this.deps.headRevision?.(cwd)) || null;
    } catch (error) {
      this.deps.log('debug', `graphify could not read HEAD in ${cwd}: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Returns why the build failed, or undefined when it produced an artifact. */
  private async build(scope: GraphScope): Promise<string | undefined> {
    const command = this.command();
    if (!command) return NOT_INSTALLED;
    // Absolute paths cannot be mistaken for a flag by the CLI's argument parser.
    const cwd = path.resolve(scope.cwd);
    const out = this.cacheDir(scope);
    // Do not let the engine follow a cache directory link, even if one was planted after opt-in.
    if ((await Promise.all([path.dirname(out), out, path.join(out, 'graphify-out')].map(lstatOrNull))).some((stat) => stat?.isSymbolicLink())) return LINKED_CACHE;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const run = this.deps.run ?? defaultGraphifyRun;
    const env = graphifyEnv(process.env);
    if (this.deps.requireVersion) {
      // Run the version probe away from the checkout, before allowing the process to read it.
      const version = await run(command, ['--version'], { cwd: path.dirname(process.execPath), env, timeoutMs: 10_000 });
      if (version.code !== 0 || version.stdout.trim() !== `graphify ${this.deps.requireVersion}`) {
        return `Unsupported Graphify release. Install graphifyy==${this.deps.requireVersion} and retry.`;
      }
    }
    await fs.mkdir(out, { recursive: true });
    this.deps.log('debug', `graphify index started in ${cwd}`);
    // `--code-only` plus no backend is the whole privacy guarantee: no flag here may enable an LLM,
    // and `extract` is the only subcommand, because `install` and `hook install` edit instruction files.
    // `.vocs-code/` holds this app's worktrees, wiki and this very cache: indexing it would graph
    // other branches' copies of the code and the index's own output.
    const result = await run(command, ['extract', cwd, '--code-only', '--exclude', '.vocs-code', '--out', out], { cwd, env, timeoutMs });
    // Same-millisecond rewrites of an equal-sized file would otherwise be served from memory.
    this.forget(scope);
    const tail = outputTail(result.stderr || result.stdout || '');
    if (result.timedOut) return `Graphify indexing timed out after ${Math.round(timeoutMs / 1000)} s.`;
    if (result.code === null) return `Graphify could not be started${tail ? `: ${tail}` : '.'}`;
    if (result.code !== 0) return `Graphify exited with code ${result.code}${tail ? `: ${tail}` : '.'}`;
    return (await this.locate(scope)) ? undefined : NO_ARTIFACT;
  }

  private forget(scope: GraphScope): void {
    const dir = this.cacheDir(scope);
    this.cache.delete(this.artifactPath(scope));
    this.cache.delete(path.join(dir, 'graph.json'));
  }

  /**
   * The artifact to read, newest layout first. Every step must be a real folder or file inside
   * `.vocs-code/graphify`: a link there (a repository can commit one) would have this read a file
   * that belongs to something else.
   */
  private async locate(scope: GraphScope): Promise<{ file: string; mtimeMs: number; size: number } | null> {
    const dir = this.cacheDir(scope);
    if (!(await lstatOrNull(path.dirname(dir)))?.isDirectory() || !(await lstatOrNull(dir))?.isDirectory()) return null;
    for (const folder of [path.join(dir, 'graphify-out'), dir]) {
      const file = path.join(folder, 'graph.json');
      const [folderStat, fileStat] = await Promise.all([lstatOrNull(folder), lstatOrNull(file)]);
      if (folderStat?.isDirectory() && fileStat?.isFile()) return { file, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
    }
    return null;
  }

  private async graph(scope: GraphScope): Promise<ParsedGraph | null> {
    return (await this.load(scope))?.graph ?? null;
  }

  /** Null when there is no artifact; otherwise the parsed graph or the reason it is unusable. */
  private async load(scope: GraphScope): Promise<Artifact | null> {
    const found = await this.locate(scope);
    if (!found) return null;
    const stamp = `${found.mtimeMs}:${found.size}`;
    const cached = this.cache.get(found.file);
    if (cached?.stamp === stamp) {
      this.cache.delete(found.file);
      this.cache.set(found.file, cached);
      return cached.artifact;
    }
    // Status and a query often arrive together; one parse of a large file serves both.
    const key = `${found.file}\u0000${stamp}`;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.read(found, stamp).finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return pending;
  }

  private async read(found: { file: string; mtimeMs: number; size: number }, stamp: string): Promise<Artifact> {
    const base = { file: found.file, mtimeMs: found.mtimeMs };
    let artifact: Artifact;
    if (found.size > MAX_ARTIFACT_BYTES) {
      artifact = { ...base, error: TOO_LARGE };
    } else {
      let raw: string;
      try {
        raw = await fs.readFile(found.file, 'utf8');
      } catch (error) {
        // Not remembered: a file that is busy now (Graphify is still writing it) may read fine next time.
        this.deps.log('debug', `graphify artifact unreadable at ${found.file}: ${errorMessage(error)}`);
        return { ...base, error: UNREADABLE };
      }
      let graph: ParsedGraph | null = null;
      try {
        graph = parseGraph(JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw));
      } catch (error) {
        this.deps.log('debug', `graphify artifact is not valid JSON at ${found.file}: ${errorMessage(error)}`);
      }
      artifact = graph ? { ...base, graph } : { ...base, error: UNREADABLE };
    }
    // The verdict on a broken file is remembered too, so it is not re-parsed on every status poll.
    this.cache.delete(found.file);
    this.cache.set(found.file, { stamp, artifact });
    while (this.cache.size > MAX_CACHED_GRAPHS) this.cache.delete(this.cache.keys().next().value as string);
    return artifact;
  }
}
