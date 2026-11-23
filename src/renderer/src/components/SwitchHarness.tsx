/** "Switch harness": changes a session's harness in place, keeping its workspace, worktree, and transcript. */
import type { ReactNode } from 'react';
import type { HarnessId, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID, HARNESSES } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { harnessShort } from '../format';
import { useStore } from '../store';
import { MISSION_MANAGED_REASON } from '../missions';
import { Dropdown, Icon, MenuItem } from './ui';

export function isSessionBusyForSwitch(session: SessionMeta): boolean {
  return session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
}

export function switchHarnessDisabledReason(session: SessionMeta): string | undefined {
  if (session.mission) return MISSION_MANAGED_REASON;
  if (session.archived) return 'Restore this session before switching harnesses.';
  if (isSessionBusyForSwitch(session)) return 'Wait for the current turn to finish before switching harnesses.';
  return undefined;
}

export function switchSessionHarness(
  session: SessionMeta,
  harness: HarnessId,
  toast: (text: string, tone?: 'info' | 'success' | 'error') => void,
  onSwitched?: (updated: SessionMeta) => void
): void {
  if (harness === session.config.harness) return;
  void invoke('sessions:switchHarness', { id: session.id, harness })
    .then((updated) => {
      if (updated) {
        toast(`Switched to ${harnessShort(updated.config.harness)} in the same workspace`, 'success');
        onSwitched?.(updated);
      }
    })
    .catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'));
}

/** Harness list shared by the header dropdown and the composer model menu's drill-in view. */
export function SwitchHarnessOptions({
  session,
  close,
  onSwitched,
  showHeading = true
}: {
  session: SessionMeta;
  close: () => void;
  onSwitched?: (s: SessionMeta) => void;
  showHeading?: boolean;
}) {
  const availability = useStore((s) => s.availability);
  const availabilityError = useStore((s) => s.availabilityError);
  const refreshAvailability = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  const h = HARNESS_BY_ID[session.config.harness];
  const reason = switchHarnessDisabledReason(session);

  return (
    <>
      {showHeading && <MenuItem disabled>Switch harness (same workspace)</MenuItem>}
      {reason && <div className="run-more-note">{reason}</div>}
      {availabilityError && (
        <MenuItem onClick={() => { close(); void refreshAvailability(); }}>
          Could not check harnesses — retry
        </MenuItem>
      )}
      {[h, ...HARNESSES.filter((x) => x.id !== session.config.harness)].map((x) => {
        const av = availability[x.id];
        const unavailable = !!av && !av.available;
        const current = x.id === session.config.harness;
        return (
          <MenuItem
            key={x.id}
            active={current}
            disabled={!!reason || unavailable || !!availabilityError}
            hint={current ? 'Current' : unavailable ? 'Not installed' : undefined}
            onClick={() => {
              close();
              if (!current) switchSessionHarness(session, x.id, toast, onSwitched);
            }}
          >
            {harnessShort(x.id)}
          </MenuItem>
        );
      })}
    </>
  );
}

/** Header trigger dropdown for switching a session's harness in place. */
export function SwitchHarnessDropdown({
  session,
  onSwitched,
  trigger
}: {
  session: SessionMeta;
  onSwitched?: (s: SessionMeta) => void;
  trigger?: (open: boolean) => ReactNode;
}) {
  const reason = switchHarnessDisabledReason(session);
  if (session.mission) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" disabled title={MISSION_MANAGED_REASON} aria-label="Switch harness unavailable for Mission">
        <Icon name="swap" size={14} />
      </button>
    );
  }
  return (
    <Dropdown
      align="right"
      width={220}
      trigger={trigger ?? (() => (
        <button type="button" className="row-act-btn" title={reason ?? 'Switch harness (same workspace)'} aria-label="Switch harness">
          <Icon name="swap" size={15} />
        </button>
      ))}
    >
      {(close) => <SwitchHarnessOptions session={session} close={close} onSwitched={onSwitched} />}
    </Dropdown>
  );
}

/** Menu items variant used inside the File menu. */
export function SwitchHarnessItems({ session, onSwitched, close }: { session: SessionMeta; onSwitched?: (s: SessionMeta) => void; close: () => void }) {
  const availability = useStore((s) => s.availability);
  const availabilityError = useStore((s) => s.availabilityError);
  const refreshAvailability = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  const reason = switchHarnessDisabledReason(session);
  if (session.mission) return <MenuItem disabled hint={MISSION_MANAGED_REASON}>Switch harness unavailable for Mission</MenuItem>;
  return (
    <>
      <div className="menu-sep" />
      <MenuItem disabled>Switch harness</MenuItem>
      {availabilityError && (
        <MenuItem onClick={() => { close(); void refreshAvailability(); }}>
          Could not check harnesses — retry
        </MenuItem>
      )}
      {HARNESSES.filter((h) => h.id !== session.config.harness).map((h) => {
        const av = availability[h.id];
        const unavailable = !!av && !av.available;
        return (
          <MenuItem
            key={h.id}
            disabled={!!reason || unavailable || !!availabilityError}
            hint={reason ? undefined : unavailable ? 'Not installed' : undefined}
            onClick={() => {
              close();
              switchSessionHarness(session, h.id, toast, onSwitched);
            }}
          >
            {harnessShort(h.id)}
          </MenuItem>
        );
      })}
    </>
  );
}
