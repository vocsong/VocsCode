/**
 * The `/doctor` report: the About & doctor panel's rows as plain text, plus the fix for anything
 * that still needs setting up. Pure, so the composer only has to hand it a report and a version.
 */
import { HARNESS_BY_ID } from './harness-meta';
import type { DoctorReport, HarnessAvailability, HarnessId } from './types';

/** What `/doctor` knows about the app itself, from `app:info`. */
export interface DoctorAppInfo {
  version: string;
  isPackaged: boolean;
}

export interface DoctorReportText {
  text: string;
  /** `warn` while any runtime is missing or signed out, so the transcript line stands out. */
  level: 'info' | 'warn';
}

/** `available` and `authenticated` as one word — the same three states the Doctor table badges. */
function harnessState(a: HarnessAvailability): 'ok' | 'not logged in' | 'missing' {
  if (!a.available) return 'missing';
  return a.authenticated === false ? 'not logged in' : 'ok';
}

function harnessLine(id: HarnessId, a: HarnessAvailability): string {
  const name = HARNESS_BY_ID[id]?.name ?? id;
  const state = harnessState(a);
  // Version and location read like the table's third column; the hint is only worth printing when
  // something is wrong, and it is what makes the line actionable (installer, or how to sign in).
  const bits = [a.version, a.binaryPath ?? a.detail].filter((bit): bit is string => !!bit);
  if (state !== 'ok' && a.installHint) bits.push(`fix: ${a.installHint}`);
  return `  ${name} · ${state}${bits.map((bit) => ` · ${bit}`).join('')}`;
}

function providerLine(p: DoctorReport['providers'][number]): string {
  return `  ${p.name} · ${p.hasKey ? 'key stored' : p.envKeyPresent ? 'key from the environment' : 'no key'}`;
}

/** Renders `app:doctor` as the one transcript note `/doctor` prints. */
export function formatDoctorReport(report: DoctorReport, app: DoctorAppInfo): DoctorReportText {
  const harnesses = Object.entries(report.harnesses) as [HarnessId, HarnessAvailability][];
  const ready = harnesses.filter(([, a]) => harnessState(a) === 'ok').length;
  const lines = [
    `Vocs Code ${app.version}${app.isPackaged ? '' : ' (dev build)'} · ${report.platform} · Electron ${report.electron} · Node ${report.node}`,
    '',
    `Harnesses (${ready} of ${harnesses.length} ready)`,
    ...harnesses.map(([id, a]) => harnessLine(id, a)),
    '',
    'Providers',
    ...report.providers.map(providerLine),
    '',
    'Settings → About & doctor shows this as a table, with the installers and update state.',
    `userData: ${report.userData}`
  ];
  return { text: lines.join('\n'), level: ready === harnesses.length ? 'info' : 'warn' };
}
