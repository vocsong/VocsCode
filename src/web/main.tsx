import React from 'react';
import { createRoot } from 'react-dom/client';
import { connectHashFromUrl, scrubParams } from './router';
import { accountStateOf, resolveAccount } from './shell/account';
import { DashboardApp } from './shell/DashboardApp';
import '@renderer/styles.css';
import './web.css';

// Read the one-time Connect with Vocs hash, then take it out of the address bar and history.
const connectHash = connectHashFromUrl(window.location.search);
scrubParams(['connect', 'code']);

async function start(): Promise<void> {
  const account = accountStateOf(await resolveAccount());
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <DashboardApp account={account} connectHash={connectHash} />
    </React.StrictMode>
  );
}

void start();
