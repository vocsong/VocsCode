/** The Claude adapter reports the slash commands its CLI accepts, which is what lets a session hand
 *  `/goal` to the harness's own goal instead of the app's engine (see src/shared/goal-driver.ts). */
import type { SessionEvent, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/main/harness/claude';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

/** A session whose meta the adapter can read back, recording every updateMeta patch it receives. */
function stubCtx() {
  const events: SessionEvent[] = [];
  const patches: Partial<SessionMeta>[] = [];
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: '.', permissionMode: 'ask' },
    cwd: '.',
    status: 'idle',
    harnessRef: {},
    usage: { ...ZERO_USAGE }
  };
  const ctx = {
    sessionId: 's1',
    session: () => meta,
    settings: () => ({ claude: { settingSources: [], useProviderKey: false }, pi: { extraArgs: [] } }) as never,
    runtime: {} as never,
    sessionDir: '.',
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => undefined,
    emit: (e: SessionEvent) => events.push(e),
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: (patch: Partial<SessionMeta>) => {
      patches.push(patch);
      if (patch.harnessCommands) meta.harnessCommands = patch.harnessCommands;
      if (patch.harnessCommandList) meta.harnessCommandList = patch.harnessCommandList;
    },
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
  return { ctx, events, meta, patches };
}

/** handle() is private; drive it directly with SDK-shaped messages. */
function feed(adapter: ClaudeAdapter, msg: Record<string, unknown>, q: Record<string, unknown>): void {
  (adapter as unknown as { handle: (m: unknown, q: unknown) => void }).handle(msg as never, q);
}

const init = { type: 'system', subtype: 'init', session_id: 'cli-1', model: 'claude-x' };

/** The reported command lists, in order. */
const reported = (patches: Partial<SessionMeta>[]): string[][] => patches.filter((p) => p.harnessCommands).map((p) => p.harnessCommands!);

describe('Claude adapter command reporting', () => {
  it('reports the CLI’s slash commands on init, aliases included', async () => {
    const { ctx, meta, patches } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    const q = {
      supportedModels: async () => [],
      supportedCommands: async () => [
        { name: 'goal', description: 'Run a goal', argumentHint: '<objective>' },
        { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
        { name: 'compact', description: 'Compact', argumentHint: '' }
      ]
    };
    feed(a, init, q);
    await new Promise((r) => setTimeout(r, 0));

    expect(meta.harnessCommands).toEqual(['goal', 'usage', 'cost', 'stats', 'compact']);
    expect(reported(patches)).toEqual([['goal', 'usage', 'cost', 'stats', 'compact']]);
  });

  it('publishes what the composer offers: descriptions, hints, built-in vs skill, the built-in row winning a shared name', async () => {
    const { ctx, meta } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    const q = {
      supportedModels: async () => [],
      supportedCommands: async () => [
        { name: 'review', description: 'My own review skill', argumentHint: '' },
        { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', builtin: true },
        { name: 'deploy', description: 'Ship it', argumentHint: '<env>' }
      ]
    };
    feed(a, init, q);
    await new Promise((r) => setTimeout(r, 0));

    expect(meta.harnessCommandList).toEqual([
      { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', kind: 'command' },
      { name: 'deploy', description: 'Ship it', argumentHint: '<env>', kind: 'skill' }
    ]);
  });

  it('re-reports when the CLI discovers commands mid-session, replacing the list', async () => {
    const { ctx, meta, patches } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    const q = { supportedModels: async () => [], supportedCommands: async () => [{ name: 'compact', description: '', argumentHint: '' }] };
    feed(a, init, q);
    await new Promise((r) => setTimeout(r, 0));
    expect(meta.harnessCommands).toEqual(['compact']);

    feed(a, { type: 'system', subtype: 'commands_changed', commands: [{ name: 'goal', description: 'Run a goal', argumentHint: '<objective>' }] }, q);
    expect(meta.harnessCommands).toEqual(['goal']);
    expect(reported(patches)).toEqual([['compact'], ['goal']]);
  });

  it('does not re-report an unchanged list, so a resume does not push sessions for nothing', async () => {
    const { ctx, patches } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    const commands = [{ name: 'goal', description: 'Run a goal', argumentHint: '<objective>' }];
    const q = { supportedModels: async () => [], supportedCommands: async () => commands };
    feed(a, init, q);
    await new Promise((r) => setTimeout(r, 0));
    // The CLI re-inits on the next turn; the same list must not reach updateMeta again.
    feed(a, init, q);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported(patches)).toHaveLength(1);
  });

  it('keeps the session working when the CLI cannot answer for its commands', async () => {
    const { ctx, patches } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    const q = {
      supportedModels: async () => [],
      supportedCommands: async () => {
        throw new Error('unsupported');
      }
    };
    feed(a, init, q);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported(patches)).toEqual([]);
  });
});
