/** Desktop-only hydration of inert transcript image placeholders; never changes cached HTML. */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { imageMimeType, type WorkspaceImage } from '../../shared/image-files';
import { invoke, isWeb } from './api';
import { workspaceRelativePath } from './file-refs';
import type { LightboxImage } from './components/ImageLightbox';

// Automatic previews are deliberately smaller than the manual Files preview's 20 MB cap.
// Keep failures too: a growing stream must not repeatedly read the same oversized file.
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DATA_CHARS = 8 * 1024 * 1024;

function localPath(cwd: string, raw: string): string | null {
  let path: string;
  try { path = decodeURIComponent(raw).trim().replace(/\\/g, '/'); } catch { return null; }
  if (!path || path.length > 4096 || /[\x00-\x1f\x7f%?#]/.test(path) || path.startsWith('//')) return null;
  // Only a drive prefix may contain a colon; URL/custom schemes and drive-relative paths fail.
  if ((/^[a-z]:\//i.test(path) ? path.slice(2) : path).includes(':')) return null;
  const rel = workspaceRelativePath(cwd, path);
  return rel && imageMimeType(rel) ? rel : null;
}

function dataSource(image: WorkspaceImage | null, path: string): string | null {
  if (!image || image.tooLarge || image.mimeType !== imageMimeType(path) || !Number.isFinite(image.size) || image.size <= 0 || image.size > MAX_IMAGE_BYTES) return null;
  if (!image.data || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return null;
  return `data:${image.mimeType};base64,${image.data}`;
}

export function useMarkdownImages(html: string, sessionId: string, cwd: string | undefined, onImageExpand: (images: LightboxImage[], index: number) => void) {
  const root = useRef<HTMLDivElement>(null);
  const scope = useMemo(() => ({ cache: new Map<string, Promise<string | null>>(), chars: 0, active: true, generation: 0, queue: Promise.resolve() }), [sessionId, cwd]);
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      scope.generation++;
      scope.chars = 0;
      scope.cache.clear();
    };
  }, [scope]);
  useLayoutEffect(() => {
    const body = root.current;
    if (!body || isWeb || !cwd) return;
    let live = true;
    for (const placeholder of body.querySelectorAll<HTMLElement>('[data-local-image]')) {
      const alt = placeholder.getAttribute('data-image-alt') || 'Image';
      const unavailable = () => { placeholder.textContent = `${alt} (image unavailable)`; };
      unavailable();
      const path = localPath(cwd, placeholder.getAttribute('data-local-image') ?? '');
      if (!path) continue;
      let pending = scope.cache.get(path);
      if (!pending) {
        if (scope.cache.size >= MAX_IMAGES) continue;
        // Serialize reads so a message cannot have eight 20 MB IPC responses in flight.
        // React can replay a mount; a revived scope must not revive its retired queue entries.
        const generation = scope.generation;
        pending = scope.queue.then(async () => {
          if (!scope.active || scope.generation !== generation || scope.chars >= MAX_DATA_CHARS) return null;
          try {
            const src = dataSource(await invoke('fs:readImage', { sessionId, path }), path);
            if (!scope.active || scope.generation !== generation || !src || scope.chars + src.length > MAX_DATA_CHARS) return null;
            scope.chars += src.length;
            return src;
          } catch { return null; }
        });
        scope.cache.set(path, pending);
        scope.queue = pending.then(() => undefined);
      }
      placeholder.textContent = `${alt} (Loading image…)`;
      void pending.then((src) => {
        if (!live || !scope.active || root.current !== body || !body.contains(placeholder)) return;
        if (!src) { unavailable(); return; }
        const image = document.createElement('img');
        image.alt = alt;
        image.style.maxWidth = '100%';
        image.style.height = 'auto';
        image.onerror = () => {
          if (!live || !scope.active) return;
          scope.cache.set(path, Promise.resolve(null));
          unavailable();
        };
        image.src = src;
        image.draggable = false;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'msg-image-btn';
        button.setAttribute('aria-label', `Preview ${alt}`);
        button.title = 'View full image';
        button.onclick = (event) => {
          // A screenshot can itself be a link; previewing must not activate its parent.
          event.preventDefault();
          event.stopPropagation();
          if (!live || !scope.active) return;
          // Read the current DOM order, not async completion order or an older streaming prefix.
          const images = Array.from(body.querySelectorAll<HTMLImageElement>('[data-local-image] .msg-image-btn img'));
          const index = images.indexOf(image);
          if (index >= 0) onImageExpand(images.map((img) => ({ src: img.src, name: img.alt })), index);
        };
        button.onkeydown = (event) => {
          // Keep native button activation, but bypass delegated file-link keyboard handlers.
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
        };
        button.append(image);
        placeholder.replaceChildren(button);
      });
    }
    return () => { live = false; };
  }, [html, scope, sessionId, cwd, onImageExpand]);
  return root;
}
