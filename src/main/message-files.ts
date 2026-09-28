import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AttachedFile, FileAttachment } from '../shared/types';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** Store uploads outside the checkout (and therefore outside git), but in the session lifetime. */
export async function retainMessageFiles(sessionDir: string, files: FileAttachment[] = []): Promise<AttachedFile[]> {
  if (files.length > 10) throw new Error('Attach at most 10 files per message.');
  const validated = files.map((file) => {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 ||
        typeof file.mimeType !== 'string' || file.mimeType.length > 200 ||
        typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
      throw new Error('Invalid file attachment.');
    }
    const bytes = Buffer.from(file.data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== file.data) throw new Error('Invalid or oversized file attachment.');
    // Never use an upload name to form a filesystem path or let control characters into prompts.
    const name = file.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim();
    if (!name) throw new Error('Invalid file name.');
    return { bytes, name, mimeType: file.mimeType };
  });
  if (validated.reduce((n, file) => n + file.bytes.length, 0) > MAX_TOTAL_BYTES) throw new Error('Attachments exceed 30 MB per message.');
  if (!validated.length) return [];
  const dir = path.join(sessionDir, 'attachments');
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  try {
    const result: AttachedFile[] = [];
    for (const file of validated) {
      const destination = path.join(dir, `${randomUUID()}-${file.name}`);
      await fs.writeFile(destination, file.bytes, { flag: 'wx' });
      written.push(destination);
      result.push({ name: file.name, mimeType: file.mimeType, path: destination });
    }
    return result;
  } catch (error) {
    await Promise.all(written.map((file) => fs.rm(file, { force: true })));
    throw error;
  }
}

export function promptWithFiles(text: string, files: AttachedFile[]): string {
  if (!files.length) return text;
  return `${text}${text ? '\n\n' : ''}Attached files (read these local paths to inspect their contents):\n${files.map((file) => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`).join('\n')}`;
}
