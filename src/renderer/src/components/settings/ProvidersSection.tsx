/** Settings → Providers & API keys, manual provider models, endpoints, and capability overrides. */
import React, { useEffect, useRef, useState } from 'react';
import { parseModelOverrideKey } from '../../../../shared/model-overrides';
import type { AppSettings, ModelInfo, ProviderConfig, ProviderKind, SecretStatus } from '../../../../shared/types';
import { invoke } from '../../api';
import { useStore } from '../../store';
import { SettingsGroup, SettingsNote } from '../SettingsPrimitives';
import { askConfirm, Badge, Button, Field, Icon, Spinner, Toggle } from '../ui';
import { HarnessLoginsCard } from './HarnessLoginsCard';

export function ProvidersSection({ settings }: { settings: AppSettings }) {
  const toast = useStore((s) => s.toast);
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const filtered = settings.providers.filter((p) => `${p.name} ${p.id} ${p.kind}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const [custom, setCustom] = useState({ id: '', name: '', baseUrl: '', envKey: '', kind: 'openai-compatible' as ProviderKind });
  const addForm = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (adding) {
      addForm.current?.scrollIntoView?.({ block: 'start' });
      addForm.current?.querySelector('input')?.focus({ preventScroll: true });
    }
  }, [adding]);

  const refreshSecretStatus = async () => {
    try {
      setSecretStatus(await invoke('secrets:status', undefined));
    } catch {
      // The warning is advisory; an unavailable status endpoint should not block provider setup.
    }
  };
  useEffect(() => {
    void refreshSecretStatus();
  }, []);

  const save = async (p: ProviderConfig, patch: Partial<ProviderConfig>) => {
    await invoke('providers:save', { ...p, ...patch });
  };
  const saveKey = async (p: ProviderConfig) => {
    const k = keys[p.id];
    if (!k?.trim()) return;
    setBusy({ ...busy, [p.id]: 'saving' });
    try {
      await invoke('secrets:set', { providerId: p.id, apiKey: k.trim() });
      setKeys({ ...keys, [p.id]: '' });
      toast(`Saved key for ${p.name}`, 'success');
      await refreshSecretStatus();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy({ ...busy, [p.id]: '' });
    }
  };
  const test = async (p: ProviderConfig) => {
    setBusy({ ...busy, [p.id]: 'testing' });
    const r = await invoke('providers:test', { id: p.id });
    setBusy({ ...busy, [p.id]: '' });
    toast(`${p.name}: ${r.detail}`, r.ok ? 'success' : 'error');
  };
  const refresh = async (p: ProviderConfig) => {
    setBusy({ ...busy, [p.id]: 'refreshing' });
    const r = await invoke('providers:refreshModels', { id: p.id });
    setBusy({ ...busy, [p.id]: '' });
    toast(r.error ? `${p.name}: ${r.error}` : `${p.name}: ${r.models.length} models`, r.error ? 'error' : 'success');
  };
  return (
    <div className="settings-section">
      <h2>Providers & API keys</h2>
      <SettingsNote>Claude and ChatGPT subscription sign-ins do not require an API key. API billing is separate; keys here power API/local harnesses and configured API routes. Keys stay in the main-process vault, encrypted by the OS when available, and are sent only to the configured provider endpoint.</SettingsNote>
      {secretStatus && !secretStatus.encryptionAvailable && secretStatus.hasFallback && (
        <div className="info-line info-warn"><Icon name="alert" size={13} /> <span>OS encryption is unavailable. Stored provider keys use a local fallback and are less protected; enable OS encryption or clear and re-enter these keys.</span></div>
      )}
      <div id="providers-logins"><HarnessLoginsCard /></div>
      <div id="providers-catalog" className="settings-provider-filter">
        <input type="search" aria-label="Filter providers" placeholder="Find a provider…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span role="status">{filtered.length} of {settings.providers.length} providers</span>
        {filter && <Button size="sm" variant="ghost" onClick={() => setFilter('')}>Show all providers</Button>}
        <span className="spacer" />
        {!adding && <Button icon="plus" size="sm" onClick={() => setAdding(true)}>Add provider</Button>}
      </div>
      {!filtered.length && <p className="muted">No providers match “{filter}”. Clear the filter or add a custom provider.</p>}
      {settings.providers.map((p) => (
        <div key={p.id} hidden={!filtered.some((match) => match.id === p.id)} className={`provider-card ${p.enabled ? '' : 'disabled'}`}>
          <div className="provider-head">
            <Toggle checked={p.enabled} onChange={(v) => void save(p, { enabled: v })} label={<span className="settings-sr-only">Enable {p.name}</span>} />
            <span className="provider-name">{p.name}</span>
            <Badge tone="neutral">{p.kind}</Badge>
            {p.hasApiKey ? <Badge tone="green">key stored</Badge> : p.envKey && <Badge tone="neutral">env: {p.envKey}</Badge>}
            <span className="spacer" />
            <span className="muted small">{p.models.length ? `${p.models.length} models` : 'catalog: built-in'}</span>
            {!p.builtin && (
              <Button variant="ghost" size="sm" icon="trash" onClick={() => void invoke('providers:delete', { id: p.id })} title="Remove provider" />
            )}
          </div>
          {p.enabled && (
            <div className="provider-body">
              <div className="row gap8">
                <input type="password" aria-label={`${p.name} API key`} autoComplete="off" placeholder={p.hasApiKey ? 'Replace stored key…' : p.kind === 'ollama' || p.kind === 'lmstudio' ? 'No key needed' : 'Paste API key'} value={keys[p.id] ?? ''} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void saveKey(p)} />
                <Button size="sm" onClick={() => void saveKey(p)} disabled={!keys[p.id]?.trim()}>
                  Save key
                </Button>
                {p.hasApiKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await invoke('secrets:clear', { providerId: p.id });
                      await refreshSecretStatus();
                    }}
                  >
                    Clear
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void test(p)}>
                  {busy[p.id] === 'testing' ? <Spinner /> : 'Test'}
                </Button>
                <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refresh(p)}>
                  {busy[p.id] === 'refreshing' ? <Spinner /> : 'Models'}
                </Button>
              </div>
              <div className="row gap8">
                <Field label="Base URL" inline>
                  <ProviderBaseUrl provider={p} onSave={(baseUrl) => save(p, { baseUrl })} />
                </Field>
              </div>
              <ProviderModels provider={p} onSave={(models) => save(p, { models })} />
            </div>
          )}
        </div>
      ))}
      {adding && (
        <div ref={addForm} className="provider-card">
          <div className="provider-head"><span className="provider-name">New provider</span></div>
          <div className="provider-body">
            <div className="row gap8">
              <input aria-label="Provider ID" placeholder="id (letters, dashes)" value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value.replace(/[^a-z0-9-]/gi, '').toLowerCase() })} />
              <input aria-label="Provider display name" placeholder="Display name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
            </div>
            <div className="row gap8">
              <input aria-label="Provider base URL" placeholder="Base URL (…/v1)" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} />
              <input aria-label="Provider key environment variable" placeholder="Env var for key (optional)" value={custom.envKey} onChange={(e) => setCustom({ ...custom, envKey: e.target.value })} />
            </div>
            <Field label="Kind" inline hint={custom.kind === 'anthropic' ? 'Claude Code runs on this endpoint, so its models appear for the Claude harness.' : 'OpenAI-compatible endpoints power the native harness.'}>
              <select value={custom.kind} onChange={(e) => setCustom({ ...custom, kind: e.target.value as ProviderKind })}>
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="anthropic">Anthropic-compatible (Claude Code)</option>
              </select>
            </Field>
            <div className="row gap8">
              <Button
                variant="primary"
                size="sm"
                disabled={!custom.id || !custom.baseUrl}
                onClick={async () => {
                  await invoke('providers:save', { id: custom.id, kind: custom.kind, name: custom.name || custom.id, baseUrl: custom.baseUrl, envKey: custom.envKey || undefined, hasApiKey: false, models: [], enabled: true });
                  setAdding(false);
                  setCustom({ id: '', name: '', baseUrl: '', envKey: '', kind: 'openai-compatible' });
                }}
              >
                Add provider
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
      <SettingsGroup id="providers-overrides" title="Model capability overrides" icon="image" description="Correct a model’s advertised support for images."><ModelOverrides settings={settings} /></SettingsGroup>
    </div>
  );
}

/** Manual model ids for an endpoint that publishes no /v1/models catalog (gateways, local hosts). */
function ProviderModels({ provider, onSave }: { provider: ProviderConfig; onSave: (models: ModelInfo[]) => Promise<void> }) {
  const [draft, setDraft] = useState('');
  const add = async () => {
    const id = draft.trim();
    if (!id || provider.models.some((m) => m.id === id)) return;
    await onSave([...provider.models, { id, provider: provider.id, displayName: id }]);
    setDraft('');
  };
  return (
    <>
      <div className="row gap8">
        <Field label="Models" inline hint="Add ids for endpoints with no catalog; the harness refresh replaces this list.">
          <input placeholder="Add a model id" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        </Field>
        <Button size="sm" variant="ghost" onClick={() => void add()} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
      {provider.models.length > 0 && (
        <div className="chips">
          {provider.models.slice(0, 12).map((m) => (
            <button key={m.id} type="button" className="chip" title={`Remove ${m.id}`} onClick={() => void onSave(provider.models.filter((x) => x.id !== m.id))}>
              {m.id} ×
            </button>
          ))}
          {provider.models.length > 12 && <span className="muted small">+{provider.models.length - 12} more</span>}
        </div>
      )}
    </>
  );
}

/** Drafted URL field: existing keyed providers require an explicit confirmation before retargeting. */
function ProviderBaseUrl({ provider, onSave }: { provider: ProviderConfig; onSave: (baseUrl: string) => Promise<void> }) {
  const [draft, setDraft] = useState(provider.baseUrl ?? '');
  const saved = useRef(provider.baseUrl ?? '');
  const saving = useRef(false);

  useEffect(() => {
    if (saving.current) return;
    const next = provider.baseUrl ?? '';
    saved.current = next;
    setDraft(next);
  }, [provider.id, provider.baseUrl]);

  const commit = async () => {
    if (saving.current) return;
    const next = draft.trim();
    if (next === saved.current) {
      if (next !== draft) setDraft(next);
      return;
    }
    saving.current = true;
    try {
      if (provider.hasApiKey) {
        const confirmed = await askConfirm({
          title: `Change the endpoint for ${provider.name}?`,
          body: 'This provider has a stored API key. Changing the base URL can send that key to a different service.',
          confirmLabel: 'Change endpoint',
          danger: true
        });
        if (!confirmed) {
          setDraft(saved.current);
          return;
        }
      }
      await onSave(next);
      saved.current = next;
      setDraft(next);
    } catch {
      setDraft(saved.current);
    } finally {
      saving.current = false;
    }
  };

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        }
      }}
    />
  );
}

/**
 * Capability corrections. Each harness derives `supportsImages` from a different and sometimes
 * wrong source, so the user gets the last word on a per-model basis.
 */
function ModelOverrides({ settings }: { settings: AppSettings }) {
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState({ provider: '', model: '', supportsImages: true });
  const entries = Object.entries(settings.modelOverrides ?? {});

  const set = async (provider: string, model: string, supportsImages: boolean | null) => {
    try {
      await invoke('models:setOverride', { provider, model, supportsImages });
    } catch (e) {
      toast(`Could not save the override: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <>
      <p className="muted">
        Harnesses advertise which models accept images, and they get it wrong — a hand-written entry in a harness catalog, a stale model list, or a name-based guess for an
        OpenAI-compatible endpoint. An override corrects one model here. It changes what this app believes and warns about; it cannot stop a harness that strips attachments
        on its own (Pi does, from <code>~/.pi/agent/models.json</code>).
      </p>
      {entries.length === 0 && <p className="muted small">No overrides. Attach an image to a model listed as text-only and the composer offers to add one.</p>}
      {entries.map(([key, o]) => {
        const { provider, model } = parseModelOverrideKey(key);
        return (
          <div key={key} className="row gap8 override-row">
            <code className="small">{key}</code>
            <Badge tone={o.supportsImages ? 'green' : 'neutral'}>{o.supportsImages ? 'accepts images' : 'text only'}</Badge>
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => void set(provider, model, !o.supportsImages)}>
              Flip
            </Button>
            <Button size="sm" variant="ghost" icon="trash" title="Remove override" onClick={() => void set(provider, model, null)} />
          </div>
        );
      })}
      <div className="row gap8">
        <input placeholder="provider (e.g. deepseek)" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value.trim() })} />
        <input placeholder="model id" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value.trim() })} />
        <select value={draft.supportsImages ? 'yes' : 'no'} onChange={(e) => setDraft({ ...draft, supportsImages: e.target.value === 'yes' })}>
          <option value="yes">accepts images</option>
          <option value="no">text only</option>
        </select>
        <Button
          size="sm"
          disabled={!draft.provider || !draft.model}
          onClick={async () => {
            await set(draft.provider, draft.model, draft.supportsImages);
            setDraft({ provider: '', model: '', supportsImages: true });
          }}
        >
          Add
        </Button>
      </div>
    </>
  );
}
