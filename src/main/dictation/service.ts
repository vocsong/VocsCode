/**
 * Dictation for the composer: takes a recorded clip and answers its transcript from the engine the
 * user picked — a provider's transcription endpoint with the key from the secret store, or the
 * local whisper.cpp server. Switching to the cloud engine stops the local server at once, so its
 * GPU memory is free again (a game, say, gets it back). No Electron imports.
 */
import path from 'node:path';
import { DEFAULT_DICTATION, cloudSttFor, type DictationLocalStatus, type DictationResult, type DictationSettings, type LocalModelId } from '../../shared/dictation';
import type { AppSettings } from '../../shared/types';
import type { Logger } from '../log';
import { resolveProviderApiKey } from '../models/providers';
import { listCloudModels, transcribeCloud } from './cloud';
import { WhisperLocal, type LocalConfig } from './local';

/** Twenty minutes of 16 kHz mono 16-bit WAV is about 38 MB; the recorder stops long before that. */
export const DICTATION_MAX_WAV_BYTES = 20 * 1024 * 1024;

export interface DictationServiceOptions {
  settings: { get(): AppSettings; onChange(listener: (s: AppSettings) => void): () => void };
  secrets: { get(id: string): Promise<string | undefined> };
  userData: string;
  log?: Logger;
  push?: (status: DictationLocalStatus) => void;
  fetchImpl?: typeof fetch;
  /** Test seam: the local engine. */
  local?: WhisperLocal;
}

export function dictationOf(settings: AppSettings): DictationSettings {
  return settings.dictation ?? DEFAULT_DICTATION;
}

/** The clip as bytes, refused unless it is a WAV file of a sane size. */
export function decodeClip(audio: unknown): Buffer {
  if (typeof audio !== 'string' || !audio) throw new Error('No audio was recorded.');
  if (audio.length > Math.ceil(DICTATION_MAX_WAV_BYTES / 3) * 4 + 4) throw new Error('The recording is too long to transcribe; keep a dictation under ten minutes.');
  const wav = Buffer.from(audio, 'base64');
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('The recording is not a WAV clip.');
  return wav;
}

export class DictationService {
  readonly local: WhisperLocal;
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: DictationServiceOptions) {
    this.local =
      opts.local ??
      new WhisperLocal({
        root: path.join(opts.userData, 'dictation'),
        config: () => this.localConfig(),
        log: opts.log,
        onStatus: opts.push,
        fetchImpl: opts.fetchImpl
      });
    this.unsubscribe = opts.settings.onChange((next) => this.settingsChanged(next));
  }

  private localConfig(settings = this.opts.settings.get()): LocalConfig {
    const d = dictationOf(settings);
    return { ...d.local, language: d.language };
  }

  /** A switch to cloud frees the GPU now; a different local model or compute restarts on the next clip. */
  private settingsChanged(next: AppSettings): void {
    const d = dictationOf(next);
    const running = this.local.activeConfig;
    if (running && (d.engine === 'cloud' || running.model !== d.local.model || running.compute !== d.local.compute)) void this.local.stop();
  }

  async transcribe(audio: unknown): Promise<DictationResult> {
    const wav = decodeClip(audio);
    const d = dictationOf(this.opts.settings.get());
    const started = Date.now();
    const text = d.engine === 'local' ? await this.local.transcribe(wav) : await this.cloud(wav, d);
    return { text: text.trim(), engine: d.engine, ms: Date.now() - started };
  }

  private async cloud(wav: Buffer, d: DictationSettings): Promise<string> {
    const provider = this.opts.settings.get().providers.find((p) => p.id === d.cloud.provider);
    if (!provider) throw new Error(`The dictation provider "${d.cloud.provider}" is gone. Pick another one under Settings → Voice.`);
    const kind = cloudSttFor(provider.kind);
    if (!kind) throw new Error(`${provider.name} has no transcription endpoint. Pick OpenRouter, OpenAI, Groq or an OpenAI-compatible provider under Settings → Voice.`);
    const apiKey = await resolveProviderApiKey(provider, (id) => this.opts.secrets.get(id));
    // A custom OpenAI-compatible server (often one on localhost) may need no key at all.
    if (!apiKey && provider.kind !== 'openai-compatible') throw new Error(`Add an API key for ${provider.name} under Settings → Providers & keys to dictate with it, or switch dictation to Local.`);
    return transcribeCloud({ provider, apiKey, model: d.cloud.model || kind.defaultModel, wav, language: d.language || undefined, fetchImpl: this.opts.fetchImpl });
  }

  async cloudModels(providerId: string): Promise<{ models: { id: string; label: string }[]; error?: string }> {
    const provider = this.opts.settings.get().providers.find((p) => p.id === providerId);
    if (!provider) return { models: [], error: `Unknown provider ${providerId}` };
    const fallback = cloudSttFor(provider.kind)?.models ?? [];
    try {
      const apiKey = await resolveProviderApiKey(provider, (id) => this.opts.secrets.get(id));
      return { models: await listCloudModels(provider, apiKey, this.opts.fetchImpl) };
    } catch (e) {
      return { models: [...fallback], error: e instanceof Error ? e.message : String(e) };
    }
  }

  status(): Promise<DictationLocalStatus> {
    return this.local.status();
  }

  async install(): Promise<DictationLocalStatus> {
    await this.local.install();
    return this.local.status();
  }

  cancelInstall(): void {
    this.local.cancelInstall();
  }

  async removeModel(model: LocalModelId): Promise<DictationLocalStatus> {
    await this.local.removeModel(model);
    return this.local.status();
  }

  async stopLocal(): Promise<DictationLocalStatus> {
    await this.local.stop();
    return this.local.status();
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.local.dispose();
  }
}
