import React from 'react';
import type { FileAttachment, ImageAttachment } from '../../shared/types';
import { Icon } from './components/ui';

/** Limit raw file bytes before base64 expansion and IPC transport. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function encodeFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function readAttachments(list: Iterable<File>, onError: (message: string) => void): Promise<{ images: ImageAttachment[]; files: FileAttachment[] }> {
  const images: ImageAttachment[] = [];
  const files: FileAttachment[] = [];
  for (const file of list) {
    if (file.size === 0) {
      onError(`${file.name} is empty and cannot be attached.`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      onError(`${file.name} is larger than the 10 MB attachment limit.`);
      continue;
    }
    try {
      const data = await encodeFile(file);
      if (file.type.startsWith('image/')) images.push({ name: file.name, mimeType: file.type, data });
      else files.push({ name: file.name, mimeType: file.type || 'application/octet-stream', data });
    } catch (error) {
      onError(`Could not attach ${file.name}: ${String((error as Error).message ?? error)}`);
    }
  }
  return { images, files };
}

export function FileAttachmentChips({ files, onRemove }: { files: FileAttachment[]; onRemove: (index: number) => void }) {
  if (!files.length) return null;
  return <div className="attachments file-attachments">{files.map((file, index) =>
    <div className="file-attachment" key={index} title={file.name}>
      <Icon name="file" size={14} />
      <span>{file.name}</span>
      <button type="button" onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`} title={`Remove ${file.name}`}><Icon name="x" size={12} /></button>
    </div>
  )}</div>;
}
