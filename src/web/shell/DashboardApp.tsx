/** The code.vocs.io web app: the signed-in owner's dashboard, plus the one-time Connect with Vocs
 *  step a desktop opens (`/dashboard?connect=<hash>`). The landing Worker gates the whole page on
 *  the Vocs session, so a signed-out visitor normally never gets here. */
import { useState } from 'react';
import { Dashboard } from '../dashboard/Dashboard';
import { ConnectScreen } from '../screens/ConnectScreen';
import { FocusStage } from './FocusStage';
import { ProductSwitcher } from './ProductSwitcher';
import type { AccountState } from './account';

export function DashboardApp({ account, connectHash }: { account: AccountState; connectHash: string | null }) {
  const [connecting, setConnecting] = useState(connectHash);

  const login = account.status === 'signed-in' ? account.account.login : null;
  const isDashboard = login !== null && connecting === null;

  return (
    <div className="w-app">
      <a className="v-skip" href="#main">Skip to content</a>
      <header className="v-topbar w-topbar">
        <div className="v-wrap v-wrap-wide v-topbar-inner">
          <a className="v-brand" href="/dashboard" aria-label="Vocs Code dashboard">
            vocs<span className="v-brand-dot" aria-hidden="true">.</span><span className="v-brand-product">code</span>
          </a>
          {login !== null && (
            <div className="v-topbar-actions">
              {isDashboard && <ProductSwitcher />}
              <div className="w-account" title={login}>
                <span className="v-avatar" aria-hidden="true">{Array.from(login)[0]?.toLocaleUpperCase()}</span>
                <span className="v-sr-only">Signed in as </span>
                <span className="w-account-name" data-testid="account-login">{login}</span>
              </div>
              <form method="post" action="/logout" className="w-signout">
                <button type="submit" className="v-btn v-btn-ghost v-btn-sm">Sign out</button>
              </form>
            </div>
          )}
        </div>
      </header>
      <main id="main" className={isDashboard ? 'w-main v-wrap v-wrap-wide' : 'w-main'}>
        {login === null ? (
          <FocusStage testId="signed-out">
            <div>
              <p className="v-eyebrow v-eyebrow-sm">Vocs Code</p>
              <h1 className="v-h1" id="focus-title">Sign in to see your dashboard</h1>
              <p className="v-text w-focus-description">Your Vocs Code computers report their analytics to your Vocs account.</p>
            </div>
            <a className="v-btn v-btn-primary" href="/login?next=%2Fdashboard">Sign in</a>
          </FocusStage>
        ) : connecting ? <ConnectScreen nonceHash={connecting} onDone={() => setConnecting(null)} /> : <Dashboard />}
      </main>
      {isDashboard && (
        <footer className="v-footer v-footer-slim">
          <div className="v-wrap v-wrap-wide v-footer-base"><span>Vocs Code</span><span>Analytics dates are shown in UTC.</span></div>
        </footer>
      )}
    </div>
  );
}
