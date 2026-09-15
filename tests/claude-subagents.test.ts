/**
 * Claude adapter subagent capture: Claude Code runs its own subagents, and the panel is supposed to
 * show them the way it shows pi's. The adapter sees that stream as nested messages plus the SDK's
 * task lifecycle, so these drive `handle()` with SDK-shaped messages and assert on what lands on
 * disk — the durable record the panel actually reads.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/main/harness/claude';
import { readSubagentRun, subagentDir } from '../src/main/subagents';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import type { SubagentRun, SubagentRunStatus } from '../src/shared/subagents';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface Stub {
  ctx: HarnessContext;
  events: SessionEvent[];
  dir: string;
}

async function stubCtx(): Promise<Stub> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-claude-subagents-'));
  tempDirs.push(dir);
  const events: SessionEvent[] = [];
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: dir, permissionMode: 'ask' },
    cwd: dir,
    status: 'idle',
    harnessRef: {},
    usage: { ...ZERO_USAGE }
  };
  const ctx = {
    sessionId: 's1',
    session: () => meta,
    settings: () => ({ claude: { settingSources: [], useProviderKey: false }, pi: { extraArgs: [] } }) as never,
    runtime: { resolve: () => undefined } as never,
    sessionDir: dir,
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => undefined,
    emit: (e: SessionEvent) => events.push(e),
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
  return { ctx, events, dir };
}

/** handle() is private; drive it directly with SDK-shaped messages. */
function feed(adapter: ClaudeAdapter, msg: Record<string, unknown>): void {
  (adapter as unknown as { handle: (m: unknown, q: unknown) => void }).handle(msg as never, null);
}

/** The run file is written asynchronously, so wait for a record rather than a tick. */
async function settled(dir: string, runId: string, status: SubagentRunStatus): Promise<SubagentRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await readSubagentRun(dir, 'claude', runId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} never reached ${status} (last: ${JSON.stringify(await readSubagentRun(dir, 'claude', runId))})`);
}

/** The item texts of a run, which is what its transcript pane renders. */
const texts = (run: SubagentRun): (string | undefined)[] => run.items.filter((item) => item.kind === 'assistant').map((item) => item.text);

const upserted = (events: SessionEvent[], id: string): TranscriptItem | undefined =>
  events
    .filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert')
    .map((e) => e.item)
    .reverse()
    .find((item) => item.id === id);

const AGENT_CALL = 'toolu_01AgentCall';
const CHILD_GREP = 'toolu_01ChildGrep';

/** A main-thread Agent tool call, exactly as the SDK puts it on the wire. */
function agentToolUse(input: Record<string, unknown> = { subagent_type: 'Explore', description: 'Find the flaky test' }): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_main', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: AGENT_CALL, name: 'Agent', input }] }
  };
}

/** One child model call: its answer text, a tool call, and the usage the call table prices. */
const childCall = (messageId: string, text = 'CHILD_ONLY looking at tests') => ({
  type: 'assistant',
  parent_tool_use_id: AGENT_CALL,
  message: {
    id: messageId,
    model: 'claude-haiku-4-5',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10, output_tokens_details: { thinking_tokens: 7 } },
    content: [
      { type: 'text', text },
      { type: 'tool_use', id: CHILD_GREP, name: 'Grep', input: { pattern: 'flaky' } }
    ]
  }
});

describe('Claude adapter subagent capture', () => {
  it('records a delegated run: card link, child transcript, per-call cost, completion', async () => {
    const { ctx, events, dir } = await stubCtx();
    const a = new ClaudeAdapter(ctx);

    feed(a, agentToolUse());
    // The transcript card points at the run, which is how the panel is reachable from the transcript.
    expect(upserted(events, AGENT_CALL)).toMatchObject({ kind: 'tool', name: 'Agent', runId: AGENT_CALL });

    feed(a, { type: 'system', subtype: 'task_started', task_id: 'task_1', tool_use_id: AGENT_CALL, description: 'Find the flaky test', subagent_type: 'Explore', is_backgrounded: false });
    feed(a, childCall('msg_child_1'));
    feed(a, { type: 'user', parent_tool_use_id: AGENT_CALL, message: { content: [{ type: 'tool_result', tool_use_id: CHILD_GREP, content: 'match at tests/a.test.ts' }] } });
    // The spawning call returns: for a foreground subagent that is the end of the run.
    feed(a, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: AGENT_CALL, content: 'Found it.' }] } });
    feed(a, { type: 'system', subtype: 'task_notification', task_id: 'task_1', tool_use_id: AGENT_CALL, status: 'completed', usage: { total_tokens: 1260, tool_uses: 1, duration_ms: 4321 } });

    const run = await settled(dir, AGENT_CALL, 'completed');
    expect(run.meta).toMatchObject({ runId: AGENT_CALL, agent: 'Explore', description: 'Find the flaky test', mode: 'foreground', model: 'claude-haiku-4-5', cwd: dir });

    // The child's transcript: its answer, then its tool call closed by the result.
    expect(run.items).toHaveLength(2);
    expect(run.items[0]).toMatchObject({ kind: 'assistant', text: 'CHILD_ONLY looking at tests' });
    expect(run.items[1]).toMatchObject({ kind: 'tool', name: 'Grep', summary: 'flaky', status: 'done', output: 'match at tests/a.test.ts' });

    // One row per model call, priced from the app's own table since the SDK reports no per-call cost.
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatchObject({ index: 0, provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 10, reasoningTokens: 7, stopReason: 'tool_use', toolsInvoked: ['Grep'] });
    expect(run.calls[0]!.costUsd).toBeGreaterThan(0);
    expect(run.totals).toMatchObject({ turns: 1, toolUses: 1, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 10, reasoningTokens: 7 });
    expect(run.totals.costUsd).toBeCloseTo(run.calls[0]!.costUsd, 10);

    // Live refresh: the panel is told about the run while it works and again when it finishes.
    const updates = events.filter((e): e is Extract<SessionEvent, { type: 'subagent.run' }> => e.type === 'subagent.run');
    expect(updates[0]!.run).toMatchObject({ runId: AGENT_CALL, status: 'running', agent: 'Explore' });
    expect(updates.at(-1)!.run).toMatchObject({ runId: AGENT_CALL, status: 'completed', costUsd: run.totals.costUsd, turns: 1, toolUses: 1 });
    // Analytics still learns about the delegation; its spend is already in the SDK's own totals,
    // so reporting usage here as well would double-count it.
    const completion = events.find((e): e is Extract<SessionEvent, { type: 'subagent' }> => e.type === 'subagent');
    expect(completion!.completion).toMatchObject({ agentId: AGENT_CALL, status: 'completed', agentType: 'Explore', toolUses: 1, costUsd: run.totals.costUsd });
    expect(completion!.completion.usage).toBeUndefined();
  });

  it('keeps the child transcript out of the parent', async () => {
    const { ctx, events, dir } = await stubCtx();
    const a = new ClaudeAdapter(ctx);
    feed(a, agentToolUse());
    feed(a, childCall('msg_child_1'));
    feed(a, { type: 'system', subtype: 'task_notification', task_id: 'task_1', tool_use_id: AGENT_CALL, status: 'completed' });

    // The child's answer belongs to the run, not to the session's own transcript.
    const assistantTexts = events
      .filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert')
      .map((e) => e.item)
      .filter((item) => item.kind === 'assistant')
      .map((item) => (item.kind === 'assistant' ? item.text : ''));
    expect(assistantTexts.join('\n')).not.toContain('CHILD_ONLY');
    // Its calls still show inline, nested under the spawning card, as they always have.
    expect(upserted(events, CHILD_GREP)).toMatchObject({ kind: 'tool', name: 'Grep', parentId: AGENT_CALL });
    expect((await settled(dir, AGENT_CALL, 'completed')).items[0]).toMatchObject({ text: 'CHILD_ONLY looking at tests' });
  });

  it('leaves a backgrounded run open until its task notification arrives', async () => {
    const { ctx, dir } = await stubCtx();
    const a = new ClaudeAdapter(ctx);
    feed(a, agentToolUse({ subagent_type: 'Plan', description: 'Audit the suite', run_in_background: true }));
    feed(a, { type: 'system', subtype: 'task_started', task_id: 'task_bg', tool_use_id: AGENT_CALL, subagent_type: 'Plan', description: 'Audit the suite', is_backgrounded: true });
    // The spawning call returns immediately: the run is not over, it has only been handed off.
    feed(a, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: AGENT_CALL, content: 'Started in the background.' }] } });
    expect(await settled(dir, AGENT_CALL, 'running')).toMatchObject({ meta: { mode: 'background' } });

    feed(a, { type: 'system', subtype: 'task_progress', task_id: 'task_bg', usage: { tool_uses: 4, duration_ms: 1500 } });
    feed(a, { type: 'system', subtype: 'task_notification', task_id: 'task_bg', status: 'completed', usage: { total_tokens: 900, tool_uses: 6, duration_ms: 5000 } });

    // Totals prefer the SDK's own numbers, which is the whole point of reading the task lifecycle.
    expect(await settled(dir, AGENT_CALL, 'completed')).toMatchObject({ meta: { mode: 'background' }, totals: { toolUses: 6, durationMs: 5000 } });
  });

  it('closes an in-flight run as interrupted when the session stops', async () => {
    const { ctx, events, dir } = await stubCtx();
    const a = new ClaudeAdapter(ctx);
    feed(a, agentToolUse());
    feed(a, childCall('msg_child_1'));

    await a.dispose();

    const run = await settled(dir, AGENT_CALL, 'interrupted');
    expect(run.meta).toMatchObject({ runId: AGENT_CALL, agent: 'Explore' });
    // Whatever the child managed to say before the process went away is kept.
    expect(texts(run)).toEqual(['CHILD_ONLY looking at tests']);
    expect(events.filter((e): e is Extract<SessionEvent, { type: 'subagent.run' }> => e.type === 'subagent.run').at(-1)!.run).toMatchObject({ runId: AGENT_CALL, status: 'interrupted' });
  });

  it('ignores the SDK\'s ambient tasks, which are not delegated runs the user asked for', async () => {
    const { ctx, dir } = await stubCtx();
    const a = new ClaudeAdapter(ctx);
    feed(a, { type: 'system', subtype: 'task_started', task_id: 'task_ambient', tool_use_id: 'toolu_ambient', ambient: true, subagent_type: 'Explore' });
    feed(a, { type: 'system', subtype: 'task_notification', task_id: 'task_ambient', tool_use_id: 'toolu_ambient', status: 'completed' });
    await a.dispose();
    await expect(fs.readdir(subagentDir(dir, 'claude')!)).rejects.toThrow();
    expect(await readSubagentRun(dir, 'claude', 'toolu_ambient')).toBeNull();
  });

  it('asks the SDK to forward subagent text, without which there is no child transcript at all', async () => {
    const { ctx } = await stubCtx();
    const a = new ClaudeAdapter(ctx);
    const options = (a as unknown as { buildOptions: () => Record<string, unknown> }).buildOptions();
    expect(options.forwardSubagentText).toBe(true);
  });
});
