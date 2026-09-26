/** Stars the web transport into window.harness. This module must be imported before anything that
 *  reaches `@renderer/api`, which reads window.harness when it loads; importing it first is what
 *  makes `platform`, `canInvoke` and `invoke` see a browser transport. The real transport arrives
 *  later (the account, and with it the vault partition, must be resolved first), so the bridge
 *  installed here forwards to whatever `setTransport` supplies. */
import type { Transport } from '@shared/transport';

let current: Transport | null = null;

const bridge: Transport = {
  platform: 'browser',
  invoke: (channel, request) => (current ? current.invoke(channel, request) : Promise.reject(new Error('the browser client is still starting'))),
  on: (channel, listener) => (current ? current.on(channel, listener) : () => undefined),
  can: (channel) => (current ? current.can?.(channel) ?? true : false)
};

(window as unknown as { harness: Transport }).harness = bridge;

/** Points the already-installed bridge at the live transport. */
export function setTransport(transport: Transport): void {
  current = transport;
}
