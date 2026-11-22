/**
 * The model pill reads provider/model with the reasoning effort beside it in a lighter weight, and
 * opens the full model identity, Effort and Fast controls.
 * Permissions stay visible; the context ring toggles Usage. Secondary details live in menus.
 */
import React from 'react';
import type { ModelInfo, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { modelName, modelRefName, parseTypedModel } from '../../../shared/model-names';
import { invoke } from '../api';
import { fmtCost, fmtTokens } from '../format';
import { setSessionEffort } from '../sessionActions';
import { effortOptions, permissionOptions } from '../session-controls';
import { useSessionModels } from '../models';
import { useStore } from '../store';
import { Dropdown, Icon, MenuItem } from './ui';
import { ModelMenu } from './ModelMenu';

export function SessionControls({ session }: { session: SessionMeta }) {
  const { models, loading: modelsLoading, error: modelsError } = useSessionModels(session);
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.settings?.providers) ?? [];
  const h = HARNESS_BY_ID[session.config.harness];

  const current = session.activeModel ?? session.config.model;
  const currentInfo = models.find((m) => current && m.id === current.model && m.provider === current.provider);
  const effortLevels = effortOptions(session, currentInfo);
  const modes = permissionOptions(session);
  const mode = session.config.permissionMode;
  const modeLabel = mode ? PERMISSION_MODE_LABELS[mode] : undefined;
  const effort = session.activeEffort ?? session.config.effort ?? undefined;
  // Keep the complete identity/settings accessible even when the compact label truncates.
  const effortLabel = h.capabilities.effort && effortLevels.length ? effort ?? 'default' : undefined;
  // The visual cue marks the saved preference, not the runtime's reported tier.
  const fastSelected = session.config.fastMode;
  const fastLabel = fastSelected ? `Fast ${session.fastModeStatus?.state ?? 'requested'}` : undefined;
  const modelDetail = [modelRefName(current) ?? 'default model', effortLabel && `Effort: ${effortLabel}`, fastLabel].filter(Boolean).join(' · ');

  const setModel = async (m: ModelInfo) => {
    try {
      await invoke('sessions:setModel', { id: session.id, model: { provider: m.provider, model: m.id } });
    } catch (e) {
      toast(`Model switch failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="run-controls">
      <Dropdown
        align="left"
        trigger={(open) => (
          <button type="button" className={`pill pill-model${fastSelected ? ' is-fast' : ''}${open ? ' open' : ''}`} title="Model" aria-label={`Model: ${modelDetail}`}>
            <Icon name={fastSelected ? 'bolt' : 'sparkles'} size={13} />
            {/* Provider first: the same model can be reached through more than one provider. */}
            <span className="pill-text" title={modelRefName(current)}>{current ? modelName(current.provider, currentInfo?.displayName ?? current.model) : 'Default model'}</span>
            {effortLabel && <span className="pill-effort">{effortLabel}</span>}
            <Icon name="chevron" size={12} />
          </button>
        )}
      >
        {(close) => (
          <ModelMenu
            session={session}
            models={models}
            loading={modelsLoading}
            error={modelsError}
            current={current}
            emptyText={h.capabilities.liveModelSwitch ? 'No models available.' : 'No models available (this harness cannot switch models live).'}
            effortSupported={h.capabilities.effort}
            effortLevels={effortLevels}
            effort={effort}
            noEffortNote={`${currentInfo?.displayName ?? 'This model'} does not support reasoning effort`}
            onSelect={(m) => void setModel(m)}
            onSelectCustom={(id) => {
              const ref = parseTypedModel(id, providers.map((p) => p.id), (current ?? models[0])?.provider ?? 'anthropic');
              void setModel({ id: ref.model, provider: ref.provider, displayName: ref.model });
            }}
            onEffort={(level) => void setSessionEffort(session.id, level, toast)}
            close={close}
          />
        )}
      </Dropdown>

      {/* A restored session can lack a mode; don't offer a selector until one exists. */}
      {modeLabel && (
        <Dropdown
          align="left"
          trigger={(open) => (
            <button type="button" className={`pill run-permission mode-${mode} ${open ? 'open' : ''}`} title="Permission mode" aria-label={`Permission mode: ${modeLabel.short}`}>
              <Icon name="shield" size={13} /> <span className="pill-text">{modeLabel.short}</span> <Icon name="chevron" size={12} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="run-more-label">Permission mode</div>
              {modes.map((option) => (
                <MenuItem key={option.value} active={option.value === mode} hint={option.hint} onClick={() => { close(); void invoke('sessions:setPermissionMode', { id: session.id, mode: option.value }); }}>
                  {option.label}
                </MenuItem>
              ))}
            </>
          )}
        </Dropdown>
      )}
    </div>
  );
}

/** Context stays glanceable; spend and token details are in the options menu / Usage panel. */
export function SessionMeter({ session }: { session: SessionMeta }) {
  const usageOpen = useStore((s) => s.panelOpen && s.panelTab === 'usage');
  const ctxPct = session.usage.contextWindow && session.usage.contextTokens ? Math.min(100, Math.round((session.usage.contextTokens / session.usage.contextWindow) * 100)) : null;
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={`session-meter ${ctxPct !== null && ctxPct >= 80 ? 'session-meter-high' : ''}`}
      title={`${fmtCost(session.usage.costUsd)} · Input ${fmtTokens(session.usage.inputTokens)} · Output ${fmtTokens(session.usage.outputTokens)} · Cache read ${fmtTokens(session.usage.cacheReadTokens)}${ctxPct !== null ? ` · Context ${ctxPct}%` : ''} — ${usageOpen ? 'close' : 'open'} Usage`}
      aria-label="Session usage"
      aria-expanded={usageOpen}
      onClick={() => {
        const { panelOpen, panelTab, setPanelTab, togglePanel } = useStore.getState();
        if (panelOpen && panelTab === 'usage') togglePanel(false);
        else setPanelTab('usage');
      }}
    >
      {ctxPct !== null && (
        <span className="session-meter-ring" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r={r} className="session-meter-track" />
            <circle cx="8" cy="8" r={r} className="session-meter-fill" strokeDasharray={`${(ctxPct / 100) * c} ${c}`} transform="rotate(-90 8 8)" />
          </svg>
          {ctxPct}%
        </span>
      )}
      {ctxPct === null && <Icon name="chart" size={16} />}
    </button>
  );
}
