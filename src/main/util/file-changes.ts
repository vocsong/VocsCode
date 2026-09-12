import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { FileChange } from '../../shared/types';

export interface FileChangeOptions {
  /** Treat an empty existing file as an add, matching tools that omit old content. */
  addWhenEmpty?: boolean;
  /** Header shown for the old side of a newly-created file. */
  newFileHeader?: string;
  context?: number;
}

/** Builds one normalized file change and its jsdiff patch for a workspace-relative path. */
export function makeFileChange(cwd: string, file: string, before: string | null | undefined, after: string, options: FileChangeOptions = {}): FileChange {
  const rel = path.isAbsolute(file) ? path.relative(cwd, file) || file : file;
  const isAdd = before == null || (options.addWhenEmpty === true && before.length === 0);
  const oldText = before ?? '';
  return {
    path: rel,
    kind: isAdd ? 'add' : 'update',
    diff: createTwoFilesPatch(rel, rel, oldText, after, isAdd ? options.newFileHeader ?? '' : '', '', { context: options.context ?? 3 })
  };
}
