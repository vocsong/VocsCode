/**
 * Cloud dictation against a real HTTP server standing in for the provider: the exact request each
 * protocol sends (OpenRouter's JSON body, OpenAI's multipart upload), and what the user is told
 * when the provider refuses — without the key ever appearing in the message.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listCloudModels, transcribeCloud } from '../src/main/dictation/cloud';
import type { ProviderConfig } from '../src/shared/types';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let server: http.Server;
let base = '';
const seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { text: 'hello world' } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  reply = { status: 200, body: { text: 'hello world' } };
});

/** A minimal valid WAV: header plus a few samples. */
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32, 1)]);

const provider = (kind: ProviderConfig['kind'], baseUrl: string, headers?: Record<string, string>): ProviderConfig => ({
  id: kind,
  kind,
  name: kind === 'openrouter' ? 'OpenRouter' : 'OpenAI',
  baseUrl,
  hasApiKey: true,
  models: [],
  enabled: true,
  ...(headers ? { headers } : {})
});

describe('cloud dictation', () => {
  it('sends OpenRouter one JSON body with the base64 clip, the model and the language', async () => {
    const text = await transcribeCloud({ provider: provider('openrouter', `${base}/api/v1/`), apiKey: 'sk-or-test', model: 'openai/whisper-large-v3-turbo', wav, language: 'en' });

    expect(text).toBe('hello world');
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/audio/transcriptions');
    expect(req.headers.authorization).toBe('Bearer sk-or-test');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body.toString('utf8'))).toEqual({
      model: 'openai/whisper-large-v3-turbo',
      input_audio: { data: wav.toString('base64'), format: 'wav' },
      language: 'en'
    });
  });

  it('uploads the clip as a multipart file to an OpenAI-protocol provider, with its custom headers', async () => {
    const text = await transcribeCloud({ provider: provider('openai', `${base}/v1`, { 'x-team': 'voice' }), apiKey: 'sk-test', model: 'gpt-4o-mini-transcribe', wav });

    expect(text).toBe('hello world');
    const [req] = seen;
    expect(req.url).toBe('/v1/audio/transcriptions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.headers['x-team']).toBe('voice');
    const form = await new Response(new Uint8Array(req.body), { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('response_format')).toBe('json');
    // No language was given, so none is sent: the provider detects it.
    expect(form.has('language')).toBe(false);
    const file = form.get('file') as File;
    expect(file.name).toBe('dictation.wav');
    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer()).equals(wav)).toBe(true);
  });

  it('sends no authorization header to a keyless OpenAI-compatible server', async () => {
    await transcribeCloud({ provider: provider('openai-compatible', `${base}/v1`), model: 'whisper-local', wav });
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it("reports the provider's own error text and points at the key on a 401, without echoing the key", async () => {
    reply = { status: 401, body: { error: { message: 'Invalid API key provided' } } };
    const error = await transcribeCloud({ provider: provider('openrouter', `${base}/api/v1`), apiKey: 'sk-or-secret-123', model: 'm', wav }).then(
      () => null,
      (e: Error) => e
    );
    expect(error?.message).toBe('OpenRouter transcription failed (401): Invalid API key provided. Check the API key under Settings → Providers & keys.');
    expect(error?.message).not.toContain('sk-or-secret-123');
  });

  it('refuses an answer that carries no transcript', async () => {
    reply = { status: 200, body: { result: 'ok' } };
    await expect(transcribeCloud({ provider: provider('openai', `${base}/v1`), apiKey: 'k', model: 'whisper-1', wav })).rejects.toThrow('OpenAI answered without a transcript.');
  });

  it("lists OpenRouter's live transcription catalog, and the built-in suggestions for OpenAI", async () => {
    reply = { status: 200, body: { data: [{ id: 'openai/whisper-1', name: 'OpenAI: Whisper 1' }, { id: 'deepgram/nova-3' }] } };
    const live = await listCloudModels(provider('openrouter', `${base}/api/v1`), 'sk-or-test');
    expect(seen[0].url).toBe('/api/v1/models?output_modalities=transcription');
    expect(live).toEqual([
      { id: 'openai/whisper-1', label: 'OpenAI: Whisper 1' },
      { id: 'deepgram/nova-3', label: 'deepgram/nova-3' }
    ]);

    seen.length = 0;
    const builtIn = await listCloudModels(provider('openai', `${base}/v1`), 'k');
    expect(seen).toHaveLength(0);
    expect(builtIn.map((m) => m.id)).toEqual(['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']);
  });
});
