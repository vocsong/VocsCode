/** The desktop's shared SKILL.md library. Contents are always displayed as plain text. */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { IpcChannel } from '../../../shared/ipc';
import type { SessionMeta } from '../../../shared/types';
import { hasOngoingWork } from '../../../shared/ongoing';
import { parseSharedSkillCommand, sharedSkillSupported, type SharedSkillDocument, type SharedSkillInfo } from '../../../shared/shared-skills';
import { canInvoke, invoke, invokeErrorMessage, isWeb } from '../api';
import { useStore } from '../store';
import { Badge, Button, EmptyState, Field, Icon, Modal, Spinner } from './ui';
import './shared-skills.css';

export const canUseSharedSkills = (channel: Extract<IpcChannel, `sharedSkills:${string}`>): boolean => !isWeb && canInvoke(channel);

/** Renderer affordances only; main rechecks eligibility when the user sends. */
export function sharedSkillSessionBlocker(session: SessionMeta | undefined, armed?: boolean, archiving?: boolean): string | undefined {
  if (!session) return 'Open a session to use a shared skill.';
  if (session.archived || archiving) return 'Shared skills cannot be used in an archived session.';
  if (session.mission || armed) return 'Shared skills cannot be used with Mission mode. Turn it off or use another session.';
  if (session.goal?.status === 'active') return 'Pause or finish the active goal before using a shared skill.';
  if (session.nativeGoal) return 'This session’s Goal is owned by its harness. Use an ordinary session for Shared skills.';
  if (session.controlCreation) return 'Shared skills cannot be used in controller-created sessions.';
  if (session.nativeGoal) return 'Shared skills are unavailable when the harness owns /goal.';
  if (session.controlCreation) return 'Use a regular desktop session to run a shared skill.';
  if (session.status === 'starting' || session.status === 'running' || session.status === 'awaiting' || session.queued || hasOngoingWork(session)) {
    return 'Wait until the session is idle to use a shared skill.';
  }
  if (!sharedSkillSupported(session.config.harness)) return 'This harness does not support shared skills.';
}

export function SharedSkillsView() {
  if (!canUseSharedSkills('sharedSkills:list')) {
    return <EmptyState icon="puzzle" title="Shared skills are available in the desktop app." />;
  }
  return <SharedSkillLibrary />;
}

function SharedSkillLibrary() {
  const active = useStore((s) => s.sessions.find((session) => session.id === s.activeId));
  const armed = useStore((s) => !!s.activeId && !!s.missionArmed[s.activeId]);
  const archiving = useStore((s) => !!s.activeId && !!s.archiving[s.activeId]);
  const [skills, setSkills] = useState<SharedSkillInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<SharedSkillDocument | null>(null);
  const currentDoc = useRef<SharedSkillDocument | null>(null);
  const showDocument = useCallback((snapshot: SharedSkillDocument | null) => {
    currentDoc.current = snapshot;
    setDoc(snapshot);
  }, []);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string; description: string } | null>(null);
  const [editing, setEditing] = useState<{ base: SharedSkillDocument; content: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const listRequest = useRef(0);
  const readRequest = useRef(0);
  const useHintId = useId();

  const updateRow = useCallback(({ name, description, revision, reviewed }: SharedSkillInfo) => {
    setSkills((current) => [...(current ?? []).filter((skill) => skill.name !== name), { name, description, revision, reviewed }]
      .sort((a, b) => a.name.localeCompare(b.name)));
  }, []);

  const select = useCallback(async (name: string) => {
    const request = ++readRequest.current;
    setSelected(name);
    showDocument(null);
    setError(null);
    if (!canUseSharedSkills('sharedSkills:read')) {
      setReading(false);
      setError('Shared skill previews are not available here.');
      return;
    }
    setReading(true);
    try {
      const result = await invoke('sharedSkills:read', { name });
      if (readRequest.current !== request) return;
      if (result.name !== name) throw new Error('The returned skill did not match the selection.');
      showDocument(result);
      updateRow(result);
    } catch (e) {
      if (readRequest.current === request) setError(invokeErrorMessage(e));
    } finally {
      if (readRequest.current === request) setReading(false);
    }
  }, [showDocument, updateRow]);

  const refresh = useCallback(async (name: string | null) => {
    if (!canUseSharedSkills('sharedSkills:list') || writing.current) return;
    const request = ++listRequest.current;
    ++readRequest.current; // a preview from before the rescan must never become current
    setSkills(null);
    showDocument(null);
    setReading(false);
    setError(null);
    try {
      const list = await invoke('sharedSkills:list', undefined);
      if (listRequest.current !== request) return;
      setSkills(list);
      if (name && list.some((skill) => skill.name === name)) void select(name);
      else setSelected(null);
    } catch (e) {
      if (listRequest.current === request) setError(invokeErrorMessage(e));
    }
  }, [select, showDocument]);

  useEffect(() => {
    void refresh(null);
    return () => { ++listRequest.current; ++readRequest.current; };
  }, [refresh]);

  const write = async (run: () => Promise<void>, onError: (message: string) => void) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    try { await run(); }
    catch (e) { onError(invokeErrorMessage(e)); }
    finally { writing.current = false; setBusy(false); }
  };

  const create = () => {
    if (!creating || !canUseSharedSkills('sharedSkills:create')) return;
    setFormError(null);
    void write(async () => {
      const result = await invoke('sharedSkills:create', { name: creating.name.trim(), description: creating.description.trim() });
      ++readRequest.current;
      updateRow(result);
      setSelected(result.name);
      showDocument(result);
      setReading(false);
      setQuery('');
      setError(null);
      setCreating(null);
    }, setFormError);
  };

  const save = () => {
    if (!editing || !canUseSharedSkills('sharedSkills:save')) return;
    const { base: { name, revision }, content } = editing;
    setFormError(null);
    void write(async () => {
      const result = await invoke('sharedSkills:save', { name, revision, content });
      if (result.name !== name) throw new Error('The returned skill did not match the selection.');
      updateRow(result);
      showDocument(result);
      setError(null);
      setEditing(null);
    }, (message) => {
      setFormError(message);
      // Keep the text in the editor, but don't let an uncertain/stale snapshot be reviewed or used.
      showDocument(null);
      setError('Refresh to check the current revision before using this skill.');
    });
  };

  const review = () => {
    if (!doc || doc !== currentDoc.current || !canUseSharedSkills('sharedSkills:review')) return;
    const { name, revision, reviewed } = doc;
    void write(async () => {
      const result = await invoke('sharedSkills:review', { name, revision, enabled: !reviewed });
      if (result.name !== name || result.revision !== revision) throw new Error('The skill changed.');
      updateRow(result);
      showDocument({ ...result, content: doc.content });
    }, (message) => {
      showDocument(null);
      setError(`${message} Refresh to check the current revision.`);
    });
  };

  const useBlocker = !doc?.reviewed ? 'Review this revision before using it.' : !canUseSharedSkills('sharedSkills:invoke') ?
    'Shared skills can only be used in the desktop app.' : sharedSkillSessionBlocker(active, armed, archiving);
  const stage = () => {
    if (writing.current || !doc?.reviewed || doc !== currentDoc.current || !canUseSharedSkills('sharedSkills:invoke')) return;
    const st = useStore.getState();
    const id = st.activeId;
    if (!id || id !== active?.id) { st.toast('The active session changed. Try again.', 'info'); return; }
    const target = st.sessions.find((session) => session.id === id);
    const reason = sharedSkillSessionBlocker(target, !!st.missionArmed[id], !!st.archiving[id]);
    if (reason) { st.toast(reason, 'info'); return; }
    const draft = st.drafts[id] ?? '';
    if (/^[!/]/.test(draft.trimStart())) {
      st.toast('Your command draft was kept. Clear it before staging a shared skill.', 'info');
      return;
    }
    const staged = `/skill ${doc.name} ${draft.trim() ? draft : ''}`;
    if (!parseSharedSkillCommand(staged)) { st.toast('Could not stage the shared skill. Your draft was kept.', 'info'); return; }
    st.setDraft(id, staged, { name: doc.name, revision: doc.revision });
    st.setView('chat'); // stages text only; the user still decides whether to send
  };

  const q = query.trim().toLowerCase();
  const visible = skills?.filter((skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
  return (
    <>
      <div className="skills-top shared-skills-toolbar">
        <span className="skill-root-path mono">~/.agents/skills</span>
        <div className="skills-actions">
          <div className="skills-search">
            <Icon name="search" size={14} />
            <input placeholder="Filter shared skills" aria-label="Filter shared skills" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Button size="sm" icon="refresh" disabled={busy} onClick={() => void refresh(selected)}>Refresh</Button>
          {canUseSharedSkills('sharedSkills:create') && <Button variant="primary" size="sm" icon="plus" disabled={busy || !skills} onClick={() => { setFormError(null); setCreating({ name: '', description: '' }); }}>New shared skill</Button>}
        </div>
      </div>
      {error && <div className="skills-error" role="alert">{error}</div>}
      <div className="skills-body shared-skills-body">
        <div className="skills-list" aria-label="Shared skills">
          {!skills && !error && <div className="skills-loading" role="status"><Spinner size={16} /> Loading shared skills…</div>}
          {visible?.length === 0 && <div className="skill-none">{q ? 'No shared skills match your filter.' : 'No shared skills yet.'}</div>}
          {visible?.map((skill) => (
            <button key={skill.name} type="button" disabled={busy} aria-pressed={selected === skill.name}
              className={`skill-row ${selected === skill.name ? 'active' : ''}`} onClick={() => { if (!writing.current) void select(skill.name); }}>
              <span className="skill-main">
                <span className="skill-name"><Icon name="puzzle" size={12} /><span>{skill.name}</span></span>
                <span className="skill-desc">{skill.description}</span>
              </span>
              {(!selected || selected !== skill.name || doc) && skill.reviewed && <Badge tone="green">Reviewed</Badge>}
            </button>
          ))}
        </div>
        <div className="skills-preview">
          {doc ? (
            <>
              <div className="skills-preview-head shared-skills-preview-head">
                <span className="skills-preview-name">{doc.name}</span>
                <Badge tone={doc.reviewed ? 'green' : 'amber'}>{doc.reviewed ? 'Reviewed' : 'Review required'}</Badge>
                <span className="spacer" />
                {canUseSharedSkills('sharedSkills:save') && <Button size="sm" icon="edit" disabled={busy} onClick={() => { setFormError(null); setEditing({ base: doc, content: doc.content }); }}>Edit</Button>}
                {canUseSharedSkills('sharedSkills:review') && <Button size="sm" disabled={busy} onClick={review}>{doc.reviewed ? 'Disable' : 'Mark as reviewed'}</Button>}
                <Button size="sm" variant="primary" disabled={busy || !!useBlocker} aria-describedby={useHintId} onClick={stage}>Use in session</Button>
              </div>
              <p id={useHintId} className="skills-truncated shared-skills-note">{useBlocker ?? `Adds /skill ${doc.name} to your draft in “${active?.title}” without sending.`}</p>
              <p className="skills-truncated shared-skills-note">Review the instructions before enabling this revision. Sending the skill shares this text with the provider, which may retain or echo it. Review does not approve tools or change session permissions.</p>
              <pre className="skills-md shared-skill-content" aria-label="SKILL.md">{doc.content}</pre>
            </>
          ) : reading ? (
            <div className="skills-loading" role="status"><Spinner size={14} /> Loading SKILL.md…</div>
          ) : !error && (
            <div className="skills-preview-empty">
              <EmptyState icon="file" title="Select a shared skill">
                <p>Preview the local SKILL.md, then review or edit it before using it in a session.</p>
              </EmptyState>
            </div>
          )}
        </div>
      </div>
      {creating && (
        <Modal title="New shared skill" width={520} onClose={() => { if (!writing.current) setCreating(null); }} footer={<>
          <span className="spacer" />
          <Button size="sm" disabled={busy} onClick={() => setCreating(null)}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={busy || !creating.name.trim() || !creating.description.trim()} onClick={create}>Create</Button>
        </>}>
          <div className="skill-form">
            <Field label="Name"><input aria-label="Name" placeholder="my-skill" autoFocus value={creating.name} disabled={busy} onChange={(e) => setCreating({ ...creating, name: e.target.value })} /></Field>
            <Field label="Description"><textarea aria-label="Description" rows={3} value={creating.description} disabled={busy} onChange={(e) => setCreating({ ...creating, description: e.target.value })} /></Field>
            {formError && <div className="skills-error" role="alert">{formError}</div>}
          </div>
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit ${editing.base.name}`} onClose={() => { if (!writing.current) setEditing(null); }} footer={<>
          <span className="spacer" />
          <Button size="sm" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={busy || editing.content === editing.base.content} onClick={save}>Save</Button>
        </>}>
          <Field label="SKILL.md" hint="A changed revision needs to be reviewed again.">
            <textarea aria-label="SKILL.md" className="mono" rows={16} spellCheck={false} autoFocus value={editing.content} disabled={busy} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          </Field>
          {formError && <div className="skills-error" role="alert">{formError}</div>}
        </Modal>
      )}
    </>
  );
}
