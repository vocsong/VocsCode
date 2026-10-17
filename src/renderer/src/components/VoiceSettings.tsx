/**
 * Settings → Voice: which engine the composer's mic uses, the cloud provider and model, and the
 * local whisper.cpp model with its download and server state.
 */
import React, { useEffect, useState } from 'react';
import { DEFAULT_DICTATION, DICTATION_IDLE_MINUTES, LOCAL_MODELS, cloudSttFor, localModel, type DictationCompute, type DictationLocalStatus, type DictationSettings } from '../../../shared/dictation';
import type { AppSettings } from '../../../shared/types';
import { invoke, on } from '../api';
import { useStore } from '../store';
import { Badge, Button, Field, Icon, Spinner } from './ui';
import { openSettings } from './SettingsView';

/** ISO-639-1 codes offered as hints; the engines understand many more, which auto-detect still finds. */
const LANGUAGES: [string, string][] = [
  ['', 'Detect automatically'],
  ['en', 'English'],
  ['zh', 'Chinese'],
  ['ms', 'Malay'],
  ['ta', 'Tamil'],
  ['hi', 'Hindi'],
  ['id', 'Indonesian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['vi', 'Vietnamese'],
  ['th', 'Thai'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
  ['ar', 'Arabic']
];

function mb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function VoiceSection({ settings }: { settings: AppSettings }) {
  const d = settings.dictation ?? DEFAULT_DICTATION;
  const toast = useStore((s) => s.toast);
  const update = (patch: Partial<DictationSettings>) => void invoke('settings:update', { dictation: { ...d, ...patch } });
  const [status, setStatus] = useState<DictationLocalStatus | null>(null);
  const [cloudModels, setCloudModels] = useState<{ id: string; label: string }[]>([]);
  const [installing, setInstalling] = useState(false);

  // The chosen build depends on the compute setting, and the download list on the model.
  useEffect(() => {
    let live = true;
    void invoke('dictation:status', undefined)
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    const off = on('push:dictationStatus', (s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [d.local.model, d.local.compute]);

  const sttProviders = settings.providers.filter((p) => cloudSttFor(p.kind));
  const provider = settings.providers.find((p) => p.id === d.cloud.provider);
  const kind = cloudSttFor(provider?.kind);
  useEffect(() => {
    let live = true;
    setCloudModels(kind?.models ?? []);
    if (!provider || !kind) return;
    void invoke('dictation:cloudModels', { provider: provider.id })
      .then((r) => live && setCloudModels(r.models))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = localModel(d.local.model);
  const modelReady = !!status?.models.includes(d.local.model);
  const buildReady = !status?.build || status.build.installed;
  const needs = (status?.build && !status.build.installed ? status.build.bytes : 0) + (model && !modelReady ? model.bytes : 0);
  const download = status?.download;

  const install = async () => {
    setInstalling(true);
    try {
      await invoke('dictation:install', undefined);
      toast('Local dictation is ready.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setInstalling(false);
    }
  };

  const removeModel = async (id: (typeof LOCAL_MODELS)[number]['id']) => {
    try {
      setStatus(await invoke('dictation:removeModel', { model: id }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const computeLabel = (c: DictationCompute): string => {
    if (c === 'cpu') return 'CPU';
    if (c === 'gpu') return status?.gpuBuild ? `GPU — ${status.gpuBuild.label}` : 'GPU';
    return status?.gpu ? `Automatic (GPU: ${status.gpu})` : 'Automatic (no supported GPU found, so CPU)';
  };

  return (
    <div className="settings-section" data-testid="voice-settings">
      <h2>Voice</h2>
      <p className="muted">
        Dictate into the composer with the mic button or <kbd>Ctrl+Shift+Space</kbd>. Click again to stop: the clip is transcribed and the text goes in at the caret. Nothing is sent to the agent until you send it.
      </p>
      {/* Not a <Field>: a <label> would make its text a click target for the first button. */}
      <div className="field">
        <span className="field-label">Engine</span>
        <div className="segmented self-start" role="group" aria-label="Dictation engine">
          {(['cloud', 'local'] as const).map((engine) => (
            <button key={engine} type="button" className={`segment ${d.engine === engine ? 'active' : ''}`} aria-pressed={d.engine === engine} onClick={() => update({ engine })}>
              <Icon name={engine === 'cloud' ? 'cloud' : 'cpu'} size={12} /> {engine === 'cloud' ? 'Cloud provider' : 'This computer'}
            </button>
          ))}
        </div>
        <span className="field-hint">The Cloud / Local chip next to the mic flips this too. Switching to Cloud stops the local server right away, so its GPU memory is free for something else.</span>
      </div>
      <Field label="Language" hint="A hint for the engine. English-only local models always transcribe English.">
        <select value={d.language} onChange={(e) => update({ language: e.target.value })}>
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </Field>

      <h3>Cloud</h3>
      <Field label="Provider" hint="Uses the key stored for that provider under Providers & keys. A custom OpenAI-compatible provider can point at a speech server of your own, on this machine or elsewhere.">
        <select
          value={d.cloud.provider}
          onChange={(e) => {
            const next = settings.providers.find((p) => p.id === e.target.value);
            update({ cloud: { provider: e.target.value, model: cloudSttFor(next?.kind)?.defaultModel ?? '' } });
          }}
        >
          {!provider && <option value={d.cloud.provider}>{d.cloud.provider} (missing)</option>}
          {sttProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.hasApiKey || p.kind === 'openai-compatible' ? '' : ' — no key yet'}
            </option>
          ))}
        </select>
      </Field>
      {provider && !provider.hasApiKey && provider.kind !== 'openai-compatible' && (
        <div className="info-line info-warn">
          <Icon name="alert" size={13} />
          <span>
            {provider.name} has no API key yet.{' '}
            <button type="button" className="link-btn" onClick={() => openSettings('providers')}>
              Add one under Providers & keys
            </button>
            {provider.envKey ? ` (or set ${provider.envKey}).` : '.'}
          </span>
        </div>
      )}
      <Field label="Model" hint={kind?.defaultModel ? `Leave empty for ${kind.defaultModel}.` : 'The model id your server expects.'}>
        <input list="dictation-cloud-models" value={d.cloud.model} placeholder={kind?.defaultModel || 'model id'} onChange={(e) => update({ cloud: { ...d.cloud, model: e.target.value } })} />
        <datalist id="dictation-cloud-models">
          {cloudModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </datalist>
      </Field>

      <h3>On this computer</h3>
      <p className="muted small">
        Runs{' '}
        <button type="button" className="link-btn" onClick={() => void invoke('app:openExternal', { url: 'https://github.com/ggml-org/whisper.cpp' })}>
          whisper.cpp
        </button>{' '}
        locally: the audio never leaves this machine. The app downloads a pinned, checksum-verified build and model once, starts the server on the first
        clip and stops it when idle.
      </p>
      {status && !status.supported && (
        <div className="info-line info-warn">
          <Icon name="alert" size={13} />
          <span>{status.detail}</span>
        </div>
      )}
      <Field label="Model">
        <select value={d.local.model} onChange={(e) => update({ local: { ...d.local, model: e.target.value as DictationSettings['local']['model'] } })}>
          {LOCAL_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {mb(m.bytes)} · {m.hint}
              {status?.models.includes(m.id) ? ' · downloaded' : ''}
            </option>
          ))}
        </select>
      </Field>
      {(status?.gpuBuild || status?.systemServer) && (
        <Field label="Runs on" hint={status?.gpuBuild ? `The GPU build is a one-time ${mb(status.gpuBuild.bytes)} download (it carries the CUDA runtime); the small CPU build comes with it as a fallback.` : undefined}>
          <select value={d.local.compute} onChange={(e) => update({ local: { ...d.local, compute: e.target.value as DictationCompute } })}>
            {(['auto', 'gpu', 'cpu'] as const).map((c) => (
              <option key={c} value={c}>
                {computeLabel(c)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Stop the server after" hint="Idle time before the local server exits and frees its memory. The next clip starts it again (a few seconds).">
        <select value={d.local.idleMinutes} onChange={(e) => update({ local: { ...d.local, idleMinutes: Number(e.target.value) } })}>
          {DICTATION_IDLE_MINUTES.map((m) => (
            <option key={m} value={m}>
              {m === 60 ? '1 hour' : `${m} minute${m === 1 ? '' : 's'}`}
            </option>
          ))}
        </select>
      </Field>
      {status?.supported && (
        <div className="dictation-local" data-testid="dictation-local-status">
          {download ? (
            <div className="dictation-progress">
              <span className="small">
                Downloading {download.item}… {mb(download.received)} of {mb(download.total)}
              </span>
              <progress max={download.total} value={download.received} />
              <Button size="sm" variant="ghost" onClick={() => void invoke('dictation:cancelInstall', undefined)}>
                Cancel
              </Button>
            </div>
          ) : modelReady && buildReady ? (
            <div className="row gap8">
              <Badge tone="green">Ready</Badge>
              {status.server === 'ready' ? (
                <>
                  <span className="muted small">Server running on the {status.runningCompute === 'gpu' ? 'GPU' : 'CPU'}.</span>
                  <Button size="sm" variant="ghost" icon="stop" onClick={() => void invoke('dictation:stopLocal', undefined).then(setStatus)}>
                    Stop now
                  </Button>
                </>
              ) : status.server === 'starting' ? (
                <span className="muted small">
                  <Spinner size={11} /> Starting…
                </span>
              ) : (
                <span className="muted small">Server stopped; the next local clip starts it.</span>
              )}
            </div>
          ) : (
            <div className="row gap8">
              <Button size="sm" variant="primary" icon="download" disabled={installing} onClick={() => void install()}>
                Download ({mb(needs)})
              </Button>
              <span className="muted small">{status.build && !status.build.installed ? `whisper.cpp ${status.build.label} + ${model?.label} model` : `${model?.label} model`}</span>
            </div>
          )}
          {status.error && (
            <div className="info-line info-error">
              <Icon name="alert" size={13} />
              <span>{status.error}</span>
            </div>
          )}
          {status.models.filter((id) => id !== d.local.model).length > 0 && (
            <div className="dictation-models">
              <span className="muted small">Other downloaded models:</span>
              {status.models
                .filter((id) => id !== d.local.model)
                .map((id) => (
                  <span key={id} className="dictation-model-chip">
                    {localModel(id)?.label ?? id}
                    <button type="button" className="icon-btn" title={`Delete the ${localModel(id)?.label ?? id} model`} aria-label={`Delete ${id}`} onClick={() => void removeModel(id)}>
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
