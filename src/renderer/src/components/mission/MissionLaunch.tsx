import React, { useRef, useState } from 'react';
import type { MissionMode } from '../../../../shared/mission';
import type { FileAttachment, ImageAttachment, PermissionMode } from '../../../../shared/types';
import { HARNESS_BY_ID, isMissionHarnessSupported, MISSION_HARNESS_UNSUPPORTED_LABEL, PERMISSION_MODE_LABELS } from '../../../../shared/harness-meta';
import { validatePresetEligibility, type ExecutionPreset } from '../../../../shared/mission-config';
import { resolveNewSessionDefaults } from '../../../../shared/session-defaults';
import { FileAttachmentChips, readAttachments } from '../../attachments';
import { createMission, missionLaunchConfig } from '../../missions';
import { useStore } from '../../store';
import { openSettings } from '../SettingsView';
import { Button, Field, Modal, Spinner } from '../ui';
import { missionHarnessWarning, MissionSupportNotice } from './MissionSupport';
import './mission.css';

const presetLabel = (preset: ExecutionPreset | undefined): string =>
  !preset ? 'unavailable' : isMissionHarnessSupported(preset.harnessId) ? preset.name : `${preset.name} · ${MISSION_HARNESS_UNSUPPORTED_LABEL}`;

export function MissionLaunch({ choices }: { choices: React.ReactNode }) {
  const settings = useStore((s) => s.settings);
  const root = useStore((s) => s.newSessionRoot) ?? '';
  const sourceId = useStore((s) => s.newMissionSourceId);
  const source = useStore((s) => s.sessions.find((session) => session.id === sourceId));
  const [mode, setMode] = useState<MissionMode>('autonomous');
  const [objective, setObjective] = useState('');
  const [override, setOverride] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(source?.config.permissionMode ?? resolveNewSessionDefaults(settings!, root).permissionMode);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const { config, error: configError } = missionLaunchConfig(settings, root);
  const project = settings?.missionProjects?.[root];
  const tier = config?.tiers.find((t) => t.id === 5);
  const leads = config?.presets.filter((p) => p.enabled && tier?.presetIds.includes(p.id) && !['unsupported', 'unavailable'].includes(validatePresetEligibility(p, { role: 'lead', restrictions: project }).status)) ?? [];
  const selected = leads.find((p) => p.id === (override || config?.defaultLeadPresetId));
  const modes = selected ? HARNESS_BY_ID[selected.harnessId].capabilities.permissionModes : Object.keys(PERMISSION_MODE_LABELS) as PermissionMode[];
  const configured = !!selected && (!override ? !!config?.defaultLeadPresetId : true);
  const close = () => useStore.getState().openNewSession(false);
  const launch = async () => {
    if (pending.current || !configured || !objective.trim() || !root || !modes.includes(permissionMode)) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await createMission({ projectRoot: root, originSessionId: sourceId ?? undefined, objective: objective.trim(), mode, leadPresetId: override || undefined, permissionMode, images: images.length ? images : undefined, files: files.length ? files : undefined });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // File conversion stays local; launch never edits ordinary-session defaults.
  const addFiles = async (list: Iterable<File>) => {
    const added = await readAttachments(list, (message) => setError(message));
    setImages((old) => [...old, ...added.images]);
    setFiles((old) => [...old, ...added.files]);
  };
  return <Modal title="New session" onClose={close} width={620} footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" disabled={busy || !configured || !objective.trim() || !root || !modes.includes(permissionMode)} onClick={() => void launch()}>{busy && <Spinner />} Start Mission</Button></>}>
    {choices}
    <div className="mission-ui mission-launch">
      <MissionSupportNotice />
      <p className="muted small">{root} · Automatically managed isolated worktrees. Source discussion and ordinary session defaults stay unchanged.</p>
      {source && <p>Linked from: {source.title}</p>}
      <Field label="Mission mode"><select aria-label="Mission mode" value={mode} onChange={(e) => setMode(e.target.value as MissionMode)}><option value="autonomous">Autonomous</option><option value="interactive_plan">Plan together</option></select></Field>
      <p className="muted small">{mode === 'autonomous' ? 'Investigate, implement, verify and deliver within your permissions; no routine plan approval.' : 'Investigate and clarify one question at a time. Implementation waits for your approval of the proposed revision.'}</p>
      <Field label="Principal engineer (T5 only)"><select aria-label="Principal engineer (T5 only)" value={override} onChange={(e) => setOverride(e.target.value)}><option value="">{config?.defaultLeadPresetId ? `Project default · ${presetLabel(config.presets.find((p) => p.id === config.defaultLeadPresetId))}` : 'No default principal engineer configured'}</option>{leads.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model.provider}/{p.model.model}{isMissionHarnessSupported(p.harnessId) ? '' : ` · ${MISSION_HARNESS_UNSUPPORTED_LABEL}`}</option>)}</select></Field>
      {selected && <p className="muted small">{HARNESS_BY_ID[selected.harnessId].name} · {selected.model.connectionId ?? selected.model.provider} · {selected.model.model} · Reasoning: {selected.reasoning.kind === 'default' ? 'runtime default' : selected.reasoning.value}. Configured; runtime eligibility is checked at launch.</p>}
      {selected && missionHarnessWarning(selected.harnessId) && <p className="callout warn" role="note">{missionHarnessWarning(selected.harnessId)}</p>}
      {(!configured || configError) && <div className="callout warn" role="alert">{configError ?? 'Mission is unconfigured. Choose an enabled T5 principal engineer in Settings → Mission. No lower-tier fallback is used.'} <Button size="sm" onClick={() => { close(); openSettings('mission'); }}>Configure Mission</Button></div>}
      <Field label="Mission permissions"><select aria-label="Mission permissions" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}>{modes.map((p) => <option key={p} value={p}>{PERMISSION_MODE_LABELS[p].label}</option>)}</select></Field>
      {!modes.includes(permissionMode) && <p role="alert">Choose permissions supported by this preset.</p>}
      <Field label="Mission objective"><textarea aria-label="Mission objective" rows={4} autoFocus value={objective} onChange={(e) => setObjective(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void launch(); } }} onPaste={(e) => { const pasted = [...e.clipboardData.files]; if (pasted.length) { e.preventDefault(); void addFiles(pasted); } }} placeholder="Describe the outcome, not the steps" /></Field>
      <label>Attach files <input type="file" multiple onChange={(e) => { if (e.target.files) void addFiles([...e.target.files]); e.target.value = ''; }} /></label>
      {images.map((image, i) => <div key={i} className="row gap8"><span>{image.name ?? 'Image'}</span><Button size="sm" onClick={() => setImages((old) => old.filter((_, j) => j !== i))}>Remove image</Button></div>)}
      <FileAttachmentChips files={files} onRemove={(i) => setFiles((old) => old.filter((_, j) => j !== i))} />
      {error && <div className="callout warn" role="alert">{error} Retry uses the same launch request.</div>}
    </div>
  </Modal>;
}
