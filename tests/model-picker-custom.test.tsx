/** @vitest-environment jsdom */
/** The picker must let a typed model id through when the endpoint publishes no catalog (custom
 *  gateways), while an exact catalog match still resolves to the listed row. */
import type { ModelInfo } from '../src/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue([]);
(window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke: invokeMock, on: vi.fn().mockReturnValue(() => undefined) };

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelPicker } from '../src/renderer/src/components/ModelPicker';
import { useStore } from '../src/renderer/src/store';

const MODELS: ModelInfo[] = [{ id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Claude Sonnet 5' }];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useStore.setState({ settings: { favoriteModels: [] } } as never);
});

afterEach(() => cleanup());

describe('ModelPicker custom ids', () => {
  it('offers the typed id when nothing in the catalog matches', () => {
    const onSelectCustom = vi.fn();
    render(<ModelPicker models={MODELS} onSelect={vi.fn()} onSelectCustom={onSelectCustom} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'glm-4.6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use “glm-4.6”' }));
    expect(onSelectCustom).toHaveBeenCalledWith('glm-4.6');
  });

  it('keeps an exact catalog match a normal row, with no custom offer', () => {
    render(<ModelPicker models={MODELS} onSelect={vi.fn()} onSelectCustom={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'claude-sonnet-5' } });
    expect(screen.queryByRole('button', { name: /^Use “/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Claude Sonnet 5/ })).toBeTruthy();
  });

  it('does not offer a custom row when the caller opts out', () => {
    render(<ModelPicker models={MODELS} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'glm-4.6' } });
    expect(screen.queryByRole('button', { name: /^Use “/ })).toBeNull();
    expect(screen.getByText('No models match “glm-4.6”.')).toBeTruthy();
  });
});
