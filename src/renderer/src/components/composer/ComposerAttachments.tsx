/** Composer attachment strips, text-only model vision warning, and image base64 encoder. */
import React from 'react';
import type { FileAttachment, ImageAttachment } from '../../../../shared/types';
import { FileAttachmentChips } from '../../attachments';
import { Button, Icon } from '../ui';

export interface VisionWarningInfo {
  model: string;
  detail: string;
}

export function ComposerAttachments({
  images,
  files,
  visionWarning,
  onMarkVisionCapable,
  onRemoveImage,
  onRemoveFile
}: {
  images: ImageAttachment[];
  files: FileAttachment[];
  visionWarning: VisionWarningInfo | null;
  onMarkVisionCapable: () => void;
  onRemoveImage: (index: number) => void;
  onRemoveFile: (index: number) => void;
}) {
  return (
    <>
      {images.length > 0 && (
        <>
          {visionWarning && (
            <div className="composer-warn">
              <Icon name="alert" size={14} />
              <span>
                <strong>{visionWarning.model}</strong> is listed as text-only. {visionWarning.detail}
              </span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={onMarkVisionCapable} title="Record an override in Settings → Providers so this model is treated as vision-capable">
                It does accept images
              </Button>
            </div>
          )}
          <div className="attachments">
            {images.map((im, i) => (
              <div key={i} className="attachment">
                <img src={`data:${im.mimeType};base64,${im.data}`} alt={im.name ?? 'image'} />
                <button type="button" onClick={() => onRemoveImage(i)} aria-label="Remove">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <FileAttachmentChips files={files} onRemove={onRemoveFile} />
    </>
  );
}

export async function fileToAttachment(f: File): Promise<ImageAttachment> {
  const buf = await f.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mimeType: f.type || 'image/png', data: btoa(binary), name: f.name };
}
