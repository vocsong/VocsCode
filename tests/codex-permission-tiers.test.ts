/**
 * Offline tests for the Codex app-server adapter against the Vocs Code tier contract: the policy
 * and sandbox each tier sends on turn/start, and the decision each approval request gets back.
 * Auto must not let Codex run commands unasked (`on-request`), session grants are the app's own
 * per-tool grants and never reach Codex as "for session" decisions, and outside-project checks
 * follow real paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { emptyUsage } from '../src/main/models/static-models';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import type { ApprovalDecision, PermissionMode, SessionEvent } from '../src/shared/types';

type Handler = (params: unknown) => Promise<unknown>;

let base: string;
let ROOT: string;
let OUTSIDE: string;
let LINK: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vocs-codex-tiers-')));
  ROOT = path.join(base, 'project');
  OUTSIDE = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  // A link inside the project that resolves outside it: lexically inside, really outside.
  LINK = path.join(ROOT, 'linked');
  fs.symlinkSync(OUTSIDE, LINK, 'junction');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function harness(initial: PermissionMode, decisions: ApprovalDecision[] = []) {
  let mode = initial;
  const events: SessionEvent[] = [];
  const queue = [...decisions];
  const requestApproval = vi.fn(async (_draft: ApprovalDraft): Promise<ApprovalDecision> => queue.shift() ?? { optionId: 'allow' });
  const ctx = {
    emit: (e: SessionEvent) => events.push(e),
    session: () => ({ cwd: ROOT, usage: emptyUsage() }),
    permissionMode: () => mode,
    requestApproval,
    log: vi.fn(),
    updateMeta: vi.fn(),
    updateRef: vi.fn(),
    sessionDir: ROOT
  } as unknown as HarnessContext;
  const adapter = new CodexAppServerAdapter(ctx);
  const handlers = new Map<string, Handler>();
  const notifications = new Map<string, (params: unknown) => void>();
  const requests: { method: string; params: unknown }[] = [];
  const rpc = {
    request: vi.fn((method: string, params: unknown) => {
      requests.push({ method, params });
      return new Promise(() => undefined);
    }),
    onServerRequest: (method: string, handler: Handler) => handlers.set(method, handler),
    onNotification: (method: string, handler: (params: unknown) => void) => notifications.set(method, handler)
  };
  const internals = adapter as unknown as { rpc: unknown; threadId: string; wireServerRequests: (c: unknown) => void; wireNotifications: (c: unknown) => void };
  internals.rpc = rpc;
  internals.threadId = 'thread-1';
  internals.wireNotifications(rpc);
  internals.wireServerRequests(rpc);
  const call = (method: string, params: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`${method} handler was not registered`);
    return handler(params);
  };
  const command = (cmd: string, extra: Record<string, unknown> = {}) =>
    call('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 't', itemId: `cmd-${cmd}`, startedAtMs: 0, kind: 'command', command: cmd, cwd: ROOT, ...extra });
  /** Announce a patch the way Codex does (item/started) before asking to apply it. */
  const fileChange = (id: string, files: { path: string; move?: string }[], extra: Record<string, unknown> = {}) => {
    notifications.get('item/started')!({
      threadId: 'thread-1',
      item: { type: 'fileChange', id, status: 'inProgress', changes: files.map((f) => ({ path: f.path, diff: '', kind: { type: 'update', move_path: f.move ?? null } })) }
    });
    return call('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 't', itemId: id, startedAtMs: 0, ...extra });
  };
  return {
    adapter,
    requestApproval,
    requests,
    call,
    command,
    fileChange,
    setMode: async (next: PermissionMode) => {
      mode = next;
      await adapter.setPermissionMode(next);
    }
  };
}

describe('codex turn/start policy per tier', () => {
  const expected: Record<PermissionMode, { approvalPolicy: unknown; sandboxPolicy: unknown }> = {
    plan: { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    ask: { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['<root>'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
    'accept-edits': { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['<root>'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
    auto: { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['<root>'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
    'full-auto': { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
  };

  it.each(Object.keys(expected) as PermissionMode[])('sends the contract policy and sandbox for %s', async (mode) => {
    const { adapter, requests } = harness(mode);
    void adapter.send({ text: 'go' });
    await vi.waitFor(() => expect(requests.map((r) => r.method)).toEqual(['turn/start']));
    const params = requests[0]!.params as { approvalPolicy: unknown; sandboxPolicy: { writableRoots?: string[] } };
    const want = JSON.parse(JSON.stringify(expected[mode]).replace('"<root>"', JSON.stringify(ROOT)));
    expect({ approvalPolicy: params.approvalPolicy, sandboxPolicy: params.sandboxPolicy }).toEqual(want);
  });
});

describe('codex command approvals through the tier gate', () => {
  it('accepts an ordinary command in Auto without prompting', async () => {
    const h = harness('auto');
    await expect(h.command('npm run lint')).resolves.toEqual({ decision: 'accept' });
    expect(h.requestApproval).not.toHaveBeenCalled();
  });

  it('prompts for a dangerous command in Auto and declines when the user denies', async () => {
    const h = harness('auto', [{ optionId: 'deny' }]);
    await expect(h.command('rm -rf build')).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    expect(h.requestApproval.mock.calls[0]![0]).toMatchObject({ kind: 'command', command: 'rm -rf build' });
  });

  it('prompts in Auto when Codex asks to retry a command outside the sandbox', async () => {
    const h = harness('auto', [{ optionId: 'allow' }]);
    await expect(h.command('npm install', { reason: 'Command failed; retry without sandbox?' })).resolves.toEqual({ decision: 'accept' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    expect(h.requestApproval.mock.calls[0]![0]).toMatchObject({ description: 'Command failed; retry without sandbox?' });
  });

  it('prompts in Auto when the model requests an escalated (unsandboxed) run', async () => {
    const h = harness('auto', [{ optionId: 'deny' }]);
    await expect(h.command('git push', { reason: 'Push the branch to the remote?' })).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('treats a managed-network approval in Auto as an ordinary command', async () => {
    const h = harness('auto');
    await expect(h.command('curl https://example.com', { reason: 'Network access to example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' } })).resolves.toEqual({ decision: 'accept' });
    expect(h.requestApproval).not.toHaveBeenCalled();
  });

  it('prompts in Auto when the command runs in a directory outside the project, including through a link', async () => {
    const h = harness('auto', [{ optionId: 'deny' }, { optionId: 'deny' }]);
    await expect(h.command('npm run build', { cwd: OUTSIDE })).resolves.toEqual({ decision: 'decline' });
    await expect(h.command('npm run build', { cwd: LINK })).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(2);
  });

  it('prompts for ordinary commands in Ask and Accept edits', async () => {
    for (const mode of ['ask', 'accept-edits'] as const) {
      const h = harness(mode, [{ optionId: 'deny' }]);
      await expect(h.command('npm run lint')).resolves.toEqual({ decision: 'decline' });
      expect(h.requestApproval).toHaveBeenCalledTimes(1);
    }
  });

  it('declines every command in Plan and accepts every command in Full without prompting', async () => {
    const plan = harness('plan');
    await expect(plan.command('ls')).resolves.toEqual({ decision: 'decline' });
    await expect(plan.command('npm install', { reason: 'Command failed; retry without sandbox?' })).resolves.toEqual({ decision: 'decline' });
    expect(plan.requestApproval).not.toHaveBeenCalled();
    const full = harness('full-auto');
    await expect(full.command('rm -rf build', { cwd: OUTSIDE, reason: 'Command failed; retry without sandbox?' })).resolves.toEqual({ decision: 'accept' });
    expect(full.requestApproval).not.toHaveBeenCalled();
  });
});

describe('codex session grants', () => {
  it('answers "allow for session" with a one-time accept and covers later commands per tool, not per command line', async () => {
    const h = harness('ask', [{ optionId: 'allow_session' }]);
    await expect(h.command('npm run lint')).resolves.toEqual({ decision: 'accept' });
    // A different command line is covered by the shell grant; Codex is never told "for session".
    await expect(h.command('npm test')).resolves.toEqual({ decision: 'accept' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('never covers dangerous or outside-project commands', async () => {
    const h = harness('ask', [{ optionId: 'allow_session' }, { optionId: 'deny' }, { optionId: 'deny' }, { optionId: 'deny' }]);
    await h.command('npm run lint');
    await expect(h.command('rm -rf build')).resolves.toEqual({ decision: 'decline' });
    await expect(h.command('npm test', { cwd: OUTSIDE })).resolves.toEqual({ decision: 'decline' });
    await expect(h.command('npm test', { reason: 'Command failed; retry without sandbox?' })).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(4);
  });

  it('keeps shell and file-change grants separate', async () => {
    const h = harness('ask', [{ optionId: 'allow_session' }, { optionId: 'deny' }]);
    await h.command('npm run lint');
    await expect(h.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts') }])).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(2);
  });

  it('answers a file-change "allow for session" with a one-time accept and covers later in-project patches', async () => {
    const h = harness('ask', [{ optionId: 'allow_session' }, { optionId: 'deny' }]);
    await expect(h.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts') }])).resolves.toEqual({ decision: 'accept' });
    await expect(h.fileChange('fc-2', [{ path: path.join(ROOT, 'src', 'b.ts') }])).resolves.toEqual({ decision: 'accept' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    // ...but not a patch that leaves the project.
    await expect(h.fileChange('fc-3', [{ path: path.join(OUTSIDE, 'c.ts') }])).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(2);
  });

  it('clears every grant on a tier change', async () => {
    const h = harness('ask', [{ optionId: 'allow_session' }, { optionId: 'allow_session' }, { optionId: 'deny' }, { optionId: 'deny' }]);
    await h.command('npm run lint');
    await h.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts') }]);
    await h.setMode('auto');
    await h.setMode('ask');
    await expect(h.command('npm run lint')).resolves.toEqual({ decision: 'decline' });
    await expect(h.fileChange('fc-2', [{ path: path.join(ROOT, 'src', 'a.ts') }])).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(4);
  });

  it('answers legacy approvals with a one-time "approved", never "approved_for_session"', async () => {
    const h = harness('ask', [{ optionId: 'allow_session' }, { optionId: 'allow_session' }]);
    await expect(h.call('execCommandApproval', { command: ['npm', 'run', 'lint'], cwd: ROOT, reason: null })).resolves.toEqual({ decision: 'approved' });
    await expect(h.call('execCommandApproval', { command: ['npm', 'test'], cwd: ROOT, reason: null })).resolves.toEqual({ decision: 'approved' });
    await expect(h.call('applyPatchApproval', { fileChanges: { [path.join(ROOT, 'src', 'a.ts')]: {} } })).resolves.toEqual({ decision: 'approved' });
    await expect(h.call('applyPatchApproval', { fileChanges: { [path.join(ROOT, 'src', 'b.ts')]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(h.requestApproval).toHaveBeenCalledTimes(2);
  });
});

describe('codex file-change approvals through the tier gate', () => {
  it('accepts in-project patches in Auto and Accept edits without prompting', async () => {
    for (const mode of ['auto', 'accept-edits'] as const) {
      const h = harness(mode);
      await expect(h.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts') }])).resolves.toEqual({ decision: 'accept' });
      expect(h.requestApproval).not.toHaveBeenCalled();
    }
  });

  it('prompts in Auto for a patch that writes outside the project', async () => {
    const h = harness('auto', [{ optionId: 'deny' }]);
    await expect(h.fileChange('fc-1', [{ path: path.join(OUTSIDE, 'secret.txt') }])).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    expect(h.requestApproval.mock.calls[0]![0]).toMatchObject({ kind: 'file_change', toolItemId: 'fc-1' });
  });

  it('prompts in Accept edits for a patch through a link that resolves outside the project', async () => {
    const h = harness('accept-edits', [{ optionId: 'deny' }]);
    await expect(h.fileChange('fc-1', [{ path: path.join(LINK, 'secret.txt') }])).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('prompts in Auto when a patch moves a file outside the project', async () => {
    const h = harness('auto', [{ optionId: 'deny' }]);
    await expect(h.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts'), move: path.join(OUTSIDE, 'a.ts') }])).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('checks a grantRoot request by real path', async () => {
    const inside = harness('auto');
    await expect(inside.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts') }], { grantRoot: path.join(ROOT, 'src') })).resolves.toEqual({ decision: 'accept' });
    expect(inside.requestApproval).not.toHaveBeenCalled();
    const outside = harness('auto', [{ optionId: 'deny' }, { optionId: 'deny' }]);
    await expect(outside.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts') }], { grantRoot: OUTSIDE })).resolves.toEqual({ decision: 'decline' });
    await expect(outside.fileChange('fc-2', [{ path: path.join(ROOT, 'src', 'a.ts') }], { grantRoot: LINK })).resolves.toEqual({ decision: 'decline' });
    expect(outside.requestApproval).toHaveBeenCalledTimes(2);
  });

  it('prompts in Auto when the patch paths are unknown', async () => {
    const h = harness('auto', [{ optionId: 'deny' }]);
    await expect(h.call('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 't', itemId: 'never-announced', startedAtMs: 0 })).resolves.toEqual({ decision: 'decline' });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('declines patches in Plan and accepts outside-project patches in Full without prompting', async () => {
    const plan = harness('plan');
    await expect(plan.fileChange('fc-1', [{ path: path.join(ROOT, 'src', 'a.ts') }])).resolves.toEqual({ decision: 'decline' });
    expect(plan.requestApproval).not.toHaveBeenCalled();
    const full = harness('full-auto');
    await expect(full.fileChange('fc-1', [{ path: path.join(OUTSIDE, 'a.ts') }], { grantRoot: OUTSIDE })).resolves.toEqual({ decision: 'accept' });
    expect(full.requestApproval).not.toHaveBeenCalled();
  });

  it('prompts for a legacy patch through a link that resolves outside the project', async () => {
    const h = harness('auto', [{ optionId: 'deny', note: 'not there' }]);
    await expect(h.call('applyPatchApproval', { fileChanges: { [path.join(LINK, 'secret.txt')]: {} } })).resolves.toEqual({ decision: { denied: { rejection: 'not there' } } });
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
  });
});
