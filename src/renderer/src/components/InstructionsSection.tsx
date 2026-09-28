/**
 * Settings → Instructions. The app's own instruction layer: one shared file added to every session,
 * plus one file per harness family added on top of it. Neither replaces the harness's own global
 * file (`APPEND_SYSTEM.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) — that keeps applying
 * through its engine, and this layer is added after the engine's own prompt.
 */
import React, { useEffect, useState } from 'react';
import { APP_INSTRUCTION_HINTS, APP_INSTRUCTION_LABELS, APP_INSTRUCTION_MAX_CHARS, APP_INSTRUCTION_SCOPES } from '../../../shared/app-instructions';
import type { AppInstructionFile, AppInstructionScope } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { Badge, Button, Spinner } from './ui';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function InstructionsSection() {
  const [files, setFiles] = useState<AppInstructionFile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<AppInstructionScope>('global');
  const [drafts, setDrafts] = useState<Partial<Record<AppInstructionScope, string>>>({});
  const [saving, setSaving] = useState(false);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    invoke('instructions:read', undefined)
      .then((next) => {
        setFiles(next);
        setLoadError(null);
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);

  const file = files?.find((f) => f.scope === scope);
  const draft = drafts[scope] ?? file?.content ?? '';
  const dirty = !!file && draft !== file.content;
  const tooLong = draft.length > APP_INSTRUCTION_MAX_CHARS;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = await invoke('instructions:write', { scope, content: draft });
      setFiles(next);
      setDrafts((d) => {
        const copy = { ...d };
        delete copy[scope];
        return copy;
      });
      toast(draft.trim() ? 'Instructions saved' : 'Instructions cleared', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section">
      <h2>Instructions</h2>
      <p className="muted small">
        Text this app adds to a session&rsquo;s system prompt, whichever harness runs it. The shared file applies to every harness; a harness tab is added after it, so nothing here replaces the shared text. This does not touch a harness&rsquo;s own global file (<code>APPEND_SYSTEM.md</code>, <code>~/.claude/CLAUDE.md</code>, <code>~/.codex/AGENTS.md</code>) — that keeps applying on its own, so put a rule in one place or the other, not both. Saving an empty file removes it.
      </p>
      <p className="muted small">
        Pi, Claude Agent SDK and the native loop take this in their system prompt at session start; Codex, Cursor and ACP agents get it on the first message instead, because their engines own the prompt. Either way it is read once when the session starts, so an edit applies to your next session, not one already running.
      </p>

      {loadError && (
        <div className="info-line info-warn">
          <span>Could not read the instruction files: {loadError}</span>
        </div>
      )}

      <div className="pi-tabs">
        {APP_INSTRUCTION_SCOPES.map((s) => {
          const item = files?.find((f) => f.scope === s);
          return (
            <button key={s} type="button" className={`pi-tab ${scope === s ? 'active' : ''}`} onClick={() => setScope(s)}>
              {APP_INSTRUCTION_LABELS[s]}
              {item?.truncated ? <Badge tone="amber">too large</Badge> : item && !item.exists ? <Badge tone="neutral">not set</Badge> : null}
            </button>
          );
        })}
      </div>
      <p className="muted small">{APP_INSTRUCTION_HINTS[scope]}</p>

      {file?.truncated ? (
        <div className="info-line info-warn">
          <span>This file is larger than {Math.round(APP_INSTRUCTION_MAX_CHARS / 1000)} KB; edit it in an external editor.</span>
        </div>
      ) : (
        <>
          <textarea
            className="pi-prompt-editor"
            spellCheck={false}
            disabled={!files}
            value={draft}
            onChange={(e) => setDrafts((d) => ({ ...d, [scope]: e.target.value }))}
            placeholder={`${scope} instructions are not set`}
          />
          <div className="pi-prompt-actions">
            <span className="muted small mono">{file?.path}</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDrafts((d) => ({ ...d, [scope]: file?.content ?? '' }))}>
              Revert
            </Button>
            <Button size="sm" disabled={!dirty || saving || tooLong} onClick={() => void save()}>
              {saving ? <Spinner /> : 'Save'}
            </Button>
          </div>
          {tooLong && (
            <div className="info-line info-warn">
              <span>Instructions are limited to {Math.round(APP_INSTRUCTION_MAX_CHARS / 1000)} KB per file.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
