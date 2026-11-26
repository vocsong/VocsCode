/** @vitest-environment jsdom */
/** The renderer's transport helpers in api.ts. */
import { describe, expect, it } from 'vitest';
import { canInvoke } from '../src/renderer/src/api';

describe('canInvoke', () => {
  it('allows every channel when the bound transport has no gate', () => {
    // The desktop preload exposes no `can`.
    expect(canInvoke('terminal:list')).toBe(true);
    expect(canInvoke('settings:update')).toBe(true);
  });
});
