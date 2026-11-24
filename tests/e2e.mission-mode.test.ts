/**
 * Electron end-to-end for Mission mode: a mission started from New Session with the Mission switch
 * on, run to its end by a native Lead and a native Builder whose model is a scripted loopback
 * provider. The Lead plans in Plan mode and starts one Builder that shares its worktree; the Builder
 * (in Auto) writes and commits a file and reports done; the app wakes the Lead with the report; the
 * Lead accepts the Builder and finishes. With no git remote the mission ends on its local branch. Every
 * Mission tool call goes through the real stdio server, gateway and MissionService, and every git
 * step runs against a real temporary repository. Then quit and relaunch: the mission is still done
 * and nothing is sent to any model, until the user writes to the Lead, which puts the recovered
 * mission back to Running. The power API is stubbed before the app starts (a mission keeps the
 * computer awake while it works). No provider keys.
 * Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs, realpathSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { MCP_BUILTIN_IDS } from '../src/shared/types';
import { BUILDER_TOOLS, LEAD_TOOLS, MISSION_SERVER_ID } from '../src/shared/mission-mode';
import { expectQuietWindow, isolatedEnv, openNewSession, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const desktopEntry = path.join(root, 'out', 'main', 'index.js');

const PROVIDER = 'mission-fixture';
const MODEL = 'fixture-mission';
/** The session title names the branch, so neither a title nor a branch name is asked of a model. */
const TITLE = 'Hello note';
const BRANCH = 'mission/hello-note';
const TASK = 'Add a hello note to the repository and commit it.';
const BUILDER_TITLE = 'Write the hello note';
const BUILDER_TASK = 'Create hello.txt containing one greeting line, commit it, then call report_done.';
const NOTE = 'Hello from the Builder\n';
const COMMIT = 'Add hello note';
const REPORT = {
  task: 'Add a hello note to the repository.',
  done: ['hello.txt greets the reader, committed on the mission branch.'],
  decisions: ['One Builder in the shared worktree: the change is a single file.'],
  files: ['hello.txt (new)'],
  verification: ['git log -1 --format=%s: Add hello note'],
  notes: ['No remote, so the work stays on the local branch.']
};
const LEAD_CLOSING = 'The mission is done on the local branch mission/hello-note.';
const FOLLOW_UP = 'Thanks. Is anything left to do?';
const FOLLOW_UP_REPLY = 'Nothing is left: the note is committed on mission/hello-note.';

/** The native loop names MCP tools `mcp__<server>__<tool>`, sanitized. */
const tool = (name: string) => `mcp__${MISSION_SERVER_ID.replace(/-/g, '_')}__${name}`;
const MUTATING = ['bash', 'write_file', 'edit_file'];

type Message = { role: string; content?: unknown; tool_call_id?: string };
type Completion = { model: string; stream?: boolean; messages: Message[]; tools?: { function: { name: string } }[] };
type Reply = { content?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] };
type Role = 'lead' | 'builder' | 'other';

const call = (id: string, name: string, args: object) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const textOf = (m: Message | undefined) => (typeof m?.content === 'string' ? m.content : '');

/**
 * The scripted model. Which session is asking is read from the tools it is offered (only a Lead
 * gets start_builder, only a Builder gets report_done), and the step from its last message.
 */
function script(body: Completion): { role: Role; step: string; reply?: Reply } {
  const names = new Set((body.tools ?? []).map((t) => t.function.name));
  const role: Role = names.has(tool('start_builder')) ? 'lead' : names.has(tool('report_done')) ? 'builder' : 'other';
  const last = body.messages.at(-1);
  const text = textOf(last);
  const after = (id: string) => last?.role === 'tool' && last.tool_call_id === id;
  if (role === 'lead') {
    if (last?.role === 'user' && text.includes('reports done')) {
      return { role, step: 'accept', reply: { tool_calls: [call('call_accept', tool('accept_builder'), { builderId: 'b1' }), call('call_finish', tool('finish_mission'), REPORT)] } };
    }
    if (last?.role === 'user' && text.includes('No PR was opened')) return { role, step: 'closing', reply: { content: LEAD_CLOSING } };
    if (last?.role === 'user' && text === FOLLOW_UP) return { role, step: 'follow-up', reply: { content: FOLLOW_UP_REPLY } };
    if (last?.role === 'user' && text.includes(TASK)) {
      return { role, step: 'plan', reply: { content: 'One Builder can do this in my worktree.', tool_calls: [call('call_start', tool('start_builder'), { title: BUILDER_TITLE, task: BUILDER_TASK })] } };
    }
    if (after('call_start')) return { role, step: 'wait', reply: { content: 'Builder 1 is on it; I check its work when it reports.' } };
    if (after('call_finish')) return { role, step: 'finished', reply: { content: 'Finishing the mission.' } };
  } else if (role === 'builder') {
    if (last?.role === 'user' && !body.messages.some((m) => m.role === 'tool')) {
      // Separate commands, no shell chaining: the native loop picks Git Bash, PowerShell or cmd.
      return { role, step: 'work', reply: { tool_calls: [
        call('call_write', 'write_file', { path: 'hello.txt', content: NOTE }),
        call('call_add', 'bash', { command: 'git add hello.txt' }),
        call('call_commit', 'bash', { command: `git commit -q -m "${COMMIT}"` })
      ] } };
    }
    if (after('call_commit')) {
      return { role, step: 'report', reply: { tool_calls: [call('call_report', tool('report_done'), { summary: 'hello.txt is written and committed.', verification: ['git log -1 --format=%s: Add hello note'], files: ['hello.txt'] })] } };
    }
    if (after('call_report')) return { role, step: 'end', reply: { content: 'Reported to the Lead.' } };
  }
  return { role, step: `unexpected ${last?.role ?? 'nothing'}: ${text.slice(0, 120) || last?.tool_call_id || ''}` };
}

function stream(res: ServerResponse, reply: Reply): void {
  const chunk = (delta: object, finish_reason: 'stop' | 'tool_calls' | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const delta = { role: 'assistant', ...(reply.content ? { content: reply.content } : {}), ...(reply.tool_calls ? { tool_calls: reply.tool_calls.map((c, index) => ({ index, ...c })) } : {}) };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(chunk(delta, null) + chunk({}, reply.tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
}

/** Git for the fixture and the assertions, without the caller's GIT_* environment. */
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  const r = spawnSync('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

describe.runIf(enabled)('electron e2e: Mission mode', () => {
  it('runs a Lead and a Builder to a local-branch finish, stays done across a restart and resumes on the next message', async ({ onTestFinished }) => {
    // The long form of the path, as git reports it (a CI runner's TEMP can be an 8.3 short name).
    const tmp = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-mode-')));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const home = path.join(tmp, 'home');
    const entry = path.join(tmp, 'main.mjs');
    const trace = path.join(tmp, 'power.jsonl');
    const mainLog = path.join(userData, 'logs', 'main.log');
    let app: ElectronApplication | null = null;

    const turns: { role: Role; step: string; body: Completion }[] = [];
    const other: string[] = [];
    const server = createServer((req, res) => {
      let json = '';
      req.setEncoding('utf8').on('data', (chunk: string) => { json += chunk; });
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
          other.push(`${req.method} ${req.url}`);
          res.writeHead(404).end();
          return;
        }
        try {
          const body = JSON.parse(json) as Completion;
          if (body.model !== MODEL || body.stream !== true) {
            // Titles and branch names are never asked for here; a background request is a regression.
            turns.push({ role: 'other', step: `background ${body.model} (stream=${body.stream})`, body });
            res.writeHead(400).end();
            return;
          }
          const { role, step, reply } = script(body);
          turns.push({ role, step, body });
          if (reply) stream(res, reply);
          else res.writeHead(400).end(step);
        } catch {
          other.push('malformed completion');
          res.writeHead(400).end();
        }
      });
    });
    onTestFinished(async ({ task }) => {
      if (task.result?.state === 'fail') {
        console.info('[mission-mode] model turns:', turns.map((t) => `${t.role}:${t.step}`).join(' | '), '| other:', other.join(', '));
        console.info('[mission-mode] main.log tail:\n' + (await fs.readFile(mainLog, 'utf8').catch(() => '')).split('\n').slice(-80).join('\n'));
      }
      await app?.close().catch(() => undefined);
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Mission fixture did not bind a TCP address');

    // A one-commit repository with a local identity and no remote.
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), 'Mission fixture.\n');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.name', 'Mission e2e');
    git(project, 'config', 'user.email', 'mission-e2e@example.invalid');
    git(project, 'config', 'commit.gpgsign', 'false');
    git(project, 'config', 'core.autocrlf', 'false');
    git(project, 'add', '--', 'README.md');
    git(project, 'commit', '-q', '-m', 'init');

    // Both power methods are replaced before the real app is imported; the trace records main's calls.
    await fs.writeFile(entry, `
import { powerSaveBlocker } from 'electron';
import { appendFileSync } from 'node:fs';
let id = 0;
const append = (...entry) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(entry) + '\\n');
const start = (type) => { append('start', ++id, type); return id; };
const stop = (blockerId) => append('stop', blockerId);
powerSaveBlocker.start = start;
powerSaveBlocker.stop = stop;
if (powerSaveBlocker.start !== start || powerSaveBlocker.stop !== stop) throw Error('Power blocker was not stubbed');
await import(${JSON.stringify(pathToFileURL(desktopEntry).href)});
`);
    await fs.writeFile(trace, '');
    const power = async (): Promise<(['start', number, string] | ['stop', number])[]> =>
      (await fs.readFile(trace, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const held = async () => {
      const live = new Set<number>();
      for (const [action, id] of await power()) {
        if (action === 'start') live.add(id);
        else live.delete(id);
      }
      return [...live];
    };

    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
      defaultHarness: 'native', defaultPermissionMode: 'ask', defaultModelByHarness: { native: { provider: PROVIDER, model: MODEL } },
      providers: [{ id: PROVIDER, kind: 'lmstudio', name: 'Mission fixture', enabled: true, hasApiKey: false,
        baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: MODEL, provider: PROVIDER, displayName: 'Mission fixture' }] }],
      missionDefaults: { builder: { harness: 'same', permissionMode: 'auto' } },
      // No utility model, knowledge or Vesta: the only model traffic is the two sessions' turns.
      agent: { enabled: false }, knowledge: { prime: false, autoDistill: false },
      mcpDisabledBuiltins: MCP_BUILTIN_IDS.filter((id) => id !== MISSION_SERVER_ID), notifications: false,
      // The screen of GitHub's Windows runners, so a local run sees the layout CI does.
      windowBounds: { x: 0, y: 0, width: 1024, height: 728 }
    }));

    const launch = async (): Promise<Page> => {
      const env = isolatedEnv(userData, {
        HOME: home, USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        CLAUDE_CONFIG_DIR: path.join(userData, 'claude'), CODEX_HOME: path.join(userData, 'codex'), PI_CODING_AGENT_DIR: path.join(userData, 'pi')
      });
      for (const key of ['ELECTRON_RENDERER_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
      for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
      for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.PI_CODING_AGENT_DIR]) await fs.mkdir(dir!, { recursive: true });
      app = await electron.launch({
        executablePath: require('electron') as string,
        args: [entry, `--user-data-dir=${userData}`, ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])],
        env,
        timeout: 60_000
      });
      const page = await app.firstWindow();
      await page.waitForSelector('.brand', { timeout: 60_000 });
      await expectQuietWindow(app);
      return page;
    };
    const wait = { timeout: 30_000 };
    const transcriptText = (page: Page, text: string) => page.locator('.transcript').getByText(text, { exact: true }).waitFor(wait);
    const steps = (role: Role) => turns.filter((t) => t.role === role).map((t) => t.step);

    let win = await launch();

    // --- New Session with Mission on: Plan, locked; a worktree, forced; a task, required.
    await openNewSession(win);
    const missionSwitch = win.getByRole('checkbox', { name: 'Mission mode', exact: true });
    await missionSwitch.waitFor(wait);
    expect(await missionSwitch.isChecked()).toBe(false);
    await missionSwitch.locator('..').click();
    expect(await missionSwitch.isChecked()).toBe(true);
    const permissions = win.getByLabel('Permissions', { exact: true });
    expect(await permissions.inputValue()).toBe('plan');
    expect(await permissions.isDisabled()).toBe(true);
    expect(await win.locator('.modal').innerText()).toContain('Builders run in Auto');
    const isolate = win.locator('.ns-workspace').getByRole('checkbox');
    await expect.poll(() => isolate.isChecked(), wait).toBe(true);
    expect(await isolate.isDisabled()).toBe(true);
    expect(await win.getByLabel('Branch prefix', { exact: true }).inputValue()).toBe('mission');
    const startMission = win.getByRole('button', { name: /^Start mission/ });
    expect(await startMission.isDisabled()).toBe(true);
    await win.getByRole('button', { name: 'Advanced', exact: true }).click();
    await win.getByPlaceholder('Auto from first prompt').fill(TITLE);
    await win.getByLabel('Mission task (required)', { exact: true }).fill(TASK);
    await win.locator('.ns-summary').getByText(BRANCH, { exact: true }).waitFor(wait);
    expect(await win.locator('.ns-summary').innerText()).toContain('Mission Lead');
    await expect.poll(() => startMission.isEnabled(), wait).toBe(true);
    await startMission.click();

    const leadRow = win.locator('[data-testid="session-row"][data-mission-role="lead"]');
    const leadId = await leadRow.getAttribute('data-session-id', wait);
    if (!leadId) throw new Error('The Lead row has no session id');
    const mission = () => win.evaluate((id) => window.harness.invoke('mission:get', { sessionId: id }), leadId);

    // --- The Lead plans and starts a Builder; the Builder commits and reports; the Lead accepts and finishes.
    await expect.poll(async () => (await mission())?.state, { timeout: 60_000 }).toBe('done_local');
    // The finish note wakes the Lead once more; its reply is the mission's last model turn.
    await expect.poll(() => steps('lead'), { timeout: 30_000 }).toEqual(['plan', 'wait', 'accept', 'finished', 'closing']);
    await expect.poll(() => win.evaluate(async (id) => {
      const meta = await window.harness.invoke('sessions:get', { id });
      const items = await window.harness.invoke('sessions:transcript', { id });
      return { status: meta?.status, last: items.flatMap((i) => (i.kind === 'assistant' && !i.streaming ? [i.text] : [])).at(-1) };
    }, leadId), wait).toEqual({ status: 'idle', last: LEAD_CLOSING });
    expect(steps('builder')).toEqual(['work', 'report', 'end']);
    expect(steps('other')).toEqual([]);

    const view = (await mission())!;
    expect(view).toMatchObject({ leadId, state: 'done_local', git: true, leadBranch: BRANCH, baseBranch: 'main', blockedOnUser: [] });
    expect(view.builders).toEqual([expect.objectContaining({ id: 'b1', index: 1, title: BUILDER_TITLE, state: 'done', ownWorktree: false, failedChecks: 0 })]);
    const builderId = view.builders[0]!.sessionId;
    const [lead, builder] = await win.evaluate(
      (ids) => Promise.all(ids.map((id) => window.harness.invoke('sessions:get', { id }))),
      [leadId, builderId]
    );
    expect(lead).toMatchObject({ title: TITLE, worktreeBranch: BRANCH, config: { harness: 'native', permissionMode: 'plan' }, mission: { role: 'lead', state: 'done_local' } });
    // The Builder shares the Lead's worktree, runs in Auto on the Lead's harness and model, and was stopped on accept.
    expect(builder).toMatchObject({ title: BUILDER_TITLE, cwd: lead!.cwd, status: 'idle', config: { harness: 'native', permissionMode: 'auto', model: { provider: PROVIDER, model: MODEL } }, mission: { role: 'builder', leadId, builderIndex: 1, builderState: 'done' } });
    expect(builder!.worktreeBranch).toBeUndefined();
    await expect.poll(async () => (await fs.readFile(mainLog, 'utf8')).includes(`[${builderId}] stopping native`), wait).toBe(true);

    // What each role was offered: the Lead plans (no edit or shell tools) and leads; the Builder builds.
    const offered = (role: Role) => new Set(turns.find((t) => t.role === role)!.body.tools!.map((t) => t.function.name));
    const leadTools = offered('lead');
    const builderTools = offered('builder');
    for (const name of LEAD_TOOLS) expect(leadTools.has(tool(name)), `Lead offered ${name}`).toBe(true);
    for (const name of [...BUILDER_TOOLS.map(tool), ...MUTATING]) expect(leadTools.has(name), `Lead not offered ${name}`).toBe(false);
    for (const name of [...BUILDER_TOOLS.map(tool), 'bash', 'write_file']) expect(builderTools.has(name), `Builder offered ${name}`).toBe(true);
    for (const name of LEAD_TOOLS) expect(builderTools.has(tool(name)), `Builder not offered ${name}`).toBe(false);
    // The kickoff carried the Lead's task and named the shared worktree; the report reached the Lead.
    const kickoff = textOf(turns.find((t) => t.role === 'builder' && t.step === 'work')!.body.messages.at(-1));
    expect(kickoff).toContain(BUILDER_TASK);
    expect(kickoff).toContain(lead!.cwd);
    const report = textOf(turns.find((t) => t.role === 'lead' && t.step === 'accept')!.body.messages.at(-1));
    expect(report).toContain(`"${BUILDER_TITLE}" reports done`);
    expect(report).toContain('hello.txt is written and committed.');

    // The Builder's commit is on the mission branch; the user's checkout is untouched.
    expect(git(project, 'log', '--format=%s', BRANCH).split('\n')).toEqual([COMMIT, 'init']);
    expect(git(project, 'show', `${BRANCH}:hello.txt`)).toBe(NOTE.trim());
    expect(git(project, 'log', '--format=%s', 'main').split('\n')).toEqual(['init']);
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    await expect(fs.access(path.join(project, 'hello.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(lead!.cwd, 'status', '--porcelain')).toBe('');
    expect(git(project, 'remote')).toBe('');

    // A mission held the power blocker while it worked and let it go when it finished.
    expect((await power()).filter(([action]) => action === 'start').length).toBeGreaterThan(0);
    await expect.poll(held, wait).toEqual([]);

    // --- What the user sees.
    const expectFinished = async (page: Page) => {
      const strip = page.getByRole('region', { name: 'Mission', exact: true });
      await strip.getByText('Done · local branch', { exact: true }).waitFor(wait);
      // The branch is the strip's first item to give way in a narrow pane (the Lead's pane is about
      // 320 px beside the side panel on a 1024 px screen); it stays in the label and its title.
      const branch = strip.getByTitle(`${BRANCH} → main`, { exact: true });
      await branch.waitFor({ state: 'attached', ...wait });
      expect((await branch.textContent())?.trim()).toBe(`${BRANCH} → main`);
      expect(await strip.getByTestId('mission-builders-running').innerText(wait)).toBe('0 Builders running');
      // Finished: neither Stop nor Resume applies.
      expect(await strip.getByRole('button').count()).toBe(0);
      // The Builder sits right under its Lead, indented, with a Done dot.
      const rows = await page.getByTestId('session-row').evaluateAll((els) => els.map((el) => ({
        id: el.getAttribute('data-session-id'),
        role: el.getAttribute('data-mission-role'),
        x: el.querySelector('.session-main')!.getBoundingClientRect().left
      })));
      const at = rows.findIndex((r) => r.id === leadId);
      expect(rows[at]).toMatchObject({ role: 'lead' });
      expect(rows[at + 1]).toMatchObject({ id: builderId, role: 'builder' });
      expect(rows[at + 1]!.x).toBeGreaterThan(rows[at]!.x);
      const builderRow = page.locator(`[data-testid="session-row"][data-session-id="${builderId}"]`);
      await builderRow.getByRole('img', { name: 'Builder 1: Done', exact: true }).waitFor(wait);
      expect(await builderRow.locator('.mission-dot').getAttribute('data-state')).toBe('done');
      // The Lead's transcript tells the handoffs and ends on the report, as the PR body would read.
      const transcript = page.locator('.transcript');
      await transcript.locator('.mission-tool[data-tool="start_builder"]').getByText(`Started Builder 1: ${BUILDER_TITLE}`, { exact: true }).waitFor(wait);
      await transcript.locator('.mission-msg[data-kind="report"]').getByText('Report', { exact: true }).waitFor(wait);
      await transcript.locator('.mission-tool[data-tool="accept_builder"]').getByText('Accepted Builder 1', { exact: true }).waitFor(wait);
      const finish = transcript.locator('.mission-tool[data-tool="finish_mission"]');
      await finish.getByText('Finished the mission', { exact: true }).waitFor(wait);
      const reportCard = finish.getByLabel('Mission report', { exact: true });
      // textContent: the headings are upper-cased by CSS, not in the text the report carries.
      expect(await reportCard.locator('.mission-report-title').allTextContents()).toEqual(['Task', 'Done', 'Decisions', 'Files', 'Verification', 'Notes']);
      const reportText = await reportCard.innerText();
      for (const line of [REPORT.task, ...REPORT.done, ...REPORT.decisions, ...REPORT.files, ...REPORT.verification, ...REPORT.notes]) expect(reportText).toContain(line);
      await transcript.locator('.mission-msg').filter({ hasText: 'No PR was opened' }).waitFor(wait);
      await transcriptText(page, LEAD_CLOSING);
    };
    await expectFinished(win);

    // --- Quit and relaunch: still done, and nothing is dispatched to any session.
    const modelTurns = turns.length;
    const powerCalls = (await power()).length;
    const recordFile = path.join(userData, 'sessions', leadId, 'mission.json');
    const recordBefore = JSON.parse(await fs.readFile(recordFile, 'utf8')) as { state: string; inbox: { lead: unknown[]; builders: Record<string, unknown[]> } };
    expect(recordBefore).toMatchObject({ state: 'done_local', inbox: { lead: [], builders: {} } });
    await app!.close();
    app = null;

    win = await launch();
    await win.locator(`[data-testid="session-row"][data-session-id="${leadId}"]`).click(wait);
    await expectFinished(win);
    expect(await mission()).toEqual(view);
    // Longer than the delivery debounce: a re-dispatch would have reached the provider by now.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(turns.length).toBe(modelTurns);
    expect(await power()).toHaveLength(powerCalls);
    expect(JSON.parse(await fs.readFile(recordFile, 'utf8'))).toMatchObject({ state: 'done_local', inbox: { lead: [], builders: {} } });
    expect(git(project, 'log', '--format=%s', BRANCH).split('\n')).toEqual([COMMIT, 'init']);
    // Recovery loaded the record and ran to the end (it once threw on the session-list push).
    const log = await fs.readFile(mainLog, 'utf8');
    expect(log).not.toContain('mission: recovery failed');
    expect(log).toContain('mission: loaded 1 mission record(s)');

    // --- The user writes to the finished Lead: the recovered mission is live again and back to Running.
    await win.getByPlaceholder(/^Message the Lead/).fill(FOLLOW_UP, wait);
    // The Lead's pane is narrow here: its long tier pill gives way, and Send stays inside the composer.
    const footer = win.locator('.pane.active .composer-actions');
    await footer.getByRole('button', { name: 'Permission mode: Lead: Plan · Builders: Auto', exact: true }).waitFor(wait);
    await expect.poll(() => footer.evaluate((el) => {
      const row = el.getBoundingClientRect();
      const send = el.querySelector('.send-btn')!.getBoundingClientRect();
      return { fits: el.scrollWidth <= el.clientWidth + 1, send: send.width > 0 && send.left >= row.left - 1 && send.right <= row.right + 1 };
    }), wait).toEqual({ fits: true, send: true });
    await win.getByRole('button', { name: 'Send', exact: true }).click(wait);
    const strip = win.getByRole('region', { name: 'Mission', exact: true });
    await strip.getByText('Running', { exact: true }).waitFor(wait);
    await strip.getByRole('button', { name: 'Stop', exact: true }).waitFor(wait);
    await expect.poll(() => steps('lead').slice(-1), wait).toEqual(['follow-up']);
    expect(turns.slice(modelTurns).map((t) => `${t.role}:${t.step}`)).toEqual(['lead:follow-up']);
    // The Lead still leads after the restart: its Mission tools came back with it, edit tools did not.
    const resumed = new Set(turns.at(-1)!.body.tools!.map((t) => t.function.name));
    for (const name of LEAD_TOOLS) expect(resumed.has(tool(name)), `Lead offered ${name} after restart`).toBe(true);
    for (const name of MUTATING) expect(resumed.has(name), `Lead not offered ${name} after restart`).toBe(false);
    await transcriptText(win, FOLLOW_UP_REPLY);
    expect(await mission()).toMatchObject({ state: 'running', builders: [expect.objectContaining({ id: 'b1', state: 'done' })] });
    await expect.poll(async () => JSON.parse(await fs.readFile(recordFile, 'utf8')).state, wait).toBe('running');
    await expect.poll(held, wait).toEqual([]);
  }, 180_000);
});
