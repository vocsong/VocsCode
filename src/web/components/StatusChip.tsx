/** The status word, shared by the list rows and the session header. */
import { StatusLabel } from '@renderer/components/ui';

export function StatusChip({ status, label }: { status: string; label?: string }) {
  return <StatusLabel status={status} label={label} className="w-status" />;
}
