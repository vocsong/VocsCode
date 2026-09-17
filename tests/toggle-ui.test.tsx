// The switch must say on/off without the reader having to decode thumb position: a word, a state
// class driving the track colour, and a check/cross glyph. It also has to stay keyboard-reachable,
// which a `display: none` input is not.
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Toggle } from '../src/renderer/src/components/ui';

afterEach(cleanup);

describe('Toggle', () => {
  it('spells the state out in words and in a state class', () => {
    const { container, rerender } = render(<Toggle checked={false} onChange={() => undefined} label="Auto-compaction" />);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByText('On')).toBeNull();
    expect(container.querySelector('.toggle.is-off')).toBeTruthy();
    expect(container.querySelector('.toggle.is-on')).toBeNull();

    rerender(<Toggle checked={true} onChange={() => undefined} label="Auto-compaction" />);
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.queryByText('Off')).toBeNull();
    expect(container.querySelector('.toggle.is-on')).toBeTruthy();
  });

  it('draws a different glyph in the thumb for each state', () => {
    const { container, rerender } = render(<Toggle checked={false} onChange={() => undefined} />);
    const off = container.querySelector('.toggle-thumb .toggle-glyph path')?.getAttribute('d');
    rerender(<Toggle checked={true} onChange={() => undefined} />);
    const on = container.querySelector('.toggle-thumb .toggle-glyph path')?.getAttribute('d');
    expect(off).toBeTruthy();
    expect(on).toBeTruthy();
    expect(on).not.toBe(off);
  });

  it('keeps the accessible name free of the On/Off word', () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => undefined} label="Auto-compaction" />);
    expect(screen.getByLabelText('Auto-compaction')).toBeTruthy();
    rerender(<Toggle checked={true} onChange={() => undefined} label="Auto-compaction" />);
    expect(screen.getByLabelText('Auto-compaction')).toBeTruthy();
  });

  it('keeps the checkbox in the tab order so the switch is keyboard-operable', () => {
    const { container } = render(<Toggle checked={false} onChange={() => undefined} label="Auto-compaction" />);
    const input = container.querySelector('.toggle input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.hidden).toBe(false);
    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it('still reports the new value when the label is clicked', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Auto-compaction" />);
    fireEvent.click(screen.getByText('Auto-compaction'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
