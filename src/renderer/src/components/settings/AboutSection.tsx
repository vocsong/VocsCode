/**
 * Settings → About: app metadata, auto-update controls (issue #198), and doctor report.
 */
import React, { useEffect, useState } from 'react';
import { HARNESSES } from '../../../../shared/harness-meta';
import { harnessStatus } from '../../../../shared/harness-setup';
import type { DoctorReport, HarnessId, UpdateState } from '../../../../shared/types';
import { invoke } from '../../api';
import { useStore } from '../../store';
import { SettingsGroup } from '../SettingsPrimitives';
import { Badge, Button, Spinner } from '../ui';

export function AboutSection() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [info, setInfo] = useState<{ version: string; platform: string; userData: string; isPackaged: boolean } | null>(null);
  const updateState = useStore((s) => s.updateState);
  useEffect(() => {
    void invoke('app:info', undefined).then(setInfo);
    void invoke('app:doctor', undefined).then(setReport);
  }, []);
  return (
    <div className="settings-section">
      <h2>About</h2>
      <SettingsGroup title="Vocs Code" icon="logo" description="One workspace for your coding agents.">
        <p>
          <strong>Vocs Code</strong> {info?.version} · Electron {report?.electron} · Node {report?.node} · {report?.platform}
        </p>
        {info?.isPackaged && <UpdatesPanel state={updateState} currentVersion={info.version} />}
        <p className="muted small mono">{info?.userData}</p>
      </SettingsGroup>
      <SettingsGroup id="about-doctor" title="Doctor" icon="activity" description="Detected runtimes and provider credentials on this computer.">
        {!report && <Spinner />}
        {report && (
          <table className="doctor">
            <tbody>
              {Object.entries(report.harnesses).map(([id, av]) => (
                <tr key={id}>
                  <td>{HARNESSES.find((h) => h.id === id)?.name}</td>
                  <td><Badge tone={harnessStatus(id as HarnessId, av).tone}>{harnessStatus(id as HarnessId, av).label}</Badge></td>
                  <td className="mono small muted">{av.version ?? ''} {av.binaryPath ?? av.detail ?? ''}</td>
                </tr>
              ))}
              {report.providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.hasKey ? <Badge tone="green">key stored</Badge> : p.envKeyPresent ? <Badge tone="blue">env key</Badge> : <Badge tone="neutral">no key</Badge>}</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsGroup>
    </div>
  );
}

/** Update entry for Settings → About (issue #198). State arrives via push:updateState, so the
 *  panel stays live while a check or download runs elsewhere. */
function UpdatesPanel({ state, currentVersion }: { state: UpdateState; currentVersion: string }) {
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    void invoke('update:check', undefined).finally(() => setBusy(false));
  };
  const download = () => void invoke('update:download', undefined);
  const install = () => void invoke('update:install', undefined);
  const line: string =
    state.status === 'idle'
      ? 'Not checked yet.'
      : state.status === 'checking'
        ? 'Checking for updates…'
        : state.status === 'available'
          ? `Update ${state.version} is available.`
          : state.status === 'downloading'
            ? `Downloading ${state.version ?? 'update'}… ${Math.round(state.progress?.percent ?? 0)}%`
            : state.status === 'restart-pending'
              ? `Update ${state.version} is ready. Restart Vocs Code to install it${state.deferred ? ' once every session is idle (or restart now)' : ''}.`
              : state.status === 'up-to-date'
                ? 'You are up to date.'
                : `Update failed: ${state.error ?? 'unknown error'}`;
  return (
    <div className="settings-updates">
      <p className="small muted">
        {line}{' '}
        {(state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error') && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={check}>
            Check for updates
          </Button>
        )}
        {state.status === 'available' && (
          <Button size="sm" variant="ghost" onClick={download}>
            Download {state.version}
          </Button>
        )}
        {state.status === 'restart-pending' && (
          <Button size="sm" variant="ghost" onClick={install}>
            Restart to update
          </Button>
        )}
      </p>
      <p className="muted small mono">current version {currentVersion}</p>
    </div>
  );
}
