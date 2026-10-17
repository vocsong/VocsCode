/**
 * Dictation — voice to text in the composer. The engine choice (a cloud provider's transcription
 * endpoint, or whisper.cpp on this machine), the providers that can transcribe, the pinned
 * whisper.cpp builds and models the app downloads, and the defaults. Shared so main normalizes
 * settings against the same catalog the renderer offers. No runtime deps, no Electron imports.
 */
import type { ProviderKind } from './types';

/** What the mic button transcribes with. */
export type DictationEngine = 'cloud' | 'local';
/** Where the local engine runs: `auto` takes the GPU build when this machine has one we ship. */
export type DictationCompute = 'auto' | 'gpu' | 'cpu';

export interface DictationSettings {
  /** Cloud by default, so dictating never spends this machine's GPU unless the user switches. */
  engine: DictationEngine;
  /** A provider from Settings → Providers (its stored key is used) and its transcription model. */
  cloud: { provider: string; model: string };
  local: {
    model: LocalModelId;
    compute: DictationCompute;
    /** The local server is stopped after this many idle minutes, which frees its GPU memory. */
    idleMinutes: number;
  };
  /** ISO-639-1 code handed to the engine; empty lets the engine detect the language. */
  language: string;
}

/** How a provider kind takes audio: OpenRouter's JSON body, or OpenAI's multipart upload. */
export type CloudSttProtocol = 'openrouter' | 'openai';

export interface CloudSttKind {
  protocol: CloudSttProtocol;
  defaultModel: string;
  /** Offered in the model picker; OpenRouter's list is also fetched live. */
  models: { id: string; label: string }[];
}

/**
 * Provider kinds with a transcription endpoint. `openai-compatible` covers a custom provider —
 * including a speech server on localhost — whose model the user types.
 */
const CLOUD_STT: Partial<Record<ProviderKind, CloudSttKind>> = {
  openrouter: {
    protocol: 'openrouter',
    defaultModel: 'openai/whisper-large-v3-turbo',
    models: [
      { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
      { id: 'openai/gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
      { id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
      { id: 'openai/whisper-large-v3', label: 'Whisper Large v3' }
    ]
  },
  openai: {
    protocol: 'openai',
    defaultModel: 'gpt-4o-mini-transcribe',
    models: [
      { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
      { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
      { id: 'whisper-1', label: 'Whisper 1' }
    ]
  },
  groq: {
    protocol: 'openai',
    defaultModel: 'whisper-large-v3-turbo',
    models: [
      { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
      { id: 'whisper-large-v3', label: 'Whisper Large v3' }
    ]
  },
  'openai-compatible': { protocol: 'openai', defaultModel: '', models: [] }
};

export function cloudSttFor(kind: ProviderKind | undefined): CloudSttKind | undefined {
  return kind ? CLOUD_STT[kind] : undefined;
}

/** whisper.cpp GGML models (huggingface.co/ggerganov/whisper.cpp); size and sha256 are pinned. */
export const LOCAL_MODELS = [
  { id: 'base.en', label: 'Base, English', bytes: 147_964_211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', hint: 'Fast on any CPU' },
  { id: 'small.en', label: 'Small, English', bytes: 487_614_201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', hint: 'More accurate; fine on a recent CPU' },
  { id: 'large-v3-turbo-q5_0', label: 'Large v3 Turbo, quantized', bytes: 574_041_195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', hint: 'Best accuracy for the size; meant for a GPU' },
  { id: 'base', label: 'Base, multilingual', bytes: 147_951_465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', hint: 'Fast; any language' },
  { id: 'small', label: 'Small, multilingual', bytes: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', hint: 'Any language' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', bytes: 1_624_555_275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69', hint: 'Full precision; GPU only' }
] as const;

export type LocalModelId = (typeof LOCAL_MODELS)[number]['id'];
export interface LocalModel {
  id: LocalModelId;
  label: string;
  bytes: number;
  sha256: string;
  hint: string;
}

export function localModel(id: string | undefined, catalog: readonly LocalModel[] = LOCAL_MODELS): LocalModel | undefined {
  return catalog.find((m) => m.id === id);
}

export function localModelUrl(model: LocalModel): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model.id}.bin`;
}

/** The whisper.cpp release every download is pinned to; its assets carry the sha256 below. */
export const WHISPER_RELEASE = 'b5454';

export interface WhisperBuild {
  id: string;
  platform: 'win32' | 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  compute: 'gpu' | 'cpu';
  label: string;
  asset: string;
  bytes: number;
  sha256: string;
}

/**
 * Official builds of the pinned release. macOS ships no server binary (only an xcframework), so
 * there the app runs a `whisper-server` installed by Homebrew (`brew install whisper-cpp`).
 */
export const WHISPER_BUILDS: readonly WhisperBuild[] = [
  { id: 'win-x64-cpu', platform: 'win32', arch: 'x64', compute: 'cpu', label: 'CPU', asset: 'whisper-bin-x64.zip', bytes: 8_928_640, sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  { id: 'win-x64-cuda', platform: 'win32', arch: 'x64', compute: 'gpu', label: 'NVIDIA GPU (CUDA 12)', asset: 'whisper-bin-win-cuda-12.4.0-x64.zip', bytes: 684_913_404, sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a' },
  { id: 'win-arm64-cpu', platform: 'win32', arch: 'arm64', compute: 'cpu', label: 'CPU', asset: 'whisper-bin-win-cpu-arm64.zip', bytes: 4_371_193, sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d' },
  { id: 'linux-x64-cpu', platform: 'linux', arch: 'x64', compute: 'cpu', label: 'CPU', asset: 'whisper-bin-ubuntu-x64.tar.gz', bytes: 10_364_195, sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c' },
  { id: 'linux-arm64-cpu', platform: 'linux', arch: 'arm64', compute: 'cpu', label: 'CPU', asset: 'whisper-bin-ubuntu-arm64.tar.gz', bytes: 4_608_377, sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149' }
];

export function whisperBuildUrl(build: WhisperBuild): string {
  return `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/${build.asset}`;
}

/** The builds this platform can download, CPU first. */
export function whisperBuildsFor(platform: string, arch: string, builds: readonly WhisperBuild[] = WHISPER_BUILDS): WhisperBuild[] {
  return builds.filter((b) => b.platform === platform && b.arch === arch).sort((a, b) => (a.compute === b.compute ? 0 : a.compute === 'cpu' ? -1 : 1));
}

/**
 * The build a local run uses: the GPU build when asked for (or, on `auto`, when a supported GPU was
 * found), else the CPU one. Undefined where nothing is downloadable (macOS, unknown platforms).
 */
export function pickWhisperBuild(platform: string, arch: string, compute: DictationCompute, hasSupportedGpu: boolean, catalog: readonly WhisperBuild[] = WHISPER_BUILDS): WhisperBuild | undefined {
  const builds = whisperBuildsFor(platform, arch, catalog);
  const wantGpu = compute === 'gpu' || (compute === 'auto' && hasSupportedGpu);
  return (wantGpu ? builds.find((b) => b.compute === 'gpu') : undefined) ?? builds.find((b) => b.compute === 'cpu');
}

export const DICTATION_IDLE_MINUTES = [1, 5, 15, 60] as const;

export const DEFAULT_DICTATION: DictationSettings = {
  engine: 'cloud',
  cloud: { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo' },
  local: { model: 'large-v3-turbo-q5_0', compute: 'auto', idleMinutes: 5 },
  language: ''
};

/** Local engine progress and readiness, pushed while a download runs and answered on request. */
export interface DictationLocalStatus {
  /** False on platforms with no downloadable build and no `whisper-server` found (macOS without Homebrew's). */
  supported: boolean;
  /** Why `supported` is false, or a hint about where the server binary comes from. */
  detail?: string;
  /** A GPU the shipped GPU build can use (an NVIDIA card on Windows x64). */
  gpu?: string;
  /** The GPU build this platform can download, whether or not a GPU was found. */
  gpuBuild?: { label: string; bytes: number };
  /** The build the current settings would run, and whether it is on disk. */
  build?: { id: string; label: string; bytes: number; installed: boolean };
  /** A system `whisper-server` (macOS Homebrew), used instead of a downloaded build. */
  systemServer?: string;
  /** Every catalog model already downloaded. */
  models: LocalModelId[];
  server: 'stopped' | 'starting' | 'ready';
  /** The compute the running server actually uses (a GPU build that failed to start falls back to CPU). */
  runningCompute?: 'gpu' | 'cpu';
  download?: { item: string; received: number; total: number };
  /** The last install or start failure, cleared by the next attempt. */
  error?: string;
}

export interface DictationResult {
  text: string;
  engine: DictationEngine;
  ms: number;
}

/** A transcript lands at the caret with one space between it and any neighbouring text. */
export function insertTranscript(draft: string, start: number, end: number, transcript: string): { text: string; caret: number } {
  const said = transcript.trim();
  if (!said) return { text: draft, caret: end };
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const text = `${before}${lead}${said}${trail}${after}`;
  return { text, caret: before.length + lead.length + said.length + trail.length };
}
