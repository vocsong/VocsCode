import React, { useEffect, useState } from 'react';
import type { LocalControlOwnerState } from '../../../shared/local-control';
import { canInvoke, invoke, invokeErrorMessage, platform } from '../api';
import { useStore } from '../store';
import { SettingsGroup } from './SettingsPrimitives';
import { Badge, Button, Field } from './ui';

// Keep only the in-flight change across Settings navigation, not the grant or consent.
let grantChange: Promise<LocalControlOwnerState | null> | undefined;

export function LocalControlSettings() {
  if (platform !== 'win32' || typeof window.harness?.invoke !== 'function' ||
      !canInvoke('control:local:get') || !canInvoke('control:local:enable') || !canInvoke('control:local:disable')) return null;
  return <LocalControlOwnerSettings />;
}

function LocalControlOwnerSettings() {
  const [state, setState] = useState<LocalControlOwnerState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    async function load() {
      // Leaving and reopening during a mutation must not read the grant before it commits.
      await grantChange?.catch(() => undefined);
      if (!live) return;
      try {
        const value = await invoke('control:local:get', undefined);
        if (!live) return;
        setState(value);
        setSelected(value.approvedProjectIds);
      } catch {
        if (live) setError('Could not load local discovery settings. Reopen this page to try again.');
      }
    }
    void load();
    return () => { live = false; };
  }, []);

  async function change(label: string, action: () => Promise<LocalControlOwnerState>) {
    // Lock synchronously, even before React can render the disabled controls.
    if (grantChange) return;
    const request = Promise.resolve().then(async () => {
      try {
        return await action();
      } catch (cause) {
        const message = `Could not ${label} local discovery: ${invokeErrorMessage(cause)}`;
        setError(message);
        // A failed replacement may already have withdrawn the old grant. Read, never retry.
        try { return await invoke('control:local:get', undefined); } catch {
          setError(`${message} Reopen this page to check the current grant.`);
          return null;
        }
      }
    });
    grantChange = request;
    setBusy(true);
    setAcknowledged(false);
    setError('');
    try {
      const value = await request;
      setState(value);
      setSelected(value?.approvedProjectIds ?? []);
    } finally {
      grantChange = undefined;
      setBusy(false);
    }
  }

  const approved = state?.approvedProjectIds ?? [];
  const projectIds = state?.projects.filter((project) => selected.includes(project.id)).map((project) => project.id) ?? [];
  const enabled = approved.length > 0;
  const changed = projectIds.length !== approved.length || projectIds.some((id) => !approved.includes(id));
  const canGrant = !busy && acknowledged && changed && projectIds.length > 0;
  const target = state?.target;

  async function copyTarget(value: string) {
    const toast = useStore.getState().toast;
    try {
      await navigator.clipboard.writeText(value);
      toast('Local target copied', 'success');
    } catch {
      toast('Could not copy the target. Select and copy it from the field instead.', 'error');
    }
  }

  return <SettingsGroup id="local-control" title="Local CLI & MCP discovery" description="Experimental · Windows desktop only" icon="terminal">
    <div data-testid="local-control-settings">
      <p className="muted">This grant ends when you revoke it, remove an approved project, or close this desktop. Vocs Code does not expose this grant over the network.</p>
      {error && <p role="alert">{error}</p>}
      {!state && !error && <p role="status">Loading local discovery settings…</p>}
      {state && !state.supported && <p role="status">Local discovery is unavailable on this Windows desktop.</p>}
      {state?.supported && <>
        <p role="status">{busy ? 'Updating local discovery…' : enabled ? `Local discovery is on for ${approved.length} ${approved.length === 1 ? 'project' : 'projects'}.` : 'Local discovery is off.'}</p>
        <fieldset disabled={busy}>
          <legend>Projects to grant</legend>
          {state.projects.map((project) => <label key={project.id} style={{ display: 'block', paddingBlock: 5 }}>
            <input type="checkbox" checked={selected.includes(project.id)} onChange={(event) => {
              const checked = event.target.checked;
              setSelected((ids) => checked ? [...ids, project.id] : ids.filter((id) => id !== project.id));
              setAcknowledged(false);
            }} />
            <strong>{project.name}</strong>{' '}
            <span className="muted">{project.root}</span>{' '}
            {approved.includes(project.id) && <Badge tone="green">Granted</Badge>}
          </label>)}
          {!state.projects.length && <p className="muted">No eligible projects. Add a project folder in the sidebar first.</p>}
        </fieldset>
        <label style={{ display: 'block', marginTop: 14 }}>
          <input type="checkbox" checked={acknowledged} disabled={busy || !projectIds.length} onChange={(event) => setAcknowledged(event.target.checked)} />
          I allow apps running as this Windows user to read ordinary session titles, status and harness in the selected projects. Titles may contain text from the opening prompt. This grant does not expose transcripts or allow changes.
        </label>
        <div className="settings-actions">
          <Button variant="primary" disabled={!canGrant} onClick={() => {
            if (canGrant) void change(enabled ? 'replace' : 'enable', () => invoke('control:local:enable', { projectIds }));
          }}>{enabled ? 'Replace grant' : 'Enable grant'}</Button>
          <Button variant="danger" disabled={busy || !enabled} onClick={() => void change('revoke', () => invoke('control:local:disable', undefined))}>Revoke grant</Button>
        </div>
        {enabled && target && <>
          <Field label="Target descriptor"><input data-testid="local-control-target" value={target} readOnly /></Field>
          <p className="muted">Use the exact descriptor with <code>--target</code> in the local CLI or stdio MCP. It identifies this profile and this desktop launch. It is public; copying it does not grant access.</p>
          <Button icon="copy" disabled={busy} onClick={() => void copyTarget(target)}>Copy target descriptor</Button>
        </>}
      </>}
    </div>
  </SettingsGroup>;
}
