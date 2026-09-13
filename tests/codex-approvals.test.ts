/**
 * Offline tests for the Codex app-server approval handlers. The legacy applyPatchApproval request
 * must not auto-approve patches that write outside the workspace (issue #125).
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import type { ApprovalDecision, PermissionMode, SessionEvent } from '../src/shared/types';

const ROOT = path.resolve(path.sep, 'tmp', 'vocs-codex-approvals');

type ApprovalHandler = (params: unknown) => Promise<unknown>;

function makeAdapter(mode: PermissionMode, decision: ApprovalDecision = { optionId: 'allow' }) {
  const events: SessionEvent[] = [];
  const requestApproval = vi.fn(async (_draft: ApprovalDraft) => decision);
  const handlers = new Map<string, ApprovalHandler>();
  const ctx = {
    emit: (e: SessionEvent) => events.push(e),
    session: () => ({ cwd: ROOT, usage: {} }),
    permissionMode: () => mode,
    requestApproval,
    log: vi.fn(),
    updateMeta: vi.fn(),
    updateRef: vi.fn(),
    sessionDir: ROOT
  } as unknown as HarnessContext;
  const adapter = new CodexAppServerAdapter(ctx);
  const rpc = {
    onServerRequest: (method: string, handler: ApprovalHandler) => handlers.set(method, handler),
    onNotification: vi.fn()
  };
  (adapter as unknown as { wireServerRequests: (client: unknown) => void }).wireServerRequests(rpc);
  const applyPatch = handlers.get('applyPatchApproval');
  if (!applyPatch) throw new Error('applyPatchApproval handler was not registered');
  return { applyPatch, requestApproval, events };
}

const inside = path.join(ROOT, 'src', 'app.ts');
const outside = path.resolve(ROOT, '..', 'elsewhere', 'secret.txt');

describe('applyPatchApproval workspace scope', () => {
  it('auto-approves in-workspace patches in auto mode without prompting', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto');
    await expect(applyPatch({ fileChanges: { [inside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('prompts for an outside-workspace patch in auto mode and honors the decision', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto', { optionId: 'allow' });
    await expect(applyPatch({ reason: 'update', fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const draft = requestApproval.mock.calls[0]![0];
    expect(draft.kind).toBe('file_change');
    expect(draft.changes?.map((c) => c.path)).toEqual([outside]);
  });

  it('prompts for an outside-workspace patch in accept-edits mode', async () => {
    const { applyPatch, requestApproval } = makeAdapter('accept-edits', { optionId: 'deny', note: 'not that file' });
    await expect(applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: { denied: { rejection: 'not that file' } } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('denies outside-workspace patches when the user declines', async () => {
    const { applyPatch } = makeAdapter('auto', { optionId: 'deny' });
    await expect(applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: { denied: { rejection: 'User declined' } } });
  });

  it('treats a grantRoot request as outside the workspace below full access', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto');
    await applyPatch({ fileChanges: { [inside]: {} }, grantRoot: path.resolve(ROOT, '..') });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('prompts when a patch moves an in-workspace file outside the workspace', async () => {
    const { applyPatch, requestApproval } = makeAdapter('auto');
    await applyPatch({ fileChanges: { [inside]: { type: 'update', unified_diff: '', move_path: outside } } });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still asks for in-workspace patches in ask mode', async () => {
    const { applyPatch, requestApproval } = makeAdapter('ask');
    await expect(applyPatch({ fileChanges: { [inside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('leaves plan mode denying patches and full-auto approving them', async () => {
    const plan = makeAdapter('plan');
    await expect(plan.applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: { denied: { rejection: 'Plan mode' } } });
    expect(plan.requestApproval).not.toHaveBeenCalled();

    const full = makeAdapter('full-auto');
    await expect(full.applyPatch({ fileChanges: { [outside]: {} } })).resolves.toEqual({ decision: 'approved' });
    expect(full.requestApproval).not.toHaveBeenCalled();
  });
});
