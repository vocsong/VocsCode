/** Reactive channel gate for the renderer. Every check is UX only: the host still refuses a
 *  channel the client thinks it can use. */
import { useMemo } from 'react';
import type { IpcChannel } from '../../shared/ipc';
import { canInvoke } from './api';

export function useCanInvoke(channel: IpcChannel): boolean {
  return useMemo(() => canInvoke(channel), [channel]);
}
