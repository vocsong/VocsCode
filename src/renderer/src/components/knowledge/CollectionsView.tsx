import React, { useState } from 'react';
import type { CollectionMember, CollectionShare, ProjectCollection, ProjectIdentity } from '../../../../shared/intelligence';
import { invoke } from '../../api';
import { Button } from '../ui';
import { ConfirmAction } from './controls';
import type { IntelligenceSectionProps, RunIntelligence } from './useIntelligence';

type CollectionDraft = { name: string; description?: string; members: CollectionMember[] };

/** Membership edits are staged locally; only Save replaces the registry's full member list. */
function CollectionCard({ collection, projects, sessionId, busy, run }: {
  collection: ProjectCollection;
  projects: ProjectIdentity[];
  sessionId: string;
  busy: boolean;
  run: RunIntelligence;
}) {
  const [draft, setDraft] = useState<CollectionDraft | null>(null);
  const displayed = draft ?? collection;
  const available = projects.filter((p) => !displayed.members.some((m) => m.projectId === p.id));
  const edit = (change: Partial<CollectionDraft>) => setDraft((previous) => ({
    name: collection.name, description: collection.description, members: collection.members, ...previous, ...change
  }));

  return (
    <article className="intelligence-card" data-testid="collection-card" data-collection-id={collection.id}>
      <h4>{collection.name}</h4>
      <label className="intelligence-field">Name
        <input value={displayed.name} disabled={busy} onChange={(e) => edit({ name: e.target.value })} />
      </label>
      <label className="intelligence-field">Description
        <textarea rows={2} value={displayed.description ?? ''} disabled={busy} onChange={(e) => edit({ description: e.target.value })} />
      </label>
      <ul className="intelligence-members">
        {displayed.members.map((member) => {
          const name = projects.find((p) => p.id === member.projectId)?.name ?? member.projectId;
          return (
            <li key={member.projectId} className="intelligence-row">
              <label className="intelligence-field"><span>{name}</span>
                <select aria-label={`Sharing for ${name}`} data-testid="collection-share" value={member.share} disabled={busy} onChange={(e) => {
                  const share = e.target.value as CollectionShare;
                  edit({ members: displayed.members.map((m) => m.projectId === member.projectId ? { ...m, share } : m) });
                }}>
                  <option value="promoted">Promoted records only</option>
                  <option value="wiki">Wiki pages too</option>
                </select>
              </label>
              <Button size="sm" aria-label={`Remove ${name}`} disabled={busy} onClick={() => edit({ members: displayed.members.filter((m) => m.projectId !== member.projectId) })}>Remove</Button>
            </li>
          );
        })}
      </ul>
      <label className="intelligence-field">Add project
        <select value="" disabled={busy || !available.length} onChange={(e) => edit({ members: [...displayed.members, { projectId: e.target.value, share: 'promoted' }] })}>
          <option value="" disabled>{available.length ? 'Choose a project' : 'No other projects available'}</option>
          {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <div className="intelligence-actions">
        <Button size="sm" variant="primary" data-testid="collection-save" disabled={busy || !displayed.name.trim()} onClick={async () => {
          const { name, members } = displayed;
          const description = displayed.description?.trim();
          if (await run(() => invoke('intelligence:collection:save', { sessionId, id: collection.id, name: name.trim(), ...(description ? { description } : {}), members }))) setDraft(null);
        }}>Save</Button>
        <ConfirmAction label="Delete" detail="Deleting this collection revokes everything promoted into it." testId="collection-delete" busy={busy}
          onConfirm={() => run(() => invoke('intelligence:collection:delete', { sessionId, id: collection.id }))} />
      </div>
    </article>
  );
}

/** The checkout identity is separate from the explicit groups allowed to share its knowledge. */
export function CollectionsView({ sessionId, view, busy, run }: IntelligenceSectionProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { project } = view;
  return (
    <div className="intelligence-view">
      <article className="intelligence-card">
        <h3>{project.name}</h3>
        <p className="muted small">Project ID: <code>{project.id}</code></p>
        {project.origin && <p className="muted small">Origin: {project.origin}</p>}
        {!!project.roots.length && <ul>{project.roots.map((root) => <li key={root}><code>{root}</code></li>)}</ul>}
      </article>
      <p className="muted small">Membership is explicit. Each member chooses what it exposes, and session history is never shared. Deleting a collection revokes what was promoted into it.</p>
      {view.collections.length ? view.collections.map((collection) => (
        <CollectionCard key={collection.id} collection={collection} projects={view.projects} sessionId={sessionId} busy={busy} run={run} />
      )) : <p className="muted small">No collections yet — create one to share selected knowledge between projects.</p>}
      <section className="intelligence-card">
        <h3>New collection</h3>
        <label className="intelligence-field">Collection name
          <input data-testid="collection-new-name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="intelligence-field">Description (optional)
          <textarea rows={2} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="intelligence-actions">
          <Button size="sm" variant="primary" data-testid="collection-new-create" disabled={busy || !name.trim()} onClick={async () => {
            if (await run(() => invoke('intelligence:collection:save', {
              sessionId, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), members: [{ projectId: project.id, share: 'promoted' }]
            }))) {
              setName('');
              setDescription('');
            }
          }}>Create collection</Button>
        </div>
      </section>
    </div>
  );
}
