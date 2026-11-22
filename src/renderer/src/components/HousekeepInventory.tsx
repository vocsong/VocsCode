import React, { useId, useState } from 'react';
import type { HousekeepInventory as Inventory, HousekeepInventoryRow } from '../../../shared/housekeep';
import { invoke, invokeErrorMessage } from '../api';
import { Badge, Button } from './ui';

const FINDINGS = {
  'unregistered-folder': { label: 'Unregistered folder', reason: 'Git does not list this folder as a worktree.' },
  'stale-registration': { label: 'Stale registration', reason: 'Git still lists this worktree.' },
  'archived-worktree': { label: 'Archived session worktree', reason: 'An archived session records a path in this worktree.' },
  'unlinked-worktree': { label: 'Unlinked worktree', reason: 'No matching checkout path was found in the session records.' },
  'unverified-path': { label: 'Unverified path', reason: 'The scan could not verify this path.' },
  'retained-branch': { label: 'Retained branch', reason: 'This local branch is linked to an archived session.' },
  'unlinked-branch': { label: 'Unlinked branch', reason: 'No session link was found for this local branch.' }
} satisfies Record<HousekeepInventoryRow['kind'], { label: string; reason: string }>;

const DISK_STATE = { present: 'present', missing: 'not found', unknown: 'not verified' } as const;
const sessionNames = (sessions: HousekeepInventoryRow['sessions']) => sessions.map(({ title, archived }) => `${title} (${archived ? 'archived' : 'not archived'})`).join('; ');

type ScanState = { step: 'idle' | 'scanning' } | { step: 'error'; message: string } | { step: 'result'; inventory: Inventory };

function scanSummary({ repositories, rows, warnings, limited }: Inventory): string {
  const scope = `${repositories} ${repositories === 1 ? 'repository' : 'repositories'} scanned.`;
  if (rows.length || limited || warnings.length) return `${scope} ${rows.length} ${rows.length === 1 ? 'finding' : 'findings'} returned.`;
  if (!repositories) return 'No known Git repositories to scan.';
  return `${scope} No findings in the checked locations.`;
}

function InventoryFindings({ rows, warnings, limited }: Inventory) {
  return <>
    {(limited || warnings.length > 0) && <div className="callout warn" role="alert">
      <strong>{limited ? 'Scan limit reached. Results are incomplete.' : 'Scan finished with warnings. Results may be incomplete.'}</strong>
      {warnings.length > 0 && <ul className="housekeep-inventory-warnings" aria-label="Scan warnings">
        {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>}
    </div>}
    {rows.length > 0 && <ul className="housekeep-list" aria-label="Inventory findings">
      {rows.map((row) => {
        const { label, reason } = FINDINGS[row.kind];
        const linkUnknown = row.sessionLinksIncomplete && (row.kind === 'unlinked-worktree' || row.kind === 'unlinked-branch');
        return <li className="housekeep-row" key={JSON.stringify([row.projectRoot, row.kind, row.location])}>
          <div className="housekeep-inventory-labels">
            <Badge>{linkUnknown ? 'Unverified session links' : label}</Badge>
            {row.locked && <Badge tone="amber">Locked</Badge>}
          </div>
          <strong><code>{row.location}</code></strong>
          <div className="muted small">Repository: <code>{row.projectRoot}</code></div>
          {row.branch && <div className="muted small">Branch: <code>{row.branch}</code></div>}
          {!linkUnknown && <div>{reason}</div>}
          {row.diskState && <div>Folder on disk: {DISK_STATE[row.diskState]}</div>}
          {row.gitMarksStale && <div>Git marks this registration as stale.</div>}
          {row.sessions.length > 0 && <div className="muted small">
            Linked {row.sessions.length === 1 ? 'session' : 'sessions'}: {sessionNames(row.sessions)}
          </div>}
          {!!row.branchSessions?.length && <div className="muted small">Sessions recording this branch at another path: {sessionNames(row.branchSessions)}</div>}
          {row.sessionLinksIncomplete && <div className="muted small">Session links could not be fully checked.</div>}
        </li>;
      })}
    </ul>}
  </>;
}

export function HousekeepInventory({ disabled }: { disabled: boolean }) {
  const headingId = useId();
  const scopeId = useId();
  const [scan, setScan] = useState<ScanState>({ step: 'idle' });

  const scanInventory = async () => {
    if (disabled || scan.step === 'scanning') return;
    setScan({ step: 'scanning' });
    try {
      const inventory = await invoke('housekeep:inventory', undefined);
      setScan({ step: 'result', inventory });
    } catch (cause) {
      setScan({ step: 'error', message: invokeErrorMessage(cause) });
    }
  };

  return <section className="housekeep-inventory" aria-labelledby={headingId}>
    <h3 id={headingId}>Stranded worktrees and branches</h3>
    <p id={scopeId} className="muted small">
      <strong>Read-only:</strong> checks Git registrations, local branches, and known worktree folders in projects from saved folders and sessions, including archived ones.
      The scan doesn’t read checkout contents or change anything locally or on remotes.
      An item with no session link is not necessarily abandoned.
    </p>
    <div className="housekeep-inventory-actions">
      <Button size="sm" aria-describedby={scopeId} disabled={disabled || scan.step === 'scanning'}
        onClick={() => void scanInventory()}>Scan worktrees and branches</Button>
      <span className="muted small" role="status">
        {scan.step === 'scanning' ? 'Scanning worktrees and branches…' : scan.step === 'result' ? scanSummary(scan.inventory) : null}
      </span>
    </div>
    {scan.step === 'error' && <p className="callout warn" role="alert">Could not scan worktrees and branches. {scan.message}</p>}
    {scan.step === 'result' && <InventoryFindings {...scan.inventory} />}
  </section>;
}
