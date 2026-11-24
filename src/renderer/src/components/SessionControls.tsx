/**
 * The model pill reads provider/model with the reasoning effort beside it in a lighter weight, and
 * opens the full model identity, Effort and Fast controls.
 * Permissions stay visible; the context ring toggles Usage. Secondary details live in menus.
 */
import React from 'react';
import type { KeepAwakeBridge } from '../../../shared/keep-awake';
import type { ModelInfo, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { modelName, modelRefName, parseTypedModel } from '../../../shared/model-names';
import { canInvoke, invoke, invokeErrorMessage } from '../api';
import { fmtCost, fmtTokens } from '../format';
import { canStartMission, missionDefaultsOf, missionPermissionLabel } from '../mission';
import { openSettings } from '../settings-nav';
import { setSessionEffort } from '../sessionActions';
import { effortOptions, permissionOptions } from '../session-controls';
import { useSessionModels } from '../models';
import { useStore } from '../store';
import { useMinimalUi } from '../ui-mode';
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

  // Mission mode: armed is renderer-local until the next send; a Lead keeps it on, a Builder never shows it.
  const role = session.mission?.role;
  const isLead = role === 'lead';
  const armed = useStore((s) => !!s.missionArmed[session.id]) && !role;
  const setMissionArmed = useStore((s) => s.setMissionArmed);
  const settings = useStore((s) => s.settings);
  const missionOn = isLead || armed;
  const missionLabel = missionPermissionLabel(settings);
  const missionBuilderTier = PERMISSION_MODE_LABELS[missionDefaultsOf(settings).builder.permissionMode]?.label ?? 'Auto';
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  // While a turn runs the switch steps aside (a mission starts from the next message); once armed it stays reachable.
  const showMissionSwitch = isLead || (canStartMission(session) && canInvoke('mission:start') && (armed || !busy));

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
            {fastSelected && <FastModeElectric />}
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

      {/* Mission mode replaces the session's own tier: the Lead always plans, Builders take the Settings tier. */}
      {missionOn ? (
        <Dropdown
          align="left"
          width={280}
          trigger={(open) => (
            <button type="button" className={`pill run-permission mode-plan is-mission ${open ? 'open' : ''}`} title="Mission mode permissions" aria-label={`Permission mode: ${missionLabel}`}>
              <Icon name="shield" size={13} /> <span className="pill-text">{missionLabel}</span> <Icon name="chevron" size={12} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="run-more-label">Mission mode</div>
              <div className="run-more-note">The Lead runs in Plan mode: it plans, coordinates and checks, and never edits. Builders run in {missionBuilderTier}; they ask the Lead first.</div>
              <MenuItem hint="Settings → Session defaults" onClick={() => { close(); openSettings('sessions'); }}>Builder settings</MenuItem>
            </>
          )}
        </Dropdown>
      ) : modeLabel && (
        /* A restored session can lack a mode; don't offer a selector until one exists. */
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
      {showMissionSwitch && (
        <button
          type="button"
          className="pill run-mission"
          role="switch"
          aria-label="Mission mode"
          aria-checked={missionOn}
          aria-readonly={isLead || undefined}
          title={isLead
            ? 'Mission Lead: Mission mode stays on for this session. Messages here go to the Lead.'
            : armed
              ? 'Mission mode is on: your next message starts a mission. A Lead plans and Builders implement.'
              : 'Mission mode: send your next message as a mission. A Lead plans and Builders implement.'}
          onClick={isLead ? undefined : () => setMissionArmed(session.id, !armed)}
        >
          <Icon name="flag" size={13} /> <span className="pill-text">Mission</span>
        </button>
      )}
      {!session.archived && window.keepAwake && (
        <KeepAwakeSwitch key={session.id} id={session.id} bridge={window.keepAwake} />
      )}
    </div>
  );
}

function FastModeElectric() {
  return (
    <svg className="fast-mode-electric" viewBox="0 0 160 28" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <g className="fast-mode-electric-arc">
        <path className="fast-mode-electric-trunk" pathLength={1} d="M3 17 5 12 4 10 9 7 13 2 24 3.5 35 1.5 43 3 52 1.5 65 3.5 77 1.5 88 3 103 1.5 115 3" />
        <path d="M9 7 14 7.5 19 4.5 M43 3 48 6 55 4.5 M77 1.5 83 5 91 4" />
      </g>
      <g className="fast-mode-electric-arc">
        <path className="fast-mode-electric-trunk" pathLength={1} d="M157 11 155 15 156 18 151 21 147 26 136 24.5 126 26.5 116 25 107 26.5 94 24.5 83 26.5 72 25 57 26.5 45 25" />
        <path d="M151 21 146 20.5 141 23.5 M116 25 111 22 104 23.5 M83 26.5 77 23 69 24" />
      </g>
    </svg>
  );
}

function KeepAwakeSwitch({ id, bridge }: { id: string; bridge: KeepAwakeBridge }) {
  const toast = useStore((s) => s.toast);
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    let current = true;
    void bridge.preference({ id }).then((choice) => {
      if (current) setEnabled(choice);
    }).catch((error) => {
      if (current) toast(`Could not read Keep computer awake: ${invokeErrorMessage(error)}`, 'error');
    });
    return () => { current = false; };
  }, [bridge, id, toast]);

  const toggle = async () => {
    if (pending || enabled === null) return;
    setPending(true);
    try {
      setEnabled(await bridge.preference({ id, enabled: !enabled }));
    } catch (error) {
      toast(`Could not change Keep computer awake: ${invokeErrorMessage(error)}`, 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <button type="button" className="pill run-keep-awake" role="switch" aria-label="Keep computer awake"
      aria-checked={enabled === true} disabled={pending || enabled === null} onClick={() => void toggle()}
      title="Keep computer awake: prevent idle sleep while this session is working. Resets when the app quits.">
      <Icon name="coffee" size={15} />
    </button>
  );
}

/** Context stays glanceable; spend and token details are in the options menu / Usage panel. */
export function SessionMeter({ session }: { session: SessionMeta }) {
  const minimal = useMinimalUi();
  // Zen's panel is a rail whose drawer shows one view: Usage is open when the drawer is out on it.
  const usageOpen = useStore((s) => s.panelOpen && s.panelTab === 'usage' && (!minimal || (s.panelFocus === 'top' && (s.panelPeek || s.pins.right))));
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
      // A press here does not count as one outside the panel's peek: this button opens and closes it.
      data-panel-trigger=""
      onClick={() => {
        const { setPanelTab, togglePanel, endPanelPeek, pins } = useStore.getState();
        // Zen closes the drawer back to its rail, never the whole rail; a pinned drawer stays out.
        if (!usageOpen) setPanelTab('usage');
        else if (!minimal) togglePanel(false);
        else if (!pins.right) endPanelPeek();
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
