/**
 * File mentions in transcript replies become links that preview the file in the split view, beside
 * the session that named it: recognition, sanitisation, click/keyboard activation, and the round
 * trip through the store into the file pane. Links nothing can open must not look clickable.
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
import { FilePreviewPane } from '../src/renderer/src/components/FilePreviewPane';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { installMarkdownHandlers, renderMarkdown, type MarkdownOptions } from '../src/renderer/src/markdown';
import { filePane, singlePaneLayout } from '../src/renderer/src/panes';
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

/** The file pane as SessionPanes mounts it: whatever the layout's file pane currently is. */
function Pane() {
  const pane = useStore((s) => filePane(s.layout));
  return pane ? <FilePreviewPane pane={pane} size={0.5} split /> : null;
}
const target = () => filePane(useStore.getState().layout)?.file;
const reads = () => invokeMock.mock.calls.filter(([channel]) => channel === 'fs:read');
const lines = (prefix: string) => Array.from({ length: 60 }, (_, i) => `${prefix} ${i + 1}`).join('\n');

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useStore.setState({
    sessions: [session],
    activeId: session.id,
    layout: singlePaneLayout(session.id),
    missions: {},
    transcripts: {},
    loaded: {},
    transcriptErrors: {},
    toasts: [],
    panelTab: 'changes',
    panelOpen: false,
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

describe('every coloured link opens something', () => {
  const root = (md: string, opts: MarkdownOptions = { fileLinks: true }) => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown(md, opts);
    return el;
  };

  it.each([
    // Codex desktop writes Windows paths as URL paths, with the line after a colon.
    ['[static-models.ts](/G:/proj/a/src/main/models/static-models.ts:17)', 'G:/proj/a/src/main/models/static-models.ts', '17'],
    ['[a.ts](file:///G:/proj/a/src/a.ts)', 'G:/proj/a/src/a.ts', null],
    ['[my file](src/my%20file.ts)', 'src/my file.ts', null],
    ['[shot](<shots/Screenshot (2).png>)', 'shots/Screenshot (2).png', null],
    ['[range](src/a.ts#L10-L20)', 'src/a.ts', '10'],
    ['[range](src/a.ts:10-20)', 'src/a.ts', '10'],
    ['[guide](docs/guide.md#install)', 'docs/guide.md', null]
  ])('%s becomes a file link', (md, file, line) => {
    const a = root(md).querySelector('a')!;
    expect(a.getAttribute('data-file')).toBe(file);
    expect(a.getAttribute('data-line')).toBe(line);
    expect(a.getAttribute('tabindex')).toBe('0');
  });

  it.each(['[write](mailto:me@example.com)', '[jump](#usage)', '[up](../outside.ts)', '[folder](src/components)', '[app](vscode://file/G:/a.ts)', 'Mail me@example.com'])('%s renders as plain text, not a dead link', (md) => {
    const el = root(md);
    expect(el.querySelector('a')).toBeNull();
    expect(el.querySelector('.md-link-text')).toBeTruthy();
  });

  it('renders link text as markdown, with no nested file link inside it', () => {
    const el = root('[`store.ts`](src/renderer/src/store.ts) and [**bold** docs](https://example.com)');
    const file = el.querySelector('a.file-ref')!;
    expect(file.getAttribute('data-file')).toBe('src/renderer/src/store.ts');
    expect(file.querySelector('code')?.textContent).toBe('store.ts');
    expect(file.querySelector('[data-file]')).toBeNull();
    expect(file.textContent).not.toContain('`');
    expect(el.querySelector('a[href="https://example.com"] strong')?.textContent).toBe('bold');
  });

  it('a click inside a file link opens the link target, not the code span in its text', () => {
    const el = root('[`tools.ts`](src/app/api/mcp/tools.ts:4)');
    document.body.appendChild(el);
    const openFile = vi.fn();
    const off = installMarkdownHandlers(el, vi.fn(), openFile);
    fireEvent.click(el.querySelector('code')!);
    expect(openFile).toHaveBeenCalledWith('src/app/api/mcp/tools.ts', 4);
    off();
    el.remove();
  });

  it('resolves links inside a previewed markdown file against that file\'s folder', () => {
    const el = root('[arch](ARCHITECTURE.md) [code](../src/a.ts#L3) [out](../../x.ts)', { fileLinks: true, fileBase: 'docs' });
    const links = [...el.querySelectorAll('a.file-ref')].map((a) => [a.getAttribute('data-file'), a.getAttribute('data-line')]);
    expect(links).toEqual([['docs/ARCHITECTURE.md', null], ['src/a.ts', '3']]);
    expect(el.querySelectorAll('.md-link-text')).toHaveLength(1);
  });

  it('a plain renderer (skills, issue bodies) never leaves a dead coloured anchor', () => {
    const el = root('[setup](docs/setup.md) [site](https://example.com)', { fileLinks: false });
    expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(el.querySelector('.md-link-text')?.textContent).toBe('setup');
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

describe('file mentions preview in the split view', () => {
  it('a clicked mention opens a file pane beside its session, which stays the active pane', async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'It lives in `src/hello.ts:30`.' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });

    render(<Transcript session={session} />);
    fireEvent.click(await screen.findByText('src/hello.ts:30'));

    const layout = useStore.getState().layout;
    expect(layout.panes.map((p) => (p.file ? `file:${p.file.path}:${p.file.line}` : p.sessionId))).toEqual([session.id, 'file:src/hello.ts:30']);
    expect(layout.orientation).toBe('horizontal');
    expect(layout.activePaneId).toBe(layout.panes[0]!.id);
    expect(useStore.getState().activeId).toBe(session.id);
    // The preview is not in the right panel any more: nothing there switched or opened.
    expect(useStore.getState().panelTab).toBe('changes');
    expect(useStore.getState().panelOpen).toBe(false);
    expect(useStore.getState().fileReveal).toBeNull();
  });

  it("opens a Codex /G:/ link inside the session folder as a workspace path", async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'See [static-models.ts](/G:/proj/a/src/main/models/static-models.ts:17).' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    render(<Transcript session={session} />);
    fireEvent.click(await screen.findByRole('link', { name: 'static-models.ts' }));
    expect(target()).toMatchObject({ sessionId: session.id, path: 'src/main/models/static-models.ts', line: 17 });
  });

  it('previews the file, scrolls to its line, and keeps the session pane in charge', async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'It lives in `src/hello.ts:30`.' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: lines('line'), truncated: false };
      return {};
    });

    render(<><Transcript session={session} /><Pane /></>);
    fireEvent.click(await screen.findByText('src/hello.ts:30'));

    const pane = await screen.findByTestId('file-pane');
    await waitFor(() => expect(pane.querySelector('.file-preview-head .mono')?.textContent).toBe('src/hello.ts'));
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }]]);
    expect(await screen.findByText(/line 30/)).toBeTruthy();
    await waitFor(() => expect((pane.querySelector('.file-preview pre') as HTMLPreElement).scrollTop).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(useStore.getState().layout.panes.map((p) => p.sessionId)).toEqual([session.id]);
    expect(screen.queryByTestId('file-pane')).toBeNull();
  });

  it('resolves a shortened worktree reference before reading and keeps its line number', async () => {
    const worktree = { ...session, cwd: 'G:/proj/a/.vocs-code/worktrees/task' };
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'See `tools.ts:30`.' }];
    useStore.setState({ sessions: [worktree], transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: 'src/app/api/mcp/tools.ts' };
      if (channel === 'fs:read') return { content: lines('line'), truncated: false };
      return {};
    });
    render(<><Transcript session={worktree} /><Pane /></>);
    fireEvent.click(await screen.findByText('tools.ts:30'));
    const pane = await screen.findByTestId('file-pane');
    await waitFor(() => expect(pane.querySelector('.file-preview-head .mono')?.textContent).toBe('src/app/api/mcp/tools.ts'));
    expect(invokeMock).toHaveBeenCalledWith('fs:resolve', { sessionId: session.id, path: 'tools.ts' });
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/app/api/mcp/tools.ts', maxBytes: 200_000 }]]);
    await waitFor(() => expect((pane.querySelector('.file-preview pre') as HTMLPreElement).scrollTop).toBeGreaterThan(0));
  });

  it('asks which full path to open when a basename is ambiguous, without reading either first', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'ambiguous', paths: ['src/api/tools.ts', 'src/lib/tools.ts'] };
      if (channel === 'fs:read') return { content: lines('chosen'), truncated: false };
      return {};
    });
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts', 30));
    const chooser = await screen.findByRole('region', { name: 'Choose a file' });
    expect(chooser.querySelectorAll('.file-row')).toHaveLength(2);
    expect(reads()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'src/lib/tools.ts' }));
    const pane = screen.getByTestId('file-pane');
    await waitFor(() => expect(pane.querySelector('.file-preview-head .mono')?.textContent).toBe('src/lib/tools.ts'));
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/lib/tools.ts', maxBytes: 200_000 }]]);
    expect(screen.queryByRole('region', { name: 'Choose a file' })).toBeNull();
    await waitFor(() => expect((pane.querySelector('.file-preview pre') as HTMLPreElement).scrollTop).toBeGreaterThan(0));
  });

  it('cancelling an ambiguous reference closes the pane without opening any candidate', async () => {
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? { status: 'ambiguous', paths: ['src/api/tools.ts', 'src/lib/tools.ts'] } : {});
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await screen.findByRole('region', { name: 'Choose a file' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Choose a file' })).toBeNull();
    expect(useStore.getState().layout.panes).toHaveLength(1);
    expect(reads()).toHaveLength(0);
  });

  it.each(['missing', 'incomplete'])('does not read a guessed path after a %s lookup, and closes the empty pane', async (status) => {
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? { status } : {});
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'api/tools.ts'));
    await waitFor(() => expect(useStore.getState().toasts).toHaveLength(1));
    expect(useStore.getState().toasts[0].text).toMatch(status === 'missing' ? /^api\/tools.ts was not found in G:\/proj\/a$/ : /full.*path/i);
    expect(reads()).toHaveLength(0);
    await waitFor(() => expect(useStore.getState().layout.panes).toHaveLength(1));
    expect(screen.queryByTestId('file-pane')).toBeNull();
  });

  it('a failed request keeps the file already on screen', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return request.path === 'gone.ts' ? { status: 'missing' } : { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: 'first file', truncated: false };
      return {};
    });
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'src/first.ts'));
    await screen.findByText('first file');
    act(() => useStore.getState().revealFile(session.id, 'gone.ts'));
    await waitFor(() => expect(useStore.getState().toasts.map((t) => t.text)).toEqual(['gone.ts was not found in G:/proj/a']));
    expect(screen.getByText('first file')).toBeTruthy();
    expect(useStore.getState().layout.panes).toHaveLength(2);
  });

  it('ignores an older resolution when a newer reference has already opened', async () => {
    let resolveOld!: (result: unknown) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    invokeMock.mockImplementation(async (channel: string, request: { path?: string }) => {
      if (channel === 'fs:resolve') return request.path === 'old.ts' ? old : { status: 'resolved', path: 'src/new.ts' };
      if (channel === 'fs:read') return { content: 'new content', truncated: false };
      return {};
    });
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'old.ts'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:resolve', expect.objectContaining({ path: 'old.ts' })));
    act(() => useStore.getState().revealFile(session.id, 'new.ts'));
    const pane = screen.getByTestId('file-pane');
    await waitFor(() => expect(pane.querySelector('.file-preview-head .mono')?.textContent).toBe('src/new.ts'));
    await act(async () => { resolveOld({ status: 'resolved', path: 'src/old.ts' }); await old; });
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/new.ts', maxBytes: 200_000 }]]);
  });

  it('resolves only once under StrictMode and still opens the file', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: 'src/tools.ts' };
      if (channel === 'fs:read') return { content: 'strict preview', truncated: false };
      return {};
    });
    render(<StrictMode><Pane /></StrictMode>);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await screen.findByText('strict preview');
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'fs:resolve')).toHaveLength(1);
    expect(reads()).toHaveLength(1);
  });

  it('cancelling a pending lookup closes the pane and discards its result', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? pending : {});
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { resolve({ status: 'resolved', path: 'src/tools.ts' }); await pending; });
    expect(reads()).toHaveLength(0);
    expect(useStore.getState().layout.panes).toHaveLength(1);
  });

  it('discards a pending lookup once the session leaves the pane, which closes the preview', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const other = { ...session, id: 'other', cwd: 'G:/other' };
    useStore.setState({ sessions: [session, other] });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? pending : []);
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await screen.findByRole('status');
    await act(async () => { await useStore.getState().setActive(other.id); });
    expect(useStore.getState().layout.panes.map((p) => p.sessionId)).toEqual([other.id]);
    await act(async () => { resolve({ status: 'resolved', path: 'src/tools.ts' }); await pending; });
    expect(reads()).toHaveLength(0);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('retains exact-path opening when the transport does not offer resolution', async () => {
    const harness = window.harness as unknown as { can?: (channel: string) => boolean };
    harness.can = (channel) => channel !== 'fs:resolve';
    try {
      invokeMock.mockImplementation(async (channel: string) => channel === 'fs:read' ? { content: 'legacy preview', truncated: false } : {});
      render(<Pane />);
      act(() => useStore.getState().revealFile(session.id, 'src/tools.ts'));
      await screen.findByText('legacy preview');
      expect(invokeMock).not.toHaveBeenCalledWith('fs:resolve', expect.anything());
    } finally {
      delete harness.can;
    }
  });

  it('previews an image file as a picture instead of decoded text', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:readImage') return { mimeType: 'image/png', data: 'iVBORw0KGgo=', size: 8, tooLarge: false };
      return { content: '\u0089PNG garbage', truncated: false };
    });
    const { container } = render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'runs/hour_bias/window_bias.png'));
    const img = await waitFor(() => {
      const el = container.querySelector('.file-preview .file-image img');
      expect(el).toBeTruthy();
      return el as HTMLImageElement;
    });
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(container.querySelector('.file-preview pre')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('fs:readImage', { sessionId: session.id, path: 'runs/hour_bias/window_bias.png' });
    expect(reads()).toHaveLength(0);
  });

  it('says an oversized image is too large instead of rendering it', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:readImage') return { mimeType: 'image/jpeg', data: '', size: 25_000_000, tooLarge: true };
      return {};
    });
    const { container } = render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'big.jpg'));
    expect(await screen.findByText('Image is 25.0 MB, too large to preview.')).toBeTruthy();
    expect(container.querySelector('.file-preview img')).toBeNull();
  });

  it('resolves an absolute mention inside the session folder', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: 'hello', truncated: false };
      return {};
    });
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'G:/proj/a/src/hello.ts'));
    await waitFor(() => expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }]]));
  });

  it('shows a file outside the session folder in File Explorer without reading it or opening a pane', async () => {
    invokeMock.mockImplementation(async (channel: string) => (channel === 'app:showInFolder' ? { ok: true } : {}));
    act(() => useStore.getState().revealFile(session.id, 'G:/elsewhere/SideGuard-Q-2026-10.zip'));
    // The file manager's name follows the platform, which the hoisted imports read before the stub above.
    await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([
      ['info', expect.stringMatching(/^Showing SideGuard-Q-2026-10\.zip in .+: files outside this session cannot be previewed here$/)]
    ]));
    expect(invokeMock).toHaveBeenCalledWith('app:showInFolder', { sessionId: session.id, path: 'G:/elsewhere/SideGuard-Q-2026-10.zip' });
    expect(reads()).toHaveLength(0);
    expect(useStore.getState().layout.panes).toHaveLength(1);
  });

  it('refuses a mention outside the session folder where the host cannot show it', async () => {
    const harness = window.harness as unknown as { can?: (channel: string) => boolean };
    harness.can = (channel) => channel !== 'app:showInFolder';
    try {
      act(() => useStore.getState().revealFile(session.id, 'G:/elsewhere/secrets.ts'));
      await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['error', 'Cannot open files outside G:/proj/a']]));
      expect(reads()).toHaveLength(0);
      expect(invokeMock).not.toHaveBeenCalledWith('app:showInFolder', expect.anything());
      expect(useStore.getState().layout.panes).toHaveLength(1);
    } finally {
      delete harness.can;
    }
  });

  it('names a file missing from the session folder without the IPC wrapper or realpath noise', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      // What Electron hands the renderer when the handler throws (for example a missing checkout).
      if (channel === 'fs:resolve') throw new Error("Error invoking remote method 'fs:resolve': Error: SideGuard-Q-2026-10.zip was not found in G:\\proj\\a");
      return {};
    });
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'SideGuard-Q-2026-10.zip'));
    await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['error', 'SideGuard-Q-2026-10.zip was not found in G:\\proj\\a']]));
    await waitFor(() => expect(screen.queryByTestId('file-pane')).toBeNull());
  });

  it('says a binary file has no text preview and offers its folder instead', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: '', truncated: false, binary: true };
      if (channel === 'app:showInFolder') return { ok: true };
      return {};
    });
    const { container } = render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'dist/bundle.zip'));
    expect(await screen.findByText('Binary file, no text preview.')).toBeTruthy();
    expect(container.querySelector('.file-preview pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Show in / }));
    expect(invokeMock).toHaveBeenCalledWith('app:showInFolder', { sessionId: session.id, path: 'G:/proj/a/dist/bundle.zip' });
  });

  it('follows a link inside a previewed markdown file relative to that file', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return request.path === 'docs/guide.md' ? { content: 'Read [the code](../src/a.ts#L2).', truncated: false } : { content: 'code body', truncated: false };
      return {};
    });
    render(<Pane />);
    act(() => useStore.getState().revealFile(session.id, 'docs/guide.md'));
    fireEvent.click(await screen.findByRole('link', { name: 'the code' }));
    expect(target()).toMatchObject({ path: 'src/a.ts', line: 2 });
    await screen.findByText('code body');
    expect(useStore.getState().layout.panes).toHaveLength(2);
  });
});

describe('the Files tab browses and previews beside the conversation', () => {
  it('a file row opens its exact path in the file pane and marks the row', async () => {
    useStore.setState({ panelTab: 'files', panelOpen: true });
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:list') return [{ name: 'hello.ts', path: 'src/hello.ts', isDir: false, size: 12 }];
      if (channel === 'fs:read') return { content: 'row preview', truncated: false };
      return {};
    });
    render(<><RightPanel session={session} /><Pane /></>);
    const row = await screen.findByRole('button', { name: /hello\.ts/ });
    fireEvent.click(row);
    await screen.findByText('row preview');
    expect(target()).toMatchObject({ path: 'src/hello.ts', exact: true });
    expect(invokeMock).not.toHaveBeenCalledWith('fs:resolve', expect.anything());
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }]]);
    await waitFor(() => expect(row.className).toContain('active'));
    // The panel stays a browser: no preview inside it.
    expect(document.querySelector('.panel .file-preview')).toBeNull();
  });

  it('a folder mention opens the Files tab on that folder instead of a pane', async () => {
    invokeMock.mockImplementation(async (channel: string) => (channel === 'fs:list' ? [] : {}));
    act(() => useStore.getState().revealFile(session.id, 'src/main/harness/'));
    expect(useStore.getState()).toMatchObject({ panelTab: 'files', panelOpen: true, fileReveal: { sessionId: session.id, path: 'src/main/harness/' } });
    expect(useStore.getState().layout.panes).toHaveLength(1);
    render(<RightPanel session={session} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:list', { sessionId: session.id, relPath: 'src/main/harness' }));
    expect(useStore.getState().fileReveal).toBeNull();
  });
});
