/** Host/UI text contracts for Mission errors: the real host producers, read by the shared helpers
 * the renderer uses. No store, harness or window. */
import { describe, expect, it } from 'vitest';
import { classifyMissionDispatch, missionFailureNotice } from '../src/main/mission/failures';
import { MissionStoreError } from '../src/main/mission/store';
import { isMissionRevisionConflict, missionFailureLabel, missionRevisionConflictMessage, readableMissionText } from '../src/shared/mission-errors';

describe('Mission revision conflicts', () => {
  it('words a handler pre-check exactly like the store CAS, recognisable through Electron and relay wrapping', () => {
    const message = missionRevisionConflictMessage(3, 4);
    expect(new MissionStoreError('REVISION_CONFLICT', 'Expected revision 3; current revision is 4').message).toBe(message);
    expect(isMissionRevisionConflict(new Error(message))).toBe(true);
    expect(isMissionRevisionConflict(new Error(`Error invoking remote method 'missions:control': Error: ${message}`))).toBe(true);
    expect(isMissionRevisionConflict(new Error('Stale Mission revision. Refresh before applying this control.'))).toBe(false);
  });
});

describe('readable Mission failure text', () => {
  it('turns the host failure notice into its category and human message, keeping the guidance', () => {
    const failure = classifyMissionDispatch('This adapter has not certified the Mission control protocol.');
    const blocker = `The principal engineer failed. ${missionFailureNotice(failure)} Pause/reconcile and explicitly resume.`;
    const text = readableMissionText(blocker);
    expect(text.startsWith(`The principal engineer failed. ${missionFailureLabel(failure.kind)} failure: ${failure.message}\n`)).toBe(true);
    expect(text).toContain('No preset, account, permission or retry policy was changed. Pause/reconcile and explicitly resume.');
    expect(text).not.toMatch(/Failure classification|[{}]/);
  });

  it('labels every failure kind in words and leaves text without a well-formed classification alone', () => {
    expect(missionFailureLabel('rate_limit')).toBe('Rate limit');
    expect(missionFailureLabel('protocol')).toBe('Runtime protocol');
    expect(missionFailureLabel('some_new_kind')).toBe('some new kind');
    for (const text of ['The managed workspace could not be provisioned.', 'Failure classification: {not json', 'Failure classification: {"kind":1,"message":"x"}', 'Failure classification: []']) {
      expect(readableMissionText(text)).toBe(text);
    }
  });
});
