import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderModels, resolveProviderApiKey } from '../src/main/models/providers';
import { generateSessionTitle } from '../src/main/session-title';
import { createKnowledgeCompleter } from '../src/main/knowledge/llm';
import { anthropicStep, openaiStep, type StepParams } from '../src/main/harness/native/drivers';
import { transcribeCloud } from '../src/main/dictation/cloud';
import { defaultSettings, SettingsStore } from '../src/main/settings';
import { browserSocket, memoryVault, RelayClient, relayBaseFor, type WebCredentials } from '../relay/src/web-client';
import { relayUrl } from '../src/main/remote/relay-url';
import { RemoteHost } from '../src/main/remote/host';
import type { ProviderConfig } from '../src/shared/types';
import { generateIdentity } from '../src/shared/crypto';

const unsafe = 'http://192.168.1.2:8080/v1?token=hidden';
const provider = (kind: ProviderConfig['kind'] = 'openai', baseUrl = unsafe): ProviderConfig => ({ id: 'test', kind, name: 'Test', baseUrl, enabled: true, hasApiKey: true, models: [{ id: 'model', provider: 'test', displayName: 'Model' }] });
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('credential transport boundaries', () => {
  it.each(['openai', 'anthropic', 'openrouter'] as const)('refuses %s catalog requests before network dispatch', async (kind) => {
    const network = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', network);
    await expect(fetchProviderModels(provider(kind), 'secret-key')).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic', 'openrouter'] as const)('guards the actual %s catalog fetch, not only configuration validation', async (kind) => {
    const network = vi.fn<typeof fetch>(async () => Response.json({ data: [] })); vi.stubGlobal('fetch', network);
    await expect(fetchProviderModels(provider(kind, 'https://provider.example/v1'), 'secret-key')).resolves.toEqual([]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it.each(['openai', 'anthropic'] as const)('refuses an SDK %s environment base URL, including before resolving keys', async (kind) => {
    vi.stubEnv(kind === 'anthropic' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL', 'http://192.168.1.2/v1');
    const p = { ...provider(kind), baseUrl: undefined };
    const secret = vi.fn(async () => 'secret-key');
    await expect(resolveProviderApiKey(p, secret)).resolves.toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
    const network = vi.fn(async () => Response.json({ data: [] })); vi.stubGlobal('fetch', network);
    await expect(fetchProviderModels(p, 'secret-key')).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps background jobs never-throwing and redacts refusals without reading secrets', async () => {
    const secret = vi.fn(async () => 'secret-key');
    const logs: string[] = [];
    const log = (_level: string, message: string) => { logs.push(message); };
    const network = vi.fn(async () => Response.json({ choices: [{ message: { content: 'A valid title' }, finish_reason: 'stop' }] })); vi.stubGlobal('fetch', network);
    await expect(generateSessionTitle('a task', [provider()], secret, undefined, log)).resolves.toBeNull();
    const settings = { ...defaultSettings(), providers: [provider()] };
    await expect(createKnowledgeCompleter({ settings: () => settings, getSecret: secret, log }).complete({ system: 'system', prompt: 'prompt' })).resolves.toBeNull();
    expect(network).not.toHaveBeenCalled(); expect(secret).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toMatch(/password|hidden|192\.168|secret-key/);
  });

  it.each([openaiStep, anthropicStep])('refuses native SDK dispatch without text or reasoning callbacks', async (step) => {
    const network = vi.fn(async () => new Response('', { status: 400 })); vi.stubGlobal('fetch', network);
    const p: StepParams = { provider: provider(step === anthropicStep ? 'anthropic' : 'openai'), apiKey: 'secret-key', model: 'model', system: 'system', history: [], tools: [], signal: new AbortController().signal, onText: vi.fn(), onReasoning: vi.fn() };
    await expect(step(p)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled(); expect(p.onText).not.toHaveBeenCalled(); expect(p.onReasoning).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic'] as const)('guards actual %s background requests while preserving safe completions', async (kind) => {
    const network = vi.fn<typeof fetch>(async () => Response.json(kind === 'anthropic'
      ? { content: [{ type: 'text', text: 'Safe title' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: 'Safe title' }, finish_reason: 'stop' }] })); vi.stubGlobal('fetch', network);
    const p = provider(kind, 'https://provider.example/v1'), secret = vi.fn(async () => 'secret-key');
    await expect(generateSessionTitle('a task', [p], secret)).resolves.toBe('Safe title');
    await expect(createKnowledgeCompleter({ settings: () => ({ ...defaultSettings(), providers: [p] }), getSecret: secret, log: vi.fn() }).complete({ system: 'system', prompt: 'prompt' })).resolves.toBe('Safe title');
    expect(network).toHaveBeenCalledTimes(2);
    for (const [, init] of network.mock.calls) expect(init).toMatchObject({ redirect: 'error' });
  });

  it.each([openaiStep, anthropicStep])('guards actual native SDK fetches on safe endpoints', async (step) => {
    const network = vi.fn<typeof fetch>(async () => new Response('', { status: 400 })); vi.stubGlobal('fetch', network);
    const p: StepParams = { provider: provider(step === anthropicStep ? 'anthropic' : 'openai', 'https://provider.example/v1'), apiKey: 'secret-key', model: 'model', system: 'system', history: [], tools: [], signal: new AbortController().signal, onText: vi.fn(), onReasoning: vi.fn() };
    await expect(step(p)).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('refuses dictation without sending audio or credentials through an injected fetch', async () => {
    const network = vi.fn(async () => Response.json({ text: 'transcript' }));
    await expect(transcribeCloud({ provider: provider(), model: 'whisper-1', apiKey: 'secret-key', wav: Buffer.from('private audio'), fetchImpl: network })).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it('refuses a settings write atomically but still loads and repairs legacy unsafe settings', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vocs-endpoint-')); dirs.push(dir);
    const store = new SettingsStore(dir);
    await store.update({ notifications: false });
    const before = await readFile(path.join(dir, 'settings.json'), 'utf8'); const listener = vi.fn(); store.onChange(listener);
    await expect(store.update({ providers: [provider()] })).rejects.toThrow();
    expect(await readFile(path.join(dir, 'settings.json'), 'utf8')).toBe(before); expect(listener).not.toHaveBeenCalled(); expect(store.get().providers.some((p) => p.id === 'test')).toBe(false);
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ providers: [provider()] }));
    await expect(store.load()).resolves.toBeTruthy();
    await expect(store.update({ notifications: false })).resolves.toBeTruthy();
    await expect(store.update({ providers: store.get().providers.map((p) => p.id === 'test' ? { ...p, baseUrl: 'https://provider.example/v1' } : p) })).resolves.toBeTruthy();
  });

  it('rejects desktop and browser overrides before relay secrets or identities are touched', async () => {
    expect(() => relayUrl({ VOCS_CODE_RELAY_URL: unsafe })).toThrow();
    expect(() => relayBaseFor('https://code.vocs.io', unsafe)).toThrow();
    const get = vi.fn(async () => undefined), set = vi.fn(async () => undefined), log = vi.fn();
    const open = vi.fn(async () => undefined);
    const host = new RemoteHost({ secrets: { get, set }, pushState: vi.fn(), log });
    await expect(host.enable(unsafe)).rejects.toThrow();
    await expect(host.signIn(unsafe, open)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    const network = vi.fn(), newIdentity = vi.fn();
    const client = new RelayClient({ vault: memoryVault(), fetchImpl: network, newIdentity });
    await expect(client.pair({ relayBase: unsafe, code: 'ABCD', deviceName: 'Browser' })).rejects.toThrow();
    expect(network).not.toHaveBeenCalled(); expect(newIdentity).not.toHaveBeenCalled();
  });

  it('blocks redirect downgrades in raw catalog, dictation and browser owner fetches, including injected transports', async () => {
    const network = vi.fn<typeof fetch>(async () => new Response('', { status: 307, headers: { location: unsafe } })); vi.stubGlobal('fetch', network);
    await expect(fetchProviderModels(provider('openrouter', 'https://provider.example/v1'), 'private')).rejects.toThrow(/redirect/);
    await expect(transcribeCloud({ provider: provider('openai', 'https://provider.example/v1'), apiKey: 'private', model: 'whisper-1', wav: Buffer.from('private audio'), fetchImpl: network })).rejects.toThrow(/redirect/);
    const client = new RelayClient({ vault: memoryVault(), fetchImpl: network });
    await expect(client.ownerHosts('https://relay.example')).rejects.toThrow(/redirect/);
    expect(network).toHaveBeenCalledTimes(3);
    for (const [url, init] of network.mock.calls) { expect(String(url)).toMatch(/^https:/); expect(init).toMatchObject({ redirect: 'error' }); }
  });

  it('guards raw desktop requests and restored desktop routes before credentials can leave', async () => {
    const network = vi.fn<typeof fetch>(async () => new Response('', { status: 307, headers: { location: unsafe } })); vi.stubGlobal('fetch', network);
    const host = new RemoteHost({ secrets: { get: vi.fn(), set: vi.fn() }, pushState: vi.fn(), log: vi.fn() });
    // Model the already-restored credential state, then exercise public production request paths.
    const restored = { relayUrl: unsafe, deviceId: 'host', deviceToken: 'refresh-private', identity: await generateIdentity() };
    Object.assign(host, { creds: restored });
    await expect(host.listDevices()).rejects.toThrow(/HTTPS/);
    await expect(host.revokeAll()).rejects.toThrow(/HTTPS/);
    expect(network).not.toHaveBeenCalled();
    Object.assign(host, { creds: { ...restored, relayUrl: 'https://relay.example' } });
    await expect(host.listDevices()).rejects.toThrow(/redirect/);
    expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('refuses insecure sockets at the native browser dispatch boundary without exposing tickets', () => {
    const socket = vi.fn(); vi.stubGlobal('WebSocket', socket);
    expect(() => browserSocket('ws://192.168.1.2/ws?ticket=private', vi.fn(), vi.fn())).toThrow(/WSS/);
    expect(socket).not.toHaveBeenCalled();
  });

  it('refuses restored browser credentials at every network boundary, not just the URL picker', async () => {
    const creds = { relayBase: unsafe, webToken: 'refresh-secret', webDeviceId: 'web', hostDeviceId: 'host' } as WebCredentials;
    const network = vi.fn(), socket = vi.fn();
    const client = new RelayClient({ vault: memoryVault({ pairings: [creds] }), fetchImpl: network, wsFactory: socket });
    await client.restore();
    await expect(client.connect()).rejects.toThrow();
    await expect(client.listDevices()).rejects.toThrow();
    expect(network).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled();
  });
});
