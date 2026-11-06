/** One explicit API/local connection at a time. Subscription sign-ins never need this form. */
import React, { useEffect, useState } from 'react';
import type { ProviderConfig, SecretStatus } from '../../../shared/types';
import type { ProviderAccess } from '../../../shared/harness-setup';
import { invoke } from '../api';
import { Badge, Button, Field, Spinner, Toggle } from './ui';

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function OnboardingProvider({ providers, access, providerId, onSelect, onChanged, onPending }: {
  providers: ProviderConfig[];
  access: ProviderAccess[];
  providerId: string;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void>;
  onPending?: (pending: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [vault, setVault] = useState<SecretStatus | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [acceptFallback, setAcceptFallback] = useState(false);
  const provider = providers.find((p) => p.id === providerId);
  const local = !!provider && ['ollama', 'lmstudio'].includes(provider.kind);
  const source = access.find((p) => p.id === providerId)?.source;
  const configured = !!provider?.hasApiKey || source === 'environment' || local;
  const draft = drafts[providerId] ?? '';

  const readVault = async () => {
    setVaultError(null);
    try { setVault(await invoke('secrets:status', undefined)); }
    catch (e) { setVaultError(message(e)); }
  };
  useEffect(() => { void readVault(); }, []);
  useEffect(() => { setProblem(null); setNotice(null); }, [providerId]);

  const enable = async (p: ProviderConfig) => {
    if (!p.enabled) await invoke('providers:save', { ...p, enabled: true });
  };
  const save = async () => {
    const submitted = draft.trim();
    if (!provider || !submitted || busy || !vault || (!vault.encryptionAvailable && !acceptFallback)) return;
    setBusy(true); onPending?.(true); setProblem(null); setNotice(null);
    let saved = false;
    try {
      await invoke('secrets:set', { providerId: provider.id, apiKey: submitted });
      saved = true;
      setDrafts((values) => values[provider.id]?.trim() === submitted ? { ...values, [provider.id]: '' } : values);
      await enable(provider);
      await onChanged();
      setNotice('Key saved. Next, check the model catalog. A saved key is not proof of model access.');
    } catch (e) {
      setProblem(`${saved ? 'Key saved, but setup could not refresh. Recheck setup. ' : 'Could not save the key. '} ${message(e)}`);
    } finally { setBusy(false); onPending?.(false); }
  };
  const useProvider = async () => {
    if (!provider || busy) return;
    setBusy(true); onPending?.(true); setProblem(null);
    try { await enable(provider); await onChanged(); setNotice('Provider enabled. Check its model catalog next.'); }
    catch (e) { setProblem(message(e)); }
    finally { setBusy(false); onPending?.(false); }
  };

  return <section className="setup-provider" aria-label="API or local connection">
    <p>API billing is separate from a Claude or ChatGPT subscription. Only add an API key if you intend to use that provider’s API. Local servers do not need a cloud subscription.</p>
    <Field label="Provider"><select value={providerId} disabled={busy} onChange={(e) => onSelect(e.target.value)}>
      {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></Field>
    {provider ? <>
      <div className="row gap8"><Badge tone={configured ? 'neutral' : 'amber'}>{local ? 'Local server' : provider.hasApiKey ? 'Key saved' : source === 'environment' ? 'Environment key detected' : 'API key needed'}</Badge><span className="muted small">{provider.enabled ? 'Provider enabled' : 'Provider disabled'}</span></div>
      {local ? <p className="callout">Start {provider.name} and load a chat model, then check models in the next step. Current endpoint: <code>{provider.baseUrl}</code>. You can change custom endpoints in Settings → Providers &amp; keys.</p> : <>
        <Field label={`${provider.name} API key`} hint="The value goes only to the app’s credential vault, not settings or transcripts.">
          <input type="password" autoComplete="off" spellCheck={false} value={draft} placeholder={provider.hasApiKey ? 'Leave blank to keep the existing key' : 'Paste an API key'} onChange={(e) => setDrafts((values) => ({ ...values, [providerId]: e.target.value }))} />
        </Field>
        {vaultError && <div role="alert" className="callout warn">Could not check credential storage: {vaultError} <Button size="sm" onClick={() => void readVault()}>Retry storage check</Button></div>}
        {vault && !vault.encryptionAvailable && <div className="callout warn">
          <p>OS encryption is unavailable. API keys would use a less-protected local fallback. You can use a vendor subscription sign-in instead.</p>
          <Toggle checked={acceptFallback} onChange={setAcceptFallback} label="I understand and want to save a key on this machine" />
        </div>}
        {vault?.encryptionAvailable && <p className="muted small">OS-backed encryption is available.</p>}
        <Button disabled={busy || !draft.trim() || !vault || (!vault.encryptionAvailable && !acceptFallback)} onClick={() => void save()}>{busy ? <Spinner size={13} /> : null} Save key</Button>
      </>}
      {configured && !provider.enabled && <Button disabled={busy} onClick={() => void useProvider()}>Enable {provider.name}</Button>}
      {problem && <p className="callout warn" role="alert">{problem}</p>}
      {notice && <p role="status">{notice}</p>}
    </> : <p role="status">Loading providers…</p>}
  </section>;
}
