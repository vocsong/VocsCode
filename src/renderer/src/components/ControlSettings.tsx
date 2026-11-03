import React, { useEffect, useState } from 'react';
import type { ControlOwnerState, ControlScope } from '../../../shared/control';
import { HARNESSES, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import type { HarnessId, PermissionMode } from '../../../shared/types';
import { invoke } from '../api';
import { Button, Field } from './ui';

const labels: Record<ControlScope, string> = {
  'control:discover': 'Discover projects and session status', 'control:read': 'Read transcripts',
  'control:create': 'Create sessions', 'control:send': 'Send development tasks', 'control:interrupt': 'Interrupt this controller’s work',
};

/** Native-owner enrollment only. Remote and agent invocation origins cannot call these channels. */
export function ControlSettings() {
  const [state, setState] = useState<ControlOwnerState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('Dots');
  const [accountId, setAccountId] = useState('');
  const [controllerId, setControllerId] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [scopes, setScopes] = useState<ControlScope[]>(['control:discover']);
  const [harness, setHarness] = useState<HarnessId>('pi');
  const [mode, setMode] = useState<PermissionMode>('ask');
  const [ack, setAck] = useState(false);
  useEffect(() => { let live = true; void invoke('control:get', undefined).then((value) => { if (live) setState(value); }).catch(() => { if (live) setError('External control settings are available only on the local desktop.'); }); return () => { live = false; }; }, []);
  async function update(action: () => Promise<ControlOwnerState>) {
    setBusy(true); setError('');
    try { setState(await action()); } catch { setError('The change was not saved. Check the identifiers, selected projects and local control storage.'); }
    finally { setBusy(false); }
  }
  function toggle<T extends string>(values: T[], value: T): T[] { return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]; }
  return <section className="settings-section" data-testid="control-settings">
    <h2>External MCP control <span className="muted">Experimental</span></h2>
    <p className="muted">Connect Dots to https://code.vocs.io/mcp after the gateway is deployed. OAuth sign-in alone grants no desktop access. Copy the account and controller IDs shown on the consent page, then approve access here.</p>
    <p className="muted">The gateway reads requests and results. Cloud content logging/storage is off by default. Projects restrict API access, not the harness’s filesystem or shell access. Ordinary session permissions still apply.</p>
    {error && <p role="alert">{error}</p>}
    {state && <>
      <label><input data-testid="control-enabled" type="checkbox" checked={state.enabled} disabled={busy} onChange={(event) => void update(() => invoke('control:enable', { enabled: event.target.checked }))} /> Allow explicitly granted external controllers</label>
      <p className="muted">Disabling or revoking blocks new work. Already-dispatched work may finish; use the session’s Stop control to cancel it. An OAuth authorization attestation lasts at most 30 seconds.</p>
      <p className="muted">Instance: <code>{state.instanceId}</code></p>
      <form onSubmit={(event) => { event.preventDefault(); if (!ack || busy) return; void update(() => invoke('control:grant', {
        name, accountId, controllerId, projectIds: projects, scopes, harnesses: [harness], permissionModes: [mode], expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      })); }}>
        <Field label="Controller label"><input aria-label="Controller label" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /></Field>
        <Field label="Account ID from OAuth consent"><input aria-label="Account ID from OAuth consent" value={accountId} onChange={(event) => setAccountId(event.target.value.trim())} placeholder="github:… or vocs-v1" required /></Field>
        <Field label="Controller ID from OAuth consent"><input aria-label="Controller ID from OAuth consent" value={controllerId} onChange={(event) => setControllerId(event.target.value.trim())} placeholder="UUID" required /></Field>
        <fieldset disabled={busy}><legend>Approved projects (all ordinary sessions in each selected project)</legend>
          {state.projects.map((project) => <label key={project.id} style={{ display: 'block' }}><input type="checkbox" checked={projects.includes(project.id)} onChange={() => setProjects(toggle(projects, project.id))} /> {project.root}</label>)}
          {!state.projects.length && <p>Add a project folder in the sidebar first.</p>}
        </fieldset>
        <fieldset disabled={busy}><legend>Allowed actions</legend>
          {(Object.keys(labels) as ControlScope[]).map((scope) => <label key={scope} style={{ display: 'block' }}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes(toggle(scopes, scope))} /> {labels[scope]}</label>)}
        </fieldset>
        <Field label="Approved harness"><select aria-label="Approved harness" value={harness} onChange={(event) => setHarness(event.target.value as HarnessId)}>{HARNESSES.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>
        <Field label="Approved permission mode"><select aria-label="Approved permission mode" value={mode} onChange={(event) => setMode(event.target.value as PermissionMode)}>{(Object.keys(PERMISSION_MODE_LABELS) as PermissionMode[]).map((id) => <option key={id} value={id}>{PERMISSION_MODE_LABELS[id].label}</option>)}</select></Field>
        <p className="muted">New sessions inherit the project’s remembered defaults. A different harness or permission mode is rejected, never silently widened. Security approvals and secret questions remain owner-only. Grants expire after 30 days.</p>
        <label style={{ display: 'block' }}><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} /> I approve these actions and the harness’s existing access on this computer.</label>
        <Button type="submit" disabled={busy || !state.enabled || !ack || !projects.length || !scopes.length || !accountId || !controllerId}>Save controller grant</Button>
      </form>
      <h3>Controller grants</h3>
      {state.grants.map((grant) => <div key={grant.id} data-testid="control-grant">
        <strong>{grant.name}</strong> — {grant.revokedAt ? 'Revoked' : grant.expiresAt <= Date.now() ? 'Expired' : 'Active'}
        <p className="muted">{grant.accountId} · {grant.controllerId} · {grant.projectIds.length} project(s)</p>
        {!grant.revokedAt && <Button disabled={busy} onClick={() => void update(() => invoke('control:revoke', { grantId: grant.id }))}>Revoke {grant.name}</Button>}
      </div>)}
    </>}
  </section>;
}
