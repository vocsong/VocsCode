/**
 * The composer's mic: click (or Ctrl+Shift+Space in the composer) to start, again to stop. The clip
 * goes to main, which transcribes it with the engine in Settings → Voice, and the transcript lands
 * at the caret — it is never sent on its own. The chip beside the mic flips between the cloud
 * engine and the local one, so a GPU busy with something else (a game) never has to be touched.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { DEFAULT_DICTATION, localModel } from '../../../shared/dictation';
import { invoke } from '../api';
import { MAX_DICTATION_SECONDS, bytesToBase64, startRecording, type Recording } from '../dictation';
import { useStore } from '../store';
import { Icon, Spinner } from './ui';
import { openSettings } from './SettingsView';

export interface DictationHandle {
  toggle(): void;
}

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const DictationControl = forwardRef<DictationHandle, { onText: (text: string) => void }>(function DictationControl({ onText }, handle) {
  const dictation = useStore((s) => s.settings?.dictation) ?? DEFAULT_DICTATION;
  const providerName = useStore((s) => s.settings?.providers?.find((p) => p.id === (s.settings?.dictation ?? DEFAULT_DICTATION).cloud.provider)?.name);
  const toast = useStore((s) => s.toast);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const recording = useRef<Recording | null>(null);
  const mounted = useRef(true);
  const phaseRef = useRef<Phase>('idle');
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const setBoth = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const finish = async () => {
    const rec = recording.current;
    if (!rec || phaseRef.current !== 'recording') return;
    recording.current = null;
    setBoth('transcribing');
    try {
      const wav = await rec.stop();
      if (!wav) {
        toast('Nothing was heard — check the microphone and speak a little longer.', 'info');
        return;
      }
      const result = await invoke('dictation:transcribe', { audio: bytesToBase64(wav) });
      if (result.text) onTextRef.current(result.text);
      else toast('No speech was recognized in that clip.', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBoth('idle');
    }
  };

  const begin = async () => {
    setBoth('starting');
    try {
      const rec = await startRecording();
      // Switched sessions while the microphone was opening (a permission prompt can take a while).
      if (!mounted.current) {
        rec.cancel();
        return;
      }
      recording.current = rec;
      setElapsed(0);
      setBoth('recording');
    } catch (e) {
      setBoth('idle');
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const toggle = () => {
    if (phaseRef.current === 'idle') void begin();
    else if (phaseRef.current === 'recording') void finish();
  };
  useImperativeHandle(handle, () => ({ toggle }));

  const cancel = () => {
    recording.current?.cancel();
    recording.current = null;
    setBoth('idle');
  };

  // The timer, the level meter and the length cap only run while the microphone is open.
  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    const tick = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      setElapsed(seconds);
      if (seconds >= MAX_DICTATION_SECONDS) void finish();
    }, 250);
    let raf = 0;
    const meter = () => {
      setLevel(recording.current?.level() ?? 0);
      raf = requestAnimationFrame(meter);
    };
    raf = requestAnimationFrame(meter);
    return () => {
      clearInterval(tick);
      cancelAnimationFrame(raf);
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unmounting (switching sessions) must not leave the microphone open.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recording.current?.cancel();
      recording.current = null;
    };
  }, []);

  const local = dictation.engine === 'local';
  const flipEngine = async () => {
    const engine = local ? 'cloud' : 'local';
    try {
      await invoke('settings:update', { dictation: { ...dictation, engine } });
      if (engine === 'cloud') return;
      const status = await invoke('dictation:status', undefined);
      const model = localModel(dictation.local.model);
      const missing = !status.supported ? status.detail : (status.build && !status.build.installed) || !status.models.includes(dictation.local.model) ? `${model?.label ?? 'The local'} model is not downloaded yet.` : undefined;
      if (missing) {
        toast(`${missing} Opening Settings → Voice.`, 'info');
        openSettings('voice');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const engineTitle = local
    ? `Dictating on this computer (whisper.cpp, ${localModel(dictation.local.model)?.label ?? dictation.local.model}). Click to use ${providerName ?? 'the cloud provider'} instead.`
    : `Dictating with ${providerName ?? dictation.cloud.provider} (cloud). Click to run the model on this computer instead.`;
  const busy = phase === 'starting' || phase === 'transcribing';

  return (
    <div className={`dictation ${phase}`} style={{ '--dictation-level': level } as React.CSSProperties}>
      {phase === 'recording' && (
        <>
          <span className="dictation-clock mono small" data-testid="dictation-clock">{clock(elapsed)}</span>
          <button type="button" className="icon-btn" onClick={cancel} title="Discard this recording" aria-label="Discard recording">
            <Icon name="x" size={14} />
          </button>
        </>
      )}
      <button
        type="button"
        className={`icon-btn dictation-mic${phase === 'recording' ? ' is-recording' : ''}`}
        data-testid="dictation-mic"
        onClick={toggle}
        disabled={busy}
        aria-pressed={phase === 'recording'}
        title={phase === 'recording' ? 'Stop and transcribe (Ctrl+Shift+Space)' : phase === 'transcribing' ? 'Transcribing…' : 'Dictate (Ctrl+Shift+Space)'}
        aria-label={phase === 'recording' ? 'Stop dictation' : 'Start dictation'}
      >
        {busy ? <Spinner size={14} /> : <Icon name="mic" size={16} />}
      </button>
      <button type="button" className="dictation-engine" data-testid="dictation-engine" data-engine={dictation.engine} onClick={() => void flipEngine()} disabled={phase !== 'idle'} title={engineTitle}>
        <Icon name={local ? 'cpu' : 'cloud'} size={12} />
        {local ? 'Local' : 'Cloud'}
      </button>
    </div>
  );
});
