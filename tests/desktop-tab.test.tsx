/**
 * The Desktop tab: a live preview built from `cua:preview`, an honest fallback to the Cua card when
 * computer use is not ready, and the session interrupt as its stop control.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopTab } from '../src/renderer/src/components/DesktopTab';
import { useStore } from '../src/renderer/src/store';
import type { CuaPreviewResult, CuaStatus, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

const session = (): SessionMeta =>
  ({
    id: 's1',
    title: 'Session',
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness: 'claude', permissionMode: 'ask' },
    status: 'idle',
    harnessRef: {},
    usage: { costUsd: 0 }
  }) as unknown as SessionMeta;

const status = (over: Partial<CuaStatus> = {}): CuaStatus => ({ installed: true, version: '0.28.2', mode: 'standard', ready: true, note: 'On.', ...over });

function mockInvoke(s: CuaStatus, preview: CuaPreviewResult) {
  invoke.mockImplementation((channel: string) => {
    if (channel === 'cua:status') return Promise.resolve(s);
    if (channel === 'cua:preview') return Promise.resolve(preview);
    return Promise.resolve({});
  });
}

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ settings: { mcpServers: [], cua: { enabled: true, mode: 'standard' } } as never });
});
afterEach(cleanup);

describe('Desktop tab', () => {
  it('renders the live capture the driver returned', async () => {
    mockInvoke(status(), { ok: true, imageDataUrl: 'data:image/png;base64,QUJD' });
    await act(async () => {
      render(<DesktopTab session={session()} />);
    });
    const img = screen.getByTestId('desktop-frame-image') as HTMLImageElement;
    expect(img.src).toBe('data:image/png;base64,QUJD');
    expect(invoke).toHaveBeenCalledWith('cua:preview', undefined);
  });

  it('stops the session from the preview', async () => {
    mockInvoke(status(), { ok: true, imageDataUrl: 'data:image/png;base64,QUJD' });
    await act(async () => {
      render(<DesktopTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    });
    expect(invoke).toHaveBeenCalledWith('sessions:interrupt', { id: 's1' });
  });

  it('falls back to the Cua card when the driver is not ready, and never polls', async () => {
    mockInvoke(status({ installed: false, version: undefined, ready: false, note: 'Cua Driver is not installed on this machine.' }), { ok: true, imageDataUrl: 'data:image/png;base64,QUJD' });
    await act(async () => {
      render(<DesktopTab session={session()} />);
    });
    expect(screen.queryByTestId('desktop-frame-image')).toBeNull();
    expect(screen.getByTestId('cua-card')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('cua:preview', undefined);
  });
});