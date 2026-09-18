/**
 * Regression coverage for "a wide subagent fan-out loses its tail".
 *
 * Claude Code runs at most `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` subagents at once and refuses the
 * rest outright: the spawning call returns `Concurrent subagent limit reached. You can run 20
 * subagents at once. Do not retry.` and the run does nothing at all. Its own default is 20, which is
 * a terminal's number — a session here fans out on purpose (thirty areas of one review), so a
 * fan-out wider than that is refused at the far end, in silence.
 *
 * The adapter therefore names the cap itself. It has to be set *after* the `CLAUDE_CODE_*` scrub,
 * which keeps this app's own host variables out of a nested session and would otherwise delete the
 * cap on its way to the subprocess — the same trap the subagent model variables sit behind (see
 * `claude-subagent-model.test.ts`).
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/main/harness/claude';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionMeta } from '../src/shared/types';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
});

/** The environment the adapter would hand the CLI it starts. */
async function envFor(): Promise<Record<string, string | undefined>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-claude-subagent-cap-'));
  tempDirs.push(dir);
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
    settings: () => ({ claude: { settingSources: [], useProviderKey: false }, pi: { extraArgs: [] }, providers: [] }) as never,
    runtime: { resolve: () => undefined } as never,
    sessionDir: dir,
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {}
  } as unknown as HarnessContext;
  const adapter = new ClaudeAdapter(ctx);
  return (adapter as unknown as { buildOptions: () => Promise<{ env: Record<string, string | undefined> }> }).buildOptions().then((o) => o.env);
}

describe('the subagent fan-out a Claude session may run', () => {
  it('raises the CLI cap, whose own default of 20 is a terminal’s number', async () => {
    // Pinned on purpose: this is the app's product choice, and moving it should be deliberate.
    expect((await envFor()).CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('32');
  });

  it('survives the scrub that drops every other CLAUDE_CODE_* variable', async () => {
    // A host session's own settings must not leak into the child, and this is one of them.
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '4';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const env = await envFor();
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('32');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });
});
