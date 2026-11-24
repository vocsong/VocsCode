/**
 * The Lead's final report (the `finish_mission` arguments) as markdown: the PR description and the
 * report card in the transcript. Headings are exactly Task / Done / Decisions / Files / Verification
 * / PR / Notes; Notes is left out when empty. GitHub turns `#` plus digits into an issue link, so
 * such references in the Lead's prose are put in code spans.
 */
import type { MissionToolArgs } from '../../shared/mission-mode';

export type FinalReport = MissionToolArgs['finish_mission'];

/** What the PR section says: the PR opened (or about to be) or why the work stayed local. */
export type ReportPr =
  | { kind: 'pr'; head: string; base: string; url?: string }
  | { kind: 'local'; reason: string; branch?: string };

export const REPORT_HEADINGS = ['Task', 'Done', 'Decisions', 'Files', 'Verification', 'PR', 'Notes'] as const;

/** GitHub's description limit is 65 536 characters; stay clear of it. */
const MAX_BODY_CHARS = 60_000;
const MAX_ENTRY_CHARS = 4_000;

/** Wraps `#123` and `owner/repo#123` outside code spans in a code span, so GitHub does not link them. */
export function neutralizeIssueRefs(text: string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|[^\w`/&#])((?:[\w.-]+\/[\w.-]+)?#\d+)(?![\w-])/g, (_m, pre: string, ref: string) => `${pre}\`${ref}\``)))
    .join('');
}

function bullet(entry: string): string | undefined {
  let text = entry.replace(/\r\n?/g, '\n').trim();
  if (!text) return undefined;
  // The model often writes its own list markers; one is enough.
  text = text.replace(/^(?:[-*•]|\d+[.)])\s+/, '');
  if (text.length > MAX_ENTRY_CHARS) text = `${text.slice(0, MAX_ENTRY_CHARS)}…`;
  const [first, ...rest] = neutralizeIssueRefs(text).split('\n');
  return [`- ${first}`, ...rest.map((line) => (line.trim() ? `  ${line}` : ''))].join('\n');
}

function section(heading: string, entries: readonly string[] | undefined, empty = '- None.'): string {
  const lines = (entries ?? []).map(bullet).filter((b): b is string => !!b);
  return `## ${heading}\n${lines.length ? lines.join('\n') : empty}`;
}

function prSection(pr: ReportPr): string {
  if (pr.kind === 'local') {
    return ['## PR', bullet(`No PR: ${pr.reason}`)!, ...(pr.branch ? [`- The work is on the local branch \`${pr.branch}\`.`] : [])].join('\n');
  }
  const target = `\`${pr.head}\` into \`${pr.base}\``;
  return ['## PR', pr.url ? `- ${pr.url} (${target})` : `- ${target}`, '- Opened by Mission mode for review; it is never merged automatically.'].join('\n');
}

/** The report as markdown, every section bulleted. */
export function renderReport(report: FinalReport, pr: ReportPr): string {
  const notes = (report.notes ?? []).filter((n) => n.trim());
  const body = [
    section('Task', [report.task]),
    section('Done', report.done),
    section('Decisions', report.decisions),
    section('Files', report.files),
    section('Verification', report.verification),
    prSection(pr),
    ...(notes.length ? [section('Notes', notes)] : [])
  ].join('\n\n');
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n… (the report was cut to fit GitHub's limit)` : body;
}

/** The PR title: the report's task line, on one line and short. */
export function reportTitle(report: FinalReport): string {
  const line = report.task.replace(/\s+/g, ' ').trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
  return neutralizeIssueRefs(line.length > 120 ? `${line.slice(0, 119)}…` : line) || 'Mission';
}
