/**
 * Zen's pins: a side held open instead of folding back to its rail when the pointer and focus leave.
 *
 * A pin is a window-layout choice like the split-pane layout, so it is kept the same way: in this
 * window's localStorage rather than in settings. Standard ignores pins — its sidebar and panel are
 * always open while shown.
 */
export type PinSide = 'left' | 'right';
export type Pins = Record<PinSide, boolean>;

const KEY = 'vocs-code.pins';
export const NO_PINS: Pins = { left: false, right: false };

export function loadPins(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Pins {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return NO_PINS;
    const parsed = JSON.parse(raw) as Partial<Record<PinSide, unknown>> | null;
    return { left: parsed?.left === true, right: parsed?.right === true };
  } catch {
    return NO_PINS;
  }
}

export function savePins(pins: Pins, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(pins));
  } catch {
    // A full or unavailable storage only costs the pin on the next launch.
  }
}
