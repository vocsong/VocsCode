/** "Fork into <harness>" menu items: forks a session into a different harness on the same worktree. */
import type { SessionMeta } from '../../../shared/types';
import { HARNESSES } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { harnessShort } from '../format';
import { useStore } from '../store';
import { MenuItem } from './ui';

export function ForkIntoItems({ session, onForked }: { session: SessionMeta; onForked?: (s: SessionMeta) => void }) {
  const availability = useStore((s) => s.availability);
  const toast = useStore((s) => s.toast);
  return (
    <>
      <div className="menu-sep" />
      <MenuItem disabled>Fork into</MenuItem>
      {HARNESSES.filter((h) => h.id !== session.config.harness).map((h) => {
        const av = availability[h.id];
        const unavailable = !!av && !av.available;
        return (
          <MenuItem
            key={h.id}
            disabled={unavailable}
            onClick={() => {
              void invoke('sessions:fork', { id: session.id, harness: h.id }).then((f) => {
                if (f) {
                  toast(`Forked into ${harnessShort(h.id)} on the same worktree`, 'success');
                  onForked?.(f);
                }
              });
            }}
          >
            {harnessShort(h.id)}{unavailable ? ' (not installed)' : ''}
          </MenuItem>
        );
      })}
    </>
  );
}
