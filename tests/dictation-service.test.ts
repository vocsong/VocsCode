/**
 * The dictation service: which engine a clip goes to, the key it is sent with, what it refuses
 * before any network call, and the GPU rule — switching to the cloud engine stops the local
 * server at once, while unrelated settings changes leave it alone. Also the settings normalizer.
 */
import { describe, expect, it, vi } from 'vitest';
import { DictationService, decodeClip } from '../src/main/dictation/service';
import type { WhisperLocal } from '../src/main/dictation/local';
import { defaultSettings, normalizeDictationSettings } from '../src/main/settings';
import { DEFAULT_DICTATION, insertTranscript, type DictationSettings } from '../src/shared/dictation';
import type { AppSettings } from '../src/shared/types';

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(40, 1)]);
const clip = wav.toString('base64');

function harness(dictation: Partial<DictationSettings> = {}, keys: Record<string, string> = {}) {
  let current: AppSettings = { ...defaultSettings(), dictation: { ...DEFAULT_DICTATION, ...dictation } };
  const listeners = new Set<(s: AppSettings) => void>();
  const settings = {
    get: () => current,
    onChange: (l: (s: AppSettings) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }
  };
  const change = (patch: Partial<DictationSettings>) => {
    current = { ...current, dictation: { ...current.dictation!, ...patch } };
    for (const l of listeners) l(current);
  };
  const local = { transcribe: vi.fn(async () => 'from the local model'), stop: vi.fn(async () => undefined), activeConfig: null as null | { model: string; compute: string }, dispose: vi.fn(async () => undefined) };
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ text: ' from the cloud ' }), { status: 200 }));
  const service = new DictationService({
    settings,
    secrets: { get: async (id) => keys[id] },
    userData: 'unused',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    local: local as unknown as WhisperLocal
  });
  return { service, local, fetchImpl, change };
}

describe('dictation service', () => {
  it('refuses a clip that is not a WAV file before any engine sees it', () => {
    expect(() => decodeClip(Buffer.from('hello world, not audio at all, really').toString('base64'))).toThrow('The recording is not a WAV clip.');
    expect(() => decodeClip('')).toThrow('No audio was recorded.');
  });

  it('sends a cloud clip to the saved provider with its stored key, and trims the transcript', async () => {
    const { service, fetchImpl, local } = harness({}, { openrouter: 'sk-or-stored' });
    const result = await service.transcribe(clip);
    expect(result.text).toBe('from the cloud');
    expect(result.engine).toBe('cloud');
    expect(local.transcribe).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-or-stored');
    expect(JSON.parse(String(init!.body)).model).toBe('openai/whisper-large-v3-turbo');
  });

  it("uses the provider's default model when the saved one is empty", async () => {
    const { service, fetchImpl } = harness({ cloud: { provider: 'groq', model: '' } }, { groq: 'gsk-test' });
    await service.transcribe(clip);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init!.body as FormData).get('model')).toBe('whisper-large-v3-turbo');
  });

  it('says where to add a missing key instead of calling the provider', async () => {
    const { service, fetchImpl } = harness();
    const prior = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(service.transcribe(clip)).rejects.toThrow('Add an API key for OpenRouter under Settings → Providers & keys');
    } finally {
      if (prior !== undefined) process.env.OPENROUTER_API_KEY = prior;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a provider with no transcription endpoint', async () => {
    const { service } = harness({ cloud: { provider: 'anthropic', model: '' } }, { anthropic: 'k' });
    await expect(service.transcribe(clip)).rejects.toThrow('Anthropic has no transcription endpoint.');
  });

  it('sends a local clip to whisper.cpp and never to the network', async () => {
    const { service, fetchImpl, local } = harness({ engine: 'local' });
    const result = await service.transcribe(clip);
    expect(result).toMatchObject({ text: 'from the local model', engine: 'local' });
    expect(local.transcribe).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops the local server the moment the engine switches to cloud, and only then', () => {
    const { local, change } = harness({ engine: 'local' });
    local.activeConfig = { model: DEFAULT_DICTATION.local.model, compute: 'auto' };
    change({ language: 'en' });
    expect(local.stop).not.toHaveBeenCalled();
    change({ engine: 'cloud' });
    expect(local.stop).toHaveBeenCalledTimes(1);
  });

  it('restarts on the next clip when the local model or compute changes, and does nothing when no server runs', () => {
    const { local, change } = harness({ engine: 'local' });
    change({ local: { ...DEFAULT_DICTATION.local, model: 'base.en' } });
    expect(local.stop).not.toHaveBeenCalled();
    local.activeConfig = { model: 'base.en', compute: 'auto' };
    change({ local: { ...DEFAULT_DICTATION.local, model: 'base.en', compute: 'cpu' } });
    expect(local.stop).toHaveBeenCalledTimes(1);
  });
});

describe('dictation settings', () => {
  it('defaults to the cloud engine on OpenRouter', () => {
    expect(defaultSettings().dictation).toEqual(DEFAULT_DICTATION);
    expect(DEFAULT_DICTATION.engine).toBe('cloud');
    expect(DEFAULT_DICTATION.cloud).toEqual({ provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' });
  });

  it('keeps only known values from a hand-edited file', () => {
    expect(normalizeDictationSettings('nonsense')).toEqual(DEFAULT_DICTATION);
    expect(
      normalizeDictationSettings({
        engine: 'quantum',
        cloud: { provider: 'groq', model: 7 },
        local: { model: '../../evil.bin', compute: 'tpu', idleMinutes: 7 },
        language: 'English'
      })
    ).toEqual({ engine: 'cloud', cloud: { provider: 'groq', model: '' }, local: DEFAULT_DICTATION.local, language: '' });
    expect(normalizeDictationSettings({ engine: 'local', cloud: { provider: 'openai', model: ' whisper-1 ' }, local: { model: 'small.en', compute: 'cpu', idleMinutes: 15 }, language: ' JA ' })).toEqual({
      engine: 'local',
      cloud: { provider: 'openai', model: 'whisper-1' },
      local: { model: 'small.en', compute: 'cpu', idleMinutes: 15 },
      language: 'ja'
    });
  });
});

describe('transcript insertion', () => {
  it('lands at the caret with one space on each side, replacing a selection', () => {
    expect(insertTranscript('', 0, 0, ' hello ')).toEqual({ text: 'hello', caret: 5 });
    expect(insertTranscript('fix the', 7, 7, 'login bug')).toEqual({ text: 'fix the login bug', caret: 17 });
    expect(insertTranscript('fix  bug', 4, 4, 'login')).toEqual({ text: 'fix login bug', caret: 9 });
    expect(insertTranscript('fix the OLD bug', 8, 11, 'login')).toEqual({ text: 'fix the login bug', caret: 13 });
    expect(insertTranscript('keep me', 3, 3, '   ')).toEqual({ text: 'keep me', caret: 3 });
  });
});
