/** Leaf transcript cards for tool calls, Mission tool handoffs, and plan checklists. */
import React, { useState } from 'react';
import type { MissionTool } from '../../../../shared/mission-mode';
import type { FileChange, TranscriptItem } from '../../../../shared/types';
import { fmtDuration } from '../../format';
import {
  builderIndexOf,
  finishReportSections,
  missionToolLabel,
  missionToolSummary,
  startedBuilderIndex,
  toolArg
} from '../../mission';
import { useStore } from '../../store';
import { DiffView } from '../DiffView';
import { Badge, Icon, Spinner } from '../ui';
import type { ToolItem } from './grouping';
import { Stamp } from './shared';

const HINT_ICON: Record<string, string> = { execute: 'terminal', edit: 'edit', read: 'file', search: 'search', fetch: 'external', think: 'brain', mcp: 'bolt', agent: 'fork', other: 'bolt' };

const MISSION_TOOL_ICON: Record<MissionTool, string> = {
  start_builder: 'play', message_builder: 'send', answer_request: 'shield', list_builders: 'list', wait_for_builders: 'clock',
  builder_diff: 'diff', builder_log: 'branch', record_check: 'check', accept_builder: 'check', stop_builder: 'stop',
  finish_mission: 'flag', ask_lead: 'info', report_done: 'check', report_blocked: 'alert', land_on_lead: 'branch'
};

/** Status badge text for a tool row: an exit code says more than "error" when there is one. */
function toolStatus(item: ToolItem): string {
  if (item.exitCode !== undefined && item.exitCode !== null && (item.status === 'done' || item.status === 'error')) return `exit ${item.exitCode}`;
  return item.status === 'done' ? 'done' : item.status;
}

/** Lines added and removed across a tool call's diffs; null when it carried none. */
function diffStat(changes: FileChange[] | undefined): { add: number; del: number } | null {
  const diffs = changes?.filter((c) => c.diff) ?? [];
  if (!diffs.length) return null;
  let add = 0;
  let del = 0;
  for (const c of diffs) {
    for (const line of c.diff!.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) add++;
      else if (line.startsWith('-') && !line.startsWith('---')) del++;
    }
  }
  return { add, del };
}

/** A plan as a checklist: done steps stay readable (no strike-through), the live one is marked. */
export function PlanCard({ item }: { item: Extract<TranscriptItem, { kind: 'plan' }> }) {
  const done = item.entries.filter((e) => e.status === 'completed').length;
  const total = item.entries.length;
  return (
    <div className="plan-card">
      <div className="plan-title">
        <Icon name="list" size={13} /> Plan
        {total > 0 && <span className="plan-progress">{done} of {total} done</span>}
        {total > 0 && (
          <span className="plan-bar" aria-hidden>
            <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
        )}
        <Stamp ts={item.ts} className="plan-time" />
      </div>
      <ul>
        {item.entries.map((e, i) => (
          <li key={i} className={`plan-${e.status}`}>
            <span className="plan-check" aria-label={e.status.replace('_', ' ')}>
              {e.status === 'completed' ? <Icon name="check" size={11} /> : e.status === 'in_progress' ? <span className="plan-live" /> : null}
            </span>
            <span className="plan-text">{e.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A Mission tool call as the handoff it is ("Started Builder 2: …", "Asked the Lead"). The raw
 * arguments and result stay one click away; `finish_mission` shows its report as the PR body reads.
 */
export function MissionToolCard({ item, tool, sessionId, dataItemId }: { item: ToolItem; tool: MissionTool; sessionId: string; dataItemId?: string }) {
  const [open, setOpen] = useState(false);
  const builderId = toolArg(item.input, 'builderId');
  const builderIndex = useStore((s) =>
    builderId ? builderIndexOf(builderId, s.missionViews, s.sessions)
      : tool === 'start_builder' ? startedBuilderIndex(item.output, toolArg(item.input, 'title'), s.missionViews)
      : undefined);
  const jumpHere = useStore((s) => !!s.searchJump && s.searchJump.sessionId === sessionId && s.searchJump.itemId === item.id);
  const expanded = open || jumpHere;
  const running = item.status === 'running';
  const failed = item.status === 'error' || item.status === 'declined';
  const label = missionToolLabel(tool, item.input, builderIndex ? `Builder ${builderIndex}` : undefined);
  const summary = missionToolSummary(tool, item.input);
  const report = tool === 'finish_mission' ? finishReportSections(item.input) : [];
  return (
    <div data-item-id={dataItemId} className={`mission-card mission-tool tool-${item.status}`} data-tool={tool}>
      <button type="button" className="mission-card-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)} title={expanded ? 'Hide the call details' : 'Show the call details'}>
        <span className="mission-card-glyph"><Icon name={MISSION_TOOL_ICON[tool]} size={13} /></span>
        <span className="mission-card-label">{label}</span>
        {summary && tool !== 'finish_mission' && <span className="mission-card-summary" title={summary}>{summary}</span>}
        <span className="spacer" />
        {running ? <Spinner size={12} /> : failed ? <Badge tone={item.status === 'error' ? 'red' : 'amber'}>{toolStatus(item)}</Badge> : null}
        <Stamp ts={item.ts} className="mission-card-time" detail={item.durationMs ? `took ${fmtDuration(item.durationMs)}` : undefined} />
        <Icon name={expanded ? 'chevron' : 'chevronRight'} size={12} />
      </button>
      {report.length > 0 && (
        <div className="mission-report" aria-label="Mission report">
          {report.map((section) => (
            <div key={section.title} className="mission-report-section">
              <div className="mission-report-title">{section.title}</div>
              {section.title === 'Task' ? <p>{section.lines[0]}</p> : <ul>{section.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>}
            </div>
          ))}
        </div>
      )}
      {expanded && (
        <div className="tool-body mission-tool-body">
          <div className="mission-tool-name muted small mono">{item.name}</div>
          {item.input !== undefined && <pre className="tool-input mono">{typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2).slice(0, 4000)}</pre>}
          {item.output && <pre className="tool-output mono">{item.output.length > 12_000 ? item.output.slice(-12_000) : item.output}</pre>}
        </div>
      )}
    </div>
  );
}

export function ToolCard({ item, sessionId, dataItemId }: { item: ToolItem; sessionId: string; dataItemId?: string }) {
  const [open, setOpen] = useState(false);
  const revealSubagentRun = useStore((s) => s.revealSubagentRun);
  const command = item.hint === 'execute';
  const running = item.status === 'running';
  const failed = item.status === 'error' || item.status === 'declined';
  const hasBody = !!item.output || !!(item.changes && item.changes.length) || item.input !== undefined;
  const statusTone = running ? 'blue' : item.status === 'error' ? 'red' : item.status === 'declined' ? 'amber' : 'green';
  // A running command streams its output into view; every other body waits for a click.
  const showBody = open || (running && command && !!item.output);
  const commandText = item.summary ?? (typeof item.input === 'string' ? item.input : '');
  const stat = diffStat(item.changes);
  return (
    <div data-item-id={dataItemId} className={`tool-card tool-${item.status} ${command ? 'tool-command' : ''} ${item.parentId ? 'tool-nested' : ''}`}>
      <button type="button" className="tool-head" onClick={() => hasBody && setOpen((o) => !o)}>
        <span className="tool-glyph"><Icon name={HINT_ICON[item.hint ?? 'other']} size={13} className="tool-icon" /></span>
        <span className="tool-name">{command ? (running ? 'Running' : 'Ran') : item.title ?? item.name}</span>
        {item.summary && <span className="tool-summary mono" title={item.summary}>{item.summary}</span>}
        <span className="spacer" />
        {stat ? (
          <span className="tool-changes diff-stat"><span className="add">+{stat.add}</span> <span className="del">−{stat.del}</span></span>
        ) : item.changes?.length ? <span className="tool-changes">{item.changes.length} file{item.changes.length === 1 ? '' : 's'}</span> : null}
        {/* Success is the expected outcome, so only a failure, a refusal or live work earns a badge. */}
        {running ? <Spinner size={12} /> : failed ? <Badge tone={statusTone}>{toolStatus(item)}</Badge> : null}
        {!command && item.durationMs ? <span className="muted small">{fmtDuration(item.durationMs)}</span> : null}
        {item.runId ? (
          <span
            className="chip"
            role="button"
            tabIndex={0}
            title="Open this run in the Subagents panel"
            onClick={(e) => {
              e.stopPropagation();
              revealSubagentRun(sessionId, item.runId!);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              revealSubagentRun(sessionId, item.runId!);
            }}
          >
            open run
          </span>
        ) : null}
        <Stamp ts={item.ts} className="tool-time" detail={item.durationMs ? `took ${fmtDuration(item.durationMs)}` : undefined} />
        {/* Held in place without a body too, so the times line up in one column down the steps. */}
        <Icon name={open ? 'chevron' : 'chevronRight'} size={12} className={hasBody ? undefined : 'tool-chevron-none'} />
      </button>
      {showBody && (
        <div className="tool-body">
          {command ? (
            <div className="shell-card">
              <div className="shell-bar">Shell</div>
              {commandText ? <pre className="shell-cmd mono"><span className="shell-prompt">$ </span>{commandText}</pre> : null}
              {item.output && <pre className="tool-output mono">{item.output.length > 12_000 && !open ? item.output.slice(-12_000) : item.output}</pre>}
              {open && (
                <div className={`shell-foot ${failed ? 'shell-foot-failed' : ''}`}>
                  <Icon name={failed ? 'alert' : 'check'} size={12} /> {toolStatus(item)}{item.durationMs ? ` · ${fmtDuration(item.durationMs)}` : ''}
                </div>
              )}
            </div>
          ) : (
            <>
              {open && item.input !== undefined && (
                <pre className="tool-input mono">{typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2).slice(0, 4000)}</pre>
              )}
              {item.changes?.some((c) => c.diff) && <DiffView diff={item.changes.filter((c) => c.diff).map((c) => c.diff!).join('\n')} compact />}
              {item.output && <pre className="tool-output mono">{item.output.length > 12_000 && !open ? item.output.slice(-12_000) : item.output}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
