import { canInvoke } from './api';

export const HOUSEKEEP_OPEN = 'vocs:housekeep-open';
export interface HousekeepOpenOptions { recentDaysOverride?: number }

declare global {
  interface WindowEventMap {
    [HOUSEKEEP_OPEN]: CustomEvent<HousekeepOpenOptions>;
  }
}

export const canHousekeepHere = (): boolean => canInvoke('housekeep:preview');
export function openHousekeep(recentDaysOverride?: number): void {
  if (canHousekeepHere()) window.dispatchEvent(new CustomEvent(HOUSEKEEP_OPEN, { detail: { recentDaysOverride } }));
}
