// Fullscreen image viewer: clicking a transcript image opens it at full size.
// Esc / backdrop click closes; ArrowLeft / ArrowRight move between images of one message.
import React, { memo, useCallback, useEffect, useState } from 'react';
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, onClose, step]);

  const image = images[current];
  if (!image) return null;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={onClose}>
      <button
        type="button"
        className="lightbox-btn lightbox-close"
        aria-label="Close image preview"
        onClick={onClose}
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
