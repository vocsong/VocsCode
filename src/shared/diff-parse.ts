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

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const newFile = (): DiffFile => {
    const f: DiffFile = { oldPath: '', newPath: '', hunks: [], additions: 0, deletions: 0 };
    files.push(f);
    hunk = null;
    return f;
  };
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
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
      // A new "---" header after hunks (or with no diff --git line) starts a new file.
      if (!cur || cur.hunks.length) cur = newFile();
      cur.oldPath = line.slice(4).replace(/^a\//, '').replace(/\t.*$/, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur) cur.newPath = line.slice(4).replace(/^b\//, '').replace(/\t.*$/, '');
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) cur = newFile();
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('Binary files')) {
      if (cur) cur.binary = true;
      continue;
    }
    if (!hunk || !cur) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
      cur.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
      cur.deletions++;
    } else if (line.startsWith('\\')) hunk.lines.push({ type: 'meta', text: line });
    else if (line.startsWith(' ') || line === '') hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return files.filter((f) => f.hunks.length || f.binary);
}
