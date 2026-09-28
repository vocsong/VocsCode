/**
 * Regression coverage for "Claude subagents 401 on a third-party endpoint".
 *
 * Claude Code picks a delegated agent's model from the agent's own definition before anything else,
 * and the built-ins declare `inherit` — which on a provider that is not Anthropic does not resolve
 * to the session's model but to Claude's own default, an Anthropic id. Against opencode-go that is
 * `401 ... model sent to the API: claude-opus-5`, reproduced against CLI 2.1.263 with
 * `--model deepseek-v4.1-flash`: the subagent still asked for `claude-opus-5`.
 *
 * So the adapter has to name the model itself, and naming it is not enough — `_FORCE` is the only
 * variant that moves a built-in, and the plain variable is read after the definition and loses.
 * The pair is therefore asserted together, and asserted to survive the `CLAUDE_CODE_*` scrub, which
 * would otherwise delete them on the way to the subprocess.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AppSettings, ModelRef, ProviderConfig, SessionEvent, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter } from '../src/main/harness/claude';
import { claudeAgentDir } from '../src/main/claude-agents';

const GATEWAY: ProviderConfig = { id: 'opencode-go', kind: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', hasApiKey: false, models: [], enabled: true };
const MODEL: ModelRef = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };

const settings = { claude: { runtime: 'auto', useProviderKey: false, settingSources: [] }, providers: [GATEWAY] } as unknown as AppSettings;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-claude-subagent-model-'));
  tempDirs.push(dir);
  return dir;
}

/** A session whose project root is a real directory, so the adapter's definition lookup is honest. */
function ctxFor(projectRoot: string, model: ModelRef | undefined): HarnessContext {
  const meta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot, permissionMode: 'ask', model },
    cwd: projectRoot,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  } as unknown as SessionMeta;
  return {
    sessionId: 's1',
    session: () => meta,
    settings: () => settings,
    runtime: { resolve: () => ({ path: process.execPath, source: 'system' }) },
    sessionDir: projectRoot,
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => undefined,
    mcpServers: async () => [],
    ownedMcpIds: () => [],
    emit: (_e: SessionEvent) => {},
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
}

async function envFor(projectRoot: string, model: ModelRef | undefined, query?: object): Promise<Record<string, string | undefined>> {
  queryMock.mockReset();
  queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, close: vi.fn(), interrupt: vi.fn(), ...query });
  await new ClaudeAdapter(ctxFor(projectRoot, model)).start();
  return (queryMock.mock.calls[0][0] as { options: { env: Record<string, string | undefined> } }).options.env;
}

async function pin(root: string, name: string, model: string): Promise<void> {
  await fs.mkdir(claudeAgentDir(root), { recursive: true });
  await fs.writeFile(path.join(claudeAgentDir(root), `${name}.md`), `---\nname: ${name}\ndescription: d\nmodel: ${model}\n---\n`, 'utf8');
}

describe('the subagent model a Claude session runs with', () => {
  it('names the session model and forces it, so the built-ins follow it too', async () => {
    const root = await tempDir();
    const env = await envFor(root, MODEL);
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4.1-flash');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1');
  });

  it('survives the scrub that drops every other CLAUDE_CODE_* variable', async () => {
    const root = await tempDir();
    // The app's own host variables must not leak into the child, and this is one of them.
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-opus-5';
    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '0';
    const env = await envFor(root, MODEL);
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4.1-flash');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1');
  });

  it('withholds FORCE when the project pins a model, because FORCE would ignore the pin', async () => {
    const root = await tempDir();
    await pin(root, 'Explore', 'deepseek-v4.1');
    const env = await envFor(root, MODEL);
    // The unpinned types still fall back to the session model through the plain variable…
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4.1-flash');
    // …and the pin is left to win for the type that declares one.
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBeUndefined();
  });

  it('keeps forcing when a definition only restates `inherit`, which asks for nothing', async () => {
    const root = await tempDir();
    await pin(root, 'Plan', 'inherit');
    expect((await envFor(root, MODEL)).CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1');
  });

  it('names nothing when the session has no model of its own', async () => {
    const root = await tempDir();
    const env = await envFor(root, undefined);
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBeUndefined();
  });
});

describe('the agent types a live session reports', () => {
  it('lists what the engine names, and reports none when it cannot be asked', async () => {
    const root = await tempDir();
    queryMock.mockReset();
    queryMock.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {},
      close: vi.fn(),
      interrupt: vi.fn(),
      supportedAgents: async () => [{ name: 'Explore', description: 'Searches the repo', model: 'inherit' }, { name: 'reviewer', description: 'Reviews a diff' }]
    });
    const adapter = new ClaudeAdapter(ctxFor(root, MODEL));
    await adapter.start();
    expect(await adapter.listAgents()).toEqual([
      { name: 'Explore', description: 'Searches the repo', model: 'inherit' },
      { name: 'reviewer', description: 'Reviews a diff' }
    ]);
    await adapter.dispose();

    // A CLI old enough to answer supportedModels but not this one reads as "unknown", not as a crash.
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, close: vi.fn(), interrupt: vi.fn() });
    const older = new ClaudeAdapter(ctxFor(root, MODEL));
    await older.start();
    expect(await older.listAgents()).toEqual([]);
    await older.dispose();
  });
});
