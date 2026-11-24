/**
 * The system prompt additions a session runs with: the app's own instruction layer (see
 * `shared/app-instructions.ts`), then what the user configured for this session, then the project's
 * knowledge digest. The digest is kept beside the config (`SessionMeta.knowledgeDigest`) rather than
 * folded into it, so a session whose config was copied — a fork, a duplicated session — does not
 * inherit a stale digest only to have a second one appended on top of it.
 *
 * The app's layer is not stored on the session for the same reason: it is a live read, so a session
 * started after an edit gets the current text. Harnesses that have no system prompt to add to
 * (`capabilities.systemPrompt` false) are primed through the first message instead; see
 * `SessionManager.dispatchInput`.
 *
 * A Mission mode session's role prompt (`missionInstructions`) goes last, after the user's own
 * additions and the digest, so Mission rules win over everything before them.
 */
import type { SessionMeta } from '../../shared/types';
import type { HarnessContext } from './types';

export function sessionAppendPrompt(meta: Pick<SessionMeta, 'config' | 'knowledgeDigest'>, appInstructions?: string, missionInstructions?: string): string | undefined {
  const parts = [appInstructions?.trim(), meta.config.appendSystemPrompt?.trim(), meta.knowledgeDigest?.trim(), missionInstructions?.trim()].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}

/** The role prompt of a session in a mission; never asked for (undefined) for any other session. */
export async function missionPrompt(ctx: Pick<HarnessContext, 'session' | 'missionInstructions'>): Promise<string | undefined> {
  return ctx.session().mission ? ctx.missionInstructions?.() : undefined;
}
