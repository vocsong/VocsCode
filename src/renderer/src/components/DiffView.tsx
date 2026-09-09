/** Renders a unified diff with per-file revert and commit actions. */
import React, { useMemo, useState } from 'react';
import { parseUnifiedDiff, type DiffFile } from '../../../shared/diff-parse';
import { Icon } from './ui';

export { parseUnifiedDiff };

export function DiffView({ diff, compact, onRevert }: { diff: string; compact?: boolean; onRevert?: (path: string) => void }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!files.length) return <div className="diff-empty muted">No textual changes.</div>;
  return (
    <div className={`diff ${compact ? 'diff-compact' : ''}`}>
      {files.map((f, i) => (
        <DiffFileView key={`${f.newPath}-${i}`} file={f} compact={compact} onRevert={onRevert} defaultOpen={files.length <= 3 || !!compact} />
      ))}
    </div>
  );
}

function DiffFileView({ file, compact, onRevert, defaultOpen }: { file: DiffFile; compact?: boolean; onRevert?: (path: string) => void; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const name = file.newPath && file.newPath !== '/dev/null' ? file.newPath : file.oldPath;
  const renamed = file.oldPath && file.newPath && file.oldPath !== file.newPath && file.oldPath !== '/dev/null' && file.newPath !== '/dev/null';
  return (
    <div className="diff-file">
      <div className="diff-file-head" onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevron' : 'chevronRight'} size={12} />
        <span className="diff-file-name mono">{renamed ? `${file.oldPath} → ${file.newPath}` : name}</span>
        <span className="diff-stat">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
        {onRevert && !compact && (
          <button
            type="button"
            className="link-btn small"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Revert changes to ${name}?`)) onRevert(name);
            }}
          >
            Revert
          </button>
        )}
      </div>
      {open && (
        <div className="diff-body">
          {file.binary && <div className="diff-line meta">Binary file</div>}
          {file.hunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-line hunk mono">{h.header}</div>
              {h.lines.map((l, li) => (
                <div key={li} className={`diff-line ${l.type} mono`}>
                  <span className="ln">{l.oldNo ?? ''}</span>
                  <span className="ln">{l.newNo ?? ''}</span>
                  <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
                  <span className="txt">{l.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
