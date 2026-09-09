/** Unified diff parser shared by the renderer and tests. Pure, no DOM. */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary?: boolean;
}

/**
 * Parses git-style and jsdiff-style unified diffs. Hunk line counts from the `@@` header are
 * tracked so content lines that happen to start with `---`/`+++` (e.g. a removed YAML document
 * separator or SQL comment) are not mistaken for file headers.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const newFile = (): DiffFile => {
    const f: DiffFile = { oldPath: '', newPath: '', hunks: [], additions: 0, deletions: 0 };
    files.push(f);
    hunk = null;
    oldLeft = newLeft = 0;
    return f;
  };
  const inHunk = () => !!hunk && (oldLeft > 0 || newLeft > 0);
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (!inHunk()) {
      if (line.startsWith('diff --git') || line.startsWith('Index: ')) {
        cur = newFile();
        const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (m) {
          cur.oldPath = m[1];
          cur.newPath = m[2];
        } else if (line.startsWith('Index: ')) cur.newPath = cur.oldPath = line.slice(7).trim();
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!cur || cur.hunks.length) cur = newFile();
        cur.oldPath = line.slice(4).replace(/^a\//, '').replace(/\t.*$/, '');
        continue;
      }
      if (line.startsWith('+++ ')) {
        if (cur) cur.newPath = line.slice(4).replace(/^b\//, '').replace(/\t.*$/, '');
        continue;
      }
      if (line.startsWith('Binary files')) {
        if (cur) cur.binary = true;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (!cur) cur = newFile();
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[3]) : 0;
      oldLeft = m ? (m[2] === undefined ? 1 : Number(m[2])) : 0;
      newLeft = m ? (m[4] === undefined ? 1 : Number(m[4])) : 0;
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk || !cur) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
      cur.additions++;
      newLeft--;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
      cur.deletions++;
      oldLeft--;
    } else if (line.startsWith('\\')) hunk.lines.push({ type: 'meta', text: line });
    else if (line.startsWith(' ') || (line === '' && inHunk())) {
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      oldLeft--;
      newLeft--;
    }
  }
  return files.filter((f) => f.hunks.length || f.binary);
}
