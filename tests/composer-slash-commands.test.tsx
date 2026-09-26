// Slash-command autocomplete: Tab takes the first prefix match in SLASH_COMMANDS order.
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub the preload bridge before any renderer module runs.
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: vi.fn().mockResolvedValue({ ok: true }),
  on: vi.fn().mockReturnValue(() => undefined)
};

import { cleanup, fireEvent, render } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import type { SessionMeta } from '../src/shared/types';

const session = {
  id: 'slash', title: 't', createdAt: 0, updatedAt: 0, cwd: '.', status: 'idle', harnessRef: {},
  config: { harness: 'native', projectRoot: '.', permissionMode: 'ask' },
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }
} as unknown as SessionMeta;

afterEach(cleanup);

function complete(textarea: HTMLTextAreaElement, typed: string, keys: string[] = []): string {
  fireEvent.change(textarea, { target: { value: typed } });
  for (const key of [...keys, 'Tab']) fireEvent.keyDown(textarea, { key });
  return textarea.value;
}

describe('slash command autocomplete', () => {
  it('keeps /m and /mo on the existing commands; /mission completes from its own prefix', () => {
    const { container } = render(<Composer session={session} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(complete(textarea, '/m')).toBe('/model ');
    expect(complete(textarea, '/mo')).toBe('/model ');
    expect(complete(textarea, '/mo', ['ArrowDown'])).toBe('/mode ');
    expect(complete(textarea, '/me')).toBe('/merge ');
    expect(complete(textarea, '/mi')).toBe('/mission ');
  });
});
