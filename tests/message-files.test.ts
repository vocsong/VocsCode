import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { promptWithFiles, retainMessageFiles } from '../src/main/message-files';

let root = '';
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = ''; });

it('retains uploaded bytes outside the checkout and gives the harness readable paths', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-attachments-'));
  const files = await retainMessageFiles(root, [
    { name: '../notes.txt', mimeType: 'text/plain', data: Buffer.from('first note').toString('base64') },
    { name: 'report.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-test').toString('base64') }
  ]);
  expect(files).toHaveLength(2);
  expect(files.map((f) => f.name)).toEqual(['.._notes.txt', 'report.pdf']);
  expect(files.every((f) => f.path.startsWith(path.join(root, 'attachments') + path.sep))).toBe(true);
  expect(await Promise.all(files.map((f) => fs.readFile(f.path, 'utf8')))).toEqual(['first note', '%PDF-test']);
  expect(promptWithFiles('Please inspect', files)).toContain(JSON.stringify(files[1].path));
});

it('removes earlier files when a later write fails', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-attachments-'));
  const original = fs.writeFile.bind(fs);
  const writer = vi.spyOn(fs, 'writeFile')
    .mockImplementationOnce((...args) => original(...args))
    .mockRejectedValueOnce(new Error('disk full'));
  try {
    const file = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('content').toString('base64') };
    await expect(retainMessageFiles(root, [file, file])).rejects.toThrow('disk full');
    expect(await fs.readdir(path.join(root, 'attachments'))).toEqual([]);
  } finally {
    writer.mockRestore();
  }
});

it('rejects malformed or oversized input without retaining any part of a batch', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-attachments-'));
  const good = { name: 'good.txt', mimeType: 'text/plain', data: Buffer.from('ok').toString('base64') };
  await expect(retainMessageFiles(root, [good, { ...good, data: 'not-base64' }])).rejects.toThrow('Invalid file attachment');
  await expect(retainMessageFiles(root, [{ ...good, data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }])).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});
