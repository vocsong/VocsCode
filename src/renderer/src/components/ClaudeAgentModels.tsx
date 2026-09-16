/**
 * The model each Claude subagent type runs on, and the project definitions behind them.
 *
 * Claude's default here is the session's own model, applied for the whole session by the adapter, so
 * this list is mostly an account of what already happens. The exception is a definition the project
 * supplies in `.claude/agents`: Claude Code lets it pin a model, and a pinned definition also stops
 * the adapter forcing the session model on everything else — which is worth saying out loud, because
 * on a provider that is not Anthropic the unforced built-ins ask for Anthropic ids and are refused.
 *
 * A row with a definition behind it is its author's: the panel rewrites the `model:` line alone and
 * never restates the instructions. A built-in has no such file, so its row writes one — clicking it
 * opens the editor and saving *replaces* that built-in, which is the only way to pin the model it
 * runs on. That file takes the built-in's own instructions with it; the editor says so plainly,
 * because the app cannot read them back to keep them.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelInfo, SessionMeta } from '../../../shared/types';
import type { ClaudeAgentTypesInfo } from '../../../shared/ipc';
import { isClaudeBuiltinAgentType } from '../../../shared/claude-agent-files';
import { useSessionModels } from '../models';
import { invoke } from '../api';
import { Badge, Button, Field, Icon, Spinner } from './ui';

interface Row {
  name: string;
  description: string;
  file?: ClaudeAgentTypesInfo['files'][number];
}

interface Draft {
  name: string;
  description: string;
  prompt: string;
  /** The model to pin; empty means the definition inherits the session model. */
  model: string;
  /** Set when the draft overrides a built-in: the name is fixed to it and the write replaces it. */
  overrideOf?: string;
}

const emptyDraft = (): Draft => ({ name: '', description: '', prompt: '', model: '' });

export function ClaudeAgentModels({ session }: { session: SessionMeta }) {
  const [info, setInfo] = useState<ClaudeAgentTypesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const { models } = useSessionModels(session);

  const load = useCallback(() => {
    void invoke('claude-agents:list', { id: session.id })
      .then((result) => setInfo(result && Array.isArray(result.files) ? result : { types: [], files: [], sessionModel: null, forced: true }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.id]);
  useEffect(load, [load]);

  // A project definition can name a type the engine also lists; one row per name, file first.
  const rows = useMemo<Row[]>(() => {
    const byName = new Map<string, Row>();
    for (const type of info?.types ?? []) byName.set(type.name, { name: type.name, description: type.description });
    for (const file of info?.files ?? []) {
      const seen = byName.get(file.name);
      byName.set(file.name, { name: file.name, description: seen?.description ?? file.description, file });
    }
    return [...byName.values()];
  }, [info]);

  const save = (name: string, model: string) => {
    setBusy(name);
    void invoke('claude-agents:setModel', { id: session.id, name, model: model || null })
      .then((result) => {
        setBusy(null);
        if (!result.ok) setError(result.error ?? 'Could not save the model.');
        else {
          setError(null);
          load();
        }
      })
      .catch((e: unknown) => {
        setBusy(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const create = () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    void invoke('claude-agents:create', {
      id: session.id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      prompt: draft.prompt,
      model: draft.model.trim() || null,
      ...(draft.overrideOf ? { override: true } : {})
    })
      .then((result) => {
        setSaving(false);
        if (!result.ok) setError(result.error ?? 'Could not create the definition.');
        else {
          setDraft(null);
          load();
        }
      })
      .catch((e: unknown) => {
        setSaving(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  if (!info) {
    return (
      <div className="subagents">
        <div className="panel-empty">
          <Spinner size={16} /> Loading agent types…
        </div>
      </div>
    );
  }

  // The session's provider is the endpoint these types are served by, so it is the only honest set
  // of choices; a model from elsewhere would be sent to an endpoint that does not host it.
  const provider = session.config.model?.provider ?? session.activeModel?.provider;
  const offered = models.filter((m) => m.provider === provider);
  // A session that has named no model yet has no provider to narrow by, and an empty select would
  // be worse than a wide one: "Same as session" is still the default and the honest answer.
  const choices = offered.length ? offered : models;
  const taken = new Set((info.files ?? []).map((file) => file.name.toLowerCase()));
  const draftName = draft?.name.trim().toLowerCase() ?? '';
  const draftOverride = Boolean(draft?.overrideOf);
  const draftBuiltin = draft && !draftOverride ? isClaudeBuiltinAgentType(draft.name) || (info.types ?? []).some((type) => type.name.toLowerCase() === draftName) : false;
  // Clicking a built-in writes the definition that replaces it. The name is fixed: a definition only
  // overrides the built-in it is named after, and the engine's description is the honest starting
  // point. The built-in's instructions are the engine's, not ours, so the prompt starts empty.
  const openOverride = (row: Row) => setDraft({ name: row.name, description: row.description, prompt: '', model: '', overrideOf: row.name });

  return (
    <div className="subagents">
      {error && <div className="callout warn small">{error}</div>}
      <div className="agent-guidance muted small">
        Delegated agents run on <strong>{info.sessionModel ?? 'the session model'}</strong> — the model this session uses — unless a definition below pins another.
      </div>
      {!info.forced && (
        <div className="callout warn small">
          A definition in <code>.claude/agents</code> pins a model, so Claude Code is no longer held to the session model for the rest of its built-in
          types. Those will ask this endpoint for Anthropic models and be refused; pin them here too, or clear the pin.
        </div>
      )}
      {draft ? (
        <ClaudeAgentEditor
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={create}
          busy={saving}
          taken={taken.has(draftName)}
          builtin={draftBuiltin}
          choices={choices}
        />
      ) : (
        <>
          <div className="agent-section-head">
            <span>Definitions in this project</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon="plus" data-testid="claude-agent-new" onClick={() => setDraft(emptyDraft())}>
              New
            </Button>
          </div>
          {rows.length === 0 ? (
            <div className="panel-empty">
              <Icon name="fork" size={20} />
              <p>This project defines no Claude agents.</p>
              <p className="muted small">
                Create one above, or add <code>.claude/agents/&lt;Name&gt;.md</code> by hand. A definition adds a type the session can delegate to, and
                its model can be set here.
              </p>
              <p className="muted small">Claude Code&rsquo;s built-in types appear here while a session is running, each ready to override.</p>
            </div>
          ) : (
            <ul className="agent-grid" data-testid="claude-agent-types">
              {rows.map((row) => (
                <li key={row.name}>
                  {row.file ? (
                    <div className="agent-tile" data-testid={`claude-agent-${row.name}`}>
                      <span className="agent-tile-head">
                        <Icon name="fork" size={12} />
                        <span className="subagent-agent">{row.name}</span>
                        <span className="spacer" />
                        {busy === row.name ? <Spinner size={11} /> : <Badge tone="blue">project</Badge>}
                      </span>
                      <span className="subagent-desc">{row.description || 'No description'}</span>
                      <select
                        className="agent-model-select"
                        value={row.file.model ?? ''}
                        disabled={busy === row.name}
                        data-testid={`claude-agent-model-${row.name}`}
                        aria-label={`Model for ${row.name}`}
                        onChange={(e) => save(row.name, e.target.value)}
                      >
                        <option value="">Same as session</option>
                        {choices.map((m) => (
                          <option key={`${m.provider}/${m.id}`} value={m.id}>
                            {m.displayName || m.id}
                          </option>
                        ))}
                        {/* A pin the catalog no longer offers still has to be visible, or saving would drop it. */}
                        {row.file.model && !choices.some((m) => m.id === row.file?.model) && <option value={row.file.model}>{row.file.model}</option>}
                      </select>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="agent-tile agent-tile-main"
                      data-testid={`claude-agent-${row.name}`}
                      title="Write the project definition that replaces this built-in"
                      onClick={() => openOverride(row)}
                    >
                      <span className="agent-tile-head">
                        <Icon name="fork" size={12} />
                        <span className="subagent-agent">{row.name}</span>
                        <span className="spacer" />
                        <Badge tone="neutral">built-in</Badge>
                      </span>
                      <span className="subagent-desc">{row.description || 'No description'}</span>
                      <span className="subagent-meta muted small">Runs on the session model · override it to pin a model</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** The fields of a definition the panel is about to write: a new one, or one that overrides a built-in. */
function ClaudeAgentEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  busy,
  taken,
  builtin,
  choices
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  /** The project already has a definition with this name; saving would overwrite it. */
  taken: boolean;
  /** The name belongs to a built-in, which the definition would replace rather than extend. */
  builtin: boolean;
  /** The models this session's provider hosts, for the pin. */
  choices: ModelInfo[];
}) {
  const patch = (next: Partial<Draft>) => onChange({ ...draft, ...next });
  const override = Boolean(draft.overrideOf);
  const blocked = !override && (taken || builtin);
  return (
    <div className="agent-editor">
      <Field
        label="Name"
        hint={override ? 'A definition replaces the built-in it is named after, so the name is fixed.' : 'The type the subagent tool uses, e.g. reviewer'}
      >
        <input value={draft.name} disabled={override} placeholder="reviewer" data-testid="claude-agent-new-name" onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      {override && (
        <div className="callout warn small" data-testid="claude-agent-override-warning">
          {draft.name.trim()} is one of Claude Code&rsquo;s built-in types. This file replaces it: the built-in&rsquo;s own instructions are gone for
          this project, and Vocs Code cannot read them back. Write the instructions this agent should follow.
        </div>
      )}
      {builtin && (
        <div className="callout warn small" data-testid="claude-agent-new-builtin">
          {draft.name.trim()} is one of Claude Code&rsquo;s built-in types: a definition named after it replaces it. Pick another name, or override
          that built-in from its row.
        </div>
      )}
      {taken && !builtin && (
        <div className="callout warn small" data-testid="claude-agent-new-taken">
          This project already defines {draft.name.trim()}. Edit it in the list instead.
        </div>
      )}
      <Field label="Description" hint="Claude Code picks a subagent from this line, so say when to use it.">
        <input value={draft.description} placeholder="Reviews a diff against the repo rules" data-testid="claude-agent-new-description" onChange={(e) => patch({ description: e.target.value })} />
      </Field>
      <Field label="Model" hint="Empty inherits the session model; a pin makes the repo depend on that provider.">
        <select value={draft.model} data-testid="claude-agent-new-model" aria-label="Model to pin" onChange={(e) => patch({ model: e.target.value })}>
          <option value="">Same as session</option>
          {choices.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={m.id}>
              {m.displayName || m.id}
            </option>
          ))}
          {/* A pin the catalog no longer offers still has to be visible, or saving would drop it. */}
          {draft.model && !choices.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
        </select>
      </Field>
      <Field label="Instructions">
        <textarea
          rows={8}
          value={draft.prompt}
          placeholder="You review diffs and report findings…"
          data-testid="claude-agent-new-prompt"
          onChange={(e) => patch({ prompt: e.target.value })}
        />
      </Field>
      <div className="agent-editor-actions">
        <Button size="sm" disabled={busy || blocked || !draft.name.trim() || !draft.description.trim()} onClick={onSave} data-testid="claude-agent-new-save">
          {override ? 'Override' : 'Create'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
