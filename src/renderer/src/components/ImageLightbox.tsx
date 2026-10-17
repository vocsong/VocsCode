// Fullscreen image viewer: clicking a transcript image opens it at full size.
// Esc / backdrop click closes; ArrowLeft / ArrowRight move between images of one message.
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './ui';

export interface LightboxImage {
  src: string;
  name?: string;
}

/** Pure helper so navigation math is testable without a DOM. */
export function navigateLightbox(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

export const ImageLightbox = memo(function ImageLightbox({
  images,
  index,
  onClose,
}: {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
}) {
  const count = images.length;
  const [current, setCurrent] = useState(() => navigateLightbox(index, count, 0));
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const message = previous?.closest('[data-item-id]');
    const source = previous?.querySelector('img')?.getAttribute('src');
    dialog.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => {
      // Streaming can replace the opener while the viewer is open; return to its new button.
      const replacement = message?.isConnected && source
        ? Array.from(message.querySelectorAll<HTMLButtonElement>('.msg-image-btn')).find((button) => button.querySelector('img')?.getAttribute('src') === source)
        : null;
      (previous?.isConnected ? previous : replacement)?.focus({ preventScroll: true });
    };
  }, []);

  const step = useCallback((delta: number) => {
    setCurrent((i) => navigateLightbox(i, count, delta));
  }, [count]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (count > 1 && e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      } else if (count > 1 && e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll('button');
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (!first || !last) return;
        if (!dialog.current?.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, onClose, step]);

  const image = images[current];
  if (!image) return null;

  return (
    <div ref={dialog} className="lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={onClose}>
      <button
        type="button"
        className="lightbox-btn lightbox-close"
        aria-label="Close image preview"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <Icon name="x" size={18} />
      </button>
      {count > 1 && (
        <button
          type="button"
          className="lightbox-btn lightbox-prev"
          aria-label="Previous image"
          onClick={(e) => {
            e.stopPropagation();
            step(-1);
          }}
        >
          <Icon name="chevron" size={20} />
        </button>
      )}
      <img
        className="lightbox-img"
        src={image.src}
        alt={image.name ?? 'attachment'}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
      {count > 1 && (
        <button
          type="button"
          className="lightbox-btn lightbox-next"
          aria-label="Next image"
          onClick={(e) => {
            e.stopPropagation();
            step(1);
          }}
        >
          <Icon name="chevronRight" size={20} />
        </button>
      )}
      <p className="lightbox-caption">
        {image.name ?? 'Image'}
        {count > 1 ? ` (${current + 1}/${count})` : ''}
      </p>
    </div>
  );
});
