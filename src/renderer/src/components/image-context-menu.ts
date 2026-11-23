import type { MouseEvent } from 'react';
import { useStore } from '../store';
import { showContextMenu } from './ContextMenu';

const PNG = 'image/png';

async function copyImage(image: HTMLImageElement) {
  const toast = useStore.getState().toast;
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image clipboard unavailable');

    // Copy the decoded pixels at their original size, not the scaled preview or its URL.
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create an image canvas');
    context.drawImage(image, 0, 0);

    // Start the clipboard write during the menu click; PNG encoding can finish asynchronously.
    const png = canvas.convertToBlob({ type: PNG });
    await Promise.all([png, clipboard.write([new ClipboardItem({ [PNG]: png })])]);
    toast('Image copied', 'success');
  } catch {
    toast('Could not copy the image', 'error');
  }
}

export function showImageContextMenu(event: MouseEvent<HTMLImageElement>) {
  const image = event.currentTarget;
  const src = image.src;
  showContextMenu(event, [{
    label: 'Copy image',
    icon: 'copy',
    disabled: !image.complete || !image.naturalWidth,
    onSelect: () => {
      // A preview can reuse this element for another file while the menu is open.
      if (image.isConnected && image.src === src) void copyImage(image);
    },
  }]);
}
