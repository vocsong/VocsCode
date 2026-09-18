/** The Claude harness must start from the same project instructions as every other harness.
 *  Claude Code's engine reads CLAUDE.md itself but not AGENTS.md, so the adapter injects the latter
 *  where no Claude document claims the directory. Regression coverage for "using the Claude harness
 *  only takes CLAUDE.md, not AGENTS.md". */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter } from '../src/main/harness/claude';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  queryMock.mockReset();
});

async function project(files: Record<string, string>): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-instructions-'));
  dirs.push(cwd);
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(cwd, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, 'utf8');
  }
  return cwd;
}

function ctx(cwd: string, settingSources: ('user' | 'project' | 'local')[], appendSystemPrompt?: string): HarnessContext {
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: cwd, permissionMode: 'ask', appendSystemPrompt },
    cwd,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  };
  return {
    sessionId: 's1',
    session: () => meta,
    settings: () => ({ claude: { runtime: 'auto', useProviderKey: false, settingSources }, providers: [] }) as unknown as AppSettings,
    runtime: { resolve: () => undefined },
    sessionDir: cwd,
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => undefined,
    mcpServers: async () => [],
    ownedMcpIds: () => [],
    emit: () => {},
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
}

/** Starts once against an empty message stream and returns the system prompt's append text. */
async function appendFor(cwd: string, settingSources: ('user' | 'project' | 'local')[] = ['user', 'project', 'local'], appendSystemPrompt?: string): Promise<string | undefined> {
  queryMock.mockReset();
  queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, setModel: vi.fn(), close: vi.fn(), interrupt: vi.fn() });
  await new ClaudeAdapter(ctx(cwd, settingSources, appendSystemPrompt)).start();
  const options = (queryMock.mock.calls[0][0] as { options: { systemPrompt: { append?: string } } }).options;
  return options.systemPrompt.append;
}

describe('Claude project instructions', () => {
  it('reads AGENTS.md where the project has no CLAUDE.md', async () => {
    const cwd = await project({ 'AGENTS.md': 'Always run the verification bar.' });
    expect(await appendFor(cwd)).toContain('Always run the verification bar.');
  });

  it('leaves CLAUDE.md to the engine instead of duplicating it beside AGENTS.md', async () => {
    const cwd = await project({ 'CLAUDE.md': '@AGENTS.md', 'AGENTS.md': 'Always run the verification bar.' });
    expect(await appendFor(cwd)).toBeUndefined();
  });

  it('still adds the app-scoped INSTRUCTIONS.md beside a Claude document', async () => {
    const cwd = await project({ 'CLAUDE.md': 'Claude rules.', '.vocs-code/INSTRUCTIONS.md': 'App-scoped rules.' });
    const append = await appendFor(cwd);
    expect(append).toContain('App-scoped rules.');
    expect(append).not.toContain('Claude rules.');
  });

  it('does not inject project rules when the project setting source is off', async () => {
    const cwd = await project({ 'AGENTS.md': 'Always run the verification bar.' });
    expect(await appendFor(cwd, ['user', 'local'])).toBeUndefined();
  });

  it('keeps the session append after the project instructions', async () => {
    const cwd = await project({ 'AGENTS.md': 'Project rule.' });
    const append = await appendFor(cwd, ['project'], 'Session rule.');
    expect(append).toContain('Project rule.');
    expect(append).toContain('Session rule.');
    expect(append!.indexOf('Project rule.')).toBeLessThan(append!.indexOf('Session rule.'));
  });
});
