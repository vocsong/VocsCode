import { describe, expect, it, vi } from 'vitest';
import type { HarnessContext } from '../src/main/harness/types';
import { PiAdapter } from '../src/main/harness/pi';
import type { SessionEvent, SessionMeta } from '../src/shared/types';
import { deferred } from '../src/main/util/async';
import { emptyUsage } from '../src/main/models/static-models';

vi.mock('../src/main/harness/spawn', async (original) => ({
  ...await original<typeof import('../src/main/harness/spawn')>(),
  shutdownChild: vi.fn(async () => {}),
}));

function fixture() {
  const events: SessionEvent[] = [];
  const requests: { type: string; extra: Record<string, unknown> }[] = [];
  const aborts: ReturnType<typeof deferred>[] = [];
  const meta = { config: { harness: 'pi', permissionMode: 'ask' }, usage: emptyUsage(), cwd: '.', harnessRef: {} } as SessionMeta;
  const ctx = {
    session: () => meta, permissionMode: () => 'ask', emit: (event: SessionEvent) => events.push(event),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch), updateRef: () => {}, log: () => {},
    requestApproval: vi.fn(async () => ({ optionId: 'deny' })),
  } as unknown as HarnessContext;
  const adapter = new PiAdapter(ctx);
  const privateAdapter = adapter as unknown as {
    child: unknown; extensionCapabilities: Set<string>; inputDispatch: Promise<void>;
    request(type: string, extra?: Record<string, unknown>): Promise<unknown>;
    handleLine(line: string): void;
  };
  const writes: string[] = [];
  privateAdapter.child = { stdin: { writable: true, write: (line: string) => writes.push(line) } };
  privateAdapter.extensionCapabilities = new Set(['approvals', 'tools', 'subagents']);
  privateAdapter.request = async (type, extra = {}) => {
    requests.push({ type, extra });
    if (type === 'abort') {
      const result = deferred();
      aborts.push(result);
      return result.promise;
    }
    return {};
  };
  const feed = (event: Record<string, unknown>) => privateAdapter.handleLine(JSON.stringify(event));
  const finish = async (stopReason = 'stop') => {
    feed({ type: 'message_end', message: { role: 'assistant', stopReason, content: [] } });
    feed({ type: 'agent_end' });
    feed({ type: 'agent_settled' });
    await tick();
  };
  return { adapter, ctx, events, requests, aborts, feed, finish, meta, privateAdapter, writes };
}
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const terminal = (events: SessionEvent[]) => events.filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn');

describe('Pi interrupting steering', () => {
  it('waits for cancellation before admitting the directive, without putting it in Pi’s cancelled queue', async () => {
    const f = fixture();
    await f.adapter.send({ text: 'old work' });
    const steering = f.adapter.send({ text: 'new direction', mode: 'steer' });
    await tick();
    expect(f.requests.map((request) => request.type)).toEqual(['prompt', 'abort']);
    expect(f.adapter.busy).toBe(true);
    await f.finish('aborted');
    f.aborts[0].resolve(undefined);
    await steering;
    expect(f.requests.filter((request) => request.type === 'prompt').map((request) => request.extra.message)).toEqual(['old work', 'new direction']);
    expect(f.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
    await f.finish();
    expect(terminal(f.events).map((event) => event.type === 'item.upsert' && event.item.kind === 'turn' && event.item.status)).toEqual(['interrupted', 'completed']);
    expect(f.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(1);
  });

  it('keeps Queue non-interrupting and preserves its image behind rapid steering inputs', async () => {
    const f = fixture();
    await f.adapter.send({ text: 'old work' });
    const image = { name: 'a.png', mimeType: 'image/png', data: 'aW1hZ2U=' };
    await f.adapter.send({ text: 'later', mode: 'queue', images: [image] });
    expect(f.requests.map((request) => request.type)).toEqual(['prompt']);
    expect(f.meta.queued).toBe(1);
    const first = f.adapter.send({ text: 'first steer', mode: 'steer' });
    const second = f.adapter.send({ text: 'second steer', mode: 'steer' });
    await tick();
    expect(f.aborts).toHaveLength(1);
    await f.finish('aborted');
    f.aborts[0].resolve(undefined);
    await first;
    await tick();
    expect(f.aborts).toHaveLength(2);
    await f.finish('aborted');
    f.aborts[1].resolve(undefined);
    await second;
    await f.finish();
    await tick();
    const prompts = f.requests.filter((request) => request.type === 'prompt');
    expect(prompts.map((request) => request.extra.message)).toEqual(['old work', 'first steer', 'second steer', 'later']);
    expect(prompts.at(-1)?.extra.images).toEqual([{ type: 'image', data: image.data, mimeType: image.mimeType }]);
    await f.finish();
    expect(f.meta.queued).toBe(0);
    expect(f.adapter.busy).toBe(false);
    expect(terminal(f.events)).toHaveLength(4);
    expect(f.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(1);
  });

  it('does not finish on an intermediate agent_end or duplicate settled events', async () => {
    const f = fixture();
    await f.adapter.send({ text: 'work' });
    f.feed({ type: 'agent_end' });
    await tick();
    expect(f.adapter.busy).toBe(true);
    expect(terminal(f.events)).toHaveLength(0);
    f.feed({ type: 'agent_settled' });
    f.feed({ type: 'agent_settled' });
    await tick();
    expect(terminal(f.events)).toHaveLength(1);
    expect(f.adapter.busy).toBe(false);
  });

  it('does not submit a directive when cancellation fails', async () => {
    const f = fixture();
    await f.adapter.send({ text: 'old work' });
    const steering = f.adapter.send({ text: 'must not run', mode: 'steer' });
    const failure = expect(steering).rejects.toThrow('cannot cancel');
    await tick();
    f.aborts[0].reject(new Error('cannot cancel'));
    await failure;
    expect(f.requests.filter((request) => request.type === 'prompt')).toHaveLength(1);
    expect(f.adapter.busy).toBe(true);
  });

  it('denies late old-run dialogs while steering waits for cancellation', async () => {
    const f = fixture();
    await f.adapter.send({ text: 'old work' });
    const steering = f.adapter.send({ text: 'new direction', mode: 'steer' });
    await tick();
    f.feed({ type: 'extension_ui_request', id: 'late-approval', method: 'select', title: 'VCODE_APPROVAL::{"tool":"bash","input":{"command":"protected"}}' });
    await tick();
    expect(f.ctx.requestApproval).not.toHaveBeenCalled();
    expect(f.writes.map((line) => JSON.parse(line))).toEqual([{ type: 'extension_ui_response', id: 'late-approval', cancelled: true }]);
    await f.finish('aborted');
    f.aborts[0].resolve(undefined);
    await steering;
    f.feed({ type: 'extension_ui_request', id: 'fresh-approval', method: 'confirm', title: 'Fresh work' });
    await tick();
    expect(f.ctx.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not let delayed old stats complete or reset an extension-started run', async () => {
    const f = fixture();
    const stats = deferred();
    const request = f.privateAdapter.request;
    let firstStats = true;
    f.privateAdapter.request = (type, extra) => {
      if (type === 'get_session_stats') {
        if (firstStats) { firstStats = false; return stats.promise; }
        return Promise.resolve({ tokens: { input: 17, output: 3 } });
      }
      return request(type, extra);
    };
    await f.adapter.send({ text: 'first run' });
    f.feed({ type: 'message_update', usage: { input: 10, output: 0 }, assistantMessageEvent: { type: 'text_delta', delta: 'old run' } });
    f.feed({ type: 'agent_settled' });
    f.feed({ type: 'agent_start' });
    f.feed({ type: 'message_start', message: { role: 'assistant' } });
    f.feed({ type: 'message_update', usage: { input: 7, output: 3 }, assistantMessageEvent: { type: 'text_delta', delta: 'new run' } });
    expect(terminal(f.events)).toHaveLength(0);
    // A slow cumulative snapshot may already contain the newer run's deferred usage.
    stats.resolve({ tokens: { input: 17, output: 3 } });
    await tick();
    expect(terminal(f.events)).toHaveLength(1);
    expect(terminal(f.events)[0]).toMatchObject({ item: { usage: { inputTokens: 10 } } });
    expect(f.adapter.busy).toBe(true);
    expect(f.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
    await f.finish();
    expect(terminal(f.events)).toHaveLength(2);
    expect(terminal(f.events).at(-1)).toMatchObject({ item: { usage: { inputTokens: 7, outputTokens: 3 } } });
    expect(f.events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({ totals: { inputTokens: 17, outputTokens: 3, turns: 2 } });
    expect(f.adapter.busy).toBe(false);
  });

  it('denies old-run dialogs even while a steer is waiting for old stats, before abort can be sent', async () => {
    const f = fixture();
    const stats = deferred();
    const request = f.privateAdapter.request;
    let firstStats = true;
    f.privateAdapter.request = (type, extra) => {
      if (type === 'get_session_stats' && firstStats) { firstStats = false; return stats.promise; }
      return request(type, extra);
    };
    await f.adapter.send({ text: 'old work' });
    f.feed({ type: 'agent_settled' });
    const steering = f.adapter.send({ text: 'urgent', mode: 'steer' });
    f.feed({ type: 'agent_start' });
    f.feed({ type: 'extension_ui_request', id: 'between-runs', method: 'confirm', title: 'Old work' });
    await tick();
    expect(f.ctx.requestApproval).not.toHaveBeenCalled();
    expect(f.writes.map((line) => JSON.parse(line))).toEqual([{ type: 'extension_ui_response', id: 'between-runs', cancelled: true }]);
    stats.resolve({});
    await tick();
    await f.finish('aborted');
    f.aborts[0].resolve(undefined);
    await steering;
  });

  it('keeps Queue non-interrupting and FIFO when an autonomous run starts during admission', async () => {
    const f = fixture();
    await f.adapter.send({ text: 'old work' });
    await f.adapter.send({ text: 'queued first', mode: 'queue' });
    await f.adapter.send({ text: 'queued second', mode: 'queue' });
    const gate = deferred<void>();
    f.privateAdapter.inputDispatch = gate.promise;
    await f.finish(); // The first follow-up is selected but not yet admitted.
    f.feed({ type: 'agent_start' });
    gate.resolve();
    await tick();
    expect(f.requests.filter((request) => request.type === 'abort')).toHaveLength(0);
    expect(f.meta.queued).toBe(2);
    await f.finish();
    expect(f.requests.filter((request) => request.type === 'prompt').map((request) => request.extra.message)).toEqual(['old work', 'queued first']);
    await f.finish();
    expect(f.requests.filter((request) => request.type === 'prompt').map((request) => request.extra.message)).toEqual(['old work', 'queued first', 'queued second']);
    await f.finish();
    expect(f.requests.filter((request) => request.type === 'abort')).toHaveLength(0);
    expect(f.meta.queued).toBe(0);
    expect(f.adapter.busy).toBe(false);
  });

  it('does not revive accepted input or queued follow-ups after disposal during cancellation', async () => {
    const f = fixture();
    await f.adapter.send({ text: 'old work' });
    await f.adapter.send({ text: 'queued', mode: 'queue' });
    const steering = f.adapter.send({ text: 'must not revive', mode: 'steer' });
    const rejected = expect(steering).rejects.toThrow('stopped');
    await tick();
    await f.adapter.dispose();
    f.aborts[0].resolve(undefined);
    await rejected;
    expect(f.requests.filter((request) => request.type === 'prompt')).toHaveLength(1);
    expect(f.meta.queued).toBe(0);
    expect(f.adapter.busy).toBe(false);
    expect(f.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
  });
});
