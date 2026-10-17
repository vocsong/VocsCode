/**
 * The local whisper.cpp engine with everything real except the bytes: downloads stream through the
 * actual size and sha256 checks into a temp `<userData>/dictation`, and the "server" is a real
 * child process answering whisper-server's /health and /inference on the port it is given. Covers
 * the guarantees a user relies on: a tampered or oversized download never gets installed, the
 * server starts once and is reused, it stops when idle (freeing the GPU), and a GPU build that
 * cannot start falls back to the CPU build.
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WhisperLocal, cleanLocalTranscript, type LocalConfig } from '../src/main/dictation/local';
import type { DictationLocalStatus, LocalModel, WhisperBuild } from '../src/shared/dictation';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const archive = Buffer.from('pretend whisper.cpp release archive');
const gpuArchive = Buffer.from('pretend CUDA release archive, larger');
const modelBytes = Buffer.alloc(4096, 7);

const cpu: WhisperBuild = { id: 'test-cpu', platform: 'win32', arch: 'x64', compute: 'cpu', label: 'CPU', asset: 'cpu.zip', bytes: archive.length, sha256: sha(archive) };
const gpu: WhisperBuild = { id: 'test-cuda', platform: 'win32', arch: 'x64', compute: 'gpu', label: 'NVIDIA GPU', asset: 'cuda.zip', bytes: gpuArchive.length, sha256: sha(gpuArchive) };
const model: LocalModel = { id: 'base.en', label: 'Base, English', bytes: modelBytes.length, sha256: sha(modelBytes), hint: '' };

/** whisper-server's surface, enough for the client: /health, then /inference echoing what it got. */
const FAKE_SERVER = `
import http from 'node:http';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
if (process.env.FAKE_WHISPER_CRASH === '1') { console.error('ggml_cuda_init: no CUDA-capable device is detected'); process.exit(3); }
// Like the real server while it loads a model: /health answers 503 until it is ready.
const readyAt = Date.now() + Number(process.env.FAKE_WHISPER_LOAD_MS || 0);
http.createServer((req, res) => {
  if (req.url === '/health') {
    if (Date.now() < readyAt) { res.writeHead(503); res.end('{"status":"loading model"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
  }
  if (req.url === '/inference' && req.method === 'POST') {
    let body = '';
    req.setEncoding('latin1');
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const language = /name="language"\\r\\n\\r\\n([^\\r]*)/.exec(body)?.[1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: ' heard ' + (body.includes('RIFF') ? 'a wav' : 'nothing') + ' in ' + language + '\\n [BLANK_AUDIO]\\n done' }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
`;

let root: string;
let script: string;
let config: LocalConfig;
let served: Record<string, Buffer>;
let spawned: { bin: string; args: string[]; cwd: string; child: ChildProcess }[];
let downloads: string[];
let engines: WhisperLocal[];
let pushed: DictationLocalStatus[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-dictation-'));
  script = path.join(root, 'fake-whisper-server.mjs');
  await fs.writeFile(script, FAKE_SERVER);
  config = { model: 'base.en', compute: 'auto', idleMinutes: 5, language: '' };
  served = {
    'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/cpu.zip': archive,
    'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/cuda.zip': gpuArchive,
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin': modelBytes
  };
  spawned = [];
  downloads = [];
  engines = [];
  pushed = [];
});

afterEach(async () => {
  for (const e of engines) await e.dispose();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function engine(opts: { gpu?: string; builds?: WhisperBuild[]; loadMs?: number; extract?: (archive: string, dest: string) => Promise<void> } = {}): WhisperLocal {
  const local = new WhisperLocal({
    root: path.join(root, 'dictation'),
    config: () => config,
    platform: 'win32',
    arch: 'x64',
    builds: opts.builds ?? [cpu],
    models: [model],
    probeGpu: async () => opts.gpu,
    onStatus: (s) => pushed.push(s),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url in served) {
        downloads.push(path.basename(url));
        return new Response(new Uint8Array(served[url]), { status: 200 });
      }
      if (url.startsWith('https://')) return new Response('not found', { status: 404 });
      return fetch(input, init);
    }) as typeof fetch,
    // The archive's contents do not matter: unpacking leaves a whisper-server binary under Release/.
    extract:
      opts.extract ??
      (async (_archive, dest) => {
        await fs.mkdir(path.join(dest, 'Release'), { recursive: true });
        await fs.writeFile(path.join(dest, 'Release', 'whisper-server.exe'), 'binary');
      }),
    spawnServer: (bin, args, { cwd, env }) => {
      const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...env, FAKE_WHISPER_CRASH: bin.includes('test-cuda') ? '1' : '', FAKE_WHISPER_LOAD_MS: String(opts.loadMs ?? 0) }, stdio: ['ignore', 'pipe', 'pipe'] });
      spawned.push({ bin, args, cwd, child });
      return child;
    },
    startupTimeoutMs: 20_000
  });
  engines.push(local);
  return local;
}

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64, 3)]);

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  await walk(dir);
  return out.sort();
}

describe('local dictation engine', () => {
  it('installs nothing when a download fails its checksum, and leaves no partial file behind', async () => {
    served['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'] = Buffer.alloc(modelBytes.length, 8);
    const local = engine();
    await expect(local.install()).rejects.toThrow(/Base, English model failed its checksum/);
    const status = await local.status();
    expect(status.models).toEqual([]);
    expect(status.error).toMatch(/failed its checksum/);
    // The build passed and is installed; the bad model left nothing, not even its .part file.
    expect(await filesUnder(path.join(root, 'dictation', 'models'))).toEqual([]);
  });

  it('refuses a download larger than its pinned size', async () => {
    served['https://github.com/ggml-org/whisper.cpp/releases/download/b5454/cpu.zip'] = Buffer.concat([archive, Buffer.from('extra')]);
    const local = engine();
    await expect(local.install()).rejects.toThrow(/larger than the pinned/);
    expect((await local.status()).build?.installed).toBe(false);
    expect(await filesUnder(path.join(root, 'dictation'))).toEqual([]);
  });

  it('says what is missing instead of starting anything before the download', async () => {
    const local = engine();
    await expect(local.transcribe(wav)).rejects.toThrow('The Base, English model is not downloaded yet.');
    expect(spawned).toHaveLength(0);
  });

  it('installs the build and model, then starts one server for every clip and stops it on demand', async () => {
    const local = engine();
    await local.install();
    // The settings page follows the pushes, so the last one must say "installed", not a stale progress tick.
    await expect.poll(() => pushed.at(-1)).toMatchObject({ build: { installed: true }, models: ['base.en'] });
    expect(pushed.at(-1)?.download).toBeUndefined();
    const ready = await local.status();
    expect(ready.build).toMatchObject({ id: 'test-cpu', installed: true });
    expect(ready.models).toEqual(['base.en']);
    expect(ready.server).toBe('stopped');
    // The archive is deleted once unpacked; the binary and the model are what stay.
    expect(await filesUnder(path.join(root, 'dictation'))).toEqual([
      path.join('bin', 'b5454-test-cpu', '.vocs-installed'),
      path.join('bin', 'b5454-test-cpu', 'Release', 'whisper-server.exe'),
      path.join('models', 'ggml-base.en.bin')
    ]);

    // An English-only model is always asked for English; the segments become one line of prose.
    expect(await local.transcribe(wav)).toBe('heard a wav in en done');
    expect(await local.transcribe(wav)).toBe('heard a wav in en done');
    expect(spawned).toHaveLength(1);
    const args = spawned[0].args;
    // The bare file name, run from the models folder: Windows whisper-server cannot open a non-ASCII path.
    expect(args.slice(0, 2)).toEqual(['-m', 'ggml-base.en.bin']);
    expect(spawned[0].cwd).toBe(path.join(root, 'dictation', 'models'));
    expect(args).toContain('-ng');
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect((await local.status())).toMatchObject({ server: 'ready', runningCompute: 'cpu' });

    await local.stop();
    expect((await local.status()).server).toBe('stopped');
    expect(local.activeConfig).toBeNull();
  }, 60_000);

  it('stops the server by itself after the idle timeout', async () => {
    const local = engine();
    await local.install();
    config = { ...config, idleMinutes: 0.01 }; // 600 ms
    await local.transcribe(wav);
    expect((await local.status()).server).toBe('ready');
    await expect.poll(async () => (await local.status()).server, { timeout: 10_000 }).toBe('stopped');
  }, 60_000);

  it('falls back to the CPU build when the GPU build cannot start, and says so', async () => {
    const local = engine({ gpu: 'NVIDIA GeForce RTX 4070 SUPER', builds: [cpu, gpu] });
    const before = await local.status();
    expect(before.gpu).toBe('NVIDIA GeForce RTX 4070 SUPER');
    expect(before.build).toMatchObject({ id: 'test-cuda', installed: false });
    await local.install();
    // The CPU build rides along with the GPU one as the fallback.
    expect(await filesUnder(path.join(root, 'dictation', 'bin'))).toEqual([
      path.join('b5454-test-cpu', '.vocs-installed'),
      path.join('b5454-test-cpu', 'Release', 'whisper-server.exe'),
      path.join('b5454-test-cuda', '.vocs-installed'),
      path.join('b5454-test-cuda', 'Release', 'whisper-server.exe')
    ]);

    expect(await local.transcribe(wav)).toBe('heard a wav in en done');
    expect(spawned.map((s) => path.basename(path.dirname(path.dirname(s.bin))))).toEqual(['b5454-test-cuda', 'b5454-test-cpu']);
    expect(spawned[0].args).not.toContain('-ng');
    const status = await local.status();
    expect(status.runningCompute).toBe('cpu');
    expect(status.error).toMatch(/^The GPU build did not start, so dictation runs on the CPU: The local whisper server exited with 3/);
  }, 60_000);

  it('passes the language setting to a multilingual model, and auto when none is set', async () => {
    const multi: LocalModel = { ...model, id: 'base' };
    served['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'] = modelBytes;
    config = { ...config, model: 'base' };
    const local = new WhisperLocal({
      root: path.join(root, 'dictation'),
      config: () => config,
      platform: 'win32',
      arch: 'x64',
      builds: [cpu],
      models: [multi],
      probeGpu: async () => undefined,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => (String(input) in served ? new Response(new Uint8Array(served[String(input)])) : fetch(input, init))) as typeof fetch,
      extract: async (_a, dest) => {
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(path.join(dest, 'whisper-server.exe'), 'binary');
      },
      spawnServer: (_bin, args, { env }) => spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    });
    engines.push(local);
    await local.install();
    expect(await local.transcribe(wav)).toBe('heard a wav in auto done');
    config = { ...config, language: 'ms' };
    expect(await local.transcribe(wav)).toBe('heard a wav in ms done');
  }, 60_000);
});

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe('local dictation engine under contention', () => {
  it('kills a server that is still starting when the user switches to cloud, and fails that clip', async () => {
    const local = engine({ loadMs: 3000 });
    await local.install();
    const clip = local.transcribe(wav).then(
      () => 'transcribed',
      (e: Error) => e.message
    );
    await expect.poll(() => spawned.length, { timeout: 10_000 }).toBe(1);
    expect((await local.status()).server).toBe('starting');
    await local.stop();
    expect(await clip).toBe('Dictation was stopped while the local server started.');
    await expect.poll(() => exited(spawned[0].child), { timeout: 10_000 }).toBe(true);
    // Nothing came back up after the stop.
    await new Promise((r) => setTimeout(r, 500));
    expect(spawned).toHaveLength(1);
    expect((await local.status()).server).toBe('stopped');
  }, 60_000);

  it('starts one server for two clips that arrive together', async () => {
    const local = engine({ loadMs: 800 });
    await local.install();
    const [a, b] = await Promise.all([local.transcribe(wav), local.transcribe(wav)]);
    expect([a, b]).toEqual(['heard a wav in en done', 'heard a wav in en done']);
    expect(spawned).toHaveLength(1);
  }, 60_000);

  it('sweeps partial files a crashed run left behind before the next install', async () => {
    const dir = path.join(root, 'dictation');
    await fs.mkdir(path.join(dir, 'models'), { recursive: true });
    await fs.mkdir(path.join(dir, 'downloads'), { recursive: true });
    await fs.mkdir(path.join(dir, 'bin', 'b5454-test-cpu.tmp-dead', 'Release'), { recursive: true });
    await fs.writeFile(path.join(dir, 'models', 'ggml-large-v3-turbo.bin.part'), Buffer.alloc(1024));
    await fs.writeFile(path.join(dir, 'downloads', 'cuda.zip.part'), Buffer.alloc(1024));
    await fs.writeFile(path.join(dir, 'bin', 'b5454-test-cpu.tmp-dead', 'Release', 'whisper-server.exe'), 'half');
    await engine().install();
    expect(await filesUnder(dir)).toEqual([
      path.join('bin', 'b5454-test-cpu', '.vocs-installed'),
      path.join('bin', 'b5454-test-cpu', 'Release', 'whisper-server.exe'),
      path.join('models', 'ggml-base.en.bin')
    ]);
  });

  it('keeps a verified archive when unpacking fails, so the retry does not download it again', async () => {
    let failUnpack = true;
    const local = engine({
      extract: async (_archive, dest) => {
        if (failUnpack) throw new Error('Could not unpack cpu.zip: EBUSY');
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(path.join(dest, 'whisper-server.exe'), 'binary');
      }
    });
    await expect(local.install()).rejects.toThrow('Could not unpack cpu.zip: EBUSY');
    expect(downloads).toEqual(['cpu.zip']);
    failUnpack = false;
    await local.install();
    expect(downloads).toEqual(['cpu.zip', 'ggml-base.en.bin']);
    expect((await local.status()).build?.installed).toBe(true);
    // Once unpacked, the archive is gone.
    expect(await filesUnder(path.join(root, 'dictation', 'downloads'))).toEqual([]);
  });
});

describe('local transcript cleanup', () => {
  it("drops whisper's non-speech tags and joins its segments", () => {
    expect(cleanLocalTranscript(' And so my fellow Americans\n ask not [BLANK_AUDIO]\n (music) what\n')).toBe('And so my fellow Americans ask not what');
    expect(cleanLocalTranscript('[BLANK_AUDIO]')).toBe('');
  });
});
