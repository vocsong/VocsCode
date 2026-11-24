import React, { useRef, useState } from 'react';
import { INLINE_SUBSCRIPTION_PROVIDERS, SUBSCRIPTION_PROVIDERS, type SubscriptionLimits, type SubscriptionProvider } from '../../../shared/subscription-usage';
import type { HarnessAvailability } from '../../../shared/types';
import { canInvoke, invoke, invokeErrorMessage, isWeb } from '../api';
import { useStore } from '../store';
import { Meter } from './analytics/charts';
import { Badge, Button } from './ui';

const PROVIDERS: Record<SubscriptionProvider, { name: string; detail: string }> = {
  codex: { name: 'Codex · ChatGPT', detail: 'Uses the ChatGPT sign-in for both Codex modes. This is not API-key usage.' },
  claude: { name: 'Claude', detail: 'Claude shows subscription limits in its account settings.' },
  antigravity: { name: 'Google Antigravity', detail: 'Open the interactive CLI and type /usage to see your limits.' },
  cursor: { name: 'Cursor', detail: 'Check plan usage in the Cursor dashboard.' }
};

function subscriptionStatus(availability: HarnessAvailability | undefined) {
  if (!availability) return null;
  if (!availability.available) return { label: 'Setup needed', tone: 'neutral' as const };
  if (availability.authenticated === false) return { label: 'Sign-in needed', tone: 'amber' as const };
  if (availability.authenticated !== true) return { label: 'Sign-in not verified', tone: 'neutral' as const };
  if (availability.authMethod === 'api-key') return { label: 'API key configured', tone: 'neutral' as const };
  return availability.authMethod === 'subscription'
    ? { label: 'Subscription sign-in detected', tone: 'green' as const }
    : { label: 'Sign-in detected', tone: 'green' as const };
}

export function SubscriptionUsage() {
  if (isWeb || !canInvoke('subscriptions:openUsage')) {
    return <p className="usage-note">Subscription usage is available in the desktop app.</p>;
  }
  return (
    <section className="usage-block" aria-label="Subscription limits">
      <p className="usage-note">Account limits are shared across sessions. Check each provider when you need it; nothing refreshes automatically.</p>
      {SUBSCRIPTION_PROVIDERS.map((provider) => <SubscriptionRow key={provider} provider={provider} />)}
      <p className="usage-note">Pi, generic ACP and API-key sessions use their own providers’ plans or billing. Vocs Code can’t match those logins to these accounts or infer their limits from session tokens.</p>
    </section>
  );
}

function SubscriptionRow({ provider }: { provider: SubscriptionProvider }) {
  const { name, detail } = PROVIDERS[provider];
  const availability = useStore((s) => s.availability[provider]);
  const signIn = subscriptionStatus(availability);
  const reader = INLINE_SUBSCRIPTION_PROVIDERS.find((id) => id === provider);
  const pending = useRef(false);
  const [action, setAction] = useState<'read' | 'open' | null>(null);
  const [snapshot, setSnapshot] = useState<{ limits: SubscriptionLimits; checkedAt: Date } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (next: 'read' | 'open') => {
    if (pending.current) return;
    pending.current = true;
    setAction(next);
    setError(null);
    setNotice(null);
    try {
      if (next === 'read' && reader) {
        setSnapshot(null); // A failed refresh must not look like up-to-date quota (or a zero balance).
        const limits = await invoke('subscriptions:read', { provider: reader });
        setSnapshot({ limits, checkedAt: new Date() });
      } else if (next === 'open') {
        const { kind } = await invoke('subscriptions:openUsage', { provider });
        setNotice(kind === 'terminal' ? 'In the terminal, type /usage and press Enter.' : 'Usage page opened in your browser.');
      }
    } catch (e) {
      setError(invokeErrorMessage(e));
    } finally {
      pending.current = false;
      setAction(null);
    }
  };

  return (
    <section className="usage-block usage-quota" aria-label={name}>
      <div className="usage-quota-title">
        <h5>{name}</h5>
        {signIn && <Badge tone={signIn.tone}>{signIn.label}</Badge>}
      </div>
      <p className="usage-note">{detail}</p>
      <div className="usage-quota-actions">
        {reader && canInvoke('subscriptions:read') && (
          <Button size="sm" variant="subtle" icon="refresh" disabled={action !== null} onClick={() => void run('read')}>
            {snapshot ? 'Refresh limits' : 'Check limits'}
          </Button>
        )}
        <Button size="sm" variant={reader ? 'ghost' : 'subtle'} icon={provider === 'antigravity' ? 'terminal' : 'external'} disabled={action !== null} onClick={() => void run('open')}>
          {provider === 'antigravity' ? 'Open CLI' : 'Open usage page'}
        </Button>
      </div>
      {error && <div className="callout warn" role="alert">{error}</div>}
      {(action || notice) && <p className="usage-note" role="status">{action === 'read' ? 'Checking account limits…' : action === 'open' ? 'Opening provider usage…' : notice}</p>}
      {snapshot && <div className="usage-quota-results" aria-live="polite">
        <p className="usage-note">Quota remaining · Checked <time dateTime={snapshot.checkedAt.toISOString()}>{snapshot.checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></p>
        {snapshot.limits.groups.map((group) => (
          <div className="usage-quota-group" key={group.name}>
            <strong>{group.name}</strong>
            {group.buckets.map((bucket) => <Meter
              key={bucket.name}
              label={bucket.name}
              value={bucket.remainingFraction}
              tone={bucket.remainingFraction <= 0.1 ? 'red' : bucket.remainingFraction <= 0.25 ? 'amber' : 'accent'}
              sub={bucket.resetAt ? `Resets ${new Date(bucket.resetAt).toLocaleString()}` : undefined}
            />)}
          </div>
        ))}
      </div>}
    </section>
  );
}
