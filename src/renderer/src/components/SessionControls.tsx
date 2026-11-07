/**
 * Keep the model beside the prompt; effort, permission and Fast mode live in More.
 * Usage stays visible next to the send actions. The header holds the session identity.
 */
import React from 'react';
import type { ModelInfo, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { modelRefName, parseTypedModel } from '../../../shared/model-names';
import { invoke } from '../api';
import { fmtCost, fmtTokens } from '../format';
import { setSessionEffort } from '../sessionActions';
import { effortOptions, permissionOptions } from '../session-controls';
import { useSessionModels } from '../models';
import { useStore } from '../store';
import { Dropdown, Icon, MenuItem } from './ui';
import { ModelPicker } from './ModelPicker';
import { FastModePill } from './FastModePill';

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
  const effort = session.activeEffort ?? session.config.effort;

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
        width={380}
        trigger={(open) => (
          <button type="button" className={`pill pill-model ${open ? 'open' : ''}`} title="Model">
            {/* Provider first: the same model id can be reached through more than one provider. */}
            <Icon name="sparkles" size={13} /> <span className="pill-text">{modelRefName(current) ?? 'default model'}</span> <Icon name="chevron" size={12} />
          </button>
        )}
      >
        {(close) => (
          <ModelPicker
            models={models}
            loading={modelsLoading}
            error={modelsError}
            selected={current}
            emptyText={h.capabilities.liveModelSwitch ? 'No models available.' : 'No models available (this harness cannot switch models live).'}
            onSelect={(m) => {
              close();
              if (m) void setModel(m);
            }}
            onSelectCustom={(id) => {
              close();
              const ref = parseTypedModel(id, providers.map((p) => p.id), (current ?? models[0])?.provider ?? 'anthropic');
              void setModel({ id: ref.model, provider: ref.provider, displayName: ref.model });
            }}
          />
        )}
      </Dropdown>

      <Dropdown
        align="left"
        width={300}
        trigger={(open) => (
          <button type="button" className={`pill run-more ${mode ? `mode-${mode}` : ''} ${open ? 'open' : ''}`} title="More session controls" aria-label="More session controls">
            <Icon name="settings" size={14} /> <span className="pill-text">More{session.config.fastMode ? session.fastModeStatus?.state === 'on' ? ' · Fast on' : ' · Fast requested' : ''}</span> <Icon name="chevron" size={12} />
          </button>
        )}
      >
        {(close) => (
          <>
            {h.capabilities.effort && <div className="run-more-label">Reasoning effort{effortLevels.length ? ` · ${effort ?? 'default'}` : ''}</div>}
            {h.capabilities.effort && (effortLevels.length ? effortLevels.map((option) => (
              <MenuItem key={option.value} active={effort === option.value} onClick={() => { close(); void setSessionEffort(session.id, option.value, toast); }}>
                {option.label}
              </MenuItem>
            )) : <div className="run-more-note">{currentInfo?.displayName ?? 'This model'} does not support reasoning effort</div>)}
            {/* A restored session can lack a mode; don't offer a selector until one exists. */}
            {modeLabel && <>
              <div className="run-more-label run-more-section">Permission mode · {modeLabel.short}</div>
              {modes.map((option) => (
                <MenuItem key={option.value} active={option.value === mode} hint={option.hint} onClick={() => { close(); void invoke('sessions:setPermissionMode', { id: session.id, mode: option.value }); }}>
                  {option.label}
                </MenuItem>
              ))}
            </>}
            <div className="run-more-footer">
              <FastModePill key={session.id} session={session} />
            </div>
          </>
        )}
      </Dropdown>
    </div>
  );
}

/** Context use as a small ring and the session's spend; a click opens the Usage panel. */
export function SessionMeter({ session }: { session: SessionMeta }) {
  const ctxPct = session.usage.contextWindow && session.usage.contextTokens ? Math.min(100, Math.round((session.usage.contextTokens / session.usage.contextWindow) * 100)) : null;
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <button
      type="button"
      className={`session-meter ${ctxPct !== null && ctxPct >= 80 ? 'session-meter-high' : ''}`}
      title={`Input ${fmtTokens(session.usage.inputTokens)} · Output ${fmtTokens(session.usage.outputTokens)} · Cache read ${fmtTokens(session.usage.cacheReadTokens)}${ctxPct !== null ? ` · Context ${ctxPct}%` : ''} — open Usage`}
      aria-label="Session usage"
      onClick={() => useStore.getState().setPanelTab('usage')}
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
      <span className="session-meter-cost">{fmtCost(session.usage.costUsd)}</span>
    </button>
  );
}
