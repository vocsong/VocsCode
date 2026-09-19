/**
 * The Cua Driver card: the opt-in and the authorization profile are the only controls, the
 * driver is never enabled without a binary, and bounded mode demands a manifest path.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CuaCard } from '../src/renderer/src/components/CuaCard';
import { useStore } from '../src/renderer/src/store';
import type { CuaStatus } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

const status = (over: Partial<CuaStatus> = {}): CuaStatus => ({ installed: true, version: '0.28.2', mode: 'standard', ready: true, note: 'On.', modeSource: 'vocs-code', ...over });

function setup(cua: { enabled: boolean; mode: string; manifestPath?: string }, s: CuaStatus) {
  useStore.setState({ settings: { mcpServers: [], cua } as never });
  invoke.mockImplementation((channel: string) => (channel === 'cua:status' ? Promise.resolve(s) : Promise.resolve({})));
}

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ settings: { mcpServers: [], cua: { enabled: false, mode: 'standard' } } as never });
});
afterEach(cleanup);

const enableToggle = () => screen.getByLabelText('Enable computer use') as HTMLInputElement;

describe('Cua Driver card', () => {
  it('does not let you switch on an uninstalled driver and shows the installer', async () => {
    setup({ enabled: false, mode: 'standard' }, status({ installed: false, version: undefined, note: 'Cua Driver is not installed on this machine.' }));
    await act(async () => {
      render(<CuaCard />);
    });
    expect(enableToggle().disabled).toBe(true);
    expect(screen.getByText('not installed')).toBeTruthy();
    expect(screen.getByText(/cua\.ai\/driver\/install/)).toBeTruthy();
  });

  it('turns computer use on through settings, keeping the mode', async () => {
    setup({ enabled: false, mode: 'standard' }, status());
    await act(async () => {
      render(<CuaCard />);
    });
    expect(enableToggle().disabled).toBe(false);
    expect(enableToggle().checked).toBe(false);
    await act(async () => {
      fireEvent.click(enableToggle());
    });
    expect(invoke).toHaveBeenCalledWith('settings:update', { cua: { enabled: true, mode: 'standard' } });
  });

  it('switches to bounded mode and asks for a manifest before it can start', async () => {
    setup({ enabled: true, mode: 'standard' }, status());
    await act(async () => {
      render(<CuaCard />);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bounded' } });
    });
    expect(invoke).toHaveBeenCalledWith('settings:update', { cua: { enabled: true, mode: 'bounded' } });
    cleanup();
    setup({ enabled: true, mode: 'bounded' }, status({ note: 'Bounded mode needs a capability manifest.' }));
    await act(async () => {
      render(<CuaCard />);
    });
    const input = screen.getByPlaceholderText('Path to cua-capabilities.yaml') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '/etc/cua-capabilities.yaml' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(invoke).toHaveBeenCalledWith('settings:update', { cua: { enabled: true, mode: 'bounded', manifestPath: '/etc/cua-capabilities.yaml' } });
  });

  it('offers a real Test connection handshake once installed', async () => {
    setup({ enabled: true, mode: 'standard' }, status());
    await act(async () => {
      render(<CuaCard />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('cua-test'));
    });
    expect(invoke).toHaveBeenCalledWith('cua:test', undefined);
  });
});