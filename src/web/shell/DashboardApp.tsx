/** The code.vocs.io web app: the signed-in owner's dashboard, plus the one-time Connect with Vocs
 *  step a desktop opens (`/dashboard?connect=<hash>`). The landing Worker gates the whole page on
 *  the Vocs session, so a signed-out visitor normally never gets here. */
import { useState } from 'react';
import { Dashboard } from '../dashboard/Dashboard';
import { ConnectScreen } from '../screens/ConnectScreen';
import type { AccountState } from './account';

export function DashboardApp({ account, connectHash }: { account: AccountState; connectHash: string | null }) {
  const [connecting, setConnecting] = useState(connectHash);

  if (account.status !== 'signed-in') {
    return (
      <section className="w-screen" data-testid="signed-out">
        <div className="w-screen-inner">
          <div className="w-card">
            <p className="w-label">Vocs Code</p>
            <h1>Sign in to see your dashboard</h1>
            <p className="w-lead">Your Vocs Code computers report their analytics to your Vocs account.</p>
            <div className="w-actions">
              <a className="btn btn-primary" href="/login?next=%2Fdashboard">Sign in</a>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="w-app">
      <header className="w-topbar">
        <a className="w-brand" href="/dashboard">Vocs Code</a>
        <span className="w-topbar-title">Dashboard</span>
        <span className="w-topbar-spacer" />
        <span className="w-account" data-testid="account-login">{account.account.login}</span>
        <form method="post" action="/logout" className="account-signout">
          <button type="submit" className="btn btn-ghost btn-sm">Sign out</button>
        </form>
      </header>
      <main className="w-main">{connecting ? <ConnectScreen nonceHash={connecting} onDone={() => setConnecting(null)} /> : <Dashboard />}</main>
    </div>
  );
}
