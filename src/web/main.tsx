import './install-transport';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { configureStore } from '@renderer/store';
import { RelayClient } from '../../relay/src/web-client';
import { connectHashFromUrl, pairingCodeFromUrl, scrubParams } from './router';
import { accountStateOf, resolveAccount } from './shell/account';
import { WebApp } from './shell/WebApp';
import { setTransport } from './install-transport';
import { RelayTransport } from './transport/relay-transport';
import { indexedDbVault, localStorageApi } from './transport/vault';
import '@renderer/styles.css';
import './web.css';

// Read the short-lived pairing parameters once, then take them out of the address bar/history.
const initialCode = pairingCodeFromUrl(window.location.search);
const connectHash = connectHashFromUrl(window.location.search);
scrubParams(['code', 'connect']);

// The shared renderer core, configured for a paged browser shell: no local availability probe and
// no auto-opened first session — the shell routes instead.
configureStore({ pagedTranscripts: true, probeAvailabilityOnBoot: false, openFirstSessionOnBoot: false });

/** Resolve who this browser is before creating the client: the account partitions the vault, and a
 *  visitor with no identity must not load anyone else's pairing keys. */
async function start(): Promise<void> {
  const resolution = await resolveAccount();
  const client = new RelayClient({
    vault: indexedDbVault(resolution.accountId, resolution.allowLegacyMigration),
    legacy: resolution.allowLegacyMigration ? localStorageApi() : undefined,
    allowLegacyMigration: resolution.allowLegacyMigration
  });
  const transport = new RelayTransport(client);
  setTransport(transport);
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <WebApp
        client={client}
        transport={transport}
        account={accountStateOf(resolution)}
        initialCode={initialCode}
        connectHash={connectHash}
      />
    </React.StrictMode>
  );
}

void start();
