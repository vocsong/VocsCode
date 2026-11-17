/** Real Pi 0.85.1 RPC + production adapter, with a deterministic provider and no API credit. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import { LineSplitter } from '../src/main/util/async';
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';
import { PiOfflineRunner, type PiEvent } from './pi-offline-runner';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const roots: string[] = [];
const runners: PiOfflineRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
});
const script = (id: string, name: string, args: Record<string, unknown>) => JSON.stringify({ calls: [{ id, name, arguments: args }] });
const userText = (message: PiEvent) => message.content.filter((part: PiEvent) => part.type === 'text').map((part: PiEvent) => part.text).join('');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pi-steering-'));
  roots.push(root);
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  const runner = new PiOfflineRunner({ cwd, agentDir });
  runners.push(runner);
  await runner.ready();
  const events: SessionEvent[] = [];
  const meta = { id: 'steering', config: { harness: 'pi', permissionMode: 'full-auto' }, usage: emptyUsage(), cwd, harnessRef: {} } as SessionMeta;
  const ctx = {
    session: () => meta, permissionMode: () => 'full-auto', emit: (event: SessionEvent) => events.push(event),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch), updateRef: () => {}, log: () => {},
    requestApproval: async () => ({ optionId: 'deny' }),
  } as unknown as HarnessContext;
  const adapter = new PiAdapter(ctx);
  // Startup is exercised by PiOfflineRunner; everything after admission uses the production RPC
  // writer, parser, cancellation, scheduler, accounting and normalized event path.
  const priv = adapter as unknown as { child: unknown; nextId: number; extensionCapabilities: Set<string>; handleLine(line: string): void };
  priv.child = runner.child;
  priv.nextId = 10000; // runner requests and adapter requests must not share correlation ids.
  priv.extensionCapabilities = new Set(['approvals', 'tools', 'subagents']);
  const splitter = new LineSplitter((line) => priv.handleLine(line));
  runner.child.stdout!.on('data', (data: Buffer) => splitter.push(data));
  const items = () => [...new Map(events.filter((event) => event.type === 'item.upsert').map((event) => [event.item.id, event.item])).values()];
  const turns = () => items().filter((item): item is Extract<TranscriptItem, { kind: 'turn' }> => item.kind === 'turn');
  const idle = async () => {
    await vi.waitFor(() => expect(adapter.busy).toBe(false), { timeout: 10000 });
    expect(events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(1);
    expect((await runner.request('get_state')).isStreaming).toBe(false);
  };
  const startLong = async () => {
    await adapter.send({ text: script('old-shell', 'bash', { command: 'printf STARTED; sleep 20; printf bad > late-write.txt' }) });
    await runner.waitFor((event) => event.type === 'tool_execution_update' && JSON.stringify(event.partialResult).includes('STARTED'), 0);
  };
  const messages = async () => (await runner.request('get_messages')).messages.filter((message: PiEvent) => message.role === 'user');
  return { adapter, runner, cwd, events, meta, items, turns, idle, startLong, messages };
}

describe.skipIf(!enabled)('real Pi interrupting steering', () => {
  it('cancels a running shell with no late write and successfully answers the directive exactly once', async () => {
    const f = await fixture();
    await f.startLong();
    const directive = script('redirect', 'write', { path: 'redirected.txt', content: 'STEER_OK' });
    await f.adapter.send({ text: directive, mode: 'steer' });
    await f.idle();
    expect(await fs.readFile(path.join(f.cwd, 'redirected.txt'), 'utf8')).toBe('STEER_OK');
    expect(await fs.readdir(f.cwd)).not.toContain('late-write.txt');
    expect((await f.messages()).filter((message: PiEvent) => userText(message) === directive)).toHaveLength(1);
    expect(f.turns().map((turn) => turn.status)).toEqual(['interrupted', 'completed']);
    expect(f.items().filter((item) => item.kind === 'tool').map((item) => item.status)).toEqual(['error', 'done']);
    expect(f.events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('preserves queued images and FIFO follow-ups behind an urgent directive', async () => {
    const f = await fixture();
    await f.startLong();
    const image = { name: 'pixel.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6C0AAAAASUVORK5CYII=' };
    await f.adapter.send({ text: 'queued with image', images: [image], mode: 'queue' });
    const later = script('later', 'write', { path: 'later.txt', content: 'LATER_OK' });
    await f.adapter.send({ text: later, mode: 'queue' });
    const directive = script('urgent', 'write', { path: 'urgent.txt', content: 'URGENT_OK' });
    await f.adapter.send({ text: directive, mode: 'steer' });
    await f.idle();
    const users = await f.messages();
    expect(users.slice(1).map(userText)).toEqual([directive, 'queued with image', later]);
    expect(users[2].content.filter((part: PiEvent) => part.type === 'image')).toEqual([{ type: 'image', data: image.data, mimeType: image.mimeType }]);
    expect(await fs.readFile(path.join(f.cwd, 'later.txt'), 'utf8')).toBe('LATER_OK');
    expect(f.items().some((item) => item.kind === 'assistant' && item.text === 'IMAGES_OK')).toBe(true);
    expect(f.turns().map((turn) => turn.status)).toEqual(['interrupted', 'completed', 'completed', 'completed']);
    expect(f.meta.queued).toBe(0);
  });

  it('admits rapid steers once each, including after a natural completion', async () => {
    const f = await fixture();
    await f.startLong();
    const first = 'first urgent instruction';
    const second = script('last', 'write', { path: 'last.txt', content: 'LAST_OK' });
    await Promise.all([f.adapter.send({ text: first, mode: 'steer' }), f.adapter.send({ text: second, mode: 'steer' })]);
    await f.idle();
    expect((await f.messages()).slice(1).map(userText)).toEqual([first, second]);
    expect(await fs.readFile(path.join(f.cwd, 'last.txt'), 'utf8')).toBe('LAST_OK');
    expect(await fs.readdir(f.cwd)).not.toContain('late-write.txt');
    f.events.length = 0;
    await f.adapter.send({ text: 'steer arrived after natural completion', mode: 'steer' });
    await f.idle();
    expect((await f.messages()).map(userText).at(-1)).toBe('steer arrived after natural completion');
    expect(f.turns().map((turn) => turn.status)).toEqual(['completed']);
  });

  it('interrupts a foreground child task before redirecting its parent', async () => {
    const f = await fixture();
    const childTask = script('child-shell', 'bash', { command: 'printf started > child-started.txt; sleep 20; printf bad > child-late-write.txt' });
    await f.adapter.send({ text: script('child', 'subagent', { description: 'Wait in child', prompt: childTask }) });
    await vi.waitFor(async () => expect(await fs.readFile(path.join(f.cwd, 'child-started.txt'), 'utf8')).toBe('started'), { timeout: 10000 });
    await f.adapter.send({ text: 'redirect parent after child cancellation', mode: 'steer' });
    await f.idle();
    expect(await fs.readdir(f.cwd)).not.toContain('child-late-write.txt');
    expect((await f.messages()).map(userText).at(-1)).toBe('redirect parent after child cancellation');
    expect(f.turns().map((turn) => turn.status)).toEqual(['interrupted', 'completed']);
    expect(f.events.filter((event) => event.type === 'subagent.run' && event.run.status === 'stopped')).toHaveLength(1);
  });
});
