/**
 * Offline tests for the Vocs Code subagents extension, driven with a scripted child session.
 *
 * These are execution-level tests for the security-critical path: a child tool call is decided by
 * the shared gate, asks through the parent's UI, and a denial blocks execution. They also pin the
 * run-record writes, the live event protocol the desktop app parses, and the lifecycle rules
 * (caps, stop, shutdown).
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVocsCodeSubagents, type SubagentDeps } from '../resources/pi/vocs-code-subagents';
import { GRANT_EVENT, PLAN_REASON } from '../resources/pi/subagent-gate';
import { parseRunFile } from '../src/shared/subagents';

const tempDirs: string[] = [];
const envKeys = ['VOCS_CODE_MODE_FILE', 'VOCS_CODE_PERMISSION_MODE', 'VOCS_CODE_SUBAGENT_DIR', 'VOCS_CODE_SUBAGENT_COMPLETION_MS', 'VOCS_CODE_PI_NONCE', 'VOCS_CODE_PROJECT_ROOT', 'PI_CODING_AGENT_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of envKeys) savedEnv[key] = process.env[key];
  // This suite runs the extension in-process, and a developer's shell inherits the pi session's own
  // Vocs Code variables. Left alone, a fake run would be written into the live session's run
  // directory and show up in the Subagents panel as real work. Only the test that asserts persistence
  // sets Vocs Code's variables, and it sets them to a temp directory.
  for (const key of ['VOCS_CODE_SUBAGENT_DIR', 'VOCS_CODE_PROJECT_ROOT', 'VOCS_CODE_MODE_FILE'] as const) delete process.env[key];
});
afterEach(async () => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagent-ext-'));
  tempDirs.push(dir);
  return dir;
}

class FakeBus {
  private handlers = new Map<string, ((payload: unknown) => void)[]>();
  on(channel: string, handler: (payload: unknown) => void): void {
    this.handlers.set(channel, [...(this.handlers.get(channel) ?? []), handler]);
  }
  emit(channel: string, payload: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

interface FakeChild {
  listeners: ((event: Record<string, unknown>) => void)[];
  messages: Record<string, unknown>[];
  prompts: string[];
  steers: string[];
  aborted: boolean;
  disposed: boolean;
  driver: ((child: FakeChild) => Promise<void>) | null;
  /** Resolves a never-finishing driver when the run is aborted, the way a real abort ends prompt(). */
  abortHook: (() => void) | null;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  emit(event: Record<string, unknown>): void;
  readonly modelRuntime: { registerProvider(id: string, config: unknown): void };
}

interface HarnessOptions {
  mode?: string;
  childDriver?: (child: FakeChild) => Promise<void>;
  select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
  cwd?: string;
}

function harness(options: HarnessOptions = {}) {
  process.env.VOCS_CODE_PERMISSION_MODE = options.mode ?? 'ask';
  delete process.env.VOCS_CODE_MODE_FILE;
  process.env.VOCS_CODE_SUBAGENT_COMPLETION_MS = '5';
  // Point at an empty agent dir so the suite never reads the developer's own pi-subagents
  // settings (a real `maxConcurrent` there would silently change the caps under test).
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'vocs-subagent-agent-'));
  tempDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const tools = new Map<string, Record<string, any>>();
  const commands = new Map<string, Record<string, any>>();
  const parentHandlers = new Map<string, ((event: Record<string, unknown>, ctx: unknown) => unknown)[]>();
  const bus = new FakeBus();
  const sent: { message: Record<string, any>; options?: Record<string, any> }[] = [];
  const notifies: string[] = [];
  const select = vi.fn(options.select ?? (async () => 'Allow once'));
  const ui = { select, notify: (message: string) => notifies.push(message) };
  const parentCtx = { ui, cwd: options.cwd ?? process.cwd(), model: { provider: 'anthropic', id: 'claude-sonnet-4-5' }, thinkingLevel: 'medium', getSystemPrompt: () => 'PARENT PROMPT', modelRegistry: { find: (provider: string, model: string) => (provider === 'ghost' ? undefined : { provider, id: model }) } };
  const pi = {
    registerTool: (definition: Record<string, any>) => tools.set(definition.name, definition),
    registerCommand: (name: string, def: Record<string, any>) => commands.set(name, def),
    on: (event: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) => parentHandlers.set(event, [...(parentHandlers.get(event) ?? []), handler]),
    sendMessage: (message: Record<string, any>, sendOptions?: Record<string, any>) => sent.push({ message, options: sendOptions }),
    events: bus,
  };

  const children: FakeChild[] = [];
  const loaderOptions: Record<string, unknown>[] = [];
  const sessionOptions: Record<string, unknown>[] = [];

  class FakeResourceLoader {
    constructor(public readonly options: Record<string, unknown>) {
      loaderOptions.push(options);
    }
    async reload(): Promise<void> {}
  }

  const deps: SubagentDeps = {
    Type: {
      Object: (fields) => fields,
      String: (o) => o,
      Optional: (v) => v,
      Boolean: (o) => o,
    },
    DefaultResourceLoader: FakeResourceLoader as unknown as SubagentDeps['DefaultResourceLoader'],
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (opts) => {
      sessionOptions.push(opts);
      const child: FakeChild = {
        listeners: [],
        messages: [],
        prompts: [],
        steers: [],
        aborted: false,
        disposed: false,
        driver: options.childDriver ?? null,
        abortHook: null,
        subscribe(listener) {
          this.listeners.push(listener);
          return () => undefined;
        },
        async prompt(text) {
          this.prompts.push(text);
          this.emit({ type: 'message_start', message: { role: 'assistant' } });
          if (this.driver) await this.driver(this);
          this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'DONE' }], stopReason: 'stop' });
          this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }], stopReason: 'stop', model: 'claude-sonnet-4-5', provider: 'anthropic', usage: { input: 100, output: 20, cost: { total: 0.05 } } } });
        },
        async steer(text) {
          this.steers.push(text);
        },
        async abort() {
          this.aborted = true;
          this.abortHook?.();
        },
        dispose() {
          this.disposed = true;
        },
        emit(event) {
          for (const listener of this.listeners) listener(event);
        },
        modelRuntime: { registerProvider: () => undefined },
      };
      children.push(child);
      return { session: child as never };
    },
  };

  const fire = async (event: string, payload: Record<string, unknown> = {}, ctx: unknown = parentCtx): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of parentHandlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  };

  return { pi, deps, tools, commands, bus, sent, notifies, select, parentCtx, children, loaderOptions, sessionOptions, fire };
}

/** Only this extension's own notifications, parsed. */
function eventsOf(h: { notifies: string[] }): Record<string, any>[] {
  return h.notifies.filter((n) => n.startsWith('VCODE_SUBAGENT::')).map((n) => JSON.parse(n.replace('VCODE_SUBAGENT::', '')) as Record<string, any>);
}

/** A driver that never finishes until the run is aborted, the way a real abort ends prompt(). */
const neverFinishes = (child: { abortHook: (() => void) | null }) => new Promise<void>((resolve) => {
  child.abortHook = resolve;
});

/** The tool_call handler the extension installed inside a child session. */
function childGate(loader: Record<string, unknown>): (event: Record<string, unknown>) => Promise<unknown> {
  const factories = loader.extensionFactories as ((childPi: unknown) => void)[];
  const handlers: ((event: Record<string, unknown>) => Promise<unknown>)[] = [];
  factories[0]!({
    on: (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      if (event === 'tool_call') handlers.push(handler);
    },
  });
  return handlers[0]!;
}

const subagentCall = { description: 'Find the registry', prompt: 'Where is the harness registry?', type: 'Explore' };

describe('suite hygiene', () => {
  it('never inherits the developer own Vocs Code run directory', () => {
    // The extension reads VOCS_CODE_SUBAGENT_DIR when it is constructed, so an inherited value would
    // write this suite's fake runs into the live session's Subagents panel.
    expect(process.env.VOCS_CODE_SUBAGENT_DIR).toBeUndefined();
    expect(process.env.VOCS_CODE_PROJECT_ROOT).toBeUndefined();
  });
});

describe('registration', () => {
  it('registers the three tools and points the model at them', async () => {
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    expect([...h.tools.keys()]).toEqual(['subagent', 'subagent_result', 'subagent_steer']);
    const subagent = h.tools.get('subagent')!;
    expect(subagent.description).toContain('Explore');
    expect(subagent.description).toContain('Plan');
    expect(subagent.promptGuidelines.join(' ')).toContain('subagent_result');
    expect(subagent.promptGuidelines.join(' ')).toMatch(/prefer it over any other delegation tool/i);
  });

  it('advertises project agent files after session_start and reports readiness', async () => {
    const dir = await tempDir();
    process.env.PI_CODING_AGENT_DIR = path.join(dir, 'agentdir');
    await fs.mkdir(path.join(dir, 'repo', '.pi', 'agents'), { recursive: true });
    await fs.writeFile(path.join(dir, 'repo', '.pi', 'agents', 'verifier.md'), '---\nname: verifier\ndescription: Runs the verification bar\n---\nVerify things.', 'utf8');
    const h = harness({ cwd: path.join(dir, 'repo') });
    await createVocsCodeSubagents(h.pi as never, h.deps);
    await h.fire('session_start', { reason: 'startup' });
    await vi.waitFor(() => expect(h.tools.get('subagent')!.description).toContain('verifier'));
    expect(h.notifies.some((n) => n.includes('VCODE_PI_READY::') && n.includes('"capability":"subagents"') && n.includes('"ready":true'))).toBe(true);
  });
});

describe('foreground runs', () => {
  it('runs a child, reports usage, returns its output and writes the run record', async () => {
    const dir = await tempDir();
    process.env.VOCS_CODE_SUBAGENT_DIR = path.join(dir, 'subagents');
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const result = (await h.tools.get('subagent')!.execute('call_1', subagentCall, undefined, undefined, h.parentCtx)) as { content: { text: string }[]; details: Record<string, unknown> };
    expect(result.content[0]!.text).toContain('DONE');
    expect(result.content[0]!.text).toContain('Explore completed');
    expect(result.details).toMatchObject({ agent: 'Explore', status: 'completed', turns: 1, costUsd: 0.05 });

    const events = eventsOf(h);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['start', 'call', 'end']));
    expect(events.find((e) => e.kind === 'call')!.call).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsd: 0.05 });

    const runId = result.details.runId as string;
    const file = path.join(dir, 'subagents', `${runId}.jsonl`);
    const parsed = parseRunFile(await fs.readFile(file, 'utf8'))!;
    expect(parsed.meta).toMatchObject({ agent: 'Explore', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(parsed.status).toBe('completed');
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.totals).toMatchObject({ turns: 1, inputTokens: 100, costUsd: 0.05 });
  });

  it('builds the child session with the agent allowlist, no discovery, and no subagent tools', async () => {
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    await h.tools.get('subagent')!.execute('call_1', subagentCall, undefined, undefined, h.parentCtx);
    const loader = h.loaderOptions[0]!;
    expect(loader.noExtensions).toBe(true);
    expect(loader.noSkills).toBe(true);
    expect(loader.noPromptTemplates).toBe(true);
    expect((loader.systemPromptOverride as () => string)()).toBeTypeOf('string');
    expect((loader.systemPromptOverride as () => string)()).not.toContain('PARENT PROMPT'); // Explore replaces
    const opts = h.sessionOptions[0]!;
    expect(opts.tools).toEqual(['read', 'grep', 'find', 'ls', 'bash']);
    expect(opts.excludeTools).toEqual(expect.arrayContaining(['subagent', 'Agent', 'SubagentWorkflow', 'steer_subagent']));
    expect(opts.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' });
  });

  it('keeps the parent prompt for append-mode agents', async () => {
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    await h.tools.get('subagent')!.execute('call_1', { ...subagentCall, type: 'general-purpose' }, undefined, undefined, h.parentCtx);
    expect((h.loaderOptions[0]!.systemPromptOverride as () => string)()).toContain('PARENT PROMPT');
  });

  it('rejects an unknown agent type with the available names', async () => {
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    await expect(h.tools.get('subagent')!.execute('call_1', { ...subagentCall, type: 'nope' }, undefined, undefined, h.parentCtx)).rejects.toThrow(/Unknown subagent type "nope".*Explore/s);
  });

  it('rejects an unavailable pinned model', async () => {
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    await expect(h.tools.get('subagent')!.execute('call_1', { ...subagentCall, model: 'ghost/model' }, undefined, undefined, h.parentCtx)).rejects.toThrow(/not available/i);
  });
});

describe('caps', () => {
  it('refuses a fifth background run and an eleventh run overall', async () => {
    const h = harness({ childDriver: neverFinishes }); // never finishes
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const spawn = (background: boolean) => h.tools.get('subagent')!.execute('c', { ...subagentCall, background }, undefined, undefined, h.parentCtx);
    for (let i = 0; i < 4; i++) await spawn(true);
    await expect(spawn(true)).rejects.toThrow(/4 background subagent runs/);
    for (let i = 0; i < 4; i++) void spawn(false); // foreground is uncapped, up to the session cap
    await expect(spawn(false)).rejects.toThrow(/8 active subagent runs/);
  });

  it('follows the configured maxConcurrent rather than a fixed cap', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'subagents.json'), JSON.stringify({ maxConcurrent: 3 }), 'utf8');
    const h = harness({ childDriver: neverFinishes });
    process.env.PI_CODING_AGENT_DIR = dir;
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const spawn = (background: boolean) => h.tools.get('subagent')!.execute('c', { ...subagentCall, background }, undefined, undefined, h.parentCtx);
    for (let i = 0; i < 3; i++) await spawn(true);
    await expect(spawn(true)).rejects.toThrow(/3 active subagent runs per session/);
  });

  it('caps foreground runs at maxConcurrentForeground when it is set', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'subagents.json'), JSON.stringify({ maxConcurrent: 20, maxConcurrentForeground: 2 }), 'utf8');
    const h = harness({ childDriver: neverFinishes });
    process.env.PI_CODING_AGENT_DIR = dir;
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const spawn = (background: boolean) => h.tools.get('subagent')!.execute('c', { ...subagentCall, background }, undefined, undefined, h.parentCtx);
    void spawn(false);
    void spawn(false);
    await vi.waitFor(() => expect(h.children).toHaveLength(2));
    await expect(spawn(false)).rejects.toThrow(/2 foreground subagent runs/);
  });
});

describe('permission gate in a child', () => {
  async function gateFor(mode: string, select?: HarnessOptions['select']) {
    const h = harness({ mode, select });
    await createVocsCodeSubagents(h.pi as never, h.deps);
    void h.tools.get('subagent')!.execute('call_1', { ...subagentCall, background: true }, undefined, undefined, h.parentCtx);
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    return { h, gate: childGate(h.loaderOptions[0]!) };
  }

  it('never asks in full-auto', async () => {
    const { h, gate } = await gateFor('full-auto');
    await expect(gate({ toolName: 'bash', toolCallId: 't1', input: { command: 'rm -rf /' } })).resolves.toBeUndefined();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('asks the parent UI in ask mode, naming the run and the agent', async () => {
    const { h, gate } = await gateFor('ask');
    await gate({ toolName: 'bash', toolCallId: 't1', input: { command: 'echo hi' } });
    expect(h.select).toHaveBeenCalledTimes(1);
    const title = h.select.mock.calls[0]![0] as string;
    expect(title.startsWith('VCODE_APPROVAL::')).toBe(true);
    const payload = JSON.parse(title.replace('VCODE_APPROVAL::', '')) as Record<string, unknown>;
    expect(payload).toMatchObject({ tool: 'bash', agent: 'Explore' });
    expect(String(payload.runId)).toMatch(/^agent_/);
  });

  it('denies execution when the parent declines', async () => {
    const execute = vi.fn();
    const { gate } = await gateFor('ask', async () => 'Deny');
    const result = (await gate({ toolName: 'bash', toolCallId: 't1', input: { command: 'npm publish' } })) as { block?: boolean } | undefined;
    if (!result?.block) execute();
    expect(result?.block).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps asking for a dangerous command after a session grant for the same tool', async () => {
    const { h, gate } = await gateFor('ask', async () => 'Allow for session');
    await expect(gate({ toolName: 'bash', toolCallId: 't1', input: { command: 'echo safe' } })).resolves.toBeUndefined();
    const dangerous = (await gate({ toolName: 'bash', toolCallId: 't2', input: { command: 'git push --force origin main' } })) as { block?: boolean } | undefined;
    expect(dangerous?.block ?? false).toBe(false);
    expect(h.select).toHaveBeenCalledTimes(2); // the grant did not cover it
  });

  it('honors a grant made by the parent extension on the shared bus', async () => {
    const { h, gate } = await gateFor('ask');
    h.bus.emit(GRANT_EVENT, { tool: 'write' });
    await expect(gate({ toolName: 'write', toolCallId: 't1', input: { path: 'src/a.ts' } })).resolves.toBeUndefined();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('blocks shell and edits outright in plan mode', async () => {
    const { gate } = await gateFor('plan');
    await expect(gate({ toolName: 'bash', toolCallId: 't1', input: { command: 'echo hi' } })).resolves.toMatchObject({ block: true, reason: PLAN_REASON });
  });

  it('asks for an edit outside the workspace even in accept-edits', async () => {
    const { h, gate } = await gateFor('accept-edits');
    await expect(gate({ toolName: 'edit', toolCallId: 't1', input: { path: 'src/a.ts' } })).resolves.toBeUndefined();
    const outside = (await gate({ toolName: 'write', toolCallId: 't2', input: { path: '../escape.txt' } })) as { block?: boolean } | undefined;
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(outside?.block ?? false).toBe(false); // Allow once from the default select
  });

  it('fails closed when no approval UI is attached at all', async () => {
    const h = harness({ mode: 'ask' });
    h.parentCtx.ui = undefined as never;
    await createVocsCodeSubagents(h.pi as never, h.deps);
    void h.tools.get('subagent')!.execute('call_1', { ...subagentCall, background: true }, undefined, undefined, h.parentCtx);
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    const gate = childGate(h.loaderOptions[0]!);
    await expect(gate({ toolName: 'bash', toolCallId: 't1', input: { command: 'echo hi' } })).resolves.toMatchObject({ block: true });
  });
});

describe('background runs and lifecycle', () => {
  it('returns immediately with an id and wakes the parent once when it finishes', async () => {
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const started = (await h.tools.get('subagent')!.execute('call_1', { ...subagentCall, background: true }, undefined, undefined, h.parentCtx)) as { content: { text: string }[]; details: Record<string, unknown> };
    expect(started.content[0]!.text).toContain(String(started.details.runId));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.message.customType).toBe('vocs-code-subagent-done');
    expect(h.sent[0]!.message.content).toContain(String(started.details.runId));
    expect(h.sent[0]!.options).toMatchObject({ deliverAs: 'followUp', triggerTurn: true });
  });

  it('lists runs and returns one by id through subagent_result', async () => {
    const h = harness();
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const run = (await h.tools.get('subagent')!.execute('call_1', subagentCall, undefined, undefined, h.parentCtx)) as { details: Record<string, unknown> };
    const list = (await h.tools.get('subagent_result')!.execute('call_2', {}, undefined, undefined, h.parentCtx)) as { content: { text: string }[] };
    expect(list.content[0]!.text).toContain(String(run.details.runId));
    const one = (await h.tools.get('subagent_result')!.execute('call_3', { runId: run.details.runId }, undefined, undefined, h.parentCtx)) as { content: { text: string }[] };
    expect(one.content[0]!.text).toContain('DONE');
    await expect(h.tools.get('subagent_result')!.execute('call_4', { runId: 'agent_missing' }, undefined, undefined, h.parentCtx)).rejects.toThrow(/No subagent run/);
  });

  it('steers a running run and refuses a finished one', async () => {
    const h = harness({ childDriver: async (child) => new Promise<void>((resolve) => setTimeout(resolve, 30)) });
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const started = (await h.tools.get('subagent')!.execute('call_1', { ...subagentCall, background: true }, undefined, undefined, h.parentCtx)) as { details: Record<string, unknown> };
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    await h.tools.get('subagent_steer')!.execute('call_2', { runId: started.details.runId as string, message: 'x' }, undefined, undefined, h.parentCtx);
    expect(h.children[0]!.steers).toEqual(['x']);
    await vi.waitFor(() => expect(h.children[0]!.disposed).toBe(true));
    await expect(h.tools.get('subagent_steer')!.execute('call_3', { runId: started.details.runId as string, message: 'x' }, undefined, undefined, h.parentCtx)).rejects.toThrow(/not running/);
  });

  it('marks a running run interrupted and aborts children when the parent aborts', async () => {
    const h = harness({ childDriver: neverFinishes });
    await createVocsCodeSubagents(h.pi as never, h.deps);
    void h.tools.get('subagent')!.execute('call_1', { ...subagentCall, background: true }, undefined, undefined, h.parentCtx);
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    await h.fire('message_end', { message: { role: 'assistant', stopReason: 'aborted' } });
    await vi.waitFor(() => expect(h.children[0]!.aborted).toBe(true));
  });

  it('stops a run and marks it stopped through the command path', async () => {
    const h = harness({ childDriver: neverFinishes });
    await createVocsCodeSubagents(h.pi as never, h.deps);
    const started = (await h.tools.get('subagent')!.execute('call_1', { ...subagentCall, background: true }, undefined, undefined, h.parentCtx)) as { details: Record<string, unknown> };
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    await h.commands.get('vocs-subagent-stop')!.handler(String(started.details.runId));
    await vi.waitFor(() => expect(h.children[0]!.aborted).toBe(true));
    await vi.waitFor(() => expect(eventsOf(h).some((e) => e.kind === 'end' && e.status === 'stopped')).toBe(true));
  });

  it('settles unfinished runs as interrupted on session shutdown', async () => {
    const h = harness({ childDriver: neverFinishes });
    await createVocsCodeSubagents(h.pi as never, h.deps);
    void h.tools.get('subagent')!.execute('call_1', { ...subagentCall, background: true }, undefined, undefined, h.parentCtx);
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    await h.fire('session_shutdown', { reason: 'quit' });
    await vi.waitFor(() => expect(eventsOf(h).some((e) => e.kind === 'end' && e.status === 'interrupted')).toBe(true));
  });
});
