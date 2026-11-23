/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../src/shared/types';
import { SessionControls } from '../src/renderer/src/components/SessionControls';

vi.mock('../src/renderer/src/models', () => ({ useSessionModels: () => ({ models: [], loading: false }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const session = {
  id: 's_one', status: 'running', config: { harness: 'native', permissionMode: 'ask' }
} as SessionMeta;
const switchForSession = () => screen.getByRole<HTMLButtonElement>('switch', { name: 'Keep computer awake' });

it('reflects the host choice, changes it mid-turn, and reads the new session on navigation', async () => {
  const choices = new Set<string>();
  const preference = vi.fn(async ({ id, enabled }: { id: string; enabled?: boolean }) => {
    if (enabled === true) choices.add(id);
    if (enabled === false) choices.delete(id);
    return choices.has(id);
  });
  vi.stubGlobal('keepAwake', { preference });
  const view = render(<SessionControls session={session} />);
  await waitFor(() => expect(switchForSession().disabled).toBe(false));
  expect(switchForSession().getAttribute('aria-checked')).toBe('false');
  fireEvent.click(switchForSession());
  await waitFor(() => expect(switchForSession().getAttribute('aria-checked')).toBe('true'));
  expect(preference).toHaveBeenLastCalledWith({ id: 's_one', enabled: true });
  view.rerender(<SessionControls session={{ ...session, id: 's_two' }} />);
  await waitFor(() => expect(switchForSession().disabled).toBe(false));
  expect(switchForSession().getAttribute('aria-checked')).toBe('false');
  view.rerender(<SessionControls session={session} />);
  await waitFor(() => expect(switchForSession().getAttribute('aria-checked')).toBe('true'));
  fireEvent.click(switchForSession());
  await waitFor(() => expect(switchForSession().getAttribute('aria-checked')).toBe('false'));
  expect(preference).toHaveBeenLastCalledWith({ id: 's_one', enabled: false });
});

it('does not offer the switch without the desktop bridge, or for managed/archived sessions', () => {
  const { rerender } = render(<SessionControls session={session} />);
  const query = () => screen.queryByRole('switch', { name: 'Keep computer awake' });
  expect(query()).toBeNull();
  const preference = vi.fn();
  vi.stubGlobal('keepAwake', { preference });
  rerender(<SessionControls session={{ ...session, archived: true }} />);
  expect(query()).toBeNull();
  rerender(<SessionControls session={{ ...session, mission: {} as NonNullable<SessionMeta['mission']> }} />);
  expect(query()).toBeNull();
  expect(preference).not.toHaveBeenCalled();
});
