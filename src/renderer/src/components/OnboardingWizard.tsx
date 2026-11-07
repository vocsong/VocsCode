/** First-run setup follows one working agent, not a checklist of unrelated API keys. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { HarnessId, ModelInfo, ModelRef, ProviderConfig } from '../../../shared/types';
import { HARNESSES, HARNESS_BY_ID } from '../../../shared/harness-meta';
import type { HarnessSetupStatus } from '../../../shared/harness-setup';
import { invoke } from '../api';
import { useStore } from '../store';
import { ModelPicker } from './ModelPicker';
import { Badge, Button, Field, Modal, Spinner, Toggle } from './ui';
import { ChatImport } from './ChatImport';
import { HarnessSetup } from './HarnessSetup';
import { OnboardingProvider } from './OnboardingProvider';
import './onboarding.css';

const STEPS = ['Choose an agent', 'Connect', 'Models', 'Optional', 'Start'] as const;
const SIMPLE: HarnessId[] = ['claude', 'codex', 'pi', 'native'];
const DESCRIPTIONS: Partial<Record<HarnessId, string>> = {
  claude: 'Use your Claude subscription through Claude Code. Its runtime and SDK are included with Vocs Code.',
  codex: 'Use your ChatGPT subscription through Codex. Its runtime is included with Vocs Code.',
  pi: 'A flexible agent with provider sign-ins or API keys. Install Pi and its prerequisites if missing.',
  native: 'Use an API key or a local model server. The agent itself is built in; no coding-agent CLI is needed.'
};
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function OnboardingWizard({ initialHarness, onClose }: { initialHarness?: HarnessId; onClose?: () => void } = {}) {
  const settings = useStore((s) => s.settings)!;
  const defaultProvider = (id?: HarnessId) => id === 'cursor' ? 'cursor' : id === 'codex' || id === 'codex-exec' ? 'openai' : id === 'native' ? settings.defaultModelByHarness.native?.provider ?? 'anthropic' : 'anthropic';
  const [step, setStep] = useState(initialHarness ? 1 : 0);
  const [harness, setHarness] = useState<HarnessId | null>(initialHarness ?? null);
  const [advanced, setAdvanced] = useState(!!initialHarness && !SIMPLE.includes(initialHarness));
  const [setup, setSetup] = useState<HarnessSetupStatus | null>(null);
  const [setupPending, setSetupPending] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState(defaultProvider(initialHarness));
  const [showApi, setShowApi] = useState(initialHarness === 'claude' && settings.claude.useProviderKey);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [acceptUnverified, setAcceptUnverified] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selected, setSelected] = useState<ModelRef | undefined>(initialHarness ? settings.defaultModelByHarness[initialHarness] : undefined);
  const [utility, setUtility] = useState(settings.utilityModel);
  const requests = useRef(0);
  const providerRequests = useRef(0);
  const requiresApi = harness === 'native' || harness === 'cursor' || showApi;
  const selectedProvider = providers.find((p) => p.id === providerId);
  const access = setup?.providers ?? [];
  const source = access.find((p) => p.id === providerId)?.source;
  const providerConfigured = !!selectedProvider?.enabled && (!!selectedProvider.hasApiKey || source === 'environment' || source === 'local');
  const connectionConfigured = !!setup?.availability.available && (requiresApi ? providerConfigured : setup.availability.authenticated === true);
  const usableModel = selected ? !!models?.some((m) => m.id === selected.model && m.provider === selected.provider) : !requiresApi;
  const checked = connectionConfigured && models !== null && models.length > 0 && !modelError && usableModel;

  const loadProviders = async () => {
    const request = ++providerRequests.current;
    setProviderError(null);
    try {
      const result = await invoke('providers:list', undefined);
      if (request === providerRequests.current) setProviders(result);
    } catch (e) {
      if (request === providerRequests.current) setProviderError(message(e));
      throw e;
    }
  };
  useEffect(() => {
    void loadProviders().catch(() => undefined);
    return () => { requests.current++; providerRequests.current++; };
  }, []);

  const invalidateModels = () => { requests.current++; setModels(null); setModelError(null); setLoadingModels(false); };
  const choose = (id: HarnessId) => {
    setHarness(id); setSetup(null); setProviderId(defaultProvider(id));
    setShowApi(id === 'claude' && settings.claude.useProviderKey); setAcceptUnverified(false);
    setSelected(settings.defaultModelByHarness[id]); invalidateModels(); setProblem(null);
  };
  const connectionChanged = async () => {
    invalidateModels();
    await loadProviders();
    setSetup(null); setRefreshToken((v) => v + 1);
  };
  const changeApi = async (next: boolean) => {
    if (saving) return;
    setProblem(null); setSaving(true);
    try {
      if (harness === 'claude') {
        const updated = await invoke('settings:update', { claude: { ...settings.claude, useProviderKey: next } });
        useStore.setState({ settings: updated });
      }
      setShowApi(next); await connectionChanged();
    } catch (e) { setProblem(message(e)); }
    finally { setSaving(false); }
  };
  const loadModels = async () => {
    if (!harness || loadingModels) return;
    const request = ++requests.current;
    setLoadingModels(true); setModelError(null); setModels(null);
    try {
      // API/local catalogs are checked explicitly, using the vault on the main side. No test prompt.
      const providerResult = requiresApi ? await invoke('providers:refreshModels', { id: providerId }) : undefined;
      // For CLI agents, intersect the selected provider with the agent's own catalog rather than
      // assuming every model on a provider's API is usable by that coding agent.
      let result = providerResult && (harness === 'native' || harness === 'cursor') ? providerResult : await invoke('harness:models', { harness });
      if (providerResult && harness !== 'native' && harness !== 'cursor') result = { models: result.models.filter((m) => m.provider === providerId), error: providerResult.error ?? result.error };
      if (request !== requests.current) return;
      setModels(result.models);
      setModelError(result.error ?? (result.models.length ? null : 'No models were returned. Check sign-in, your provider or local server, then retry.'));
      if (requiresApi) await loadProviders();
    } catch (e) {
      if (request === requests.current) { setModels([]); setModelError(message(e)); }
    } finally { if (request === requests.current) setLoadingModels(false); }
  };
  const finish = async (skip = false) => {
    if (saving || (!skip && (!harness || (!checked && !acceptUnverified)))) return;
    setSaving(true); setProblem(null);
    try {
      const updated = await invoke('settings:update', skip ? { onboardingDone: true } : {
        onboardingDone: true, defaultHarness: harness!,
        defaultModelByHarness: { ...settings.defaultModelByHarness, [harness!]: selected },
        utilityModel: utility
      });
      useStore.setState({ settings: updated });
      void useStore.getState().refreshAvailability();
      onClose?.();
    } catch (e) { setProblem(`Setup was not saved. ${message(e)}`); }
    finally { setSaving(false); }
  };
  const next = () => {
    if (step === 1) { setStep(2); if (!models) void loadModels(); }
    else setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const apiProviders = useMemo(() => providers.filter((p) => harness === 'cursor' ? p.id === 'cursor' : harness === 'claude' ? p.id === 'anthropic' : harness === 'codex' || harness === 'codex-exec' ? p.id === 'openai' : p.kind !== 'cursor'), [providers, harness]);
  const utilityModels = useMemo(() => providers.filter((p) => p.enabled && (p.hasApiKey || access.some((a) => a.id === p.id && a.source !== 'none'))).flatMap((p) => p.models), [providers, access]);
  const blockNext = saving || (step === 0 && !harness) || (step === 1 && (setupPending || (!connectionConfigured && !acceptUnverified))) || (step === 2 && (loadingModels || ((!models?.length || !usableModel || !!modelError) && !acceptUnverified)));

  return <Modal title="Welcome to Vocs Code" width={820} onClose={() => { if (!saving) onClose?.(); }} footer={
    <div className="setup-footer">
      <Button variant="ghost" disabled={saving || (!importing && step === 0)} onClick={() => importing ? setImporting(false) : setStep((s) => Math.max(0, s - 1))}>Back</Button>
      <span className="spacer" />
      <Button variant="ghost" disabled={saving} onClick={() => importing ? setImporting(false) : void finish(true)}>{importing ? 'Done' : 'Skip setup'}</Button>
      {!importing && (step < STEPS.length - 1 ? <Button variant="primary" disabled={blockNext} onClick={next}>Next</Button> : <Button variant="primary" disabled={saving || (!checked && !acceptUnverified)} onClick={() => void finish()}>{saving && <Spinner size={13} />} Finish setup</Button>)}
    </div>
  }>
    <div className="onboarding-setup">
      <p className="setup-intro">Choose one agent, connect your account, then pick its models. You do not need to install every agent or buy an API key to use a supported subscription.</p>
      {!importing && <ol className="setup-progress" aria-label="Setup progress">{STEPS.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>}
      {problem && <div role="alert" className="callout warn">{problem}</div>}
      {providerError && <div role="alert" className="callout warn">Provider list unavailable: {providerError} <Button size="sm" onClick={() => void loadProviders().catch(() => undefined)}>Retry providers</Button></div>}
      {importing && <><p>Importing conversations is optional and does not install or sign in to an agent.</p><ChatImport /></>}
      <div hidden={importing}>
        {step === 0 && <section aria-label="Choose an agent">
          <h2>What would you like to use?</h2>
          <p className="muted">An agent (also called a harness) runs your coding session. Pick the account or connection you already have; you can add others later.</p>
          <div className="setup-agent-grid">{HARNESSES.filter((h) => SIMPLE.includes(h.id) || advanced).sort((a, b) => {
            const ai = SIMPLE.indexOf(a.id), bi = SIMPLE.indexOf(b.id);
            return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
          }).map((h) => <button key={h.id} type="button" className="setup-agent" aria-pressed={harness === h.id} onClick={() => choose(h.id)}><strong>{h.name}</strong><span>{DESCRIPTIONS[h.id] ?? h.description}</span>{h.id === 'claude' || h.id === 'codex' ? <Badge tone="neutral">Subscription or API</Badge> : null}</button>)}</div>
          <Button variant="ghost" onClick={() => setAdvanced((v) => !v)}>{advanced ? 'Hide advanced agents' : 'Show advanced agents'}</Button>
          <p className="muted small">A consumer subscription and an API account are separate products. The vendor decides whether your plan includes its coding agent and each model; Vocs Code cannot grant that access.</p>
          <Button variant="ghost" icon="download" onClick={() => setImporting(true)}>Import chats from Claude Code or Codex</Button>
        </section>}
        {harness && <div hidden={step !== 1}>
          <h2>Connect {HARNESS_BY_ID[harness].name}</h2>
          {(harness === 'claude' || harness === 'codex' || harness === 'codex-exec') && <p className="callout">{harness === 'claude' ? 'Claude Code can use an eligible Claude subscription.' : 'Codex can use an eligible ChatGPT subscription.'} Use the sign-in below; an API key is not required for that route. If the runtime is already included and working, do not install another CLI or SDK.</p>}
          {harness === 'pi' && <p className="callout">Pi supports provider sign-ins through <code>/login</code>, including subscription routes offered by its installed version. Or add an API key below. After signing in, use <code>/model</code> in Pi or check models here.</p>}
          {harness === 'acp' && <p className="callout">ACP runs separately configured agents. The default preset uses DeepSeek Harness; install it below or add another command in Settings → ACP agents. Follow that agent’s own provider instructions. This generic check cannot verify its account.</p>}
          <HarnessSetup key={harness} harness={harness} refreshToken={refreshToken} onChange={(value, pending) => { setSetup(value); setSetupPending(!!pending); invalidateModels(); }} />
          {setup?.apiCredentialsMayOverrideLogin && <p className="callout warn">Codex also receives configured OpenAI API keys. Its CLI sign-in status alone does not prove session billing. For subscription-only use, review OpenAI keys in Settings → Providers &amp; keys and your environment; removing a key may affect other agents. This guide does not silently change that credential precedence.</p>}
          {(harness === 'claude' || harness === 'codex' || harness === 'codex-exec' || harness === 'pi') && <Toggle label="Use an API key instead" checked={showApi} disabled={saving} onChange={(v) => void changeApi(v)} />}
          {requiresApi && <OnboardingProvider providers={apiProviders} access={access} providerId={providerId} onSelect={(id) => { setProviderId(id); setSelected(undefined); invalidateModels(); }} onChanged={connectionChanged} onPending={setSaving} />}
          {!connectionConfigured && <Toggle label="Continue without a verified connection" checked={acceptUnverified} onChange={setAcceptUnverified} />}
          {!connectionConfigured && <p className="muted small">You can explore the app, but sessions may fail until installation or sign-in is finished. Skip setup is also available.</p>}
        </div>}
        {step === 2 && <section aria-label="Choose a model">
          <h2>Choose the models this agent can offer</h2>
          <p>A model catalog is not a guarantee of quota or paid access. This check does not send a prompt or run a coding session.</p>
          <Button icon="refresh" disabled={loadingModels} onClick={() => void loadModels()}>{loadingModels ? 'Checking models…' : 'Recheck models'}</Button>
          {loadingModels && <p role="status"><Spinner size={13} /> Loading the selected connection’s model catalog…</p>}
          {modelError && <div className="callout warn" role="alert">Catalog check failed: {modelError} Suggestions below may be built-in fallbacks, not verified account access. Recheck sign-in or choose another connection.</div>}
          {models && <><p role="status">{models.length} {modelError ? 'suggested' : 'catalog'} model{models.length === 1 ? '' : 's'}.</p><Field label="Default model" hint="Applies to new projects. Existing projects keep their remembered New Session choices."><ModelPicker models={models} selected={selected} clearOption={requiresApi ? undefined : { label: 'Let the agent choose its default' }} onSelect={(m) => setSelected(m ? { provider: m.provider, model: m.id } : undefined)} /></Field></>}
          {(modelError || !models?.length || !usableModel) && <Toggle label="Continue without verified model access" checked={acceptUnverified} onChange={setAcceptUnverified} />}
          <p className="muted small">If the catalog or a later session rejects a model, choose another one or return to the connection step. A subscription does not make every model in a fallback list available.</p>
        </section>}
        {step === 3 && <section aria-label="Optional features">
          <h2>Optional — keep the first session simple</h2>
          <p>Utility models handle small background tasks. They use API/local connections, not your Claude Code or ChatGPT login. You can leave this unset and configure it later in Settings → Vesta &amp; utility.</p>
          {utilityModels.length ? <Field label="Utility model"><ModelPicker models={utilityModels} selected={utility} clearOption={{ label: 'No dedicated utility model' }} onSelect={(m) => setUtility(m ? { provider: m.provider, model: m.id } : undefined)} /></Field> : <p className="callout">No API/local utility connection is configured. That does not block a subscription-backed coding session.</p>}
          <p className="muted small">Vesta is a separate optional Pi helper. Setting up Claude or Codex does not install Pi or configure Vesta’s model.</p>
          <Button variant="ghost" icon="download" onClick={() => setImporting(true)}>Import chats from Claude Code or Codex</Button>
        </section>}
        {step === 4 && harness && <section aria-label="Setup summary">
          <h2>{checked ? 'Your choices are configured' : 'Your choices are saved only when you finish'}</h2>
          <dl className="setup-summary"><dt>Agent</dt><dd>{HARNESS_BY_ID[harness].name}</dd><dt>Connection</dt><dd>{requiresApi ? selectedProvider?.name ?? 'API/local' : setup?.availability.authMethod === 'subscription' ? 'Subscription sign-in detected' : setup?.availability.authMethod === 'api-key' ? 'API credentials configured' : 'Agent-owned credentials'}</dd><dt>Default model</dt><dd>{selected ? `${selected.provider} / ${selected.model}` : 'Agent default'}</dd><dt>Utility model</dt><dd>{utility ? `${utility.provider} / ${utility.model}` : 'No dedicated model'}</dd></dl>
          {!checked && <><p className="callout warn">Setup is not fully verified. Installation, sign-in or model access still needs attention before you can run reliably.</p><Toggle label="Finish without verification" checked={acceptUnverified} onChange={setAcceptUnverified} /></>}
          <p>After finishing, choose <strong>New session</strong>, pick a project folder, check the agent/model, then send your first prompt. You control when a paid request is made.</p>
          <p className="muted small">Reopen this guide from Home or Settings → Harnesses → Setup guide. Closing it with × does not mark unfinished setup complete.</p>
        </section>}
      </div>
    </div>
  </Modal>;
}
