/**
 * The Mission tools as the model sees them: one zod schema per tool is the single source of its JSON
 * Schema (what `tools/list` returns), its description and the validation the gateway runs before
 * MissionService sees a call. Objects are strict and every string and list is bounded, so a raw
 * loopback caller cannot hand the service identity fields or unbounded data. No Electron imports.
 */
import { z } from 'zod';
import { BUILDER_TOOLS, LEAD_TOOLS, type MissionRole, type MissionTool, type MissionToolArgs } from '../../shared/mission-mode';

const nonBlank = /\S/;
const text = (max: number, description: string) => z.string().min(1).max(max).regex(nonBlank).describe(description);
const optionalText = (max: number, description: string) => z.string().max(max).optional().describe(description);
const id = (description: string) => z.string().min(1).max(100).regex(nonBlank).describe(description);
const list = (description: string) => z.array(z.string().min(1).max(2_000)).max(100).describe(description);
const builderId = id('The Builder id start_builder returned (also in list_builders).');

/** One schema per tool, typed against the shared argument contract. */
const SCHEMAS: { [T in MissionTool]: z.ZodType<MissionToolArgs[T]> } = {
  start_builder: z.strictObject({
    title: text(120, 'A short title for the Builder, shown in the sidebar.'),
    task: text(20_000, 'The complete task: goal, scope, files, constraints and how to verify. The Builder sees only this and your later messages.'),
    own_worktree: z.boolean().optional().describe('Give the Builder its own branch and worktree (it lands on your branch with land_on_lead). Default false: it shares your worktree.')
  }),
  message_builder: z.strictObject({
    builderId,
    text: text(20_000, 'The message: an answer to its question, a correction or follow-up work.')
  }),
  answer_request: z.strictObject({
    requestId: id('The permission request id from the message that forwarded it.'),
    decision: z.enum(['allow', 'deny']).describe('allow or deny.'),
    note: optionalText(4_000, 'Why; the Builder (or the user, for a request only they may answer) sees it.')
  }),
  list_builders: z.strictObject({}),
  wait_for_builders: z.strictObject({}),
  builder_diff: z.strictObject({
    builderId,
    stat: z.boolean().optional().describe('Only the per-file summary, not the full diff.')
  }),
  builder_log: z.strictObject({ builderId }),
  record_check: z.strictObject({
    builderId,
    passed: z.boolean().describe('Whether the Builder’s work passed your check.'),
    note: optionalText(4_000, 'What you checked and what failed.')
  }),
  accept_builder: z.strictObject({ builderId }),
  stop_builder: z.strictObject({ builderId }),
  finish_mission: z.strictObject({
    task: text(4_000, 'One-line recap of the task as the user asked it.'),
    done: list('What was delivered, in outcome terms.'),
    decisions: list('Decisions taken and why.'),
    files: list('Files touched, grouped by what changed.'),
    verification: list('Exact commands run and their results.'),
    notes: list('Anything left for follow-up or deliberately not done.').optional()
  }),
  ask_lead: z.strictObject({
    question: text(8_000, 'One clear question, with the options you see.')
  }),
  report_done: z.strictObject({
    summary: text(20_000, 'What you did and how it meets the task.'),
    verification: list('Exact commands you ran and their results.'),
    files: list('Files you changed.').optional()
  }),
  report_blocked: z.strictObject({
    reason: text(8_000, 'What blocks you and what you need to continue.')
  }),
  land_on_lead: z.strictObject({})
};

const DESCRIPTIONS: Record<MissionTool, string> = {
  start_builder: 'Start a Builder session on one task. Returns the Builder id at once; the Builder works in the background and the app messages you when it reports, asks or fails. At most 3 Builders run at once.',
  message_builder: 'Send a Builder a message (an answer, a correction, follow-up work). It is delivered when the Builder is between turns.',
  answer_request: 'Answer a Builder’s permission request that was routed to you. deny always resolves it. allow resolves requests you may approve; for one only the user may answer, allow becomes your recommendation to the user.',
  list_builders: 'List the mission’s Builders with their states.',
  wait_for_builders: 'Returns the Builders’ states immediately. Then end your turn: the app messages you when a Builder reports, asks or fails.',
  builder_diff: 'Show a Builder’s changes since it started (stat: true for the per-file summary only).',
  builder_log: 'Show a Builder’s commits since it started.',
  record_check: 'Record the result of your check of a Builder’s work. The third failed check on one task blocks that Builder until the user next messages you.',
  accept_builder: 'Accept a Builder’s finished work: it must have landed on your branch (own worktree) or be committed (shared worktree). Stops the Builder and cleans up its worktree.',
  stop_builder: 'Stop a Builder without accepting its work. Unmerged work is kept and reported.',
  finish_mission: 'Finish the mission with the final report (Task / Done / Decisions / Files / Verification / Notes). Needs no Builder running and a clean Lead tree. The app pushes the mission branch once and opens a PR with the report as its body, or ends on a local branch.',
  ask_lead: 'Ask your Lead a question instead of guessing. Returns at once: end your turn, and the answer arrives as a message.',
  report_done: 'Report your task done to the Lead, with what you verified. Test and verify first. In a shared worktree, commit before reporting; in your own worktree, land_on_lead first.',
  report_blocked: 'Tell the Lead you cannot continue, and why.',
  land_on_lead: 'Own worktree only: fast-forward the Lead’s branch to yours. Merge the Lead’s branch into yours and resolve conflicts first; refused when either tree is dirty or the Lead’s branch moved.'
};

const ROLE_TOOLS: Readonly<Record<MissionRole, readonly MissionTool[]>> = { lead: LEAD_TOOLS, builder: BUILDER_TOOLS };

/** The tools a role's token lists and may call. */
export function missionToolsFor(role: MissionRole): readonly MissionTool[] {
  return ROLE_TOOLS[role];
}

/** True when `name` is one of `role`'s Mission tools. */
export function isMissionToolFor(role: MissionRole, name: unknown): name is MissionTool {
  return typeof name === 'string' && (ROLE_TOOLS[role] as readonly string[]).includes(name);
}

export interface MissionToolSchema {
  name: MissionTool;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { title: string; readOnlyHint: true; destructiveHint: false; openWorldHint: false };
}

function inputSchemaFor(tool: MissionTool): Record<string, unknown> {
  // The `$schema` keyword is noise to MCP clients and some model APIs reject it.
  const { $schema: _dialect, ...schema } = z.toJSONSchema(SCHEMAS[tool], { io: 'input' }) as Record<string, unknown>;
  return schema;
}

const LISTINGS = new Map<MissionTool, MissionToolSchema>(
  [...LEAD_TOOLS, ...BUILDER_TOOLS].map((tool) => [tool, {
    name: tool,
    description: DESCRIPTIONS[tool],
    inputSchema: inputSchemaFor(tool),
    // The tools never touch the workspace; the hints let a harness (Codex) run them in Plan.
    annotations: { title: tool, readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }])
);

/** What `tools/list` returns for a role's token. Fresh copies, so a caller cannot edit the table. */
export function missionToolSchemas(role: MissionRole): MissionToolSchema[] {
  return ROLE_TOOLS[role].map((tool) => structuredClone(LISTINGS.get(tool)!));
}

export type MissionArgsResult<T extends MissionTool> = { ok: true; args: MissionToolArgs[T] } | { ok: false; error: string };

/** Validates one call's raw arguments; the error names the offending fields, never their values. */
export function validateMissionToolArgs<T extends MissionTool>(tool: T, raw: unknown): MissionArgsResult<T> {
  const schema = SCHEMAS[tool] as z.ZodType<MissionToolArgs[T]> | undefined;
  if (!schema) return { ok: false, error: 'Unknown Mission tool.' };
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || (issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : 'arguments')))];
  return { ok: false, error: `Invalid arguments for ${tool}: ${fields.join('; ')}. See the tool's input schema.` };
}
