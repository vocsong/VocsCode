/** One line about the connection, announced politely: reconnecting, mirrored, offline or
 *  view-only. It doubles as the retry affordance when the desktop is unreachable. */
import { Button } from '@renderer/components/ui';
import type { ConnectionState } from '../transport/relay-transport';

export function ConnectionBanner({ state, viewOnly, onRetry }: { state: ConnectionState; viewOnly: boolean; onRetry: () => void }) {
  const text =
    state === 'connecting' ? 'Reconnecting…'
      : state === 'offline' ? 'Offline: the computer is unreachable'
        : state === 'mirror' ? 'Offline: reading the last mirrored snapshot'
          : state === 'revoked' ? 'This browser is no longer paired'
            : viewOnly ? 'View-only on this computer' : '';
  if (!text) return null;
  return (
    <div className={`w-banner w-banner-${state}`} role="status" aria-live="polite">
      <span>{text}</span>
      {(state === 'offline' || state === 'revoked') && <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
