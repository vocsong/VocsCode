/** The status word, shared by the list rows and the session header. */
import { StatusLabel } from '@renderer/components/ui';
import { hasOngoingWork, ongoingBadgeLabel } from '@shared/ongoing';
import type { OngoingItem } from '@shared/types';

export function StatusChip({ status, label, ongoing }: { status: string; label?: string; ongoing?: readonly OngoingItem[] }) {
  if (!label && status === 'idle' && hasOngoingWork({ ongoing })) {
    return (
      <span className="session-status status-ongoing w-status" title={ongoing!.map((i) => i.label).join(' · ')}>
        {ongoingBadgeLabel(ongoing!)}
      </span>
    );
  }
  return <StatusLabel status={status} label={label} className="w-status" />;
}
