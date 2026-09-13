/** Stat tiles, the hero figure and footnotes shared by the analytics tabs. */
import React from 'react';
import type { AnalyticsSummary } from '../../../../shared/types';
import { fmtCost } from '../../format';
import { Sparkline } from './charts';
import { fmtDay, plural, type Delta, type Scope } from './model';

/**
 * One headline number. The delta is signed text with an arrow, so direction never rides on colour
 * alone; colour is added only when `upIsGood` says which direction is welcome.
 */
export function StatTile({ label, value, delta, upIsGood, sub, spark, title }: { label: string; value: string; delta?: Delta; upIsGood?: boolean; sub?: string; spark?: number[]; title?: string }) {
  const tone = !delta || delta.dir === 'flat' || upIsGood === undefined ? 'neutral' : (delta.dir === 'up') === upIsGood ? 'good' : 'bad';
  const arrow = delta?.dir === 'up' ? '▲' : delta?.dir === 'down' ? '▼' : '·';
  return (
    <div className="kpi" title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-row">
        <div className="kpi-value">{value}</div>
        {spark && <Sparkline values={spark} />}
      </div>
      {(delta || sub) && (
        <div className="kpi-foot">
          {delta && (
            <span className={`kpi-delta ${tone}`}>
              {arrow} {delta.text}
            </span>
          )}
          {sub && <span className="kpi-sub">{sub}</span>}
        </div>
      )}
    </div>
  );
}

export function KpiGrid({ children, caption }: { children: React.ReactNode; caption?: string }) {
  return (
    <div className="kpi-block">
      <div className="kpi-grid">{children}</div>
      {caption && <div className="kpi-caption">{caption}</div>}
    </div>
  );
}

/** The one number a tab leads with. */
export function Hero({ value, label, sub, delta, deltaLabel }: { value: string; label: string; sub?: React.ReactNode; delta?: Delta; deltaLabel?: string }) {
  return (
    <div className="hero">
      <div className="hero-label">{label}</div>
      <div className="hero-row">
        <div className="hero-value">{value}</div>
        {delta && (
          <div className="hero-delta">
            <span className="kpi-delta neutral">
              {delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '·'} {delta.text}
            </span>
            {deltaLabel && <span className="kpi-sub"> {deltaLabel}</span>}
          </div>
        )}
      </div>
      {sub && <div className="hero-sub">{sub}</div>}
    </div>
  );
}

/** Data-provenance notes that belong under every tab. */
export function Footnotes({ scope, summary, extra }: { scope: Scope; summary: AnalyticsSummary; extra?: string[] }) {
  const u = scope.unattributed;
  const notes: string[] = [];
  if (summary.firstDay) notes.push(`Tracking since ${fmtDay(summary.firstDay)} ${summary.firstDay.slice(0, 4)} across ${plural(summary.sessionCount, 'session')}, including deleted ones.`);
  notes.push('Days are UTC calendar days.');
  if (u && (u.costUsd > 0 || u.turns > 0 || u.toolCalls > 0)) notes.push(`${fmtCost(u.costUsd)}, ${plural(u.turns, 'turn')} and ${plural(u.toolCalls, 'tool call')} in this range were recorded before per-model tracking existed; they count in the totals but appear in no breakdown.`);
  if (scope.estimatedDays > 0) notes.push(`Breakdowns for ${plural(scope.estimatedDays, 'day')} recorded before per-model tracking were estimated from the sessions last active on each day, in proportion to their lifetime usage.`);
  if (scope.allTime) notes.push('All-time breakdowns attribute each session to its last model; bounded ranges attribute usage to the model that was active when it happened.');
  for (const e of extra ?? []) notes.push(e);
  return (
    <div className="afoot">
      {notes.map((n) => (
        <div key={n}>{n}</div>
      ))}
    </div>
  );
}
