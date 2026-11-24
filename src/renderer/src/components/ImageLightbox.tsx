// Fullscreen viewer for transcript images, with wheel zoom and bounded panning.
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeContextMenu } from './ContextMenu';
import { showImageContextMenu } from './image-context-menu';
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

type Point = { x: number; y: number };
type ImageView = Point & { scale: number };
type Geometry = { width: number; height: number; fitWidth: number; fitHeight: number };

const FIT: ImageView = { x: 0, y: 0, scale: 1 };
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

function panLimits(scale: number, { width, height, fitWidth, fitHeight }: Geometry): Point {
  return {
    x: Math.max(0, (fitWidth * scale - width) / 2),
    y: Math.max(0, (fitHeight * scale - height) / 2),
  };
}

function constrain(view: ImageView, geometry: Geometry): ImageView {
  const limit = panLimits(view.scale, geometry);
  const x = Math.max(-limit.x, Math.min(limit.x, view.x));
  const y = Math.max(-limit.y, Math.min(limit.y, view.y));
  return x === view.x && y === view.y ? view : { ...view, x, y };
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
  const image = images[current];
  const imageSrc = image?.src;
  const dialog = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [view, setView] = useState(FIT);
  const drag = useRef<(Point & { id: number }) | null>(null);
  const [dragging, setDragging] = useState(false);

  // The fitted <img> keeps its layout size; transforms only affect what is painted.
  useLayoutEffect(() => {
    const stage = viewport.current;
    const img = picture.current;
    if (!stage || !img) return;
    const measure = () => {
      const { width, height } = stage.getBoundingClientRect();
      const style = getComputedStyle(img);
      const fitWidth = Number.parseFloat(style.width);
      const fitHeight = Number.parseFloat(style.height);
      if (!width || !height || !img.naturalWidth || !fitWidth || !fitHeight) {
        setGeometry(null);
        return;
      }
      const next = { width, height, fitWidth, fitHeight };
      setGeometry(next);
      setView((previous) => constrain(previous, next));
    };
    measure();
    img.addEventListener('load', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    observer?.observe(img);
    return () => {
      img.removeEventListener('load', measure);
      observer?.disconnect();
    };
  }, [current, imageSrc]);

  const zoom = useCallback((factor: number, anchor: Point = { x: 0, y: 0 }) => {
    if (!geometry) return;
    setView((previous) => {
      const scale = Math.min(MAX_SCALE, previous.scale * factor);
      if (scale <= 1 + 1e-6) return FIT;
      if (scale === previous.scale) return previous;
      const ratio = scale / previous.scale;
      // Preserve the point under the cursor, except where it would expose a blank edge.
      return constrain({
        scale,
        x: anchor.x + (previous.x - anchor.x) * ratio,
        y: anchor.y + (previous.y - anchor.y) * ratio,
      }, geometry);
    });
  }, [geometry]);

  useLayoutEffect(() => {
    const el = dialog.current;
    const stage = viewport.current;
    if (!el || !stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const mode = e.deltaMode;
      const dy = e.deltaY;
      if (drag.current || !dy) return;
      const { left, top, width, height } = stage.getBoundingClientRect();
      const unit = mode === 1 ? 16 : mode === 2 ? height : 1;
      const delta = Math.max(-320, Math.min(320, dy * unit));
      const inside = e.clientX >= left && e.clientX <= left + width && e.clientY >= top && e.clientY <= top + height;
      zoom(Math.exp(-delta * 0.002), inside ? { x: e.clientX - left - width / 2, y: e.clientY - top - height / 2 } : undefined);
    };
    // React's delegated wheel listeners are passive; the preview must consume the wheel even at its limits.
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

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
    closeContextMenu();
    drag.current = null;
    setDragging(false);
    setView(FIT);
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

  if (!image) return null;
  const limits = geometry && panLimits(view.scale, geometry);
  const canPan = !!limits && (limits.x > 0 || limits.y > 0);
  const percent = Math.round(view.scale * 100);
  const caption = (image.name ?? 'Image') + (count > 1 ? ` (${current + 1}/${count})` : '');
  const closeOnBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.target === e.currentTarget || e.target === viewport.current) onClose();
  };
  const endDrag = (e: React.PointerEvent<HTMLImageElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div ref={dialog} className="lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={closeOnBackdrop}>
      <button type="button" className="lightbox-btn lightbox-close" aria-label="Close image preview" onClick={onClose}>
        <Icon name="x" size={18} />
      </button>
      {count > 1 && (
        <button type="button" className="lightbox-btn lightbox-prev" aria-label="Previous image" onClick={() => step(-1)}>
          <Icon name="chevron" size={20} />
        </button>
      )}
      <div ref={viewport} className="image-lightbox-viewport" data-dragging={dragging || undefined}>
        <img
          key={current}
          ref={picture}
          className="lightbox-img"
          src={image.src}
          alt={image.name ?? 'attachment'}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          data-can-pan={canPan || undefined}
          onContextMenu={showImageContextMenu}
          draggable={false}
          onPointerDown={(e) => {
            if (!e.isPrimary || e.button !== 0) return;
            // Capture on the image so releasing on the backdrop doesn't dismiss the viewer.
            e.currentTarget.setPointerCapture(e.pointerId);
            if (!canPan) return;
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
            setDragging(true);
          }}
          onPointerMove={(e) => {
            const previous = drag.current;
            if (!geometry || previous?.id !== e.pointerId) return;
            const dx = e.clientX - previous.x;
            const dy = e.clientY - previous.y;
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
            setView((v) => constrain({ ...v, x: v.x + dx, y: v.y + dy }, geometry));
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        />
      </div>
      {count > 1 && (
        <button type="button" className="lightbox-btn lightbox-next" aria-label="Next image" onClick={() => step(1)}>
          <Icon name="chevronRight" size={20} />
        </button>
      )}
      <div className="lightbox-footer">
        <div className="lightbox-zoom" role="group" aria-label="Zoom controls">
          <button type="button" className="lightbox-btn" aria-label="Zoom out" title="Zoom out" aria-disabled={!geometry || view.scale === FIT.scale} onClick={() => zoom(1 / ZOOM_STEP)}>
            <Icon name="minus" size={16} />
          </button>
          <button type="button" className="lightbox-btn lightbox-percent" aria-label="Reset zoom" aria-description={`${percent}% of fit`} title="Reset to fit" onClick={() => setView(FIT)}>
            {percent}%
          </button>
          <button type="button" className="lightbox-btn" aria-label="Zoom in" title="Zoom in" aria-disabled={!geometry || view.scale === MAX_SCALE} onClick={() => zoom(ZOOM_STEP)}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        <p className="lightbox-caption">
          <span className="lightbox-filename">{caption}</span>
          <span className="lightbox-hint">Scroll to zoom{canPan ? ' · Drag to pan' : ''}</span>
        </p>
      </div>
    </div>
  );
});
