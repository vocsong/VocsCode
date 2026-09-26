import { client, transport } from './install-transport';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { configureStore } from '@renderer/store';
import { connectHashFromUrl, pairingCodeFromUrl, scrubParams } from './router';
import { WebApp } from './shell/WebApp';
import '@renderer/styles.css';
import './web.css';

// Read the short-lived pairing parameters once, then take them out of the address bar/history.
const initialCode = pairingCodeFromUrl(window.location.search);
const connectHash = connectHashFromUrl(window.location.search);
scrubParams(['code', 'connect']);

// The shared renderer core, configured for a paged browser shell: no local availability probe and
// no auto-opened first session — the shell routes instead.
configureStore({ pagedTranscripts: true, probeAvailabilityOnBoot: false, openFirstSessionOnBoot: false });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebApp client={client} transport={transport} initialCode={initialCode} connectHash={connectHash} />
  </React.StrictMode>
);
