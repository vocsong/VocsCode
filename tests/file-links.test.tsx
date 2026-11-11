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

import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('resolves a shortened worktree reference before reading and keeps its line number', async () => {
    const worktree = { ...session, cwd: 'G:/proj/a/.vocs-code/worktrees/task' };
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'See `tools.ts:30`.' }];
    useStore.setState({ sessions: [worktree], transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: 'src/app/api/mcp/tools.ts' };
      if (channel === 'fs:list') return [];
      if (channel === 'fs:read') return { content: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'), truncated: false };
      return {};
    });
    render(<Transcript session={worktree} />);
    fireEvent.click(await screen.findByText('tools.ts:30'));
    cleanup();
    const { container } = render(<RightPanel session={worktree} />);
    await waitFor(() => expect(container.querySelector('.file-preview-head .mono')?.textContent).toBe('src/app/api/mcp/tools.ts'));
    expect(invokeMock).toHaveBeenCalledWith('fs:resolve', { sessionId: session.id, path: 'tools.ts' });
    expect(invokeMock).toHaveBeenCalledWith('fs:read', { sessionId: session.id, path: 'src/app/api/mcp/tools.ts', maxBytes: 200_000 });
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.objectContaining({ path: 'tools.ts' }));
    expect(invokeMock).toHaveBeenCalledWith('fs:list', { sessionId: session.id, relPath: 'src/app/api/mcp' });
    await waitFor(() => expect((container.querySelector('.file-preview pre') as HTMLPreElement).scrollTop).toBeGreaterThan(0));
  });

  it('asks which full path to open when a basename is ambiguous, without reading either first', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'tools.ts', line: 30 } });
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'ambiguous', paths: ['src/api/tools.ts', 'src/lib/tools.ts'] };
      if (channel === 'fs:list') return [];
      if (channel === 'fs:read') return { content: Array.from({ length: 60 }, (_, i) => `chosen ${i + 1}`).join('\n'), truncated: false };
      return {};
    });
    const { container } = render(<RightPanel session={session} />);
    const chooser = await screen.findByRole('region', { name: 'Choose a file' });
    expect(chooser.querySelectorAll('.file-row')).toHaveLength(2);
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'src/lib/tools.ts' }));
    await waitFor(() => expect(container.querySelector('.file-preview-head .mono')?.textContent).toBe('src/lib/tools.ts'));
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'fs:read')).toEqual([
      ['fs:read', { sessionId: session.id, path: 'src/lib/tools.ts', maxBytes: 200_000 }]
    ]);
    expect(screen.queryByRole('region', { name: 'Choose a file' })).toBeNull();
    await waitFor(() => expect((container.querySelector('.file-preview pre') as HTMLPreElement).scrollTop).toBeGreaterThan(0));
  });

  it('cancels an ambiguous reference without opening any candidate', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'tools.ts' } });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve'
      ? { status: 'ambiguous', paths: ['src/api/tools.ts', 'src/lib/tools.ts'] } : []);
    render(<RightPanel session={session} />);
    await screen.findByRole('region', { name: 'Choose a file' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Choose a file' })).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
  });

  it.each(['missing', 'incomplete'])('does not read a guessed path after a %s lookup', async (status) => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'api/tools.ts' } });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? { status } : []);
    const { container } = render(<RightPanel session={session} />);
    await waitFor(() => expect(useStore.getState().toasts).toHaveLength(1));
    expect(useStore.getState().toasts[0].text).toMatch(status === 'missing' ? /api\/tools.ts was not found in/ : /full.*path/i);
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('fs:list', expect.objectContaining({ relPath: 'api' }));
    expect(container.querySelector('.file-preview')).toBeNull();
  });

  it('ignores an older resolution when a newer reference has already opened', async () => {
    let resolveOld!: (result: unknown) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'old.ts' } });
    invokeMock.mockImplementation(async (channel: string, request: { path?: string }) => {
      if (channel === 'fs:resolve') return request.path === 'old.ts' ? old : { status: 'resolved', path: 'src/new.ts' };
      if (channel === 'fs:read') return { content: 'new content', truncated: false };
      return [];
    });
    const { container } = render(<RightPanel session={session} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:resolve', expect.objectContaining({ path: 'old.ts' })));
    act(() => useStore.getState().revealFile(session.id, 'new.ts'));
    await waitFor(() => expect(container.querySelector('.file-preview-head .mono')?.textContent).toBe('src/new.ts'));
    await act(async () => { resolveOld({ status: 'resolved', path: 'src/old.ts' }); await old; });
    expect(useStore.getState().fileReveal).toBeNull();
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'fs:read')).toEqual([
      ['fs:read', { sessionId: session.id, path: 'src/new.ts', maxBytes: 200_000 }]
    ]);
  });

  it('resolves only once under StrictMode and still opens the file', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'tools.ts' } });
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: 'src/tools.ts' };
      if (channel === 'fs:read') return { content: 'strict preview', truncated: false };
      return [];
    });
    render(<StrictMode><RightPanel session={session} /></StrictMode>);
    await screen.findByText('strict preview');
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'fs:resolve')).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'fs:read')).toHaveLength(1);
  });

  it('discards a pending resolution after navigating to a folder', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'tools.ts' } });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? pending : []);
    const { container } = render(<RightPanel session={session} />);
    await screen.findByRole('status');
    fireEvent.click(container.querySelector('.crumbs button')!);
    await act(async () => { resolve({ status: 'resolved', path: 'src/tools.ts' }); await pending; });
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
    expect(container.querySelector('.file-preview')).toBeNull();
  });

  it('discards a pending resolution after the active session changes', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'tools.ts' } });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? pending : []);
    const { rerender, container } = render(<RightPanel session={session} />);
    await screen.findByRole('status');
    rerender(<RightPanel session={{ ...session, id: 'other', cwd: 'G:/other' }} />);
    await act(async () => { resolve({ status: 'resolved', path: 'src/tools.ts' }); await pending; });
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
    expect(container.querySelector('.file-preview')).toBeNull();
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('retains exact-path opening when the transport does not offer resolution', async () => {
    const harness = window.harness as unknown as { can?: (channel: string) => boolean };
    harness.can = (channel) => channel !== 'fs:resolve';
    try {
      useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'src/tools.ts' } });
      invokeMock.mockImplementation(async (channel: string) => channel === 'fs:read' ? { content: 'legacy preview', truncated: false } : []);
      render(<RightPanel session={session} />);
      await screen.findByText('legacy preview');
      expect(invokeMock).not.toHaveBeenCalledWith('fs:resolve', expect.anything());
    } finally {
      delete harness.can;
    }
  });

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
    invokeMock.mockImplementation((channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return Promise.resolve({ status: 'resolved', path: request.path });
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'fs:read') return Promise.resolve({ content: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'), truncated: false });
      return Promise.resolve({});
    });

    render(<Transcript session={session} />);
    fireEvent.click(await screen.findByText('src/hello.ts:30'));
    cleanup();
    const { container } = render(<RightPanel session={session} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }));
    await waitFor(() => expect(container.querySelector('.file-preview-head .mono')?.textContent).toBe('src/hello.ts'));
    expect(await screen.findByText(/line 30/)).toBeTruthy();
    await waitFor(() => expect((container.querySelector('.file-preview pre') as HTMLPreElement).scrollTop).toBeGreaterThan(0));
    expect(useStore.getState().fileReveal).toBeNull();
  });

  it('previews an image file as a picture instead of decoded text', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'runs/hour_bias/window_bias.png' } });
    invokeMock.mockImplementation((channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return Promise.resolve({ status: 'resolved', path: request.path });
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'fs:readImage') return Promise.resolve({ mimeType: 'image/png', data: 'iVBORw0KGgo=', size: 8, tooLarge: false });
      return Promise.resolve({ content: '\u0089PNG garbage', truncated: false });
    });

    const { container } = render(<RightPanel session={session} />);

    const img = await waitFor(() => {
      const el = container.querySelector('.file-preview .file-image img');
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    });
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(container.querySelector('.file-preview pre')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('fs:readImage', { sessionId: session.id, path: 'runs/hour_bias/window_bias.png' });
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
  });

  it('says an oversized image is too large instead of rendering it', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'big.jpg' } });
    invokeMock.mockImplementation((channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return Promise.resolve({ status: 'resolved', path: request.path });
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'fs:readImage') return Promise.resolve({ mimeType: 'image/jpeg', data: '', size: 25_000_000, tooLarge: true });
      return Promise.resolve({});
    });

    const { container } = render(<RightPanel session={session} />);

    expect(await screen.findByText('Image is 25.0 MB, too large to preview.')).toBeTruthy();
    expect(container.querySelector('.file-preview img')).toBeNull();
  });

  it('resolves an absolute mention inside the session folder', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'G:/proj/a/src/hello.ts' } });
    invokeMock.mockImplementation((channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return Promise.resolve({ status: 'resolved', path: request.path });
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'fs:read') return Promise.resolve({ content: 'hello', truncated: false });
      return Promise.resolve({});
    });

    render(<RightPanel session={session} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }));
  });

  it('shows a file outside the session folder in File Explorer without reading it', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'G:/elsewhere/SideGuard-Q-2026-10.zip' } });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'app:showInFolder') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    render(<RightPanel session={session} />);

    // The file manager's name follows the platform, which the hoisted imports read before the stub above.
    await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([
      ['info', expect.stringMatching(/^Showing SideGuard-Q-2026-10\.zip in .+: files outside this session cannot be previewed here$/)]
    ]));
    expect(invokeMock).toHaveBeenCalledWith('app:showInFolder', { sessionId: session.id, path: 'G:/elsewhere/SideGuard-Q-2026-10.zip' });
    expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
  });

  it('refuses a mention outside the session folder where the host cannot show it', async () => {
    const harness = window.harness as unknown as { can?: (channel: string) => boolean };
    harness.can = (channel) => channel !== 'app:showInFolder';
    try {
      useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'G:/elsewhere/secrets.ts' } });
      invokeMock.mockImplementation((channel: string) => (channel === 'fs:list' ? Promise.resolve([]) : Promise.resolve({})));

      render(<RightPanel session={session} />);

      await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['error', 'Cannot open files outside G:/proj/a']]));
      expect(invokeMock).not.toHaveBeenCalledWith('fs:read', expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith('app:showInFolder', expect.anything());
    } finally {
      delete harness.can;
    }
  });

  it('names a file missing from the session folder without the IPC wrapper or realpath noise', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'SideGuard-Q-2026-10.zip' } });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'fs:list') return Promise.resolve([]);
      // What Electron hands the renderer when the handler throws (for example a missing checkout).
      if (channel === 'fs:resolve') return Promise.reject(new Error("Error invoking remote method 'fs:resolve': Error: SideGuard-Q-2026-10.zip was not found in G:\\proj\\a"));
      return Promise.resolve({});
    });

    const { container } = render(<RightPanel session={session} />);

    await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['error', 'SideGuard-Q-2026-10.zip was not found in G:\\proj\\a']]));
    expect(container.querySelector('.file-preview')).toBeNull();
  });

  it('says a binary file has no text preview and offers its folder instead', async () => {
    useStore.setState({ panelTab: 'files', fileReveal: { sessionId: session.id, path: 'dist/bundle.zip' } });
    invokeMock.mockImplementation((channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return Promise.resolve({ status: 'resolved', path: request.path });
      if (channel === 'fs:list') return Promise.resolve([]);
      if (channel === 'fs:read') return Promise.resolve({ content: '', truncated: false, binary: true });
      if (channel === 'app:showInFolder') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    const { container } = render(<RightPanel session={session} />);

    expect(await screen.findByText('Binary file, no text preview.')).toBeTruthy();
    expect(container.querySelector('.file-preview pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Show in / }));
    expect(invokeMock).toHaveBeenCalledWith('app:showInFolder', { sessionId: session.id, path: 'G:/proj/a/dist/bundle.zip' });
  });
});
