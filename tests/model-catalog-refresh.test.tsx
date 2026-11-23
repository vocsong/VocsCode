/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, HarnessId, ModelInfo, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: vi.fn(), isMac: false, modKey: 'Ctrl', isWeb: false, canInvoke: () => true }));

import { useStore } from '../src/renderer/src/store';
import { pickSessionModels } from '../src/renderer/src/models';
import { SessionControls } from '../src/renderer/src/components/SessionControls';
import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';

const old: ModelInfo = { id: 'gpt-6', provider: 'openai', displayName: 'GPT 6', supportedEfforts: ['high'] };
const fresh: ModelInfo = { id: 'gpt-6.2', provider: 'openai', displayName: 'GPT 6.2' };
const session = { id: 'existing', config: { harness: 'pi', projectRoot: 'G:/project', model: { provider: old.provider, model: old.id } }, status: 'idle' } as SessionMeta;
const settings = { defaultHarness: 'pi', defaultPermissionMode: 'ask', defaultModelByHarness: {}, favoriteModels: [], providers: [], acpAgents: [], folders: ['G:/project'] } as unknown as AppSettings;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => channel === 'harness:models' ? { models: [old, fresh] } : {});
  useStore.setState({ settings, sessions: [session], models: { existing: [old] }, modelCatalog: { pi: { models: [old], loading: false } }, drafts: { existing: 'Keep my draft' }, newSessionRoot: 'G:/project', availability: {}, toasts: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('shared model catalog refresh', () => {
  it('offers and switches to a newly discovered model beneath an existing session without starting a turn', async () => {
    render(<SessionControls session={session} />);
    await act(async () => { await useStore.getState().refreshModelCatalog('pi'); });
    fireEvent.click(screen.getByRole('button', { name: /^Model:/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /More models/ }));
    fireEvent.click(screen.getByTitle('openai/gpt-6.2').closest('button')!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:setModel', { id: 'existing', model: { provider: 'openai', model: 'gpt-6.2' } }));
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['harness:models', 'sessions:setModel']);
    expect(useStore.getState().drafts.existing).toBe('Keep my draft');
    expect(useStore.getState().models.existing).toEqual([old]);
  });

  it('publishes New Session discovery into the catalog used by existing composers', async () => {
    render(<NewSessionDialog />);
    await waitFor(() => expect(useStore.getState().modelCatalog.pi).toEqual({ models: [old, fresh], loading: false, error: undefined }));
    expect(pickSessionModels(useStore.getState().models.existing, useStore.getState().modelCatalog.pi, 'pi').models).toEqual([old, fresh]);
    expect(invoke).toHaveBeenCalledWith('harness:models', { harness: 'pi', acpAgent: 'dsh', projectRoot: 'G:/project' });
    expect(invoke).not.toHaveBeenCalledWith('sessions:create', expect.anything());
  });

  it('deduplicates cached fetches but explicitly refreshes an already loaded catalog', async () => {
    useStore.setState({ modelCatalog: {} });
    const pending = deferred<{ models: ModelInfo[] }>();
    invoke.mockReturnValueOnce(pending.promise);
    const first = useStore.getState().ensureModelCatalog('pi');
    await useStore.getState().ensureModelCatalog('pi');
    expect(invoke).toHaveBeenCalledTimes(1);
    pending.resolve({ models: [old] });
    await first;
    await useStore.getState().ensureModelCatalog('pi');
    expect(invoke).toHaveBeenCalledTimes(1);
    await useStore.getState().refreshModelCatalog('pi');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(useStore.getState().modelCatalog.pi?.models).toEqual([old, fresh]);
  });

  it('preserves last-good models for discovery errors and rejected IPC, then recovers on retry', async () => {
    invoke.mockResolvedValueOnce({ models: [], error: 'Login expired' });
    expect(await useStore.getState().refreshModelCatalog('pi')).toEqual({ models: [old], error: 'Login expired', loading: false });
    invoke.mockRejectedValueOnce(new Error('Disconnected'));
    await useStore.getState().refreshModelCatalog('pi');
    expect(useStore.getState().modelCatalog.pi).toEqual({ models: [old], error: 'Disconnected', loading: false });
    invoke.mockResolvedValueOnce({});
    await useStore.getState().refreshModelCatalog('pi');
    expect(useStore.getState().modelCatalog.pi).toEqual({ models: [old], error: 'Harness model discovery returned an invalid catalog.', loading: false });
    await useStore.getState().refreshModelCatalog('pi');
    expect(useStore.getState().modelCatalog.pi).toEqual({ models: [old, fresh], error: undefined, loading: false });
  });

  it('does not let an older probe overwrite a newer refresh or resurrect an invalidated catalog', async () => {
    const pending = deferred<{ models: ModelInfo[] }>();
    invoke.mockReturnValueOnce(pending.promise);
    const older = useStore.getState().refreshModelCatalog('pi');
    expect(useStore.getState().modelCatalog.pi).toEqual({ models: [old], loading: true });
    await useStore.getState().refreshModelCatalog('pi');
    pending.resolve({ models: [old] });
    await older;
    expect(useStore.getState().modelCatalog.pi?.models).toEqual([old, fresh]);

    const invalidated = deferred<{ models: ModelInfo[] }>();
    invoke.mockReturnValueOnce(invalidated.promise);
    const request = useStore.getState().refreshModelCatalog('pi');
    useStore.setState({ modelCatalog: {} });
    invalidated.resolve({ models: [old] });
    await request;
    expect(useStore.getState().modelCatalog).toEqual({});
  });

  it.each(['claude', 'codex', 'codex-exec', 'pi'] as HarnessId[])('does not offer another provider in a started %s session', (harness) => {
    const gateway = { ...fresh, provider: 'gateway' };
    const result = pickSessionModels([old], { models: [{ ...old, supportedEfforts: ['low'] }, fresh, gateway], loading: false }, harness);
    expect(result.models).toEqual([old, fresh]);
    expect(result.models[0].supportedEfforts).toEqual(['high']);
    const custom = pickSessionModels([gateway], { models: [old, fresh, gateway, { ...old, provider: 'gateway' }], loading: false }, harness);
    expect(custom.models.map((m) => m.provider)).toEqual(['gateway', 'gateway']);
  });

  it('keeps ACP session-advertised models authoritative', () => {
    const catalog = { models: [old, fresh], loading: false };
    expect(pickSessionModels([old], catalog, 'acp').models).toEqual([old]);
  });

  it('invalidates last-good models and fences a pending probe when providers or runtimes change', async () => {
    const gateway = { ...fresh, provider: 'gateway' };
    const pending = deferred<{ models: ModelInfo[] }>();
    useStore.setState({ settings: { ...settings, providers: [{ id: 'gateway' }] } as AppSettings, modelCatalog: { claude: { models: [gateway], loading: false } } });
    invoke.mockReturnValueOnce(pending.promise);
    const request = useStore.getState().refreshModelCatalog('claude');
    useStore.getState().setSettings(settings);
    expect(useStore.getState().modelCatalog).toEqual({});
    pending.resolve({ models: [gateway] });
    await request;
    expect(useStore.getState().modelCatalog).toEqual({});
    invoke.mockResolvedValueOnce({ models: [old], error: 'Showing current saved catalog' });
    await useStore.getState().refreshModelCatalog('claude');
    expect(useStore.getState().modelCatalog.claude?.models).toEqual([old]);
    useStore.getState().setSettings({ ...settings, binaries: { claude: 'G:/new/claude.exe' } });
    expect(useStore.getState().modelCatalog).toEqual({});
  });
});
