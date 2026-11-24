/**
 * The analytics tab strip and the selected tab's body, shared by the desktop's Analytics screen and
 * the code.vocs.io dashboard. Data loading stays with the caller; `replace` lets a caller render its
 * own body for a tab (the web dashboard compares computers side by side where reports cannot be
 * added together).
 */
import React, { useRef } from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import type { AnalyticsTab } from '../../store';
import { ActivityTab } from './ActivityTab';
import { CodeTab } from './CodeTab';
import type { Scope } from './model';
import { TABS } from './model';
import { OverviewTab } from './OverviewTab';
import { ReliabilityTab } from './ReliabilityTab';
import { SessionsTab } from './SessionsTab';
import { SpendTab } from './SpendTab';
import { TokensTab } from './TokensTab';
import { ToolsTab } from './ToolsTab';
import { Icon } from '../ui';

export function AnalyticsTabs({ tab, onTab }: { tab: AnalyticsTab; onTab: (tab: AnalyticsTab) => void }) {
  const tablist = useRef<HTMLDivElement>(null);
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next: AnalyticsTab | undefined;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length].id;
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length].id;
    else if (e.key === 'Home') next = TABS[0].id;
    else if (e.key === 'End') next = TABS[TABS.length - 1].id;
    if (!next) return;
    e.preventDefault();
    onTab(next);
    tablist.current?.querySelector<HTMLButtonElement>(`[data-tab='${next}']`)?.focus();
  };
  return (
    <div className="analytics-tabs" role="tablist" aria-label="Analytics sections" ref={tablist} onKeyDown={onTabKey}>
      {TABS.map((t) => (
        <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className={`atab ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
          <Icon name={t.icon} size={14} /> {t.label}
        </button>
      ))}
    </div>
  );
}

export function AnalyticsTabBody({ tab, scope, summary, replace }: { tab: AnalyticsTab; scope: Scope; summary: AnalyticsSummary; replace?: Partial<Record<AnalyticsTab, React.ReactNode>> }) {
  if (replace && tab in replace) return <>{replace[tab]}</>;
  switch (tab) {
    case 'overview':
      return <OverviewTab scope={scope} summary={summary} />;
    case 'spend':
      return <SpendTab scope={scope} summary={summary} />;
    case 'tokens':
      return <TokensTab scope={scope} summary={summary} />;
    case 'activity':
      return <ActivityTab scope={scope} summary={summary} />;
    case 'tools':
      return <ToolsTab scope={scope} summary={summary} />;
    case 'code':
      return <CodeTab scope={scope} summary={summary} />;
    case 'reliability':
      return <ReliabilityTab scope={scope} summary={summary} />;
    case 'sessions':
      return <SessionsTab scope={scope} summary={summary} />;
    default:
      return null;
  }
}
