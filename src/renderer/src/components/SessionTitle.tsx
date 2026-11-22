import React from 'react';
import { HARNESSES } from '../../../shared/harness-meta';
import { basename, harnessShort, sessionTitleText } from '../../../shared/session-title';
import type { SessionTitleMeta } from '../../../shared/session-title';
import './session-title.css';

export function HarnessPill({ harness, acpAgent }: { harness: string; acpAgent?: string }) {
  const label = harnessShort(harness);
  const name = HARNESSES.find((h) => h.id === harness)?.name ?? label;
  return (
    <span className="harness-pill" data-harness={harness} title={harness === 'acp' && acpAgent ? name + ' · ' + acpAgent : name}>
      {label}
    </span>
  );
}

export function SessionTitle({ session, className, nameTestId }: {
  session: SessionTitleMeta;
  className?: string;
  nameTestId?: string;
}) {
  const { title, config } = session;
  return (
    <span className={className ? 'session-label ' + className : 'session-label'} title={sessionTitleText(session)}>
      <HarnessPill harness={config.harness} acpAgent={config.acpAgent} />{' '}
      <span className="session-label-project" title={config.projectRoot}>{basename(config.projectRoot)}</span>{' '}
      <span className="session-label-separator">|</span>{' '}
      <span className="session-label-name" data-testid={nameTestId} title={title}>{title}</span>
    </span>
  );
}
