/** Exact command parsing shared by the composer and privileged launch handler. */
import type { MissionMode } from './mission';
import type { ImageAttachment } from './types';

/** Genuine user command input; images are launch/steering context, never control authority. */
export interface MissionCommandRequest {
  sessionId: string;
  text: string;
  idempotencyKey: string;
  images?: ImageAttachment[];
}

/** `/mission status` in a session that has no Mission: said out loud, never a silent no-op. */
export const MISSION_NOT_LINKED_MESSAGE = 'No Mission is linked to this session.';

export type MissionCommand =
  | { kind: 'show' }
  | { kind: 'launch'; mode: MissionMode; objective: string; explicit: boolean }
  | { kind: 'control'; action: 'execute' | 'pause' | 'resume' | 'stop' | 'status' }
  | { kind: 'error'; message: string };

export function parseMissionCommand(text: string): MissionCommand | null {
  const input = text.trim();
  if (!/^\/mission(?:\s|$)/.test(input)) return null;
  const rest = input.slice('/mission'.length).trim();
  if (!rest) return { kind: 'show' };
  const [verb] = rest.split(/\s+/, 1);
  const tail = rest.slice(verb.length).trim();
  if (verb === 'start') {
    if (!/^--(?:\s|$)/.test(tail) || !tail.slice(2).trim()) {
      return { kind: 'error', message: 'Use /mission start -- <literal objective> to create a Mission whose objective starts with a reserved word.' };
    }
    return { kind: 'launch', mode: 'autonomous', objective: tail.slice(2).trim(), explicit: true };
  }
  if (['execute', 'pause', 'resume', 'stop', 'status'].includes(verb)) {
    if (tail) return { kind: 'error', message: `/mission ${verb} does not take arguments. For a literal objective, use /mission start -- ${rest}` };
    return { kind: 'control', action: verb as 'execute' | 'pause' | 'resume' | 'stop' | 'status' };
  }
  if (/(?:^|\s)--?\S+/.test(rest)) return { kind: 'error', message: 'Mission flags are not supported. Select options in New Session, or use /mission start -- <literal objective>.' };
  if (verb === 'plan') {
    if (!tail) return { kind: 'error', message: 'Describe what to plan: /mission plan <objective>.' };
    return { kind: 'launch', mode: 'interactive_plan', objective: tail, explicit: false };
  }
  return { kind: 'launch', mode: 'autonomous', objective: rest, explicit: false };
}

/** Conservative host interpretation; material changes/hypotheticals/quotes never authorize. */
export function isMissionAffirmative(text: string): boolean {
  return /^(?:yes(?:,?\s+(?:please|proceed|execute|go ahead))?|proceed|execute|go ahead|approved|approve|ok(?:ay)?)[.!]?$/i.test(text.trim());
}
