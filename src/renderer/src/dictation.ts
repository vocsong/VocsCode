/**
 * Composer dictation, renderer half: records the microphone with MediaRecorder, then decodes and
 * resamples the clip to the 16 kHz mono 16-bit WAV every engine takes (whisper.cpp reads nothing
 * else without ffmpeg). Main does the transcription, so no key or model ever reaches this side.
 */

export const DICTATION_SAMPLE_RATE = 16_000;
/** A dictation is a prompt, not a meeting: stop on our own well inside every engine's upload limit. */
export const MAX_DICTATION_SECONDS = 300;
/** Below this peak the clip is silence; Whisper invents text for silence ("Thank you."), so it is never sent. */
const SILENCE_PEAK = 0.01;
const MIN_SECONDS = 0.3;

/** 16-bit PCM WAV bytes for mono samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Loudest sample, to tell a spoken clip from silence. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** A failed getUserMedia, said in terms of what the user can do about it. */
export function microphoneError(e: unknown): Error {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('Microphone access is blocked. On Windows allow desktop apps under Settings → Privacy & security → Microphone; on macOS allow Vocs Code under System Settings → Privacy & Security → Microphone.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('No microphone was found.');
  if (name === 'NotReadableError') return new Error('The microphone is in use by another app or could not be opened.');
  return new Error(`Could not start the microphone: ${(e as Error)?.message ?? String(e)}`);
}

export interface Recording {
  /** Stops recording and answers the clip as WAV, or null when it was too short or silent. */
  stop(): Promise<Uint8Array | null>;
  /** Stops recording and drops the clip. */
  cancel(): void;
  /** The current input level, 0–1, for the meter. */
  level(): number;
}

async function toWav(blob: Blob): Promise<Uint8Array | null> {
  const data = await blob.arrayBuffer();
  if (!data.byteLength) return null;
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }
  if (decoded.duration < MIN_SECONDS) return null;
  // One output channel: the offline graph downmixes a stereo microphone on the way.
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * DICTATION_SAMPLE_RATE), DICTATION_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  if (peakOf(samples) < SILENCE_PEAK) return null;
  return encodeWav(samples, DICTATION_SAMPLE_RATE);
}

export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This window cannot use a microphone.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    throw microphoneError(e);
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const meter = new AudioContext();
  const analyser = meter.createAnalyser();
  analyser.fftSize = 1024;
  meter.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const track of stream.getTracks()) track.stop();
    void meter.close();
  };
  recorder.start(250);
  return {
    level: () => {
      if (released) return 0;
      analyser.getFloatTimeDomainData(frame);
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      // Speech RMS sits around 0.02–0.2; stretch it so a normal voice fills most of the meter.
      return Math.min(1, Math.sqrt(sum / frame.length) * 6);
    },
    stop: () =>
      new Promise<Uint8Array | null>((resolve, reject) => {
        recorder.onstop = () => {
          release();
          toWav(new Blob(chunks, { type: recorder.mimeType })).then(resolve, reject);
        };
        if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
        else recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    }
  };
}
