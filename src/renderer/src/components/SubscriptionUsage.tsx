import React, { useCallback, useEffect, useRef, useState } from 'react';
import { INLINE_SUBSCRIPTION_PROVIDERS, SUBSCRIPTION_PROVIDERS, type ObservedSubscriptionWindow, type SubscriptionLimits, type SubscriptionProvider } from '../../../shared/subscription-usage';
import type { HarnessAvailability, SessionMeta } from '../../../shared/types';
import { canInvoke, invoke, invokeErrorMessage } from '../api';
import { useStore } from '../store';
import { Meter } from './analytics/charts';
import { Badge, Button } from './ui';

const PROVIDERS: Record<SubscriptionProvider, { name: string; detail: string }> = {
  codex: { name: 'Codex · ChatGPT', detail: 'Uses the ChatGPT sign-in for both Codex modes. This is not API-key usage.' },
  claude: { name: 'Claude', detail: 'Usage shows limits that Claude reports during this session. For the full view, open Claude’s usage page.' },
  antigravity: { name: 'Google Antigravity', detail: 'Account limits aren’t available here. Open the interactive CLI and type /usage to see them.' },
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

function canShowSubscriptions() {
  return !!window.harness && canInvoke('subscriptions:openUsage');
}

function inlineProviders(session: SessionMeta): readonly SubscriptionProvider[] {
  return session.config.harness === 'claude' && canInvoke('subscriptions:claudeObserved')
    ? ['claude', ...INLINE_SUBSCRIPTION_PROVIDERS]
    : INLINE_SUBSCRIPTION_PROVIDERS;
}

export function SubscriptionUsage({ session, readLimitsOnOpen }: { session: SessionMeta; readLimitsOnOpen: boolean }) {
  if (!canShowSubscriptions()) return null;
  const codexSession = session.config.harness === 'codex' || session.config.harness === 'codex-exec';
  return (
    <section className="usage-block" aria-label="Subscription limits">
      <h5>Subscription limits</h5>
      {inlineProviders(session).map((provider) => (
        <SubscriptionRow key={provider} provider={provider} readLimitsOnOpen={readLimitsOnOpen} activeCodex={provider === 'codex' && codexSession}>
          {provider === 'claude' && <ClaudeObservedLimits key={session.id} session={session} visible={readLimitsOnOpen} />}
        </SubscriptionRow>
      ))}
    </section>
  );
}

export function SubscriptionUsageLinks({ session }: { session: SessionMeta }) {
  if (!canShowSubscriptions()) return null;
  const inline = inlineProviders(session);
  return (
    <section className="usage-block" aria-label="Provider usage links">
      <h5>Provider usage links</h5>
      {SUBSCRIPTION_PROVIDERS.filter((provider) => !inline.includes(provider)).map((provider) => (
        <SubscriptionRow key={provider} provider={provider} readLimitsOnOpen={false} />
      ))}
    </section>
  );
}

function SubscriptionRow({ provider, readLimitsOnOpen, activeCodex = false, children }: {
  provider: SubscriptionProvider;
  readLimitsOnOpen: boolean;
  activeCodex?: boolean;
  children?: React.ReactNode;
}) {
  const { name, detail } = PROVIDERS[provider];
  const availability = useStore((s) => s.availability[provider] ?? (provider === 'codex' ? s.availability['codex-exec'] : undefined));
  const reader = INLINE_SUBSCRIPTION_PROVIDERS.find((id) => id === provider);
  const canRead = !!reader && canInvoke('subscriptions:read');
  const autoRead = availability?.available === true && (
    (availability.authMethod === 'subscription' && availability.authenticated === true) ||
    (activeCodex && availability.authMethod !== 'api-key')
  );
  const readAttempted = useRef(false);
  const pending = useRef(false);
  const [action, setAction] = useState<'read' | 'open' | null>(null);
  const [snapshot, setSnapshot] = useState<{ limits: SubscriptionLimits; checkedAt: Date } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const signIn = snapshot ? { label: 'ChatGPT account', tone: 'green' as const } : subscriptionStatus(availability);

  const run = useCallback(async (next: 'read' | 'open') => {
    if (pending.current || (next === 'read' && !canRead)) return;
    pending.current = true;
    setAction(next);
    setError(null);
    setNotice(null);
    try {
      if (next === 'read' && reader) {
        readAttempted.current = true;
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
  }, [canRead, provider, reader]);

  // A login outside the app can make the boot-time sign-in hint stale. In a Codex session
  // let the existing account preflight verify the saved login before it requests any limits.
  useEffect(() => {
    if (readLimitsOnOpen && autoRead && canRead && !action && !readAttempted.current) void run('read');
  }, [action, autoRead, canRead, readLimitsOnOpen, run]);

  return (
    <section className="usage-block usage-quota" aria-label={name}>
      <div className="usage-quota-title">
        <h5>{name}</h5>
        {signIn && <Badge tone={signIn.tone}>{signIn.label}</Badge>}
      </div>
      {children}
      {snapshot && <div className="usage-quota-results" aria-live="polite">
        <p className="usage-note">Quota remaining · Checked <time dateTime={snapshot.checkedAt.toISOString()}>{snapshot.checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></p>
        {snapshot.limits.groups.map((group) => (
          <div className="usage-quota-group" key={group.name}>
            <strong>{group.name}</strong>
            {group.buckets.map((bucket) => <Meter
              key={bucket.name}
              label={bucket.name}
              value={bucket.remainingFraction}
              tone={quotaTone(bucket.remainingFraction)}
              sub={bucket.resetAt ? `Resets ${new Date(bucket.resetAt).toLocaleString()}` : undefined}
            />)}
          </div>
        ))}
      </div>}
      {error && <div className="callout warn" role="alert">{error}</div>}
      {(action || notice) && <p className="usage-note" role="status">{action === 'read' ? 'Checking account limits…' : action === 'open' ? 'Opening provider usage…' : notice}</p>}
      <p className="usage-note">{detail}</p>
      <div className="usage-quota-actions">
        {canRead && (
          <Button size="sm" variant={snapshot ? 'ghost' : 'subtle'} icon="refresh" disabled={action !== null} onClick={() => void run('read')}>
            {snapshot ? 'Refresh limits' : 'Check limits'}
          </Button>
        )}
        <Button size="sm" variant={reader ? 'ghost' : 'subtle'} icon={provider === 'antigravity' ? 'terminal' : 'external'} disabled={action !== null} onClick={() => void run('open')}>
          {provider === 'antigravity' ? 'Open CLI' : 'Open usage page'}
        </Button>
      </div>
    </section>
  );
}

function quotaTone(remaining: number) {
  return remaining <= 0.1 ? 'red' : remaining <= 0.25 ? 'amber' : 'accent';
}

function ClaudeObservedLimits({ session, visible }: { session: SessionMeta; visible: boolean }) {
  const [windows, setWindows] = useState<ObservedSubscriptionWindow[]>([]);
  const { id, status, usage: { turns } } = session;
  const stopped = status === 'stopped' || status === 'error';

  useEffect(() => {
    if (stopped) { setWindows([]); return; }
    if (!visible) return;
    let cancelled = false;
    // Only reads the live adapter's memory, not the provider. A settled turn may have reported
    // new information while Usage was open.
    void invoke('subscriptions:claudeObserved', { sessionId: id }).then(
      (value) => { if (!cancelled) setWindows(value); },
      () => { if (!cancelled) setWindows([]); }
    );
    return () => { cancelled = true; };
  }, [id, stopped, turns, visible]);

  useEffect(() => {
    if (!windows.length) return;
    // Clear stale observations while the panel stays open, without making a new request.
    const expires = Math.min(...windows.map(({ expiresAt }) => expiresAt));
    const timer = window.setTimeout(() => setWindows((old) => old.filter(({ expiresAt }) => expiresAt > Date.now())), Math.max(0, expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [windows]);

  if (stopped || !windows.length) return <p className="usage-note">No recent Claude limits reported for this session.</p>;
  return (
    <div className="usage-quota-results" aria-live="polite">
      <p className="usage-note">Quota remaining · Last reported by Claude</p>
      {windows.map((bucket) => (
        <Meter key={bucket.name} label={bucket.name} value={bucket.remainingFraction} tone={quotaTone(bucket.remainingFraction)}
          sub={`Observed ${new Date(bucket.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${bucket.resetAt ? ` · Resets ${new Date(bucket.resetAt).toLocaleString()}` : ''}`} />
      ))}
    </div>
  );
}
