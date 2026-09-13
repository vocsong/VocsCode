/** "Fork into <harness>": forks a session into a different harness on the same worktree. */
import type { ReactNode } from 'react';
import type { HarnessId, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID, HARNESSES } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { harnessShort } from '../format';
import { useStore } from '../store';
import { Dropdown, Icon, MenuItem } from './ui';

/** The sidebar row's fork button as a reusable dropdown: the same trigger menu wherever it is mounted. */
export function ForkIntoDropdown({ session, onForked, trigger }: {
  session: SessionMeta;
  onForked?: (s: SessionMeta) => void;
  /** Overrides the default sidebar-style icon trigger (e.g. for the header). */
  trigger?: (open: boolean) => ReactNode;
}) {
  const availability = useStore((s) => s.availability);
  const availabilityError = useStore((s) => s.availabilityError);
  const refreshAvailability = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  const h = HARNESS_BY_ID[session.config.harness];
  const fork = (harness: HarnessId) => {
    void invoke('sessions:fork', { id: session.id, harness })
      .then((f) => {
        if (f) {
          toast(`Forked into ${harnessShort(f.config.harness)} on the same worktree`, 'success');
          onForked?.(f);
        }
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'));
  };
  return (
    <Dropdown align="right" width={190} trigger={trigger ?? (() => (
      <button type="button" className="row-act-btn" title="Fork into another harness" aria-label="Fork session">
        <Icon name="fork" size={15} />
      </button>
    ))}>
      {(close) => (
        <>
          <MenuItem disabled>Fork into</MenuItem>
          {availabilityError && (
            <MenuItem onClick={() => { close(); void refreshAvailability(); }}>
              Could not check harnesses — retry
            </MenuItem>
          )}
          {[h, ...HARNESSES.filter((x) => x.id !== session.config.harness)].map((x) => {
            const av = availability[x.id];
            const unavailable = !!av && !av.available;
            return (
              <MenuItem key={x.id} active={x.id === session.config.harness} disabled={unavailable || !!availabilityError} onClick={() => { close(); fork(x.id); }}>
                {harnessShort(x.id)}{unavailable ? ' (not installed)' : ''}
              </MenuItem>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}

/** Menu items variant used inside larger menus (title bar, command menus). */
export function ForkIntoItems({ session, onForked }: { session: SessionMeta; onForked?: (s: SessionMeta) => void }) {
  const availability = useStore((s) => s.availability);
  const availabilityError = useStore((s) => s.availabilityError);
  const refreshAvailability = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  return (
    <>
      <div className="menu-sep" />
      <MenuItem disabled>Fork into</MenuItem>
      {availabilityError && (
        <MenuItem onClick={() => void refreshAvailability()}>
          Could not check harnesses — retry
        </MenuItem>
      )}
      {HARNESSES.filter((h) => h.id !== session.config.harness).map((h) => {
        const av = availability[h.id];
        const unavailable = !!av && !av.available;
        return (
          <MenuItem
            key={h.id}
            disabled={unavailable || !!availabilityError}
            onClick={() => {
              void invoke('sessions:fork', { id: session.id, harness: h.id })
                .then((f) => {
                  if (f) {
                    toast(`Forked into ${harnessShort(h.id)} on the same worktree`, 'success');
                    onForked?.(f);
                  }
                })
                .catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'));
            }}
          >
            {harnessShort(h.id)}{unavailable ? ' (not installed)' : ''}
          </MenuItem>
        );
      })}
    </>
  );
}