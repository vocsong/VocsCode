/**
 * Electron end-to-end for composer dictation. Chromium's fake microphone (a steady tone) feeds the
 * real recorder, the clip goes through the real `dictation:transcribe` handler, and a custom
 * OpenAI-compatible provider pointed at a local HTTP server stands in for the cloud — so the suite
 * proves what jsdom cannot: the microphone opens in the real window, the clip reaches the provider
 * as a 16 kHz mono WAV, and the transcript lands in the draft without anything being sent. It also
 * flips the Cloud / Local chip and checks the choice is saved and, with no local model downloaded,
 * that Settings → Voice opens with the download offered. No provider key; requires `npm run build`
 * first; gated by VOCS_CODE_E2E_UI=1.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;
let server: http.Server | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const T = Date.now() - 60_000;

interface Upload {
  url: string;
  model: string | null;
  language: string | null;
  wav: Buffer;
}

describe.runIf(enabled)('electron e2e: dictation', () => {
  it('records the microphone, transcribes through the provider and inserts the text without sending it', async () => {
    const uploads: Upload[] = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
        const file = form.get('file') as File | null;
        uploads.push({ url: req.url ?? '', model: form.get('model') as string | null, language: form.get('language') as string | null, wav: Buffer.from(file ? await file.arrayBuffer() : new ArrayBuffer(0)) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: ' hello from the fake microphone ' }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-dictation-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(userData, 'settings.json'),
      seedSettings(project, {
        providers: [{ id: 'stt-fake', kind: 'openai-compatible', name: 'Fake speech server', baseUrl: `http://127.0.0.1:${port}/v1`, hasApiKey: false, models: [], enabled: true }],
        dictation: { engine: 'cloud', cloud: { provider: 'stt-fake', model: 'fake-whisper' }, local: { model: 'base.en', compute: 'cpu', idleMinutes: 5 }, language: 'en' }
      })
    );
    const session: SessionMeta = {
      id: 's_dictation',
      title: 'Dictation',
      createdAt: T,
      updatedAt: T,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));

    const packaged = process.env.HARNESS_E2E_EXE;
    // Chromium's fake capture device and auto-accepted permission prompt: a real getUserMedia, no hardware.
    const media = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`, ...media] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`, ...media],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(app);

    const box = win.locator('.composer textarea');
    await box.fill('Please');
    const chip = win.getByTestId('dictation-engine');
    await expect.poll(() => chip.innerText()).toBe('Cloud');

    const mic = win.getByTestId('dictation-mic');
    await mic.click();
    await expect.poll(() => mic.getAttribute('aria-pressed'), { timeout: 15_000 }).toBe('true');
    await win.getByTestId('dictation-clock').waitFor();
    // Long enough for MediaRecorder to flush a few chunks of the fake tone.
    await win.waitForTimeout(1500);
    await mic.click();

    await expect.poll(() => box.inputValue(), { timeout: 30_000 }).toBe('Please hello from the fake microphone');
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload.url).toBe('/v1/audio/transcriptions');
    expect(upload.model).toBe('fake-whisper');
    expect(upload.language).toBe('en');
    // A 16 kHz, mono, 16-bit PCM WAV of roughly the recorded length.
    expect(upload.wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(upload.wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(upload.wav.readUInt16LE(20)).toBe(1);
    expect(upload.wav.readUInt16LE(22)).toBe(1);
    expect(upload.wav.readUInt32LE(24)).toBe(16_000);
    expect(upload.wav.readUInt16LE(34)).toBe(16);
    const seconds = upload.wav.readUInt32LE(40) / 32_000;
    expect(seconds).toBeGreaterThan(0.8);
    expect(seconds).toBeLessThan(15);
    // Dictation fills the draft; nothing reached the agent.
    expect(await win.locator('.transcript .msg').count()).toBe(0);
    expect(await mic.getAttribute('aria-pressed')).toBe('false');

    // The chip saves the engine. No local model is downloaded here, so Settings → Voice opens
    // with the download offered instead of a mic that would fail on the next click.
    await chip.click();
    await win.getByTestId('voice-settings').waitFor({ timeout: 15_000 });
    const saved = async () => JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')).dictation;
    await expect.poll(async () => (await saved()).engine).toBe('local');
    await expect.poll(() => win.getByTestId('dictation-local-status').innerText(), { timeout: 15_000 }).toMatch(/Download \(\d+ MB\)/);

    // And back to the cloud from the settings page.
    await win.getByRole('group', { name: 'Dictation engine' }).getByRole('button', { name: 'Cloud provider', exact: true }).click();
    await expect.poll(async () => (await saved()).engine).toBe('cloud');
    expect(await saved()).toMatchObject({ cloud: { provider: 'stt-fake', model: 'fake-whisper' }, language: 'en' });
  }, 240_000);
});
