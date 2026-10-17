/**
 * The local dictation engine: whisper.cpp's `whisper-server`, downloaded from the pinned release
 * into `<userData>/dictation` with every file's size and sha256 checked, started on loopback by
 * the first local clip and stopped after the idle timeout, a switch to the cloud engine, or quit —
 * so the model's GPU memory is held only while the user is actually dictating. A GPU build that
 * cannot start (no driver, out of memory) falls back to the CPU build, which is always installed
 * beside it. macOS has no official server binary, so there a Homebrew `whisper-server` is used.
 * No Electron imports.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  LOCAL_MODELS,
  WHISPER_BUILDS,
  WHISPER_RELEASE,
  localModel,
  localModelUrl,
  pickWhisperBuild,
  whisperBuildUrl,
  whisperBuildsFor,
  type DictationCompute,
  type DictationLocalStatus,
  type LocalModel,
  type LocalModelId,
  type WhisperBuild
} from '../../shared/dictation';
import { killTree, spawnTool } from '../harness/spawn';
import { freePort } from '../mcp/shared-server';
import { withProcessOwner } from '../process-context';
import type { Logger } from '../log';

export interface LocalConfig {
  model: LocalModelId;
  compute: DictationCompute;
  idleMinutes: number;
  language: string;
}

export interface WhisperLocalOptions {
  /** `<userData>/dictation`. */
  root: string;
  config: () => LocalConfig;
  log?: Logger;
  onStatus?: (status: DictationLocalStatus) => void;
  platform?: string;
  arch?: string;
  fetchImpl?: typeof fetch;
  /** The GPU the shipped GPU build can use; defaults to asking `nvidia-smi` on Windows x64. */
  probeGpu?: () => Promise<string | undefined>;
  /** A `whisper-server` already on this machine; defaults to PATH and Homebrew's prefixes on macOS. */
  findSystemServer?: () => Promise<string | undefined>;
  extract?: (archive: string, dest: string, cwd: string) => Promise<void>;
  /** Test seam: the pinned catalogs, so a test can serve files whose size and sha256 it knows. */
  builds?: readonly WhisperBuild[];
  models?: readonly LocalModel[];
  /** Test seam: starts the server process (defaults to spawning the binary). */
  spawnServer?: (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
  startupTimeoutMs?: number;
}

const SERVER_LABEL = 'Dictation (whisper.cpp)';
const INSTALLED_MARKER = '.vocs-installed';
const INFERENCE_TIMEOUT_MS = 180_000;
/** Whisper marks silence and noise with bracketed tags; they are not something the user said. */
const NON_SPEECH = /\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]|\((?:silence|music|noise)\)/gi;

interface RunPlan {
  key: string;
  bin: string;
  /** The Linux build's shared libraries live beside the binary. */
  binDir: string;
  /** The server runs in the models folder and is handed the bare file name (see launch). */
  modelDir: string;
  modelFile: string;
  compute: 'gpu' | 'cpu';
  fallback?: RunPlan;
}

const STOPPED = 'Dictation was stopped while the local server started.';
/** Antivirus scanning freshly unpacked DLLs holds them briefly; a rename then fails with these. */
const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      if (attempt >= 8 || !RENAME_RETRY.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
}

/** A file already on disk with the pinned size and sha256 (a verified archive kept from a failed unpack). */
async function fileMatches(file: string, bytes: number, sha256: string): Promise<boolean> {
  try {
    if ((await fs.stat(file)).size !== bytes) return false;
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex') === sha256;
  } catch {
    return false;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** whisper.cpp's transcript has one line per segment; dictation wants one run of prose. */
export function cleanLocalTranscript(text: string): string {
  return text.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Unpacks with the system `tar`: bsdtar on Windows 10+ reads zip, GNU tar reads the Linux tarballs.
 * Paths are passed relative to `cwd`, because Windows tar reads its arguments in the ANSI code page
 * and cannot open a profile folder named outside it (C:\Users\测试); the working directory itself is
 * set through the wide API and is fine.
 */
export function extractArchive(archive: string, dest: string, cwd = path.dirname(archive)): Promise<void> {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const from = path.relative(cwd, archive);
  const to = path.relative(cwd, dest);
  const args = archive.endsWith('.zip') ? ['-xf', from, '-C', to] : ['-xzf', from, '-C', to];
  return new Promise((resolve, reject) => {
    withProcessOwner({ label: 'Dictation download' }, () =>
      execFile(tar, args, { cwd, windowsHide: true, timeout: 10 * 60_000 }, (err, _out, stderr) => {
        if (err) reject(new Error(`Could not unpack ${path.basename(archive)}: ${String(stderr).trim() || err.message}`));
        else resolve();
      })
    );
  });
}

async function probeNvidia(): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        const name = err ? '' : String(out).split(/\r?\n/)[0]?.trim();
        resolve(name || undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function findOnPath(name: string, extra: string[] = []): Promise<string | undefined> {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extra].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** The server binary inside an unpacked release (the zips nest it under `Release/`). */
async function findServerBinary(dir: string, platform: string, depth = 3): Promise<string | undefined> {
  const name = platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const hit = entries.find((e) => e.isFile() && e.name === name);
  if (hit) return path.join(dir, hit.name);
  if (depth <= 0) return undefined;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findServerBinary(path.join(dir, e.name), platform, depth - 1);
    if (found) return found;
  }
  return undefined;
}

export class WhisperLocal {
  private readonly platform: string;
  private readonly arch: string;
  private readonly fetchImpl: typeof fetch;
  private readonly builds: readonly WhisperBuild[];
  private readonly models: readonly LocalModel[];
  private gpuProbe: Promise<string | undefined> | undefined;
  private systemProbe: Promise<string | undefined> | undefined;
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private runningKey: string | null = null;
  private runningCompute: 'gpu' | 'cpu' | undefined;
  /** The settings the running (or starting) server was started for. */
  private startedFor: Pick<LocalConfig, 'model' | 'compute'> | null = null;
  private starting: { key: string; promise: Promise<string> } | null = null;
  /** Starts and restarts run one at a time, so two composers asking at once cannot both spawn. */
  private serverQueue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  /** Bumped by every stop, so a start that was stopped midway does not go on to its fallback. */
  private generation = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private busy = 0;
  private installing: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private download: DictationLocalStatus['download'];
  private lastError: string | undefined;
  private outputTail: string[] = [];
  private statusSeq = 0;

  constructor(private readonly opts: WhisperLocalOptions) {
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.builds = opts.builds ?? WHISPER_BUILDS;
    this.models = opts.models ?? LOCAL_MODELS;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.opts.log?.(level, `dictation: ${message}`);
  }

  private gpu(): Promise<string | undefined> {
    // Only Windows x64 has a GPU build to run; elsewhere a probe would only cost a process spawn.
    if (!this.gpuProbe) this.gpuProbe = this.opts.probeGpu ? this.opts.probeGpu() : this.platform === 'win32' && this.arch === 'x64' ? probeNvidia() : Promise.resolve(undefined);
    return this.gpuProbe;
  }

  private systemServer(): Promise<string | undefined> {
    if (!this.systemProbe) {
      this.systemProbe = this.opts.findSystemServer
        ? this.opts.findSystemServer()
        : this.platform === 'darwin'
          ? findOnPath('whisper-server', ['/opt/homebrew/bin', '/usr/local/bin'])
          : Promise.resolve(undefined);
    }
    return this.systemProbe;
  }

  buildDir(build: WhisperBuild): string {
    return path.join(this.opts.root, 'bin', `${WHISPER_RELEASE}-${build.id}`);
  }

  modelPath(id: LocalModelId): string {
    return path.join(this.opts.root, 'models', `ggml-${id}.bin`);
  }

  private async buildInstalled(build: WhisperBuild): Promise<string | undefined> {
    const dir = this.buildDir(build);
    if (!(await isFile(path.join(dir, INSTALLED_MARKER)))) return undefined;
    return findServerBinary(dir, this.platform);
  }

  /** A model counts as downloaded only at its exact catalog size; it was hashed before it got that name. */
  private async modelInstalled(model: LocalModel): Promise<boolean> {
    try {
      return (await fs.stat(this.modelPath(model.id))).size === model.bytes;
    } catch {
      return false;
    }
  }

  private async chosenBuild(compute: DictationCompute): Promise<WhisperBuild | undefined> {
    return pickWhisperBuild(this.platform, this.arch, compute, !!(await this.gpu()), this.builds);
  }

  private cpuBuild(): WhisperBuild | undefined {
    return pickWhisperBuild(this.platform, this.arch, 'cpu', false, this.builds);
  }

  async status(): Promise<DictationLocalStatus> {
    const cfg = this.opts.config();
    const gpu = await this.gpu();
    const build = await this.chosenBuild(cfg.compute);
    const gpuBuild = whisperBuildsFor(this.platform, this.arch, this.builds).find((b) => b.compute === 'gpu');
    const systemServer = build ? undefined : await this.systemServer();
    const models: LocalModelId[] = [];
    for (const m of this.models) if (await this.modelInstalled(m)) models.push(m.id);
    const supported = !!build || !!systemServer;
    const detail = supported
      ? systemServer
        ? `Runs ${systemServer}.`
        : undefined
      : this.platform === 'darwin'
        ? 'Install whisper.cpp with Homebrew (brew install whisper-cpp); Vocs Code runs its whisper-server.'
        : `whisper.cpp publishes no build for ${this.platform}-${this.arch}.`;
    return {
      supported,
      ...(detail ? { detail } : {}),
      ...(gpu ? { gpu } : {}),
      ...(gpuBuild ? { gpuBuild: { label: gpuBuild.label, bytes: gpuBuild.bytes } } : {}),
      ...(build ? { build: { id: build.id, label: build.label, bytes: build.bytes, installed: !!(await this.buildInstalled(build)) } } : {}),
      ...(systemServer ? { systemServer } : {}),
      models,
      server: this.baseUrl ? 'ready' : this.starting ? 'starting' : 'stopped',
      ...(this.baseUrl && this.runningCompute ? { runningCompute: this.runningCompute } : {}),
      ...(this.download ? { download: { ...this.download } } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    };
  }

  emitStatus(): void {
    if (!this.opts.onStatus) return;
    // status() reads the disk, so two in flight can settle out of order; only the newest is pushed,
    // or a progress tick could land after "done" and leave the bar up.
    const seq = ++this.statusSeq;
    void this.status().then(
      (s) => {
        if (seq === this.statusSeq) this.opts.onStatus?.(s);
      },
      (e) => this.log('warn', `status failed: ${errorText(e)}`)
    );
  }

  /** Downloads whatever the saved settings still need: the build (plus the CPU fallback) and the model. */
  install(): Promise<void> {
    if (this.installing) return this.installing;
    const abort = new AbortController();
    this.abort = abort;
    this.lastError = undefined;
    const run = async () => {
      await this.sweepLeftovers();
      const cfg = this.opts.config();
      const model = localModel(cfg.model, this.models);
      if (!model) throw new Error(`Unknown dictation model ${cfg.model}.`);
      const build = await this.chosenBuild(cfg.compute);
      if (!build && !(await this.systemServer())) throw new Error((await this.status()).detail ?? 'Local dictation is not available on this machine.');
      if (build) {
        const builds = [build, ...(build.compute === 'gpu' ? [this.cpuBuild()].filter((b): b is WhisperBuild => !!b) : [])];
        for (const b of builds) if (!(await this.buildInstalled(b))) await this.installBuild(b, abort.signal);
      }
      if (!(await this.modelInstalled(model))) {
        await this.fetchVerified(localModelUrl(model), this.modelPath(model.id), model.bytes, model.sha256, `${model.label} model`, abort.signal);
      }
      this.log('info', `installed ${build?.id ?? 'system server'} + ${model.id}`);
    };
    this.emitStatus();
    const installing = run()
      .catch((e: unknown) => {
        this.lastError = abort.signal.aborted ? 'Download cancelled.' : errorText(e);
        this.log('warn', `install failed: ${this.lastError}`);
        throw new Error(this.lastError);
      })
      .finally(() => {
        this.installing = null;
        this.abort = null;
        this.download = undefined;
        this.emitStatus();
      });
    this.installing = installing;
    return installing;
  }

  cancelInstall(): void {
    this.abort?.abort();
  }

  /**
   * Partial downloads and half-unpacked builds from a run that crashed or was quit midway. Only
   * install() calls this, and installs never overlap, so nothing in use is swept.
   */
  private async sweepLeftovers(): Promise<void> {
    const sweep = async (dir: string, test: (name: string) => boolean) => {
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        if (test(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    };
    await sweep(path.join(this.opts.root, 'models'), (n) => n.endsWith('.part'));
    await sweep(path.join(this.opts.root, 'downloads'), (n) => n.endsWith('.part'));
    await sweep(path.join(this.opts.root, 'bin'), (n) => n.includes('.tmp-'));
  }

  async removeModel(id: LocalModelId): Promise<void> {
    if (this.runningKey?.endsWith(`|${id}`)) await this.stop();
    await fs.rm(this.modelPath(id), { force: true });
    this.emitStatus();
  }

  private async installBuild(build: WhisperBuild, signal: AbortSignal): Promise<void> {
    const downloads = path.join(this.opts.root, 'downloads');
    const archive = path.join(downloads, build.asset);
    // A verified archive survives a failed unpack, so a retry does not fetch 685 MB again.
    if (!(await fileMatches(archive, build.bytes, build.sha256))) {
      await this.fetchVerified(whisperBuildUrl(build), archive, build.bytes, build.sha256, `whisper.cpp ${build.label}`, signal);
    }
    const dir = this.buildDir(build);
    const staging = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      await fs.mkdir(staging, { recursive: true });
      await (this.opts.extract ?? extractArchive)(archive, staging, this.opts.root);
      if (!(await findServerBinary(staging, this.platform))) throw new Error(`${build.asset} has no whisper-server in it.`);
      await fs.writeFile(path.join(staging, INSTALLED_MARKER), JSON.stringify({ release: WHISPER_RELEASE, asset: build.asset, sha256: build.sha256 }));
      await fs.rm(dir, { recursive: true, force: true });
      await renameWithRetry(staging, dir);
    } catch (e) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
    await fs.rm(archive, { force: true }).catch(() => undefined);
  }

  /** Streams `url` to `dest` through a size and sha256 check; nothing gets the final name unless both pass. */
  private async fetchVerified(url: string, dest: string, bytes: number, sha256: string, item: string, signal: AbortSignal): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // One fixed name per file: an interrupted download is overwritten by the next, never left beside it.
    const part = `${dest}.part`;
    this.download = { item, received: 0, total: bytes };
    this.emitStatus();
    try {
      const res = await this.fetchImpl(url, { signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Downloading ${item} failed (${res.status}).`);
      const hash = createHash('sha256');
      let received = 0;
      let lastEmit = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, done) => {
          received += chunk.length;
          if (received > bytes) return done(new Error(`${item} is larger than the pinned ${bytes} bytes; the download was discarded.`));
          hash.update(chunk);
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            this.download = { item, received, total: bytes };
            this.emitStatus();
          }
          done(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), meter, createWriteStream(part), { signal });
      if (received !== bytes) throw new Error(`${item} download was cut short (${received} of ${bytes} bytes).`);
      const digest = hash.digest('hex');
      if (digest !== sha256) throw new Error(`${item} failed its checksum (sha256 ${digest.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…); the download was discarded.`);
      await renameWithRetry(part, dest);
    } catch (e) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  private async plan(cfg: LocalConfig): Promise<RunPlan> {
    const model = localModel(cfg.model, this.models);
    if (!model) throw new Error(`Unknown dictation model ${cfg.model}.`);
    if (!(await this.modelInstalled(model))) throw new Error(`The ${model.label} model is not downloaded yet. Download it under Settings → Voice, or switch dictation to Cloud.`);
    const modelPath = this.modelPath(model.id);
    const modelAt = { modelDir: path.dirname(modelPath), modelFile: path.basename(modelPath) };
    const build = await this.chosenBuild(cfg.compute);
    if (!build) {
      const system = await this.systemServer();
      if (!system) throw new Error((await this.status()).detail ?? 'Local dictation is not available on this machine.');
      const compute = cfg.compute === 'cpu' ? 'cpu' : 'gpu';
      return { key: `system:${compute}|${model.id}`, bin: system, binDir: path.dirname(system), ...modelAt, compute };
    }
    const bin = await this.buildInstalled(build);
    if (!bin) throw new Error(`whisper.cpp (${build.label}) is not downloaded yet. Download it under Settings → Voice.`);
    const primary: RunPlan = { key: `${build.id}|${model.id}`, bin, binDir: path.dirname(bin), ...modelAt, compute: build.compute };
    const cpu = build.compute === 'gpu' ? this.cpuBuild() : undefined;
    const cpuBin = cpu ? await this.buildInstalled(cpu) : undefined;
    if (cpu && cpuBin) primary.fallback = { key: primary.key, bin: cpuBin, binDir: path.dirname(cpuBin), ...modelAt, compute: 'cpu' };
    return primary;
  }

  /** The running server's URL, (re)starting it when the model or compute changed since it started. */
  private ensureServer(): Promise<string> {
    const run = this.serverQueue.then(() => this.ensureServerNow());
    this.serverQueue = run.catch(() => undefined);
    return run;
  }

  private async ensureServerNow(): Promise<string> {
    const cfg = this.opts.config();
    const plan = await this.plan(cfg);
    if (this.baseUrl && this.runningKey === plan.key) return this.baseUrl;
    if (this.child) await this.stop();
    this.startedFor = { model: cfg.model, compute: cfg.compute };
    const promise = this.startWithFallback(plan, this.generation);
    this.starting = { key: plan.key, promise };
    this.emitStatus();
    try {
      return await promise;
    } finally {
      if (this.starting?.promise === promise) this.starting = null;
      this.emitStatus();
    }
  }

  /** `generation` is the stop count the start began under; a stop since then cancels it and its fallback. */
  private async startWithFallback(plan: RunPlan, generation: number): Promise<string> {
    this.lastError = undefined;
    try {
      return await this.launch(plan, generation);
    } catch (e) {
      if (!plan.fallback || generation !== this.generation) {
        if (generation === this.generation) this.lastError = errorText(e);
        throw e;
      }
      this.log('warn', `GPU build did not start (${errorText(e)}); falling back to the CPU build`);
      try {
        const url = await this.launch(plan.fallback, generation);
        this.lastError = `The GPU build did not start, so dictation runs on the CPU: ${errorText(e)}`;
        return url;
      } catch (fallbackError) {
        if (generation === this.generation) this.lastError = errorText(fallbackError);
        throw fallbackError;
      }
    }
  }

  private async healthy(url: string): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }

  private async launch(plan: RunPlan, generation: number): Promise<string> {
    const port = await freePort();
    if (generation !== this.generation) throw new Error(STOPPED);
    const threads = Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1));
    // The model goes by its bare (ASCII) file name, with the server running in the models folder:
    // the Windows build reads argv in the ANSI code page and cannot open C:\Users\José\…\ggml-*.bin.
    const args = ['-m', plan.modelFile, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), ...(plan.compute === 'cpu' ? ['-ng'] : [])];
    const env = this.platform === 'linux' ? { ...process.env, LD_LIBRARY_PATH: [plan.binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : process.env;
    this.outputTail = [];
    const child = withProcessOwner({ label: SERVER_LABEL }, () =>
      this.opts.spawnServer ? this.opts.spawnServer(plan.bin, args, { cwd: plan.modelDir, env }) : spawnTool(plan.bin, args, { cwd: plan.modelDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    );
    this.child = child;
    const remember = (d: Buffer) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) this.outputTail.push(line.trim());
      if (this.outputTail.length > 12) this.outputTail.splice(0, this.outputTail.length - 12);
    };
    child.stdout?.on('data', remember);
    child.stderr?.on('data', remember);
    const state: { exited: string | null } = { exited: null };
    child.on('error', (e) => {
      state.exited = `could not start: ${e.message}`;
    });
    child.on('exit', (code, signal) => {
      state.exited = `exited with ${code ?? signal}`;
      if (this.child !== child) return;
      this.child = null;
      this.baseUrl = null;
      this.runningKey = null;
      this.runningCompute = undefined;
      this.clearIdle();
      if (!this.stopping) {
        this.log('warn', `server ${state.exited}`);
        this.emitStatus();
      }
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (this.opts.startupTimeoutMs ?? 120_000);
    const current = () => generation === this.generation && this.child === child;
    while (Date.now() < deadline && !state.exited && current()) {
      if ((await this.healthy(url)) && current()) {
        this.baseUrl = url;
        this.runningKey = plan.key;
        this.runningCompute = plan.compute;
        this.log('info', `server ready on ${url} (${plan.compute}, ${plan.modelFile})`);
        return url;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    // Every way out kills this child: a start that lost to a stop must not leave a server holding the GPU.
    const stopped = generation !== this.generation;
    const tail = this.outputTail.slice(-3).join(' · ');
    if (this.child === child) this.child = null;
    await killTree(child);
    if (stopped) throw new Error(STOPPED);
    throw new Error(`The local whisper server ${state.exited ?? 'did not become ready in time'}${tail ? ` (${tail})` : ''}.`);
  }

  async transcribe(wav: Buffer): Promise<string> {
    const cfg = this.opts.config();
    this.clearIdle();
    this.busy++;
    try {
      const url = await this.ensureServer();
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      // English-only models ignore anything else; the multilingual ones detect when told `auto`.
      form.append('language', cfg.model.endsWith('.en') ? 'en' : cfg.language || 'auto');
      const res = await this.fetchImpl(`${url}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS) });
      const body = await res.text();
      let json: { text?: unknown; error?: unknown } | null = null;
      try {
        json = JSON.parse(body) as { text?: unknown; error?: unknown };
      } catch {
        /* not JSON */
      }
      if (!res.ok || typeof json?.text !== 'string') {
        const detail = typeof json?.error === 'string' ? json.error : body.slice(0, 200);
        throw new Error(`The local whisper server could not transcribe the clip (${res.status})${detail ? `: ${detail}` : ''}.`);
      }
      return cleanLocalTranscript(json.text);
    } finally {
      this.busy--;
      this.armIdle(cfg.idleMinutes);
    }
  }

  private armIdle(minutes: number): void {
    this.clearIdle();
    if (!this.child) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy) return;
      this.log('info', `server idle for ${minutes} min; stopping it`);
      void this.stop();
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** What the running or starting server was started for, so a settings change can tell whether it still fits. */
  get activeConfig(): Pick<LocalConfig, 'model' | 'compute'> | null {
    return this.child || this.starting ? this.startedFor : null;
  }

  async stop(): Promise<void> {
    // A start in flight sees the new generation, kills its own child and gives up; nobody may join it.
    this.generation++;
    this.starting = null;
    this.clearIdle();
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    this.runningKey = null;
    this.runningCompute = undefined;
    if (!child) return;
    this.stopping = true;
    try {
      await killTree(child);
      this.log('info', 'server stopped');
    } finally {
      this.stopping = false;
      this.emitStatus();
    }
  }

  async dispose(): Promise<void> {
    this.cancelInstall();
    // Let the cancelled download remove its .part file before the app exits.
    await this.installing?.catch(() => undefined);
    await this.stop();
  }
}
