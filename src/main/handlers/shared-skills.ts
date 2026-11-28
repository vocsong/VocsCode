import path from 'node:path';
import { z } from 'zod';
import { MAX_SHARED_SKILL_COMMAND_CHARS, SHARED_SKILL_NAME } from '../../shared/shared-skills';
import { SharedSkillsStore } from '../shared-skills';
import { sessionIdSchema, type HandlerContext } from './context';

const name = z.string().max(64).regex(SHARED_SKILL_NAME);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const readRequest = z.strictObject({ name });
const createRequest = z.strictObject({ name, description: z.string().max(1024) });
const saveRequest = z.strictObject({ name, revision, content: z.string().max(32 * 1024) });
const reviewRequest = z.strictObject({ name, revision, enabled: z.boolean() });
const invokeRequest = z.strictObject({ id: sessionIdSchema, text: z.string().max(MAX_SHARED_SKILL_COMMAND_CHARS), revision: revision.optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  // Do not reflect unexpected keys, values, or document text into the registry's error logger.
  if (!result.success) throw new Error('Invalid Shared skill request.');
  return result.data;
}

/** Do not join this with `skills:list/read`: those native inventory routes are remotely readable. */
export function registerSharedSkillHandlers({ handle, deps, sessionFor }: HandlerContext): void {
  let catalog = deps.sharedSkills;
  const store = () => catalog ??= new SharedSkillsStore(path.join(deps.desktop.userDataPath(), 'shared-skills.json'));
  handle('sharedSkills:list', (request) => {
    if (request !== undefined) throw new Error('Invalid Shared skill request.');
    return store().list();
  });
  handle('sharedSkills:read', (request) => store().read(parse(readRequest, request).name));
  handle('sharedSkills:create', (request) => store().create(parse(createRequest, request)));
  handle('sharedSkills:save', (request) => store().save(parse(saveRequest, request)));
  handle('sharedSkills:review', (request) => store().review(parse(reviewRequest, request)));
  handle('sharedSkills:invoke', async (request) => {
    const { id, text, revision: expected } = parse(invokeRequest, request);
    sessionFor(id);
    const resolve = (skill: string) => store().resolve(skill);
    if (expected) await deps.sessions.sendSharedSkill(id, text, resolve, expected);
    else await deps.sessions.sendSharedSkill(id, text, resolve);
    return { sent: true };
  });
}
