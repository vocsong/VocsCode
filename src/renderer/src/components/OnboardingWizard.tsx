/** First-run setup guide: harness check, provider API keys, and the utility model. */
import React, { useEffect, useMemo, useState } from 'react';
import type { AppSettings, HarnessAvailability, ModelInfo, ProviderConfig } from '../../../shared/types';
import { HARNESSES } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { useStore } from '../store';
import { ModelPicker } from './ModelPicker';
import { Badge, Button, Field, Icon, Modal, Spinner } from './ui';

const INSTALLABLE = ['claude', 'codex', 'pi', 'dsh'] as const;
type Installable = (typeof INSTALLABLE)[number];

const STEPS = ['Harnesses', 'API keys', 'Utility model'] as const;

export function OnboardingWizard() {
  const settings = useStore((s) => s.settings)!;
  const update = (patch: Partial<AppSettings>) => void invoke('settings:update', patch);
  const [step, setStep] = useState(0);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);

  useEffect(() => {
    void invoke('providers:list', undefined)
      .then(setProviders)
      .catch((e) => setProvidersError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Closing the wizard at any point marks onboarding done — the guide should not
  // re-appear on every launch; everything in it is reachable from Settings.
  const finish = () => update({ onboardingDone: true });

  return (
    <Modal
      title={
        <span className="row gap8">
          Welcome to Vocs Code
          <span className="muted small">
            step {step + 1}/{STEPS.length} — {STEPS[step]}
          </span>
        </span>
      }
      onClose={finish}
      width={640}
      footer={
        <div className="row gap8" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </Button>
          <div className="row gap8">
            <Button variant="ghost" onClick={finish}>
              Skip setup
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
                Next
              </Button>
            ) : (
              <Button variant="primary" icon="check" onClick={finish}>
                Done
              </Button>
            )}
          </div>
        </div>
      }
    >
      {providersError && <div className="info-line info-error"><Icon name="alert" size={13} /> <span>Provider list unavailable: {providersError}</span></div>}
      {step === 0 && <HarnessStep />}
      {step === 1 && <ProviderKeys providers={providers} onChanged={setProviders} />}
      {step === 2 && <UtilityModelStep settings={settings} providers={providers} update={update} />}
    </Modal>
  );
}

/** Step 1: default harness plus what is installed and logged in on this machine. */
function HarnessStep() {
  const settings = useStore((s) => s.settings)!;
  const availability = useStore((s) => s.availability);
  const refresh = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async (id: Installable) => {
    setInstalling(id);
    const r = await invoke('harness:install', { id });
    setInstalling(null);
    toast(r.ok ? `Installed ${id}` : `Install failed: ${r.log.slice(-400)}`, r.ok ? 'success' : 'error');
    void refresh();
  };

  return (
    <div>
      <p className="muted">
        Vocs Code drives coding agents — harnesses — from one desktop. Most harnesses are CLIs you may already have; the bundled ones (pi, the DeepSeek harness) can be
        installed right here. You can change all of this later under Settings → Harnesses.
      </p>
      <Field label="Default harness" hint="Preselected when you start a new session.">
        <select value={settings.defaultHarness} onChange={(e) => void invoke('settings:update', { defaultHarness: e.target.value as AppSettings['defaultHarness'] })}>
          {HARNESSES.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="onboarding-harness-list">
        {HARNESSES.map((h) => {
          const a: HarnessAvailability | undefined = availability[h.id];
          const tone = !a ? 'neutral' : a.available ? (a.authenticated === false ? 'amber' : 'green') : 'red';
          const label = !a ? 'checking…' : a.available ? (a.authenticated === false ? 'not logged in' : 'ready') : 'not installed';
          return (
            <div key={h.id} className="row gap8 onboarding-harness-row">
              <span className="onboarding-harness-name">{h.name}</span>
              <Badge tone={tone}>{label}</Badge>
              <span className="muted small spacer">{a?.version ?? a?.detail ?? a?.installHint ?? ''}</span>
              {INSTALLABLE.includes(h.id as Installable) && (
                <Button size="sm" variant="ghost" disabled={installing !== null} onClick={() => void install(h.id as Installable)}>
                  {installing === h.id ? <Spinner size={11} /> : 'Install'}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Step 2: store API keys for the providers the user wants, and test them. */
function ProviderKeys({ providers, onChanged }: { providers: ProviderConfig[]; onChanged: (p: ProviderConfig[]) => void }) {
  const toast = useStore((s) => s.toast);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const save = async (p: ProviderConfig) => {
    const key = keyDrafts[p.id]?.trim();
    if (!key) return;
    await invoke('secrets:set', { providerId: p.id, apiKey: key });
    setKeyDrafts((d) => ({ ...d, [p.id]: '' }));
    onChanged(providers.map((x) => (x.id === p.id ? { ...x, hasApiKey: true } : x)));
  };

  const test = async (id: string) => {
    setTesting(id);
    const r = await invoke('providers:test', { id });
    setTesting(null);
    onChanged(providers.map((x) => (x.id === id ? { ...x } : x)));
    return r;
  };

  return (
    <div>
      <p className="muted">
        Paste an API key for at least one provider — this is how the agents reach their models. Keys are stored in the OS keychain, never in settings or transcripts. You can
        skip this and add keys later under Settings → Providers &amp; keys.
      </p>
      {providers
        .filter((p) => p.builtin)
        .map((p) => (
          <div key={p.id} className="row gap8 onboarding-key-row">
            <span className="onboarding-harness-name">{p.name}</span>
            {p.hasApiKey ? <Badge tone="green">key saved</Badge> : <Badge tone="neutral">no key</Badge>}
            <input
              className="spacer"
              type="password"
              placeholder={p.hasApiKey ? 'replace key' : 'API key'}
              value={keyDrafts[p.id] ?? ''}
              onChange={(e) => setKeyDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
            />
            <Button size="sm" disabled={!keyDrafts[p.id]?.trim()} onClick={() => void save(p)}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!p.hasApiKey || testing !== null}
              onClick={async () => {
                const r = await test(p.id);
                toast(r.ok ? `${p.name}: ${r.detail}` : `${p.name}: ${r.detail}`, r.ok ? 'success' : 'error');
              }}
            >
              {testing === p.id ? <Spinner size={11} /> : 'Test'}
            </Button>
          </div>
        ))}
    </div>
  );
}

/** Step 3: the cheap model used for background chores (session titles). Optional. */
function UtilityModelStep({ settings, providers, update }: { settings: AppSettings; providers: ProviderConfig[]; update: (p: Partial<AppSettings>) => void }) {
  const models = useMemo(() => providers.filter((p) => p.enabled).flatMap((p) => p.models), [providers]);
  const [selected, setSelected] = useState(settings.utilityModel);
  return (
    <div>
      <p className="muted">
        Optional but recommended: pick a cheap, fast model (e.g. a DeepSeek or GLM flash tier) for background tasks like naming sessions. Without one, the session's own
        model does these jobs.
      </p>
      <div className="onboarding-model-picker">
        <ModelPicker
          models={models}
          selected={selected}
          clearOption={{ label: 'Use the session model' }}
          onSelect={(m: ModelInfo | null) => {
            const next = m ? { provider: m.provider, model: m.id } : undefined;
            setSelected(next);
            update({ utilityModel: next });
          }}
        />
      </div>
    </div>
  );
}
