/**
 * File mentions in transcript replies become links that open the file in the right panel's Files
 * tab: recognition, sanitisation, click/keyboard activation, and the panel round trip.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { installMarkdownHandlers, renderMarkdown } from '../src/renderer/src/markdown';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const session = {
  id: 's_files',
  title: 'Files',
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' },
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
} as SessionMeta;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useStore.setState({
    sessions: [session],
    activeId: session.id,
    transcripts: {},
    loaded: {},
    transcriptErrors: {},
    toasts: [],
    panelTab: 'changes',
    fileReveal: null,
    view: 'chat'
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe('renderMarkdown file references', () => {
  it('marks inline code that looks like a file when file links are on', () => {
    const html = renderMarkdown('Updated `src/renderer/src/store.ts` and `README.md`.', { fileLinks: true });
    expect(html).toContain('data-file="src/renderer/src/store.ts"');
    expect(html).toContain('data-file="README.md"');
    expect(html).toContain('file-ref');
  });

  it('carries the line number of a `:line` mention', () => {
    const html = renderMarkdown('See `src/main/handlers.ts:136:7`.', { fileLinks: true });
    expect(html).toContain('data-file="src/main/handlers.ts"');
    expect(html).toContain('data-line="136"');
  });

  it('turns a relative markdown link into a file reference', () => {
    const html = renderMarkdown('See [the store](src/store.ts).', { fileLinks: true });
    expect(html).toContain('data-file="src/store.ts"');
  });

  it('leaves ordinary code and external links alone', () => {
    const plain = renderMarkdown('Run `npm run build` first.');
    expect(plain).not.toContain('data-file');
    const external = renderMarkdown('[docs](https://example.com/docs)', { fileLinks: true });
    expect(external).toContain('href="https://example.com/docs"');
    expect(external).not.toContain('data-file');
  });
});

describe('installMarkdownHandlers file activation', () => {
  it('opens a code-span reference on click and on Enter', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('`src/store.ts`', { fileLinks: true });
    document.body.appendChild(root);
    const openFile = vi.fn();
    const off = installMarkdownHandlers(root, vi.fn(), openFile);
    const ref = root.querySelector('.file-ref')!;

    fireEvent.click(ref);
    expect(openFile).toHaveBeenCalledWith('src/store.ts', undefined);
    fireEvent.keyDown(ref, { key: 'Enter' });
    expect(openFile).toHaveBeenCalledTimes(2);
    off();
    root.remove();
  });

  it('opens a markdown-link reference from the keyboard too', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('[the store](src/store.ts:9)', { fileLinks: true });
    document.body.appendChild(root);
    const openFile = vi.fn();
    const off = installMarkdownHandlers(root, vi.fn(), openFile);
    const ref = root.querySelector('a.file-ref')!;

    expect(ref.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(ref, { key: 'Enter' });
    expect(openFile).toHaveBeenCalledWith('src/store.ts', 9);
    off();
    root.remove();
  });
});

describe('file mentions open the Files panel', () => {
  it('a clicked mention switches to the Files tab and reveals the path', async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'It lives in `src/hello.ts:30`.' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });

    render(<Transcript session={session} />);
    fireEvent.click(await screen.findByText('src/hello.ts:30'));

    expect(useStore.getState().panelTab).toBe('files');
    expect(useStore.getState().fileReveal).toEqual({ sessionId: session.id, path: 'src/hello.ts', line: 30 });
  });

  it('the Files tab previews the revealed file, scrolls to its line and clears the request', async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'It lives in `src/hello.ts:30`.' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'fs:read') return Promise.resolve({ content: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'), truncated: false });
      return Promise.resolve({});
    });

    render(<Transcript session={session} />);
    fireEvent.click(await screen.findByText('src/hello.ts:30'));
    cleanup();
    const { container } = render(<RightPanel session={session} />);

    expect(invokeMock).toHaveBeenCalledWith('fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 });
    await waitFor(() => expect(container.querySelector('.file-preview-head .mono')?.textContent).toBe('src/hello.ts'));
    expect(await screen.findByText(/line 30/)).toBeTruthy();
    await waitFor(() => expect((container.querySelector('.file-preview pre') as HTMLPreElement).scrollTop).toBeGreaterThan(0));
    expect(useStore.getState().fileReveal).toBeNull();
  });

  it('resolves an absolute mention inside the session folder', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'G:/proj/a/src/hello.ts' } });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'fs:read') return Promise.resolve({ content: 'hello', truncated: false });
      return Promise.resolve({});
    });

    render(<RightPanel session={session} />);

    expect(invokeMock).toHaveBeenCalledWith('fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 });
  });

  it('refuses a mention outside the session folder without reading it', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'G:/elsewhere/secrets.ts' } });
    invokeMock.mockImplementation((channel: string) => (channel === 'fs:list' ? Promise.resolve([]) : Promise.resolve({})));

    render(<RightPanel session={session} />);

    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.kind === 'error')).toBe(true));
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
  });
});
