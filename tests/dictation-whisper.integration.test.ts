/**
 * Opt-in: the real local engine end to end — the pinned whisper.cpp release and the Base English
 * model downloaded through the production size and sha256 checks, the real `whisper-server`
 * started, and whisper.cpp's own reference clip (jfk.wav) transcribed. Downloads about 160 MB on
 * the CPU build and about 840 MB on the GPU one (the CUDA runtime ships inside it).
 *
 *   VOCS_CODE_WHISPER_INTEGRATION=1 npx vitest run tests/dictation-whisper.integration.test.ts
 *   VOCS_CODE_WHISPER_COMPUTE=gpu ...   the CUDA build (Windows x64 with an NVIDIA GPU); fails
 *                                        rather than passing on a silent CPU fallback
 *   VOCS_CODE_WHISPER_CACHE=<dir>       reuse downloads between runs (default: a temp dir)
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WhisperLocal, type LocalConfig } from '../src/main/dictation/local';
import { WHISPER_RELEASE } from '../src/shared/dictation';

const enabled = process.env.VOCS_CODE_WHISPER_INTEGRATION === '1';
const compute = process.env.VOCS_CODE_WHISPER_COMPUTE === 'gpu' ? 'gpu' : 'cpu';
const root = process.env.VOCS_CODE_WHISPER_CACHE || path.join(os.tmpdir(), 'vocs-whisper-integration');
const config: LocalConfig = { model: 'base.en', compute, idleMinutes: 5, language: '' };
const local = new WhisperLocal({ root, config: () => config, log: (level, message) => level !== 'debug' && console.log(`[${level}] ${message}`) });

afterAll(async () => {
  await local.dispose();
});

describe.runIf(enabled)(`real whisper.cpp ${WHISPER_RELEASE} (${compute})`, () => {
  it('downloads, verifies, starts and transcribes the reference clip', async () => {
    const before = await local.status();
    expect(before.supported).toBe(true);
    if (compute === 'gpu') expect(before.build?.id, `no GPU build was chosen (GPU found: ${before.gpu ?? 'none'})`).toBe('win-x64-cuda');

    await local.install();
    const installed = await local.status();
    expect(installed.build?.installed).toBe(true);
    expect(installed.models).toContain('base.en');

    const res = await fetch(`https://raw.githubusercontent.com/ggml-org/whisper.cpp/${WHISPER_RELEASE}/samples/jfk.wav`);
    expect(res.ok).toBe(true);
    const wav = Buffer.from(await res.arrayBuffer());
    const started = Date.now();
    const text = await local.transcribe(wav);
    console.log(`transcribed in ${Date.now() - started} ms (cold start included): ${text}`);
    expect(text).toMatch(/ask not what your country can do for you/i);

    const warm = Date.now();
    expect(await local.transcribe(wav)).toMatch(/what you can do for your country/i);
    console.log(`warm transcription: ${Date.now() - warm} ms`);

    const running = await local.status();
    expect(running.server).toBe('ready');
    expect(running.runningCompute).toBe(compute);
    expect(running.error).toBeUndefined();

    await local.stop();
    expect((await local.status()).server).toBe('stopped');
    await expect(fs.stat(path.join(root, 'models', 'ggml-base.en.bin'))).resolves.toBeTruthy();
  }, 45 * 60_000);
});
