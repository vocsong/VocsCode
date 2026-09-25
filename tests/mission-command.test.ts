import { describe, expect, it } from 'vitest';
import { isMissionAffirmative, parseMissionCommand } from '../src/shared/mission-command';

describe('Mission command boundary', () => {
  it.each(['/missionary fix it', 'please /mission do this', '"/mission execute"', '/goal work'])('does not route %s', (text) => {
    expect(parseMissionCommand(text)).toBeNull();
  });
  it('opens controls for an exact empty command', () => {
    expect(parseMissionCommand(' /mission \n')).toEqual({ kind: 'show' });
  });
  it('treats ordinary non-verb text as an objective, not an unknown command', () => {
    expect(parseMissionCommand('/mission build the export view')).toEqual({ kind: 'launch', mode: 'autonomous', objective: 'build the export view', explicit: false });
    expect(parseMissionCommand('/mission plan explain cancellation')).toEqual({ kind: 'launch', mode: 'interactive_plan', objective: 'explain cancellation', explicit: false });
  });
  it.each(['execute', 'pause', 'resume', 'stop', 'status'] as const)('reserves %s exactly', (action) => {
    expect(parseMissionCommand(`/mission ${action}`)).toEqual({ kind: 'control', action });
    expect(parseMissionCommand(`/mission ${action} something`)).toMatchObject({ kind: 'error' });
    expect(parseMissionCommand(`/mission ${action}able`)).toMatchObject({ kind: 'launch' });
  });
  it.each(['/mission plan', '/mission start', '/mission start --', '/mission start fix', '/mission --model x', '/mission fix --force'])('reports actionable syntax errors for %s', (text) => {
    expect(parseMissionCommand(text)).toMatchObject({ kind: 'error', message: expect.stringMatching(/mission|Mission/) });
  });
  it('escapes reserved words and flags without interpreting literal input', () => {
    expect(parseMissionCommand('/mission start -- stop --now')).toEqual({ kind: 'launch', mode: 'autonomous', objective: 'stop --now', explicit: true });
  });
});

describe('user affirmative recognition (only used with a current pending proposal)', () => {
  it.each(['ok', 'Yes, please.', 'Proceed!', 'go ahead', 'approved', 'yes proceed'])('recognizes %s', (text) => expect(isMissionAffirmative(text)).toBe(true));
  it.each(['"proceed"', '> yes', '`/mission execute`', 'if I say yes', 'yes but change the scope', 'the worker said proceed', 'no', 'ok?'])('never authorizes %s', (text) => expect(isMissionAffirmative(text)).toBe(false));
});
