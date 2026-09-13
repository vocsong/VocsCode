// Accessibility semantics for the shared primitives: modal focus management, toast live regions
// and dropdown menu ARIA plus keyboard navigation.
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Stub the preload bridge before any renderer module runs.
const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};
vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

import { useState } from 'react';
import { Dropdown, MenuItem, Modal } from '../src/renderer/src/components/ui';
import { Toasts } from '../src/renderer/src/App';
import { useStore } from '../src/renderer/src/store';

afterEach(() => {
  cleanup();
  useStore.setState({ toasts: [] });
  vi.clearAllMocks();
});

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open && (
        <Modal title="Restore" onClose={() => setOpen(false)}>
          <button type="button">Inside</button>
        </Modal>
      )}
    </>
  );
}

function DropdownHarness() {
  return (
    <Dropdown trigger={() => <button type="button">Open menu</button>}>
      {(close) => (
        <>
          <MenuItem onClick={close}>First</MenuItem>
          <MenuItem disabled>Disabled</MenuItem>
          <MenuItem onClick={close}>Last</MenuItem>
        </>
      )}
    </Dropdown>
  );
}

describe('Modal accessibility', () => {
  it('moves focus into the dialog and labels it by the title', () => {
    render(
      <Modal title="Rename session" onClose={() => {}}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Rename session');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
  });

  it('traps Tab between the first and last focusable elements', () => {
    render(
      <Modal title="Trap" onClose={() => {}}>
        <button type="button">Alpha</button>
        <button type="button">Omega</button>
      </Modal>
    );
    const close = screen.getByLabelText('Close');
    const omega = screen.getByText('Omega');

    omega.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(omega);
  });

  it('leaves an autoFocus child focused instead of stealing it', () => {
    render(
      <Modal title="Confirm" onClose={() => {}} footer={<button type="button" autoFocus>Confirm</button>}>
        <button type="button">Body</button>
      </Modal>
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
  });

  it('restores focus to the trigger when the dialog unmounts', () => {
    render(<ModalHarness />);
    const trigger = screen.getByText('Open dialog');
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Toast announcements', () => {
  it('uses a polite status stack and assertive error toasts', () => {
    useStore.setState({
      toasts: [
        { id: 'e', kind: 'error', text: 'Something failed' },
        { id: 's', kind: 'success', text: 'Saved' },
      ],
    });
    const { container } = render(<Toasts />);
    const stack = container.querySelector('.toasts') as HTMLElement;
    expect(stack.getAttribute('role')).toBe('status');
    expect(stack.getAttribute('aria-live')).toBe('polite');
    expect(stack.getAttribute('aria-atomic')).toBe('false');

    const error = container.querySelector('.toast-error') as HTMLElement;
    const success = container.querySelector('.toast-success') as HTMLElement;
    expect(error.getAttribute('role')).toBe('alert');
    expect(success.getAttribute('role')).toBe('status');
  });
});

describe('Dropdown menu accessibility', () => {
  it('marks the trigger and focuses the first item on open', () => {
    render(<DropdownHarness />);
    const trigger = screen.getByText('Open menu');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves focus with arrows and Home/End, skipping disabled items', () => {
    render(<DropdownHarness />);
    fireEvent.click(screen.getByText('Open menu'));
    const first = screen.getByRole('menuitem', { name: 'First' });
    const last = screen.getByRole('menuitem', { name: 'Last' });

    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<DropdownHarness />);
    const trigger = screen.getByText('Open menu');
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('only gives MenuItem the menuitem role inside a dropdown menu', () => {
    const { container } = render(<MenuItem>Standalone</MenuItem>);
    expect(container.querySelector('.menu-item')?.getAttribute('role')).toBeNull();
  });
});
