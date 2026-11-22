import { canInvoke, isWeb } from './api';

export const HOUSEKEEP_OPEN = 'vocs:housekeep-open';
export const canHousekeepHere = (): boolean => !isWeb && canInvoke('housekeep:preview');
export function openHousekeep(): void {
  if (canHousekeepHere()) window.dispatchEvent(new Event(HOUSEKEEP_OPEN));
}
