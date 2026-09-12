/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
