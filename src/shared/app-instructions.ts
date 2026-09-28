/**
 * The app's own instruction layer: one shared text for every harness, plus one addition per harness
 * family. Shared by main (where the files are read and composed into a prompt) and the renderer
 * (which labels the editor tabs).
 *
 * This layer is additive on purpose. A scope never replaces the shared text — a `pi.md` that
 * silently dropped `global.md` would be a rule the user only discovers by reading a transcript.
 *
 * It is also not the harness's own global file. `APPEND_SYSTEM.md`, `~/.claude/CLAUDE.md` and
 * `~/.codex/AGENTS.md` stay exactly as they are and keep applying through their engine; this layer
 * is added after the engine's own prompt, so it can only add to it, never override it.
 */
import type { AppInstructionScope, HarnessId } from './types';

/** Both files are capped so an instruction file cannot crowd out the rest of a system prompt. */
export const APP_INSTRUCTION_MAX_CHARS = 16_000;

/** In the order the editor shows them: shared first, then one tab per harness family. */
export const APP_INSTRUCTION_SCOPES: AppInstructionScope[] = ['global', 'pi', 'claude', 'codex', 'cursor', 'acp', 'native'];

export const APP_INSTRUCTION_LABELS: Record<AppInstructionScope, string> = {
  global: 'All harnesses',
  pi: 'Pi',
  claude: 'Claude Agent SDK',
  codex: 'Codex',
  cursor: 'Cursor',
  acp: 'ACP agents',
  native: 'Native'
};

export const APP_INSTRUCTION_HINTS: Record<AppInstructionScope, string> = {
  global: 'Added to every session, whichever harness runs it, before the harness-specific text.',
  pi: 'Added for Pi sessions only, after the shared text.',
  claude: 'Added for Claude Agent SDK sessions only, after the shared text.',
  codex: 'Added for both Codex harnesses (app-server and exec), after the shared text.',
  cursor: 'Added for Cursor sessions only, after the shared text.',
  acp: 'Added for every ACP agent session, after the shared text.',
  native: 'Added for the native loop only, after the shared text.'
};

/** Which scope's file a session's harness reads. Both Codex harnesses share one family. */
export function appInstructionScope(harness: HarnessId): AppInstructionScope {
  switch (harness) {
    case 'codex':
    case 'codex-exec':
      return 'codex';
    default:
      return harness;
  }
}
