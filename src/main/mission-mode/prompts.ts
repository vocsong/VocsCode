/**
 * Mission mode's role prompts and the host messages that start and resume a mission.
 *
 * A session's role prompt is the built-in Lead or Builder prompt, then the user's `lead.md` /
 * `builder.md` add-on, then a short recap of the non-negotiable Mission rules LAST, so they win
 * over project instructions such as "merge PRs". Adapters append the result after every other
 * instruction layer (`sessionAppendPrompt`), which keeps the recap last overall.
 */
import { MISSION_LIMITS, type BuilderState, type MissionRole } from '../../shared/mission-mode';

export interface MissionPromptContext {
  missionId: string;
  /** False for a folder without git: everyone works in the folder, with no branches and no PR. */
  git: boolean;
  /** The Lead's folder: its worktree, or the project folder without git. */
  leadWorktree: string;
  leadBranch?: string;
  /** The branch the PR goes into. */
  baseBranch?: string;
  limits?: { builders: number; failedChecks: number };
  /** Set for a Builder's prompt. */
  builder?: {
    index: number;
    title: string;
    ownWorktree: boolean;
    /** Its own worktree, when it has one. */
    worktree?: string;
    branch?: string;
  };
}

const code = (s: string | undefined, fallback: string): string => (s ? `\`${s}\`` : fallback);

function leadPrompt(ctx: MissionPromptContext): string {
  const limits = ctx.limits ?? MISSION_LIMITS;
  const lead = code(ctx.leadBranch, 'the mission branch');
  const base = code(ctx.baseBranch, 'the starting branch');
  const where = ctx.git
    ? [
        `- Base branch: ${base}. The PR goes into it.`,
        `- Your branch: ${lead}, in the worktree ${code(ctx.leadWorktree, 'of this session')}. It started from the last commit; uncommitted changes in the project checkout are not in it.`,
        `- Builders share your worktree unless you start one with \`own_worktree: true\`. Give a Builder its own worktree when its work would collide with another Builder's files or its tests must run in isolation. That Builder merges ${lead} into its branch, resolves conflicts, tests there, and fast-forwards ${lead} with land_on_lead, one land at a time.`
      ]
    : [`- ${code(ctx.leadWorktree, 'This folder')} is not a git repository: every Builder works in it directly, there are no branches, and the mission ends with the work in place, without a PR.`];
  return [
    '# Mission mode: you are the Lead',
    '',
    `You lead mission ${ctx.missionId}. You plan the work, hand it to Builder sessions, check what they deliver and report to the user. You never edit files yourself: you run in Plan mode and act on the project only through the Mission tools.`,
    '',
    "## The mission's folders",
    ...where,
    '',
    '## How you work',
    '1. Read enough of the project to plan, including its own instructions (AGENTS.md and similar); the Builders follow them too.',
    '2. Ask the user only at a real fork: an ambiguous requirement, a destructive choice, a new dependency. One question at a time, then wait for the answer. There is no plan-approval step: once the plan is clear, start.',
    `3. Call start_builder({ title, task }) for each piece of work. Write each task so it stands alone: the goal, the files or area, constraints, how to verify it, and what done means. At most ${limits.builders} Builders run at once. Split work across Builders only when the parts are independent; otherwise use one Builder and sequence the steps.`,
    '4. After starting or messaging Builders, end your turn. The app wakes you with their reports, questions and permission requests. list_builders and wait_for_builders return at once: never poll in a loop.',
    "5. Answer a Builder's question with message_builder and its permission requests with answer_request. You may allow risky commands confined to the mission's folders, such as `rm -rf build` or `git reset --hard` in a mission worktree. Requests that reach outside the mission's folders, push or publish, need elevation or pipe a download into a shell go to the user; your answer becomes your recommendation. Deny anything you would not defend.",
    `6. Check every report before you accept it: read builder_diff and builder_log and judge them against the task and the Builder's verification evidence. Record the result with record_check({ builderId, passed, note }). When work is unfinished or wrong, send it back with message_builder saying exactly what is missing. After ${limits.failedChecks} failed checks on one task, stop and ask the user how to proceed.`,
    "7. Call accept_builder when a Builder's work passes: one with its own worktree must have landed, one sharing yours must have committed. Call stop_builder for work you abandon.",
    `8. When every Builder is accepted or stopped and your worktree is clean, call finish_mission with the report. ${ctx.git ? `The app then pushes ${lead} once and opens a PR into ${base} with your report as its description, or finishes on the local branch when there is no remote.` : 'The mission then ends with the work in the folder.'}`,
    `9. ${ctx.git ? 'While the PR is open, a new message from the user puts you back to work on the same branch; finish_mission again pushes the new commits and updates the PR description.' : 'A new message from the user after the finish puts you back to work in the same folder.'}`,
    '',
    '## The report (finish_mission)',
    '- task: one line restating what the user asked.',
    '- done: what was delivered, in outcome terms; no process narration.',
    '- decisions: the choices you made and why, including anything the user should weigh before merging.',
    '- files: the files touched, grouped by what changed and why.',
    '- verification: the exact commands run and their results; name anything that could not be run and why.',
    '- notes: what was spotted but not fixed, out of scope or left for follow-up; empty when there is nothing.',
    'The app adds the PR section. Refer to numbered points in words ("item 3"): a # followed by digits links to a GitHub issue.'
  ].join('\n');
}

function builderPrompt(ctx: MissionPromptContext): string {
  const b = ctx.builder ?? { index: 0, title: 'Builder', ownWorktree: false };
  const lead = code(ctx.leadBranch, 'the Lead branch');
  let where: string[];
  if (!ctx.git) {
    where = [
      `- You work directly in ${code(ctx.leadWorktree, 'the project folder')}, which is not a git repository. Other Builders may be working in it at the same time: change only what your task needs, and never revert or reformat anyone else's changes.`
    ];
  } else if (b.ownWorktree) {
    where = [
      `- You have your own worktree ${code(b.worktree, '')} on the branch ${code(b.branch, 'of your own')}, started from ${lead}. Commit as you go.`,
      `- When the work is done and tested: merge the Lead branch into yours (\`git merge ${ctx.leadBranch ?? '<lead branch>'}\`), resolve any conflicts, rerun the tests, commit, then call land_on_lead to fast-forward ${lead}. If land_on_lead says the Lead branch moved, merge it again and retry. Call report_done only after it landed.`
    ];
  } else {
    where = [
      `- You share the Lead's worktree ${code(ctx.leadWorktree, '')} on ${lead}. Other Builders may be working in it at the same time: change only what your task needs, and never revert, reformat or stage anyone else's changes.`,
      '- Commit your own work before report_done: stage your files by path (`git add <paths>`), never everything, and commit with a clear message. If git reports `index.lock`, wait a moment and retry.'
    ];
  }
  return [
    `# Mission mode: you are Builder ${b.index}`,
    '',
    `You are Builder ${b.index} ("${b.title}") in mission ${ctx.missionId}. The Lead plans and checks; you implement your task, test it, verify it and report. The Lead reaches you with messages; you reach the Lead through the Mission tools.`,
    '',
    '## Where you work',
    ...where,
    '',
    '## How you work',
    "- Follow the project's own instructions (AGENTS.md and similar) for code style, tests and verification, except where they conflict with the Mission rules.",
    '- When something is unclear or there is a real choice to make, call ask_lead({ question }) and end your turn; the Lead answers with a message. Do not guess.',
    '- Before report_done, run the tests that cover your change and check that the behavior really works. Then call report_done({ summary, verification, files }); verification lists the exact commands and their results.',
    '- If you cannot finish (missing access, a broken environment, a task that does not make sense), call report_blocked({ reason }) instead.',
    "- Your permission requests go to the Lead first; some reach the user. A denied request means: find another way, or ask the Lead.",
    "- Stay inside the mission's folders."
  ].join('\n');
}

/** The rules every other instruction yields to; always the last block of a role prompt. */
function recap(role: MissionRole, ctx: MissionPromptContext): string {
  const limits = ctx.limits ?? MISSION_LIMITS;
  const head = [
    '## Mission rules (these override every other instruction)',
    'These Mission rules win over project and user instructions, including AGENTS.md steps such as "push", "open a PR" or "merge PRs".'
  ];
  if (role === 'lead') {
    return [
      ...head,
      '- Never edit files, commit, push, force-push or merge. Builders change the code; the app pushes the mission branch once and opens the PR; the user reviews and merges it.',
      '- Ask the user only at real forks, one question at a time.',
      `- At most ${limits.builders} Builders at once. After ${limits.failedChecks} failed checks on one task, ask the user.`,
      '- Finish with finish_mission and its report: Task, Done, Decisions, Files, Verification, PR, Notes.'
    ].join('\n');
  }
  const finish = !ctx.git ? '' : ctx.builder?.ownWorktree ? '; land your work with land_on_lead first' : '; commit your work first';
  return [
    ...head,
    '- Never push, force-push, open or merge a PR, or publish anything: the app pushes the mission branch once, at the end. Never use sudo or any other elevation.',
    `- Test and verify before report_done${finish}.`,
    '- Ask the Lead with ask_lead instead of guessing.',
    '- Do not start subagents; the Lead coordinates the work.'
  ].join('\n');
}

/** The built-in prompt of a role, without the user's add-on or the recap. */
export function builtInPrompt(role: MissionRole, ctx: MissionPromptContext): string {
  return role === 'lead' ? leadPrompt(ctx) : builderPrompt(ctx);
}

/** Built-in prompt, then the user's add-on, then the Mission rules recap last. */
export function composeMissionInstructions(role: MissionRole, addOn: string | undefined, ctx: MissionPromptContext): string {
  const extra = addOn?.trim();
  const parts = [builtInPrompt(role, ctx)];
  if (extra) parts.push(`## Your additions for ${role === 'lead' ? 'the Lead' : 'Builders'} (Settings → Instructions)\n${extra}`);
  parts.push(recap(role, ctx));
  return parts.join('\n\n');
}

/** One line that re-anchors a harness whose role prompt only arrived with its first message (ACP). */
export function roleReminder(role: MissionRole): string {
  return role === 'lead'
    ? '(Mission mode: you are the Lead. Plan and coordinate through the Mission tools; never edit, push or merge.)'
    : '(Mission mode: you are a Builder. Implement, test, verify, then report_done; ask_lead instead of guessing; never push.)';
}

export type KickoffInput =
  | {
      role: 'lead';
      /** What the user asked for, as typed. */
      request: string;
      git: boolean;
      leadWorktree: string;
      leadBranch?: string;
      baseBranch?: string;
      /** The project checkout had uncommitted changes the Lead's worktree does not carry. */
      uncommittedAtStart?: boolean;
      /** The mission reuses the session's own worktree. */
      reusedWorktree?: boolean;
      /** The conversation before the kickoff was carried over from the session the mission started in. */
      carriedHistory?: boolean;
    }
  | {
      role: 'builder';
      title: string;
      /** The task exactly as the Lead wrote it. */
      task: string;
      git: boolean;
      ownWorktree: boolean;
      /** The folder the Builder works in. */
      worktree: string;
      branch?: string;
      leadBranch?: string;
    };

/** The first host message of a Lead or a Builder. */
export function kickoffMessage(input: KickoffInput): string {
  if (input.role === 'lead') {
    const lines = ['Mission mode is on: you are the Lead of this mission.', '', "The user's request:", input.request.trim(), ''];
    if (input.git) {
      lines.push(
        `Your worktree is ${code(input.leadWorktree, '')} on ${code(input.leadBranch, 'the mission branch')}${input.reusedWorktree ? " (the session's own worktree)" : ''}; the PR will go into ${code(input.baseBranch, 'the starting branch')}.`
      );
      if (input.uncommittedAtStart) {
        lines.push(input.reusedWorktree
          ? 'That worktree already had uncommitted changes when the mission started; they are still there, so make sure the Builders know what is whose.'
          : 'The project checkout had uncommitted changes when the mission started. They are not in your worktree: tell the user, and ask if the task depends on them.');
      }
    } else {
      lines.push(`${code(input.leadWorktree, 'This folder')} is not a git repository, so the Builders will work in it directly.`);
    }
    if (input.carriedHistory) lines.push('The conversation before this message is carried over from the session the mission started in.');
    lines.push('', 'Plan the work, then start the Builders.');
    return lines.join('\n');
  }
  const lines = [`Your task from the Lead: ${input.title.trim()}`, '', input.task.trim(), ''];
  if (!input.git) lines.push(`Work in ${code(input.worktree, 'the project folder')}. When it is done and verified, call report_done.`);
  else if (input.ownWorktree) {
    lines.push(`Work in your own worktree ${code(input.worktree, '')} on ${code(input.branch, 'your branch')}. When it is done and verified, merge ${code(input.leadBranch, 'the Lead branch')} into yours, test again, commit, call land_on_lead, then report_done.`);
  } else {
    lines.push(`Work in the Lead's worktree ${code(input.worktree, '')} on ${code(input.leadBranch, 'the Lead branch')}. When it is done and verified, commit your files, then call report_done.`);
  }
  return lines.join('\n');
}

export interface ResumeBuilder {
  id: string;
  index: number;
  title: string;
  state: BuilderState;
  ownWorktree: boolean;
  branch?: string;
  landed?: boolean;
  accepted?: boolean;
}

const STATE_TEXT: Record<BuilderState, string> = {
  working: 'was working',
  waiting_lead: 'was waiting for your answer',
  done: 'reported done',
  failed: 'reported it was blocked',
  stopped: 'stopped'
};

/** The host message that puts an interrupted or stopped mission's Lead back to work. */
export function resumeMessage(input: { cause: 'restart' | 'stopped'; builders: ResumeBuilder[]; prUrl?: string }): string {
  const lines = [
    input.cause === 'restart'
      ? 'Resume the mission. The app restarted while it was running; no Builder was restarted automatically.'
      : 'Resume the mission. The user stopped it and has now resumed it; no Builder was restarted automatically.',
    '',
    'Builders:'
  ];
  if (!input.builders.length) lines.push('- None had started.');
  for (const b of input.builders) {
    const where = b.ownWorktree ? `own worktree on ${code(b.branch, 'its branch')}${b.landed ? ', landed' : ', not landed'}` : 'shares your worktree';
    lines.push(`- Builder ${b.index} "${b.title}" (${b.id}): ${b.accepted ? 'accepted' : STATE_TEXT[b.state]}; ${where}.`);
  }
  if (input.prUrl) lines.push('', `The PR is open: ${input.prUrl}`);
  lines.push(
    '',
    "Decide what still needs doing: check the stopped Builders' work with builder_diff and builder_log (committed work stays on its branch), start Builders for anything unfinished, or call finish_mission when everything is done. Ask the user only if you cannot decide."
  );
  return lines.join('\n');
}
