/** The same actionable setup card is used by first-run setup and its recovery entry points. */
import React, { useEffect, useRef, useState } from 'react';
import type { HarnessId } from '../../../shared/types';
import { HARNESS_BY_ID } from '../../../shared/harness-meta';
import { harnessStatus, type HarnessSetupStatus } from '../../../shared/harness-setup';
import { invoke } from '../api';
import { useStore } from '../store';
import { Badge, Button, Icon, Spinner } from './ui';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function HarnessSetup({ harness, refreshToken = 0, onChange }: {
  harness: HarnessId;
  refreshToken?: number;
  onChange: (status: HarnessSetupStatus | null, pending?: boolean) => void;
}) {
  const [status, setStatus] = useState<HarnessSetupStatus | null>(null);
  const [busy, setBusy] = useState<'check' | 'install' | 'login' | null>(null);
  const [awaitingLogin, setAwaitingLogin] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState('');
  const generation = useRef(0);
  const change = useRef(onChange);
  change.current = onChange;

  const check = async () => {
    const request = ++generation.current;
    setBusy('check'); setStatus(null); setAwaitingLogin(false);
    setProblem(null);
    change.current(null, true);
    try {
      const result = await invoke('harness:setup', { harness });
      if (request !== generation.current) return;
      setStatus(result);
      change.current(result);
      useStore.getState().recordHarnessAvailability(harness, result.availability);
    } catch (error) {
      if (request === generation.current) { setStatus(null); setProblem(message(error)); change.current(null, false); }
    } finally {
      if (request === generation.current) setBusy(null);
    }
  };

  useEffect(() => {
    setStatus(null);
    setNotice(null);
    setInstallLog('');
    void check();
    return () => { generation.current++; };
  }, [harness, refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = async () => {
    if (!status?.installId || !status.canInstall || busy) return;
    const request = ++generation.current;
    setBusy('install'); setProblem(null); setNotice(null); setInstallLog('');
    change.current(null, true);
    try {
      const result = await invoke('harness:install', { id: status.installId });
      if (request !== generation.current) return;
      setInstallLog(result.log);
      if (!result.ok) { setProblem('Installation failed. Review the installer output, fix the prerequisite and retry.'); return; }
      setNotice('Installer finished. Rechecking the runtime before calling it installed.');
      await check();
    } catch (error) {
      if (request === generation.current) setProblem(message(error));
    } finally {
      if (request === generation.current) { setBusy(null); change.current(status, false); }
    }
  };

  const login = async (device = false) => {
    if (!status?.loginId || busy) return;
    const request = ++generation.current;
    setBusy('login'); setProblem(null); setNotice(null);
    change.current(null, true);
    let launched = false;
    try {
      const result = await invoke('harness:login', { harness: status.loginId, ...(device ? { device: true } : {}) });
      if (request !== generation.current) return;
      if (!result.ok) setProblem(result.error ?? 'Could not open sign-in. Retry after checking the runtime.');
      else {
        launched = true;
        setNotice(harness === 'pi' ? 'Sign-in launcher started. In the Pi window, type /login and choose your provider. When finished, return here and select Recheck setup. If no terminal appears, check your terminal installation and retry.' : 'Sign-in launcher started. Finish the vendor sign-in, return here, then select Recheck setup. Opening the window does not mean you are signed in. If no terminal appears, check your terminal installation and retry.');
      }
    } catch (error) {
      if (request === generation.current) setProblem(message(error));
    } finally {
      if (request === generation.current) { setBusy(null); setAwaitingLogin(launched); change.current(launched ? null : status, false); }
    }
  };

  const badge = awaitingLogin ? { label: 'Recheck sign-in', tone: 'amber' as const } : harnessStatus(harness, status?.availability);
  return <section className="setup-checks" aria-label={`${HARNESS_BY_ID[harness].name} setup`} aria-busy={!!busy}>
    <div className="row gap8">
      <strong>Runtime and sign-in</strong><Badge tone={badge.tone}>{badge.label}</Badge><span className="spacer" />
      <Button size="sm" variant="ghost" disabled={!!busy} icon="refresh" onClick={() => void check()}>Recheck setup</Button>
    </div>
    {busy && <p role="status"><Spinner size={13} /> {busy === 'install' ? 'Installing into Vocs Code’s private runtime folder. This can take a few minutes…' : busy === 'login' ? 'Opening the vendor sign-in…' : 'Checking this machine…'}</p>}
    {problem && <div className="callout warn" role="alert">{problem}</div>}
    {notice && <p className="callout" role="status">{notice}</p>}
    {status && <>
      <p className="muted small">{status.availability.detail}</p>
      {status.availability.binaryPath && <p className="small setup-path"><strong>{status.availability.source === 'bundled' ? 'Included with the app' : 'Selected runtime'}:</strong> <code>{status.availability.binaryPath}</code>{status.availability.version && <> · {status.availability.version}</>}</p>}
      {status.availability.available && status.loginId && <div className="row gap8 wrap">
        <Button disabled={!!busy} onClick={() => void login()}>{status.loginId === 'claude' ? 'Sign in with Claude' : status.loginId === 'codex' ? 'Sign in with ChatGPT' : 'Open Pi sign-in'}</Button>
        {status.loginId === 'codex' && <Button disabled={!!busy} variant="ghost" onClick={() => void login(true)}>Use device sign-in</Button>}
      </div>}
      {status.availability.authMethod === 'api-key' && <p className="callout warn">API credentials are configured. API usage is billed separately from a Claude or ChatGPT subscription.</p>}
      {!status.availability.available && <>
        {status.installId && <Button disabled={!!busy || !status.canInstall} onClick={() => void install()}>Install {status.installId === 'dsh' ? 'DeepSeek Harness' : HARNESS_BY_ID[harness].name}</Button>}
        {status.installReason && <p className="small">{status.installReason}</p>}
        {!status.installReason && status.installId && <p className="muted small">Downloads the vendor’s npm package into Vocs Code’s own runtime folder. No SDK development setup is needed.</p>}
      </>}
      <ul className="setup-requirements" aria-label="Prerequisites">
        {status.requirements.map((r) => <li key={r.id}>
          <Icon name={r.available ? 'check' : 'info'} size={14} /><div><strong>{r.name}</strong><p className="muted small">{r.detail}</p></div>
          {!r.available && r.url && <Button size="sm" variant="ghost" icon="external" onClick={() => void invoke('app:openExternal', { url: r.url! }).catch((e) => setProblem(message(e)))}>Get {r.name}</Button>}
        </li>)}
      </ul>
      <p className="muted small">These are setup checks, not a paid test prompt. Model access still depends on your account, plan and provider limits.</p>
    </>}
    {!!installLog && <details><summary>Installer output</summary><pre className="setup-log">{installLog.slice(-16000)}</pre></details>}
  </section>;
}
