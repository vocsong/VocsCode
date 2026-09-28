/**
 * The app's own instruction layer on disk: one markdown file per scope under
 * `<userData>/instructions/`. `global.md` is added to every session; `pi.md`, `claude.md`,
 * `codex.md`, `cursor.md`, `acp.md` and `native.md` add to it for that harness family only.
 *
 * Files rather than a settings key because this is text a user edits and keeps under version
 * control, the same reason the project layer (`AGENTS.md`, `.vocs-code/INSTRUCTIONS.md`) and pi's
 * own prompt files are files. Saving an empty file removes it, so the editor can switch the layer
 * off without leaving an empty artifact behind.
 *
 * Nothing is cached: native rebuilds its system prompt per step, and two small reads there are far
 * cheaper than the staleness a cache would introduce for a user editing the file mid-session.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { APP_INSTRUCTION_MAX_CHARS, APP_INSTRUCTION_SCOPES, appInstructionScope } from '../shared/app-instructions';
import type { AppInstructionFile, AppInstructionScope, HarnessId } from '../shared/types';
import { errorMessage } from './util/async';
import type { Logger } from './log';

export class AppInstructions {
  private readonly root: string;

  constructor(userData: string, private readonly log: Logger = () => undefined) {
    this.root = path.join(userData, 'instructions');
  }

  /** The directory the editor offers to open, whether or not it exists yet. */
  dir(): string {
    return this.root;
  }

  async read(): Promise<AppInstructionFile[]> {
    return Promise.all(APP_INSTRUCTION_SCOPES.map((scope) => this.readOne(scope)));
  }

  /** Writes one scope; blank content deletes the file. Returns the whole layer, as the editor reads it. */
  async write(scope: AppInstructionScope, content: string): Promise<AppInstructionFile[]> {
    this.requireScope(scope);
    if (content.length > APP_INSTRUCTION_MAX_CHARS) {
      throw new Error(`Instructions are limited to ${Math.round(APP_INSTRUCTION_MAX_CHARS / 1000)} KB per file`);
    }
    const file = this.fileFor(scope);
    if (!content.trim()) {
      await fs.rm(file, { force: true });
      this.log('info', `app instructions removed: ${scope}`);
    } else {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(file, content, 'utf8');
      this.log('info', `app instructions saved: ${scope}`);
    }
    return this.read();
  }

  /**
   * The text a session of this harness runs with: the shared file, then the harness family's own.
   * Undefined when neither has anything in it, so callers can leave the harness's prompt untouched.
   */
  async effective(harness: HarnessId): Promise<string | undefined> {
    const parts = await Promise.all((['global', appInstructionScope(harness)] as AppInstructionScope[]).map(async (scope) => (await this.readOne(scope)).content.trim()));
    const text = parts.filter(Boolean).join('\n\n');
    return text || undefined;
  }

  private fileFor(scope: AppInstructionScope): string {
    return path.join(this.root, `${scope}.md`);
  }

  private requireScope(scope: string): asserts scope is AppInstructionScope {
    if (!APP_INSTRUCTION_SCOPES.includes(scope as AppInstructionScope)) throw new Error(`Unknown instruction scope: ${scope}`);
  }

  private async readOne(scope: AppInstructionScope): Promise<AppInstructionFile> {
    const file = this.fileFor(scope);
    try {
      const buf = await fs.readFile(file);
      const truncated = buf.length > APP_INSTRUCTION_MAX_CHARS;
      // A truncated read is shown but never saved back: the editor offers the file itself instead.
      return { scope, path: file, exists: true, content: buf.subarray(0, APP_INSTRUCTION_MAX_CHARS).toString('utf8'), ...(truncated ? { truncated: true } : {}) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log('warn', `could not read ${file}: ${errorMessage(e)}`);
      return { scope, path: file, exists: false, content: '' };
    }
  }
}
