/** Image formats the Files panel previews as a picture instead of decoding the bytes as text.
 *  Shared so the renderer picks the image read and the main process serves only these types. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml'
};

/** The MIME type for a previewable image path, or undefined when the extension is not one. */
export function imageMimeType(filePath: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase();
  return ext ? IMAGE_MIME[ext] : undefined;
}

/** One image read for the Files panel: base64 bytes, or `tooLarge` with no data past the cap. */
export interface WorkspaceImage {
  mimeType: string;
  data: string;
  size: number;
  tooLarge: boolean;
}
