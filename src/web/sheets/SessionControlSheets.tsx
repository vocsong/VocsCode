import { useState } from 'react';

/** The session control sheets: model, effort, permission mode and usage. Each writes through the
 *  same channels the desktop header uses; a view-only host disables the chips before opening. */
import { canInvoke, invoke } from '@renderer/api';
import { fmtCost, fmtTokens } from '@renderer/format';
import { useSessionModels } from '@renderer/models';
import { setSessionEffort } from '@renderer/sessionActions';
import { askConfirm, Button, Spinner } from '@renderer/components/ui';
import { modelRefName } from '@shared/model-names';
import { PERMISSION_MODE_LABELS } from '@shared/harness-meta';
import { useStore } from '@renderer/store';
import type { SessionMeta } from '@shared/types';
import { permissionOptions, effortOptions, type SessionControlOption } from '@renderer/session-controls';
import { ModelPicker } from '@renderer/components/ModelPicker';
import { BottomSheet } from './BottomSheet';

function OptionList<T extends string>({ options, active, onPick }: { options: SessionControlOption<T>[]; active?: T; onPick: (value: T) => void }) {
  return (
    <ul className="w-list">
      {options.map((option) => (
        <li key={option.value} className={`w-list-row ${option.value === active ? 'is-active' : ''}`}>
          <button type="button" className="w-list-main" onClick={() => onPick(option.value)}>
            <span className="w-list-name">{option.label}</span>
            {option.hint && <span className="w-list-hint">{option.hint}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ModelSheet({ session, onClose }: { session: SessionMeta; onClose: () => void }) {
  const { models, loading, error } = useSessionModels(session);
  const toast = useStore((s) => s.toast);
  return (
    <BottomSheet title="Model" onClose={onClose}>
      <ModelPicker
        models={models}
        loading={loading}
        error={error}
        selected={session.activeModel ?? session.config.model}
        emptyText="No models available."
        onSelect={(model) => {
          onClose();
          if (!model) return;
          void invoke('sessions:setModel', { id: session.id, model: { provider: model.provider, model: model.id } })
            .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'));
        }}
      />
    </BottomSheet>
  );
}

export function EffortSheet({ session, onClose }: { session: SessionMeta; onClose: () => void }) {
  const { models, loading } = useSessionModels(session);
  const toast = useStore((s) => s.toast);
  const current = session.activeModel ?? session.config.model;
  const info = models.find((m) => current && m.id === current.model && m.provider === current.provider);
  const options = effortOptions(session, info);
  return (
    <BottomSheet title="Reasoning effort" onClose={onClose}>
      {loading && <div className="w-loading"><Spinner /></div>}
      <OptionList
        options={options}
        active={session.activeEffort ?? session.config.effort ?? undefined}
        onPick={(value) => {
          onClose();
          void setSessionEffort(session.id, value, toast);
        }}
      />
    </BottomSheet>
  );
}

export function PermissionSheet({ session, onClose }: { session: SessionMeta; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const mode = session.config.permissionMode;
  return (
    <BottomSheet title="Permissions" onClose={onClose}>
      <OptionList
        options={permissionOptions(session)}
        active={mode}
        onPick={(value) => {
          void (async () => {
            // Escalation is a deliberate choice: confirm before letting an agent run unattended.
            if (value === 'auto' || value === 'full-auto') {
              const ok = await askConfirm({
                title: `Switch to ${PERMISSION_MODE_LABELS[value].label}?`,
                body: PERMISSION_MODE_LABELS[value].description,
                confirmLabel: 'Switch',
                danger: value === 'full-auto'
              });
              if (!ok) return;
            }
            onClose();
            void invoke('sessions:setPermissionMode', { id: session.id, mode: value })
              .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'));
          })();
        }}
      />
    </BottomSheet>
  );
}

export function UsageSheet({ session, onClose }: { session: SessionMeta; onClose: () => void }) {
  const usage = session.usage;
  const pct = usage.contextWindow && usage.contextTokens ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100)) : null;
  const rows: Array<[string, string]> = [
    ['Input', fmtTokens(usage.inputTokens)],
    ['Output', fmtTokens(usage.outputTokens)],
    ['Cache read', fmtTokens(usage.cacheReadTokens)],
    ['Cache write', fmtTokens(usage.cacheWriteTokens)],
    ['Cost', fmtCost(usage.costUsd)],
    ['Turns', String(usage.turns)],
    ['Context', pct === null ? 'unknown' : `${pct}%`]
  ];
  return (
    <BottomSheet title="Usage" onClose={onClose}>
      <ul className="w-list">
        {rows.map(([label, value]) => (
          <li key={label} className="w-list-row">
            <span className="w-list-main"><span className="w-list-name">{label}</span></span>
            <span className="w-list-hint">{value}</span>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}

/** The chip row under the session header. */
export function SessionControls({ session }: { session: SessionMeta }) {
  const [sheet, setSheet] = useState<'model' | 'effort' | 'permission' | 'usage' | null>(null);
  const { models } = useSessionModels(session);
  const current = session.activeModel ?? session.config.model;
  const info = models.find((m) => current && m.id === current.model && m.provider === current.provider);
  const writeAllowed = canInvoke('sessions:setModel');
  const action = (open: typeof sheet) => () => {
    if (writeAllowed) setSheet(open);
  };
  return (
    <div className="w-controls" data-testid="session-controls">
      <button type="button" className="w-chip" disabled={!writeAllowed} onClick={action('model')}>{modelRefName(current) ?? 'default model'}</button>
      {effortOptions(session, info).length > 0 && (
        <button type="button" className="w-chip" disabled={!writeAllowed} onClick={action('effort')}>{session.activeEffort ?? session.config.effort ?? 'effort'}</button>
      )}
      <button type="button" className="w-chip" disabled={!writeAllowed} onClick={action('permission')}>{PERMISSION_MODE_LABELS[session.config.permissionMode].short}</button>
      <button type="button" className="w-chip" onClick={() => setSheet('usage')}>{fmtCost(session.usage.costUsd)}</button>
      {sheet === 'model' && <ModelSheet session={session} onClose={() => setSheet(null)} />}
      {sheet === 'effort' && <EffortSheet session={session} onClose={() => setSheet(null)} />}
      {sheet === 'permission' && <PermissionSheet session={session} onClose={() => setSheet(null)} />}
      {sheet === 'usage' && <UsageSheet session={session} onClose={() => setSheet(null)} />}
    </div>
  );
}
