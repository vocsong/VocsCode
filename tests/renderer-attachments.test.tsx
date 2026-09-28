/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readAttachments, MAX_ATTACHMENT_BYTES } from '../src/renderer/src/attachments';

const invoke = vi.fn().mockRejectedValue(new Error('send failed'));
(window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke, on: vi.fn().mockReturnValue(() => undefined) };

import { Composer } from '../src/renderer/src/components/Composer';
import type { SessionMeta } from '../src/shared/types';

const session = {
  id: 'file-test', title: 'File test', status: 'idle', config: { harness: 'native', projectRoot: '.', permissionMode: 'ask' },
  cwd: '.', harnessRef: {}, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }
} as unknown as SessionMeta;

describe('renderer attachments', () => {
  it('encodes images separately from files and rejects oversized files without reading them', async () => {
    const large = new File(['x'], 'large.pdf', { type: 'application/pdf' });
    Object.defineProperty(large, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    const read = vi.spyOn(large, 'arrayBuffer');
    const empty = new File([], 'empty.txt', { type: 'text/plain' });
    const readEmpty = vi.spyOn(empty, 'arrayBuffer');
    const errors: string[] = [];
    const result = await readAttachments([
      new File(['photo'], 'photo.png', { type: 'image/png' }),
      new File(['hello'], 'notes.txt', { type: 'text/plain' }), empty, large
    ], (message) => errors.push(message));
    expect(result.images).toEqual([{ name: 'photo.png', mimeType: 'image/png', data: btoa('photo') }]);
    expect(result.files).toEqual([{ name: 'notes.txt', mimeType: 'text/plain', data: btoa('hello') }]);
    expect(errors).toEqual(['empty.txt is empty and cannot be attached.', 'large.pdf is larger than the 10 MB attachment limit.']);
    expect(readEmpty).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps a file chip and draft when a session send fails', async () => {
    invoke.mockClear();
    const view = render(<Composer session={session} />);
    const picker = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] } });
    await screen.findByText('notes.txt');
    fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'read this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:send', {
      id: 'file-test', input: { text: 'read this', images: undefined, files: [{ name: 'notes.txt', mimeType: 'text/plain', data: btoa('hello') }], mode: 'now' }
    }));
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy());
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('read this');
    view.unmount();
  });
});
