/** Mission mode text: role prompt composition (recap last), host messages, and the final report's markdown. */
import { describe, expect, it } from 'vitest';
import { composeMissionInstructions, kickoffMessage, resumeMessage, roleReminder, type MissionPromptContext } from '../src/main/mission-mode/prompts';
import { neutralizeIssueRefs, renderReport, reportTitle, type FinalReport } from '../src/main/mission-mode/report';

const ctx: MissionPromptContext = { missionId: 'm_1', git: true, leadWorktree: '/repo/.vocs-code/worktrees/fix', leadBranch: 'mission/fix', baseBranch: 'develop' };
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const RECAP = '## Mission rules (these override every other instruction)';

describe('role prompts', () => {
  it('puts the built-in prompt first, the add-on next and the Mission rules recap last', () => {
    const text = composeMissionInstructions('lead', 'ADDON: prefer small PRs', ctx);
    const builtIn = text.indexOf('# Mission mode: you are the Lead');
    const addOn = text.indexOf('ADDON: prefer small PRs');
    const recap = text.indexOf(RECAP);
    expect(builtIn).toBe(0);
    expect(addOn).toBeGreaterThan(builtIn);
    expect(recap).toBeGreaterThan(addOn);
    expect(text.lastIndexOf('## ')).toBe(recap);
    expect(text.slice(recap)).toContain('"merge PRs"');
    expect(text.slice(recap)).toContain('Never edit files, commit, push, force-push or merge');
    expect(text).toContain('Task, Done, Decisions, Files, Verification, PR, Notes');
    expect(text).toContain('At most 3 Builders');
    expect(text).toContain('After 3 failed checks');
    expect(text).toContain('`mission/fix`');
    expect(text).toContain('into `develop`');
  });

  it('leaves out the add-on heading when there is none and stays tight', () => {
    for (const role of ['lead', 'builder'] as const) {
      const text = composeMissionInstructions(role, '   ', { ...ctx, builder: { index: 1, title: 'API', ownWorktree: false } });
      expect(text).not.toContain('Settings → Instructions');
      expect(text.trimEnd().endsWith('- Do not start subagents; the Lead coordinates the work.') || text.trimEnd().endsWith('Verification, PR, Notes.')).toBe(true);
      expect(words(text)).toBeLessThan(900);
    }
  });

  it('tells a shared Builder to commit and an own-worktree Builder to merge and land', () => {
    const shared = composeMissionInstructions('builder', undefined, { ...ctx, builder: { index: 1, title: 'API', ownWorktree: false } });
    const own = composeMissionInstructions('builder', 'ADDON', { ...ctx, builder: { index: 2, title: 'UI', ownWorktree: true, worktree: '/repo/.vocs-code/worktrees/fix-b2', branch: 'mission/fix-b2' } });
    expect(shared).toContain('Commit your own work before report_done');
    expect(shared).not.toContain('land_on_lead');
    expect(shared.slice(shared.indexOf(RECAP))).toContain('commit your work first');
    expect(own).toContain('`git merge mission/fix`');
    expect(own).toContain('call land_on_lead');
    expect(own.slice(own.indexOf(RECAP))).toContain('land your work with land_on_lead first');
    for (const text of [shared, own]) {
      expect(text.slice(text.indexOf(RECAP))).toContain('Never push, force-push, open or merge a PR');
      expect(text).toContain('ask_lead');
    }
    expect(own.indexOf('ADDON')).toBeLessThan(own.indexOf(RECAP));
  });

  it('drops branches and the PR for a folder without git', () => {
    const text = composeMissionInstructions('lead', undefined, { missionId: 'm_2', git: false, leadWorktree: '/notes' });
    expect(text).toContain('is not a git repository');
    expect(text).not.toContain('opens a PR into');
  });

  it('builds the kickoff, resume and reminder messages', () => {
    const lead = kickoffMessage({ role: 'lead', request: 'Add dark mode', git: true, leadWorktree: ctx.leadWorktree, leadBranch: 'mission/fix', baseBranch: 'develop', uncommittedAtStart: true, carriedHistory: true });
    expect(lead).toContain("The user's request:\nAdd dark mode");
    expect(lead).toContain('uncommitted changes');
    expect(lead).toContain('carried over');
    const builder = kickoffMessage({ role: 'builder', title: 'Theme tokens', task: 'Add the tokens.', git: true, ownWorktree: true, worktree: '/wt/b1', branch: 'mission/fix-b1', leadBranch: 'mission/fix' });
    expect(builder).toContain('Your task from the Lead: Theme tokens\n\nAdd the tokens.');
    expect(builder).toContain('call land_on_lead, then report_done');
    const resume = resumeMessage({ cause: 'restart', builders: [{ id: 'b_1', index: 1, title: 'Theme tokens', state: 'working', ownWorktree: true, branch: 'mission/fix-b1' }], prUrl: 'https://github.com/acme/repo/pull/9' });
    expect(resume).toContain('The app restarted');
    expect(resume).toContain('- Builder 1 "Theme tokens" (b_1): was working; own worktree on `mission/fix-b1`, not landed.');
    expect(resume).toContain('The PR is open: https://github.com/acme/repo/pull/9');
    expect(roleReminder('builder')).toContain('never push');
  });
});

describe('final report', () => {
  const report: FinalReport = {
    task: 'Add dark mode (fixes #12)',
    done: ['- Dark theme behind the toggle', 'Tokens for acme/ui#3\nwith a second line'],
    decisions: [],
    files: ['src/theme.ts — tokens'],
    verification: ['`npm test -- #12` passed', 'See https://github.com/acme/repo/pull/5#issuecomment-1'],
    notes: []
  };
  const headings = (md: string) => [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

  it('uses exactly the report headings and omits empty Notes', () => {
    const md = renderReport(report, { kind: 'pr', head: 'mission/fix', base: 'develop' });
    expect(headings(md)).toEqual(['Task', 'Done', 'Decisions', 'Files', 'Verification', 'PR']);
    expect(headings(renderReport({ ...report, notes: ['Follow-up: contrast check'] }, { kind: 'pr', head: 'mission/fix', base: 'develop' })))
      .toEqual(['Task', 'Done', 'Decisions', 'Files', 'Verification', 'PR', 'Notes']);
    for (const line of md.split('\n')) if (line && !line.startsWith('## ')) expect(line).toMatch(/^(?:- |  )/);
    expect(md).toContain('## Decisions\n- None.');
    expect(md).toContain('- Dark theme behind the toggle');
    expect(md).not.toContain('- - ');
    expect(md).toContain('- Tokens for `acme/ui#3`\n  with a second line');
    expect(md).toContain('## PR\n- `mission/fix` into `develop`\n- Opened by Mission mode for review; it is never merged automatically.');
  });

  it('never leaves a linkable issue number in prose', () => {
    const md = renderReport(report, { kind: 'local', reason: 'there is no origin remote (see #4).', branch: 'mission/fix' });
    const prose = md.replace(/`[^`\n]*`/g, '');
    expect(prose).not.toMatch(/(^|[^\w/&])#\d/m);
    expect(md).toContain('(fixes `#12`)');
    expect(md).toContain('`npm test -- #12` passed');
    expect(md).toContain('https://github.com/acme/repo/pull/5#issuecomment-1');
    expect(md).toContain('## PR\n- No PR: there is no origin remote (see `#4`).\n- The work is on the local branch `mission/fix`.');
    expect(neutralizeIssueRefs('item #3, `#4` and a#5')).toBe('item `#3`, `#4` and a#5');
    expect(reportTitle(report)).toBe('Add dark mode (fixes `#12`)');
  });
});
