/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImageLightbox, navigateLightbox } from '../src/renderer/src/components/ImageLightbox';
import { UserMessage } from '../src/renderer/src/components/Transcript';
import type { ImageAttachment, TranscriptItem } from '../src/shared/types';

afterEach(cleanup);

const img = (data: string, name?: string): ImageAttachment => ({ mimeType: 'image/png', data, name });

const userItem = (images: ImageAttachment[]): Extract<TranscriptItem, { kind: 'user' }> =>
  ({ kind: 'user', id: 'u1', ts: 0, text: 'hello', images });

describe('navigateLightbox', () => {
  it('wraps forwards and backwards within bounds', () => {
    expect(navigateLightbox(0, 3, -1)).toBe(2);
    expect(navigateLightbox(2, 3, 1)).toBe(0);
    expect(navigateLightbox(1, 3, 1)).toBe(2);
  });

  it('stays put for a single image or empty list', () => {
    expect(navigateLightbox(0, 1, 1)).toBe(0);
    expect(navigateLightbox(0, 0, 1)).toBe(0);
  });
});

describe('ImageLightbox', () => {
  const images = [
    { src: 'data:image/png;base64,AAA', name: 'shot-a.png' },
    { src: 'data:image/png;base64,BBB', name: 'shot-b.png' },
  ];

  it('renders the selected image at full size', () => {
    render(<ImageLightbox images={images} index={1} onClose={() => {}} />);
    const imgEl = screen.getByRole('img') as HTMLImageElement;
    expect(imgEl.src).toContain('BBB');
    expect(screen.getByText('shot-b.png (2/2)')).toBeTruthy();
  });

  it('navigates with arrow keys and closes on Escape', () => {
    const onClose = vi.fn();
    render(<ImageLightbox images={images} index={0} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect((screen.getByRole('img') as HTMLImageElement).src).toContain('BBB');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(<ImageLightbox images={images} index={0} onClose={onClose} />);
    fireEvent.click(container.querySelector('.lightbox') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('UserMessage image expand', () => {
  it('renders images and reports the clicked index with all message images', () => {
    const onImageExpand = vi.fn();
    const { container } = render(
      <UserMessage item={userItem([img('AAA', 'a.png'), img('BBB')])} onImageExpand={onImageExpand} />,
    );
    const buttons = Array.from(container.querySelectorAll('.msg-image-btn'));
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[1]);
    expect(onImageExpand).toHaveBeenCalledWith(
      [
        { src: 'data:image/png;base64,AAA', name: 'a.png' },
        { src: 'data:image/png;base64,BBB', name: undefined },
      ],
      1,
    );
  });
});
