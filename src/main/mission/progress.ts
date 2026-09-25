/** Progress describes new findings, not new receipt identities or journal observations. */
import { createHash } from 'node:crypto';
import type { MissionCheck, MissionCodeRevision, MissionEvidence, MissionRecord } from '../../shared/mission';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function verificationScope(specificationRevision: number, check: Pick<MissionCheck, 'id' | 'kind' | 'command'>, revision: MissionCodeRevision): string {
  return hash([specificationRevision, check.id, check.kind, check.command, revision.baseCommitSha, revision.contentHash]);
}
function evidenceScope(evidence: MissionEvidence): string {
  return verificationScope(evidence.specificationRevision, { id: evidence.checkId, kind: evidence.kind as MissionCheck['kind'], command: evidence.commandOrFlow }, evidence.sourceRevision);
}
function outcome(evidence: MissionEvidence): string {
  // Older receipts have no output digest. Their random artifact IDs are not proof of novelty.
  return hash([evidence.result, evidence.exitCode, evidence.executedTests, evidence.skippedTests, evidence.outcomeHash]);
}

export function evidenceMakesProgress(evidence: MissionEvidence, previous: readonly MissionEvidence[]): boolean {
  if (evidence.provenance === 'agent_claim' || evidence.result === 'passed' && evidence.invalidatedBy || !['passed', 'failed'].includes(evidence.result)) return false;
  if (evidence.result === 'failed' && (evidence.exitCode === undefined || evidence.kind === 'test' && !evidence.executedTests)) return false;
  return !previous.some((old) => evidenceScope(old) === evidenceScope(evidence) && outcome(old) === outcome(evidence));
}

export function missionProgressSnapshot(record: MissionRecord) {
  return { candidates: record.candidates.length, evidence: [...record.evidence], decisions: record.decisions.filter((d) => d.resolution).length,
    integrated: record.tasks.filter((task) => task.status === 'integrated').length };
}
export function missionMadeProgress(previous: ReturnType<typeof missionProgressSnapshot>, next: MissionRecord): boolean {
  return next.candidates.length > previous.candidates || next.decisions.filter((d) => d.resolution).length > previous.decisions
    || next.tasks.filter((task) => task.status === 'integrated').length > previous.integrated
    || next.evidence.slice(previous.evidence.length).some((evidence, index) => evidenceMakesProgress(evidence, [...previous.evidence, ...next.evidence.slice(previous.evidence.length, previous.evidence.length + index)]));
}

/** Same-input retries use the existing failed-attempt diagnosis bound, even within one turn.
 * A resolved, evidence-bound decision records the lead's diagnosis/changed approach. Merely
 * resuming, changing request keys, or adding observations does not reset the bound. */
export function verificationRetryIssue(record: MissionRecord, scope: string): { evidenceId: string; attempts: number; message: string } | undefined {
  const history = record.evidence.filter((evidence) => evidenceScope(evidence) === scope);
  const diagnosed = history.findLastIndex((evidence) => record.decisions.some((decision) => decision.resolution && decision.rationale && decision.evidenceIds.includes(evidence.id)));
  const failures = history.slice(diagnosed + 1).filter((evidence) => ['failed', 'blocked', 'skipped', 'not_run'].includes(evidence.result));
  const latest = failures.at(-1);
  // A denial requires a user action, never an implementation retry or model diagnosis.
  if (!latest || latest.failure?.recovery === 'user_action') return undefined;
  const attempts = failures.filter((evidence) => outcome(evidence) === outcome(latest)).length;
  if (attempts < record.config.limits.maxTaskAttemptsBeforeLeadDiagnosis) return undefined;
  return { evidenceId: latest.id, attempts, message: `Check ${latest.checkId} produced the same unsuccessful outcome ${attempts} times on unchanged content. Automation paused at the configured attempt limit. Inspect evidence ${latest.id}; record a decision with this evidence and a diagnosed changed approach, or change the check input, before requesting it again.` };
}

/** Compare actual output, excluding only host/run-specific paths and runner timing fields.
 * Raw output/reports remain immutable artifacts; this digest never certifies a pass. */
export function verificationOutcomeHash(outputs: readonly string[], paths: readonly string[], format?: 'vitest-json' | 'node-tap'): string {
  const normalize = (value: string) => {
    for (const path of paths) for (const spelling of new Set([path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\')])) {
      if (spelling) value = value.replaceAll(spelling, '<check-workspace>');
    }
    return value.replaceAll('\r\n', '\n').replace(/^(\s*(?:#\s*)?duration_ms:?\s+)\d+(?:\.\d+)?\s*$/gm, '$1<duration>');
  };
  return hash(outputs.map((output) => {
    // JSON reporters may write the same report to stdout as well as the report artifact.
    if (format === 'vitest-json') {
      try {
        const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
        const report: unknown = JSON.parse(output);
        if (object(report) && Array.isArray(report.testResults)) {
          delete report.startTime; delete report.endTime;
          for (const suite of report.testResults) if (object(suite)) {
            delete suite.startTime; delete suite.endTime;
            if (Array.isArray(suite.assertionResults)) for (const assertion of suite.assertionResults) if (object(assertion)) delete assertion.duration;
          }
          return normalize(JSON.stringify(report));
        }
      } catch { /* Invalid reports still retain and compare their actual diagnostic output. */ }
    }
    return normalize(output);
  }));
}
