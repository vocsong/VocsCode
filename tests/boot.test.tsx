/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/renderer/src/App';
import { useStore } from '../src/renderer/src/store';

vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

afterEach(() => {
  cleanup();
  useStore.setState({ bootError: null, booted: false, settings: null });
});

describe('renderer boot failure handling', () => {
  it('shows the failure and retries from the error screen', () => {
    const originalBoot = useStore.getState().boot;
    const retry = vi.fn().mockResolvedValue(undefined);
    useStore.setState({
      booted: false,
      bootError: 'session data is unreadable',
      settings: null,
      boot: retry as unknown as () => Promise<void>
    });

    render(<App />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not load Vocs Code');
    expect(alert.textContent).toContain('session data is unreadable');
    retry.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    useStore.setState({ boot: originalBoot });
  });

  it('records the desktop focus and remote policy the boot is given', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'settings:get') return { remote: { viewOnly: true } };
      if (channel === 'sessions:list') return [];
      if (channel === 'terminal:list') return [];
      if (channel === 'desktop:focus') return { sessionId: 's1', at: 1, windowFocused: true };
      return undefined;
    });
    (window as unknown as { harness: unknown }).harness = {
      platform: 'win32',
      invoke,
      on: (channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      }
    };
    useStore.setState({ booted: false, settings: null, bootError: null });

    await useStore.getState().boot();
    await waitFor(() => expect(useStore.getState().desktopFocus).toMatchObject({ sessionId: 's1' }));
    expect(useStore.getState().remoteAccess.viewOnly).toBe(true);

    listeners.get('push:remotePolicy')?.({ viewOnly: false });
    listeners.get('push:desktopFocus')?.({ sessionId: null, at: 2, windowFocused: false });
    expect(useStore.getState().remoteAccess.viewOnly).toBe(false);
    expect(useStore.getState().desktopFocus).toMatchObject({ sessionId: null });
  });
});
