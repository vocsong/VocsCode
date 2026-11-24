import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  canTransition, isRecallableState, isServableState,
  type MemoryExportBundle, type MemoryRecord, type MemoryState, type MemoryVerification
} from '../../../../shared/intelligence';
import { invoke, isWeb, on } from '../../api';
import { Badge, Button } from '../ui';
import { ConfirmAction, LOCAL_RECALL_NOTE, LOCAL_RECALL_PRIVACY_NOTICE, LOCAL_REFLECTION_NOTE, PromoteControl, REFLECTION_PRIVACY_NOTICE, shortDate } from './controls';
import { readIntelligence, useScopeGuard, type IntelligenceController, type IntelligenceSectionProps } from './useIntelligence';

const FILTERS = [['all', 'All'], ['servable', 'Active or verified'], ['unverified', 'Unverified'], ['history', 'Inactive']] as const;
type Filter = (typeof FILTERS)[number][0];
const TRANSITIONS = [['verified', 'Verify'], ['active', 'Activate'], ['uncertain', 'Uncertain'], ['rejected', 'Reject'], ['expired', 'Expire'], ['revoked', 'Revoke']] as const;

function verificationText(verification: MemoryVerification) {
  switch (verification.method) {
    case 'human-review': return 'Verified by a person';
    case 'commit': return `Verified against commit${verification.revision ? ` ${verification.revision.slice(0, 12)}` : ''}`;
    case 'test': return 'Verified by a test run';
    case 'source-check': return 'Verified by a source check';
  }
}

/** Measure the collapsed text so short entries don't gain a redundant tab stop. */
function MemoryText({ text }: { text: string }) {
  const id = useId();
  const body = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    return () => resize.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p id={id} ref={body} className={`intelligence-text${expanded ? '' : ' intelligence-clamped'}`}>{text}</p>
      {(overflow || expanded) && <div className="intelligence-actions">
        <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</Button>
      </div>}
    </>
  );
}

/** Authority follows recorded evidence, never the author or the presence of a citation alone. */
function MemoryRow({ record, group, sessionId, view, busy, run, onApplied }: IntelligenceSectionProps & {
  record: MemoryRecord;
  group: 'project' | 'personal' | 'shared';
  onApplied: (pageId: string) => void;
}) {
  const { state, verification, id, updatedAt } = record;
  const checked = state === 'verified' ? verification : undefined;
  const unverified = !isServableState(state) && isRecallableState(state);
  const stateLabel = state === 'verified' && !checked ? 'verification missing' : state;
  const collection = view.collections.find((c) => c.id === record.collectionId);
  const decide = (to: MemoryState) => run(() => invoke('intelligence:memory:decide', { sessionId, id, to }));
  return (
    <article className="intelligence-card" data-testid="memory-row" data-state={state} data-record-id={id} data-scope={record.scope}>
      <div className="intelligence-row">
        <h4>{record.title}</h4>
        <span data-testid="memory-state"><Badge tone={state === 'active' || checked ? 'green' : unverified || state === 'verified' ? 'amber' : 'neutral'}>{stateLabel}</Badge></span>
      </div>
      <p className="muted small">{record.type} · {record.kind} · {record.origin} · <time dateTime={updatedAt} title={updatedAt}>{shortDate(updatedAt)}</time></p>
      {group === 'shared' && <p className="muted small">{collection?.name ?? record.collectionId ?? 'Collection'}{record.promotedFrom?.projectName ? ` · from ${record.promotedFrom.projectName}` : ''}</p>}
      <MemoryText text={record.text} />
      {!!record.sources.length && <ul className="muted small" aria-label="Sources">
        {record.sources.map((source, i) => (
          <li key={i}>{source.type}: {source.ref}{source.revision && <> @<code title={source.revision}>{source.revision.slice(0, 12)}</code></>}</li>
        ))}
      </ul>}
      {checked && <p className="small">{verificationText(checked)}</p>}
      {/* Keep history distinct from guidance even when a candidate carries old verification data. */}
      {unverified && <p className="muted small">Not checked — history, not guidance</p>}
      <div className="intelligence-actions">
        {group === 'project' ? (
          <>
            {TRANSITIONS.map(([to, label]) => canTransition(state, to) && <Button key={to} size="sm" disabled={busy} data-testid={`memory-${label.toLowerCase()}`} onClick={() => void decide(to)}>{label}</Button>)}
            <Button size="sm" data-testid="memory-apply" disabled={busy} title="Write this record as a human-reviewed wiki page" onClick={() => void run(async (current) => {
              const result = await invoke('intelligence:memory:apply', { sessionId, id });
              if (current()) onApplied(result.pageId);
              return result.view;
            })}>Write to wiki</Button>
            <PromoteControl prefix="memory" view={view} busy={busy} disabledReason={checked ? undefined : 'Verify it first'}
              onPromote={(target) => run(() => invoke('intelligence:promote', { sessionId, recordId: id, ...target }))} />
          </>
        ) : canTransition(state, 'revoked') && <Button size="sm" data-testid="memory-revoke" disabled={busy} onClick={() => void decide('revoked')}>Revoke</Button>}
        <ConfirmAction label="Forget" detail="Forgetting removes this record and its promoted copies." testId="memory-forget" busy={busy}
          onConfirm={() => run(() => invoke('intelligence:memory:forget', { sessionId, id }))} />
      </div>
    </article>
  );
}

/** Drafts live only in this session; a rejected save leaves the draft editable. */
function AddMemoryForm({ sessionId, busy, run, id, onSaved }: Pick<IntelligenceSectionProps, 'sessionId' | 'busy' | 'run'> & { id: string; onSaved: () => void }) {
  const [type, setType] = useState<'episodic' | 'procedural' | 'preference'>('episodic');
  const [scope, setScope] = useState<'project' | 'personal'>('project');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const canSave = !busy && !!title.trim() && !!text.trim();
  return (
    <form id={id} className="intelligence-card" data-testid="memory-add-form" onSubmit={async (e) => {
      e.preventDefault();
      if (canSave && await run(() => invoke('intelligence:memory:add', { sessionId, type, scope, title: title.trim(), text: text.trim() }))) onSaved();
    }}>
      <label className="intelligence-field">Kind
        <select data-testid="memory-add-type" value={type} disabled={busy} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="episodic">Lesson</option>
          <option value="procedural">Procedure</option>
          <option value="preference">Preference</option>
        </select>
      </label>
      <label className="intelligence-field">Scope
        <select data-testid="memory-add-scope" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value === 'personal' ? 'personal' : 'project')}>
          <option value="project">This project</option>
          <option value="personal">Personal</option>
        </select>
      </label>
      <label className="intelligence-field">Title
        <input data-testid="memory-add-title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label className="intelligence-field">Text
        <textarea data-testid="memory-add-text" value={text} disabled={busy} rows={4} onChange={(e) => setText(e.target.value)} required />
      </label>
      <div className="intelligence-actions"><Button size="sm" type="submit" variant="primary" data-testid="memory-add-save" disabled={!canSave}>Save</Button></div>
    </form>
  );
}

function downloadMemory(bundle: MemoryExportBundle) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `vocs-memory-${bundle.project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')}.json`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Allow the browser to consume the URL before the export is released.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Coalesce durable-write notifications within this Memory visit, even during the initial read. */
export function MemoryRefresh({ sessionId, busy, run }: Pick<IntelligenceSectionProps, 'sessionId' | 'busy'> & Pick<IntelligenceController, 'run'>) {
  const [changed, setChanged] = useState(false);
  const capture = useScopeGuard();
  useLayoutEffect(() => {
    if (isWeb || !window.harness?.on) return;
    return on('push:projectMemoryChanged', (event) => {
      if (event.sessionId === sessionId && document.visibilityState !== 'hidden') setChanged(true);
    });
  }, [sessionId]);
  useEffect(() => {
    if (!changed || busy) return;
    if (document.visibilityState === 'hidden') { setChanged(false); return; }
    const current = capture();
    void run('load', async () => {
      setChanged(false);
      // Keep the current view and action results if this background read fails.
      const next = await readIntelligence(sessionId).catch(() => undefined);
      if (current() && document.visibilityState !== 'hidden') return next;
    });
  }, [busy, capture, changed, run, sessionId]);
  return null;
}

/** A ledger of current guidance, reviewable candidates and history, with explicit scope changes. */
export function MemoryView(props: IntelligenceSectionProps) {
  const { view, sessionId, busy, run } = props;
  const addId = useId();
  const reflectionNote = useId();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [reflect, setReflect] = useState<{ text: string; failed: boolean } | null>(null);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  if (!view.available) return <div className="intelligence-view"><p className="muted">{view.reason ?? 'The memory ledger is unavailable.'}</p></div>;

  const list = (records: MemoryRecord[], group: 'project' | 'personal' | 'shared', empty: string) => {
    const shown = records.filter(({ state }) => {
      if (filter === 'servable') return isServableState(state);
      if (filter === 'unverified') return isRecallableState(state) && !isServableState(state);
      if (filter === 'history') return !isRecallableState(state);
      return true;
    }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return shown.length ? shown.map((record) => <MemoryRow key={record.id} {...props} record={record} group={group} onApplied={(pageId) => setNotice(`Written to wiki page ${pageId}`)} />)
      : <p className="muted small">{filter === 'all' ? empty : 'No records here match this filter.'}</p>;
  };
  const reflectionOff = view.settings.reflection === 'off';
  const importFile = (file: File) => run(async (current) => {
    setNotice('');
    const contents = await file.text();
    let bundle: unknown;
    try {
      bundle = JSON.parse(contents);
    } catch {
      throw new Error('That file is not valid JSON');
    }
    if (!current()) return;
    const result = await invoke('intelligence:memory:import', { sessionId, bundle });
    if (current()) setNotice(`Imported ${result.imported}, skipped ${result.skipped}`);
    return result.view;
  });

  return (
    <div className="intelligence-view">
      {view.settings.reflection === 'local' && <p className="muted small">{LOCAL_REFLECTION_NOTE}</p>}
      <p className="muted small">{LOCAL_RECALL_NOTE}</p>
      <p className="muted small">{LOCAL_RECALL_PRIVACY_NOTICE}</p>
      <p id={reflectionNote} className="intelligence-warning small">{REFLECTION_PRIVACY_NOTICE}</p>
      <div className="intelligence-actions">
        <Button size="sm" data-testid="memory-reflect" aria-describedby={reflectionNote} disabled={busy || reflectionOff} title={reflectionOff ? 'Session reflection is off in Sources.' : undefined} onClick={() => void run(async (current) => {
          setReflect(null);
          const result = await invoke('intelligence:reflect', { sessionId });
          if (!current()) return;
          setReflect({ text: result.ok ? result.detail ?? `Captured ${result.captured}, found ${result.candidates} candidate lesson(s).` : result.error ?? result.detail ?? 'Reflection failed.', failed: !result.ok });
          if (result.ok) return readIntelligence(sessionId);
        })}>Reflect on this session</Button>
        <Button size="sm" variant="primary" data-testid="memory-add" disabled={busy} aria-expanded={adding} aria-controls={adding ? addId : undefined} onClick={() => setAdding(!adding)}>Add</Button>
      </div>
      {reflect && <p className={reflect.failed ? 'intelligence-error' : 'muted small'} role={reflect.failed ? 'alert' : 'status'} data-testid="memory-reflect-result">{reflect.text}</p>}
      {notice && <p className="muted small" role="status" data-testid="memory-result">{notice}</p>}
      {adding && <AddMemoryForm id={addId} sessionId={sessionId} busy={busy} run={run} onSaved={() => setAdding(false)} />}
      <div className="intelligence-actions" role="group" aria-label="Filter memories">
        {FILTERS.map(([value, label]) => (
          <Button key={value} size="sm" variant={filter === value ? 'subtle' : 'ghost'} aria-pressed={filter === value} data-testid={`memory-filter-${value}`} onClick={() => setFilter(value)}>{label}</Button>
        ))}
      </div>
      {!!view.promotions.length && <section className="intelligence-fields">
        <h3>Promotion requests</h3>
        {view.promotions.map((request) => {
          const target = request.to === 'personal' ? 'Personal memory' : view.collections.find((c) => c.id === request.collectionId)?.name ?? request.collectionId ?? 'Collection';
          return (
            <article key={request.id} className="intelligence-card" data-testid="promotion-row" data-promotion-id={request.id}>
              <h4>{request.title}</h4>
              <p className="intelligence-text">{request.text}</p>
              <p className="muted small">To {target} · requested by {request.requestedBy}</p>
              <div className="intelligence-actions">
                <Button size="sm" data-testid="promotion-approve" disabled={busy} title="Approve this snapshot as a human reviewer" onClick={() => void run(() => invoke('intelligence:promotion:decide', { sessionId, id: request.id, decision: 'approve' }))}>Approve</Button>
                <Button size="sm" data-testid="promotion-reject" disabled={busy} onClick={() => void run(() => invoke('intelligence:promotion:decide', { sessionId, id: request.id, decision: 'reject' }))}>Reject</Button>
              </div>
            </article>
          );
        })}
      </section>}
      <section className="intelligence-fields">
        <h3>This project</h3>
        {list(view.records, 'project', 'No project memories yet.')}
      </section>
      <section className="intelligence-fields">
        <h3>Personal</h3>
        <p className="muted small">Personal memory is {view.settings.personalMemory ? 'on and served to sessions' : 'off; these records are not served to sessions'}.</p>
        {list(view.personal, 'personal', 'No personal memories yet — use Add to save a personal preference or procedure.')}
      </section>
      <section className="intelligence-fields">
        <h3>Shared with this project</h3>
        {list(view.shared, 'shared', 'No shared memories yet — promote a record into a collection to share it.')}
      </section>
      <footer className="intelligence-fields">
        <div className="intelligence-actions">
          <Button size="sm" data-testid="memory-export" disabled={busy} onClick={() => void run(async (current) => {
            const bundle = await invoke('intelligence:memory:export', { sessionId });
            if (current()) downloadMemory(bundle);
          })}>Export</Button>
          <Button size="sm" data-testid="memory-import" disabled={busy} onClick={() => fileInput.current?.click()}>Import</Button>
          <input ref={fileInput} type="file" hidden aria-label="Memory export file" data-testid="memory-import-file" accept=".json,application/json" onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importFile(file);
          }} />
        </div>
        <details className="intelligence-card" data-testid="memory-activity">
          <summary>Activity</summary>
          {view.audit.length ? <ul className="muted small">{view.audit.map(({ at, action, actor, detail }, i) => (
            <li key={i}><time dateTime={at} title={at}>{shortDate(at)}</time> · {action} · {actor}{detail ? ` — ${detail}` : ''}</li>
          ))}</ul> : <p className="muted small">No activity yet — memory changes will appear here.</p>}
        </details>
      </footer>
    </div>
  );
}
