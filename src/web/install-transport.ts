/** Binds the web transport to window.harness. This module must be imported before anything that
 *  reaches `@renderer/api`, which reads window.harness when it loads; importing it first is what
 *  makes `platform`, `canInvoke` and `invoke` see the browser transport. */
import { RelayClient } from '../../relay/src/web-client';
import { RelayTransport } from './transport/relay-transport';
import { indexedDbVault, localStorageApi } from './transport/vault';

export const client = new RelayClient({ vault: indexedDbVault(), legacy: localStorageApi() });
export const transport = new RelayTransport(client);

(window as unknown as { harness: RelayTransport }).harness = transport;
