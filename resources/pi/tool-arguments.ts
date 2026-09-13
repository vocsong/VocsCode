/** Compatibility preparation only: no I/O, permissions, or execution belongs here. */
export type CompatibleTool = 'read' | 'write' | 'edit' | 'bash';

export const TOOL_GUIDELINES = {
  read: 'read accepts file_path as an alias for path; prefer canonical path.',
  write: 'write accepts file_path as an alias for path; prefer canonical path.',
  edit: 'edit accepts file_path and a single old_string/new_string pair (including an empty new_string). Prefer path and edits[]. replace_all:true is unsupported; use unique, non-overlapping edits instead.',
  bash: 'bash timeout is in seconds (no default). timeout_ms is an explicit milliseconds alias; never infer units from magnitude or send both timeout fields.',
} satisfies Record<CompatibleTool, string>;

export function prepareToolArguments(tool: CompatibleTool, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = { ...value } as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  if (tool !== 'bash' && has('file_path')) {
    if (typeof input.file_path !== 'string') throw new Error('file_path must be a string. Use path for Pi file tools.');
    if (has('path') && input.path !== input.file_path) throw new Error('Conflicting path and file_path. Send only path.');
    input.path = input.file_path;
    delete input.file_path;
  }
  if (tool === 'edit') {
    if (has('replace_all')) {
      if (input.replace_all !== false) {
        throw new Error('replace_all:true is unsupported by Pi edit (replace_all must be false). Read the file and supply unique, non-overlapping edits[]; no changes were made.');
      }
      delete input.replace_all;
    }
    if (has('old_string') || has('new_string')) {
      if (has('edits') || has('oldText') || has('newText')) {
        throw new Error('Conflicting edit shapes. Send either edits[] or one old_string/new_string pair, not both.');
      }
      if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
        throw new Error('Both old_string and new_string must be strings; new_string may be empty.');
      }
      input.edits = [{ oldText: input.old_string, newText: input.new_string }];
      delete input.old_string;
      delete input.new_string;
    }
  }
  if (tool === 'bash' && has('timeout_ms')) {
    if (has('timeout')) throw new Error('Conflicting timeout units. Send timeout in seconds OR timeout_ms in milliseconds, not both.');
    if (typeof input.timeout_ms !== 'number' || !Number.isFinite(input.timeout_ms) || input.timeout_ms <= 0 || input.timeout_ms > 2_147_483_647) {
      throw new Error('timeout_ms must be a finite positive number no greater than 2147483647 milliseconds.');
    }
    input.timeout = input.timeout_ms / 1000;
    delete input.timeout_ms;
  }
  return input;
}
