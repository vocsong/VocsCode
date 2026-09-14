/** Vesta, the in-app assistant. The point of these tests is the gate: pi drives the handler
 *  registry, which also serves keychain writes and raw PTY input, so nothing outside the
 *  capability allowlist may be invoked and nothing that changes state may run unapproved.
 *
 *  The runtime is scripted rather than spawned: each test plays the app's side of the bridge
 *  (pi's extension asks through `run`, the test answers through the proposal), which is exactly
 *  the sequence tests/vesta-pi.integration.test.ts proves against the real pi. */
import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES, agentChannels, resolveSessionModel, type CapabilityContext } from '../src/shared/agent-manifest';
import { defaultSettings, normalizeSettings } from '../src/main/settings';
import type { AppSettings, ImageAttachment, ModelInfo, ProviderConfig, SessionConfig, SessionMeta } from '../src/shared/types';
import type { VestaRuntime, VestaToolCall, PiAgentOptions } from '../src/main/agents/pi-runtime';
import { isRemoteBlocked } from '../src/main/web-server';

const { Vesta } = await import('../src/main/agents');

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function call(name: string, args: Record<string, unknown>, id = `c${name}`): VestaToolCall {
  return { id, name, args };
}

const PROVIDER: ProviderConfig = { id: 'testprov', kind: 'anthropic', name: 'Test', hasApiKey: true, enabled: true, models: [{ id: 'm1', provider: 'testprov', displayName: 'M1' }] };

const SESSION: SessionMeta = {
  id: 's1',
  title: 'Vocs Code',
  createdAt: 1,
  updatedAt: 1,
  config: { harness: 'native', permissionMode: 'ask', projectRoot: 'G:/Vocs-Code' },
  cwd: 'G:/Vocs-Code',
  status: 'idle',
  harnessRef: {},
  usage: { ...NO_USAGE, costUsd: 0, turns: 0 }
};

function settingsWith(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultSettings(), providers: [PROVIDER], agentModel: { provider: 'testprov', model: 'm1' }, ...patch };
}

/** Plays the app's half of the bridge for one test: the test calls step()/run()/settle() the way
 *  pi's extension would. */
class ScriptedRuntime implements VestaRuntime {
  model = 'vocs-offline/scripted';
  busy = false;
  dead = false;
  disposed = false;
  aborts = 0;
  promptCalls: { message: string; systemPrompt: string; images?: ImageAttachment[] }[] = [];

  constructor(private readonly opts: PiAgentOptions) {}

  async prompt(message: string, systemPrompt: string, images?: ImageAttachment[]): Promise<void> {
    this.promptCalls.push({ message, systemPrompt, images });
  }
  abort(): void {
    this.aborts++;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  /** One assistant message: text plus the tool calls it asked for. */
  step(text: string, calls: VestaToolCall[]): void {
    this.opts.events.stepStart();
    if (text) this.opts.events.text(text);
    this.opts.events.stepEnd(text, calls);
  }
  /** The extension's tool execution reaching the app. */
  run(call: VestaToolCall): Promise<{ ok: boolean; detail: string }> {
    return this.opts.events.run(call);
  }
  settled(error?: string): void {
    this.opts.events.settled(error);
  }
  options(): PiAgentOptions {
    return this.opts;
  }
}

function makeAgent(opts: { invoke?: (channel: string, req: unknown) => Promise<unknown>; settings?: AppSettings; pi?: boolean } = {}) {
  const invoked: { channel: string; req: unknown }[] = [];
  const runtimes: ScriptedRuntime[] = [];
  const agent = new Vesta({
    getSettings: () => opts.settings ?? settingsWith(),
    listSessions: () => [SESSION],
    getSession: (id) => (id === SESSION.id ? SESSION : undefined),
    getSecret: async () => 'sk-test',
    invoke: async (channel, req) => {
      invoked.push({ channel, req });
      return opts.invoke ? opts.invoke(channel, req) : { ok: true };
    },
    push: () => undefined,
    log: () => undefined,
    piBinary: () => (opts.pi === false ? null : 'C:/fake/pi.cmd'),
    piExtension: () => 'resources/pi/vocs-code-vesta.ts',
    piCwd: () => 'G:/Vocs-Code',
    createRuntime: (o) => {
      const runtime = new ScriptedRuntime(o);
      runtimes.push(runtime);
      return runtime;
    }
  });
  return {
    agent,
    invoked,
    /** The runtime the first send spawned; the fake above records it. */
    runtime: () => {
      if (!runtimes.length) throw new Error('no runtime was created');
      return runtimes[runtimes.length - 1];
    },
    runtimeCount: () => runtimes.length
  };
}

/** Resolves once a proposal is on screen, so a test can answer it while the call is mid-flight. */
async function waitForProposal(agent: InstanceType<typeof Vesta>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const item = agent.state().items.find((x) => x.kind === 'proposal' && x.proposal.status === 'pending');
    if (item && item.kind === 'proposal') return item.proposal.id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no proposal appeared');
}

describe('capability manifest', () => {
  it('never exposes a channel that could exfiltrate secrets or run arbitrary code', () => {
    const forbidden = [/^terminal:/, /^secrets:/, /^window:/, /^providers:/, /^app:open/, /^settings:update$/, /^agent:/, /^sessions:send$/, /^sessions:delete$/];
    for (const channel of agentChannels()) {
      for (const pattern of forbidden) expect(pattern.test(channel), `${channel} must not be reachable by Vesta`).toBe(false);
    }
  });

  it('registers each capability once, with an object schema', () => {
    const names = AGENT_CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of AGENT_CAPABILITIES) {
      expect(c.parameters.type, c.name).toBe('object');
      expect(typeof c.description === 'string' && c.description.length > 20, c.name).toBe(true);
    }
  });

  it('treats a stdio MCP probe as a change, because it runs the command the model chose', () => {
    const probe = AGENT_CAPABILITIES.find((c) => c.name === 'probe_mcp_server')!;
    expect(probe.tier({ server: { transport: 'http', url: 'https://example.com/mcp' } })).toBe('read');
    expect(probe.tier({ server: { transport: 'stdio', command: 'npx', args: ['-y', 'evil'] } })).toBe('write');
  });

  it('keeps the provider table out of the settings a model can read', () => {
    const caps = AGENT_CAPABILITIES.find((c) => c.name === 'get_app_settings')!;
    const full = normalizeSettings({ providers: [{ ...PROVIDER, envKey: 'SECRET_ENV' }] });
    const seen = JSON.stringify(caps.project!(full));
    expect(seen).not.toContain('testprov');
    expect(seen).not.toContain('SECRET_ENV');
  });
});

describe('create_session model', () => {
  const create = AGENT_CAPABILITIES.find((c) => c.name === 'create_session')!;
  const PI_MODELS: ModelInfo[] = [
    { id: 'claude-opus-5', provider: 'anthropic', displayName: 'Opus 5' },
    { id: 'gpt-5', provider: 'openai', displayName: 'GPT-5' },
    { id: 'gpt-5', provider: 'openrouter', displayName: 'GPT-5 via OpenRouter' },
    { id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6' }
  ];
  /** A context whose catalog is per harness; records which harnesses were looked up. */
  function ctxWith(catalog: Partial<Record<string, { models: ModelInfo[]; error?: string }>>, settings = settingsWith()) {
    const lookups: string[] = [];
    const ctx: CapabilityContext = {
      settings,
      models: async (harness) => {
        lookups.push(harness);
        return catalog[harness] ?? { models: [] };
      }
    };
    return { ctx, lookups };
  }
  const configOf = async (args: Record<string, unknown>, ctx: CapabilityContext) => ((await create.request(args, ctx)) as { config: SessionConfig }).config;

  it('keeps today\'s behaviour when model is omitted: the configured per-harness default, without consulting the catalog', async () => {
    const settings = settingsWith({ defaultHarness: 'pi', defaultModelByHarness: { pi: { provider: 'openai', model: 'gpt-5' } } });
    const { ctx, lookups } = ctxWith({ pi: { models: PI_MODELS } }, settings);
    const cfg = await configOf({ project_root: 'G:/Vocs-Code' }, ctx);
    expect(cfg).toMatchObject({ harness: 'pi', model: { provider: 'openai', model: 'gpt-5' } });
    expect(lookups).toEqual([]);
  });

  it('leaves model unset when it is omitted and no default is configured, so the harness default applies', async () => {
    const { ctx } = ctxWith({ pi: { models: PI_MODELS } }, settingsWith({ defaultHarness: 'pi', defaultModelByHarness: {} }));
    const cfg = await configOf({ project_root: 'G:/Vocs-Code', harness: 'claude' }, ctx);
    expect(cfg.harness).toBe('claude');
    expect(cfg.model).toBeUndefined();
  });

  it('resolves a provider/model name against the chosen harness\'s catalog, not the default harness\'s', async () => {
    const settings = settingsWith({ defaultHarness: 'claude', defaultModelByHarness: { pi: { provider: 'openai', model: 'gpt-5' } } });
    const { ctx, lookups } = ctxWith({ pi: { models: PI_MODELS } }, settings);
    const cfg = await configOf({ project_root: 'G:/Vocs-Code', harness: 'pi', model: 'anthropic/claude-opus-5' }, ctx);
    expect(cfg.model).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(lookups).toEqual(['pi']);
  });

  it('accepts a bare id when exactly one provider offers it, and keeps an aggregator\'s slashed id whole', async () => {
    const { ctx } = ctxWith({ pi: { models: PI_MODELS } });
    await expect(resolveSessionModel('claude-opus-5', 'pi', ctx)).resolves.toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    await expect(resolveSessionModel('z-ai/glm-4.6', 'pi', ctx)).resolves.toEqual({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
    await expect(resolveSessionModel('openrouter/z-ai/glm-4.6', 'pi', ctx)).resolves.toEqual({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
  });

  it('refuses a bare id several providers offer, naming them', async () => {
    const { ctx } = ctxWith({ pi: { models: PI_MODELS } });
    await expect(resolveSessionModel('gpt-5', 'pi', ctx)).rejects.toThrow(/several providers.*openai\/gpt-5, openrouter\/gpt-5/);
  });

  it('refuses an unknown id and names the nearest catalog entries', async () => {
    const { ctx } = ctxWith({ pi: { models: PI_MODELS } });
    await expect(resolveSessionModel('anthropic/claude-opus', 'pi', ctx)).rejects.toThrow(/not a model the pi harness offers\. anthropic offers: anthropic\/claude-opus-5\./);
    await expect(resolveSessionModel('opus', 'pi', ctx)).rejects.toThrow(/Did you mean: anthropic\/claude-opus-5\./);
    await expect(resolveSessionModel('nothing-like-it', 'pi', ctx)).rejects.toThrow(/Available: anthropic\/claude-opus-5, openai\/gpt-5/);
  });

  it('refuses a model the chosen harness does not offer even when another harness does', async () => {
    const { ctx } = ctxWith({ pi: { models: PI_MODELS }, claude: { models: [PI_MODELS[0]] } });
    await expect(resolveSessionModel('openai/gpt-5', 'claude', ctx)).rejects.toThrow(/"openai\/gpt-5" is not a model the claude harness offers/);
  });

  it('refuses rather than guesses when the harness cannot list its models', async () => {
    const { ctx } = ctxWith({ pi: { models: [], error: 'pi is not installed.' } });
    await expect(resolveSessionModel('anthropic/claude-opus-5', 'pi', ctx)).rejects.toThrow(/pi harness lists no models.*\(pi is not installed\.\).*Omit model/);
  });

  it('refuses an unknown harness id before looking anything up', async () => {
    const { ctx, lookups } = ctxWith({});
    await expect(create.request({ project_root: 'G:/Vocs-Code', harness: 'gemini-cli', model: 'x' }, ctx)).rejects.toThrow(/Unknown harness "gemini-cli"\. Harness ids: pi, claude, codex/);
    expect(lookups).toEqual([]);
  });

  it('shows the requested model on the proposal card', () => {
    expect(create.summarize({ project_root: 'G:/Vocs-Code', model: 'anthropic/claude-opus-5' })).toBe('Create a session in G:/Vocs-Code on anthropic/claude-opus-5');
    expect(create.summarize({ project_root: 'G:/Vocs-Code' })).toBe('Create a session in G:/Vocs-Code');
  });

  it('lists the catalog lookup among the channels Vesta reaches', () => {
    expect(agentChannels()).toContain('harness:models');
  });

  /** The app's side: the catalog answers per harness and a create returns the new session. */
  function appInvoke(created: unknown[]) {
    return async (channel: string, req: unknown) => {
      if (channel === 'harness:models') return { models: (req as { harness: string }).harness === 'pi' ? PI_MODELS : [] };
      if (channel === 'sessions:create') {
        created.push(req);
        return { ...SESSION, id: 's2', title: 'New', config: (req as { config: SessionConfig }).config };
      }
      throw new Error(`unexpected channel ${channel}`);
    };
  }

  it('starts an approved session on the requested model', async () => {
    const created: unknown[] = [];
    const { agent, invoked, runtime } = makeAgent({ invoke: appInvoke(created), settings: settingsWith({ defaultHarness: 'claude' }) });
    await agent.send('start a pi session on opus');
    const target = call('create_session', { project_root: 'G:/Vocs-Code', harness: 'pi', model: 'anthropic/claude-opus-5', title: 'Opus' });
    runtime().step('', [target]);
    const id = await waitForProposal(agent);
    expect(invoked).toEqual([]);
    const pending = runtime().run(target);
    agent.resolveProposal(id, true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(invoked.map((i) => i.channel)).toEqual(['harness:models', 'sessions:create']);
    expect(created).toEqual([
      expect.objectContaining({ title: 'Opus', config: expect.objectContaining({ harness: 'pi', projectRoot: 'G:/Vocs-Code', model: { provider: 'anthropic', model: 'claude-opus-5' } }) })
    ]);
  });

  it('refuses the model when the catalog lookup itself fails, and never reaches sessions:create', async () => {
    const created: unknown[] = [];
    const { agent, invoked, runtime } = makeAgent({
      invoke: async (channel, req) => {
        if (channel === 'harness:models') throw new Error('codex CLI crashed');
        return appInvoke(created)(channel, req);
      }
    });
    await agent.send('start a codex session');
    const target = call('create_session', { project_root: 'G:/Vocs-Code', harness: 'codex', model: 'openai/gpt-5' });
    runtime().step('', [target]);
    const id = await waitForProposal(agent);
    const pending = runtime().run(target);
    agent.resolveProposal(id, true);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/codex harness lists no models.*\(codex CLI crashed\)/);
    expect(invoked.map((i) => i.channel)).toEqual(['harness:models']);
    expect(created).toEqual([]);
  });

  it('never reaches sessions:create with a model the harness does not offer, and tells the model why', async () => {
    const created: unknown[] = [];
    const { agent, invoked, runtime } = makeAgent({ invoke: appInvoke(created) });
    await agent.send('start a pi session on gpt-6');
    const target = call('create_session', { project_root: 'G:/Vocs-Code', harness: 'pi', model: 'openai/gpt-6' });
    runtime().step('', [target]);
    const id = await waitForProposal(agent);
    const pending = runtime().run(target);
    agent.resolveProposal(id, true);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/"openai\/gpt-6" is not a model the pi harness offers\. openai offers: openai\/gpt-5\./);
    expect(invoked.map((i) => i.channel)).toEqual(['harness:models']);
    expect(created).toEqual([]);
    const proposal = agent.state().items.find((i) => i.kind === 'proposal');
    expect(proposal?.kind === 'proposal' && proposal.proposal.status).toBe('failed');
  });
});

describe('pi is the only way in', () => {
  it('does not start pi until the first message', async () => {
    const { agent, runtime } = makeAgent();
    expect(agent.state().model).toBeUndefined();
    await agent.send('hi');
    expect(runtime().options().bin).toBe('C:/fake/pi.cmd');
  });

  it('sends the raw message and the refreshed app context as the system prompt', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('which branches are stale?', { sessionId: 's1', view: 'chat' });
    const [prompt] = runtime().promptCalls;
    expect(prompt.message).toBe('which branches are stale?');
    expect(prompt.systemPrompt).toContain('You are Vesta');
    expect(prompt.systemPrompt).toContain('id=s1 title="Vocs Code"');
  });

  it('says so instead of failing when pi is not installed', async () => {
    const { agent, invoked } = makeAgent({ pi: false });
    expect(agent.state().unavailable).toBeTruthy();
    await agent.send('do something');
    expect(invoked).toEqual([]);
    expect(agent.state().items.some((i) => i.kind === 'error')).toBe(true);
  });

  it('reports the model pi is answering with', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('hi');
    expect(agent.state().model).toBe(runtime().model);
  });
});

describe('pasted images', () => {
  const PNG: ImageAttachment = { mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'pixel.png' };

  it('sends an image with no text, showing it on the user row and in the prompt', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('', undefined, [PNG]);
    const user = agent.state().items.find((i) => i.kind === 'user');
    expect(user?.kind === 'user' && user.images).toEqual([PNG]);
    expect(runtime().promptCalls[0]).toMatchObject({ message: '', images: [PNG] });
  });

  it('sends an image alongside text', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('what is this?', { sessionId: 's1' }, [PNG]);
    expect(runtime().promptCalls[0]).toMatchObject({ message: 'what is this?', images: [PNG] });
  });

  it('ignores an empty message with no images, and does not start pi', async () => {
    const { agent, runtimeCount } = makeAgent();
    await agent.send('   ');
    expect(agent.state().items).toEqual([]);
    expect(runtimeCount()).toBe(0);
  });
});

describe('gating', () => {
  it('runs a read capability without asking', async () => {
    const { agent, invoked, runtime } = makeAgent({ invoke: async () => [SESSION] });
    await agent.send('what sessions do I have?');
    const outcome = await runtime().run(call('list_sessions', {}));
    expect(outcome.ok).toBe(true);
    expect(invoked.map((i) => i.channel)).toEqual(['sessions:list']);
    expect(agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);
    runtime().step('You have one session.', []);
    runtime().settled();
    expect(agent.state().items.some((i) => i.kind === 'assistant' && i.text.includes('one session'))).toBe(true);
    expect(agent.state().busy).toBe(false);
  });

  it('does not invoke a destructive capability until the user approves', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete the old branch');
    const target = call('delete_branch', { session_id: 's1', branch: 'old' });
    runtime().step('', [target]);
    const id = await waitForProposal(agent);
    expect(invoked).toEqual([]);
    const pending = runtime().run(target);
    agent.resolveProposal(id, true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(invoked).toEqual([{ channel: 'git:deleteBranch', req: { sessionId: 's1', branch: 'old', force: false } }]);
  });

  it('invokes nothing when the user declines, and tells the model so', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete the old branch');
    const target = call('delete_branch', { session_id: 's1', branch: 'old' });
    runtime().step('', [target]);
    const id = await waitForProposal(agent);
    const pending = runtime().run(target);
    agent.resolveProposal(id, false);
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(invoked).toEqual([]);
    const proposal = agent.state().items.find((i) => i.kind === 'proposal');
    expect(proposal?.kind === 'proposal' && proposal.proposal.status).toBe('rejected');
  });

  it('groups one step\'s changes into a single proposal listing every target', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('clean up branches older than a day');
    const calls = ['a', 'b', 'c'].map((branch, i) => call('delete_branch', { session_id: 's1', branch }, `c${i}`));
    runtime().step('', calls);
    const id = await waitForProposal(agent);
    const proposals = agent.state().items.filter((i) => i.kind === 'proposal');
    expect(proposals).toHaveLength(1);
    const only = proposals[0];
    expect(only.kind === 'proposal' && only.proposal.actions.map((a) => a.summary)).toEqual(['Delete branch a', 'Delete branch b', 'Delete branch c']);
    const pending = calls.map((c) => runtime().run(c));
    agent.resolveProposal(id, true);
    await expect(Promise.all(pending)).resolves.toHaveLength(3);
    expect(invoked).toHaveLength(3);
    const resolved = agent.state().items.find((i) => i.kind === 'proposal');
    expect(resolved?.kind === 'proposal' && resolved.proposal.results).toEqual(['Done', 'Done', 'Done']);
  });

  it('gates a stdio probe but not an http one', async () => {
    const http = makeAgent({ invoke: async () => ({ ok: true, tools: [], durationMs: 1 }) });
    await http.agent.send('set up https://example.com/mcp');
    const httpCall = call('probe_mcp_server', { server: { id: 'x', transport: 'http', url: 'https://example.com/mcp' } }, 'h1');
    http.runtime().step('', [httpCall]);
    await http.runtime().run(httpCall);
    expect(http.invoked.map((i) => i.channel)).toEqual(['mcp:inspect']);
    expect(http.agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);

    const stdio = makeAgent({ invoke: async () => ({ ok: true, tools: [], durationMs: 1 }) });
    await stdio.agent.send('set up the pkg server');
    const stdioCall = call('probe_mcp_server', { server: { id: 'y', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] } }, 's1');
    stdio.runtime().step('', [stdioCall]);
    const id = await waitForProposal(stdio.agent);
    const pending = stdio.runtime().run(stdioCall);
    expect(stdio.invoked).toEqual([]);
    stdio.agent.resolveProposal(id, true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(stdio.invoked.map((i) => i.channel)).toEqual(['mcp:inspect']);
  });

  it('refuses an oversized batch without showing a proposal or invoking anything', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete every branch');
    const calls = Array.from({ length: 26 }, (_, i) => call('delete_branch', { session_id: 's1', branch: `b${i}` }, `c${i}`));
    runtime().step('', calls);
    expect(agent.state().items.some((i) => i.kind === 'proposal')).toBe(false);
    const outcomes = await Promise.all(calls.map((c) => runtime().run(c)));
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(invoked).toEqual([]);
  });

  it('cancels the waiting proposal and stops pi when the user hits Stop', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('delete the old branch');
    const target = call('delete_branch', { session_id: 's1', branch: 'old' });
    runtime().step('', [target]);
    await waitForProposal(agent);
    const pending = runtime().run(target);
    agent.cancel();
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(invoked).toEqual([]);
    expect(runtime().aborts).toBe(1);
    expect(agent.state().busy).toBe(false);
    const proposal = agent.state().items.find((i) => i.kind === 'proposal');
    expect(proposal?.kind === 'proposal' && proposal.proposal.status).toBe('cancelled');
  });
});

describe('robustness', () => {
  it('refuses a tool that is not on the allowlist instead of dispatching it', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('open a terminal and wipe the disk');
    const outcome = await runtime().run(call('terminal:input', { terminalId: 't1', data: 'rm -rf /\n' }));
    expect(outcome.ok).toBe(false);
    expect(invoked).toEqual([]);
  });

  it('survives a model that answers in prose instead of calling a tool', async () => {
    const { agent, invoked, runtime } = makeAgent();
    await agent.send('set up an mcp server');
    runtime().step('I think you should add it manually.', []);
    runtime().settled();
    expect(invoked).toEqual([]);
    expect(agent.state().busy).toBe(false);
    expect(agent.state().items.some((i) => i.kind === 'error')).toBe(false);
  });

  it('reports a failed capability without retrying it', async () => {
    const { agent, invoked, runtime } = makeAgent({
      invoke: async () => {
        throw new Error('not a git repository');
      }
    });
    await agent.send('list branches');
    await runtime().run(call('list_branches', { session_id: 's1' }));
    expect(invoked).toHaveLength(1);
    const tool = agent.state().items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.ok).toBe(false);
  });

  it('reports a turn that ended in an error', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('do something');
    runtime().settled('rate limit exceeded');
    expect(agent.state().busy).toBe(false);
    expect(agent.state().items.some((i) => i.kind === 'error' && i.text.includes('rate limit'))).toBe(true);
  });

  it('clears the conversation and disposes the runtime on reset', async () => {
    const { agent, runtime } = makeAgent();
    await agent.send('hi');
    runtime().step('hello', []);
    expect(agent.state().items.length).toBeGreaterThan(0);
    agent.reset();
    expect(agent.state().items).toEqual([]);
    expect(runtime().disposed).toBe(true);
  });
});

describe('remote transport', () => {
  it('keeps Vesta off the WebSocket bridge, which has no other channel allowlist', () => {
    expect(isRemoteBlocked('agent:send')).toBe(true);
    expect(isRemoteBlocked('agent:resolve')).toBe(true);
    expect(isRemoteBlocked('sessions:list')).toBe(false);
  });
});
