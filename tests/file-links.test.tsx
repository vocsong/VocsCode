/**
 * File mentions in transcript replies become links that open the right-panel file preview:
 * recognition, sanitisation, click/keyboard activation, and the round trip through the store into
 * the file editor. Links nothing can open must not look clickable.
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
import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilePreviewPane } from '../src/renderer/src/components/FilePreviewPane';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { installMarkdownHandlers, renderMarkdown, type MarkdownOptions } from '../src/renderer/src/markdown';
import { singlePaneLayout } from '../src/renderer/src/panes';
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

const target = () => useStore.getState().layout.filePreview;
const reads = () => invokeMock.mock.calls.filter(([channel]) => channel === 'fs:read');
const writes = () => invokeMock.mock.calls.filter(([channel]) => channel === 'fs:writeText');
const findEditor = async () => EditorView.findFromDOM((await screen.findByRole('textbox', { name: 'File contents' })).closest<HTMLElement>('.cm-editor')!)!;
const expectEditor = async (text: string) => expect((await findEditor()).state.doc.toString()).toBe(text);
const changeEditor = (editor: EditorView, text: string) => act(() => editor.dispatch({
  changes: { from: 0, to: editor.state.doc.length, insert: text }, userEvent: 'input.type'
}));
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
const pressSave = (element: HTMLElement | EditorView) => fireEvent.keyDown(element instanceof EditorView ? element.contentDOM : element, { key: 's', ctrlKey: true });
const openExact = (path: string) => act(() => useStore.getState().revealFile(session.id, path, undefined, { exact: true }));
const lines = (prefix: string) => Array.from({ length: 60 }, (_, i) => `${prefix} ${i + 1}`).join('\n');

beforeEach(() => {
  // jsdom implements Range, but not its layout measurements. Real scrolling is checked in Electron.
  Range.prototype.getClientRects ??= () => document.createElement('div').getClientRects();
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
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

describe('file mentions open the right-panel preview', () => {
  it('opens Files for a clicked mention without changing the conversation layout', async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'It lives in `src/hello.ts:30`.' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    const before = useStore.getState().layout;

    render(<Transcript session={session} />);
    fireEvent.click(await screen.findByText('src/hello.ts:30'));

    expect(useStore.getState().layout).toEqual({
      ...before,
      filePreview: expect.objectContaining({ sessionId: session.id, path: 'src/hello.ts', line: 30 })
    });
    expect(useStore.getState()).toMatchObject({ activeId: session.id, panelTab: 'files', panelOpen: false, fileReveal: null });
  });

  it("opens a Codex /G:/ link inside the session folder as a workspace path", async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'See [static-models.ts](/G:/proj/a/src/main/models/static-models.ts:17).' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    render(<Transcript session={session} />);
    fireEvent.click(await screen.findByRole('link', { name: 'static-models.ts' }));
    expect(target()).toMatchObject({ sessionId: session.id, path: 'src/main/models/static-models.ts', line: 17 });
  });

  it('opens the source editor, positions the caret, and scrolls to the requested line', async () => {
    const items: TranscriptItem[] = [{ id: 'a1', kind: 'assistant', ts: 2, text: 'It lives in `src/hello.ts:30`.' }];
    useStore.setState({ transcripts: { [session.id]: items }, loaded: { [session.id]: true } });
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: lines('line'), truncated: false };
      return {};
    });

    render(<><Transcript session={session} /><FilePreviewPane /></>);
    fireEvent.click(await screen.findByText('src/hello.ts:30'));

    const editor = await findEditor();
    expect(screen.getByRole('region', { name: 'Preview: src/hello.ts' })).toBeTruthy();
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }]]);
    expect(editor.state.doc.toString()).toBe(lines('line'));
    const offset = editor.state.doc.line(30).from;
    expect(editor.state.selection.main.empty).toBe(true);
    expect(editor.state.selection.main.head).toBe(offset);

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(target()).toBeUndefined();
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
    render(<><Transcript session={worktree} /><FilePreviewPane /></>);
    fireEvent.click(await screen.findByText('tools.ts:30'));
    const editor = await findEditor();
    expect(screen.getByRole('region', { name: 'Preview: src/app/api/mcp/tools.ts' })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith('fs:resolve', { sessionId: session.id, path: 'tools.ts' });
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/app/api/mcp/tools.ts', maxBytes: 200_000 }]]);
    expect(editor.state.selection.main.head).toBe(editor.state.doc.line(30).from);
  });

  it('asks which full path to open when a basename is ambiguous, without reading either first', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'ambiguous', paths: ['src/api/tools.ts', 'src/lib/tools.ts'] };
      if (channel === 'fs:read') return { content: lines('chosen'), truncated: false };
      return {};
    });
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts', 30));
    const chooser = await screen.findByRole('region', { name: 'Choose a file' });
    expect(chooser.querySelectorAll('.file-row')).toHaveLength(2);
    expect(reads()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'src/lib/tools.ts' }));
    const editor = await findEditor();
    expect(screen.getByRole('region', { name: 'Preview: src/lib/tools.ts' })).toBeTruthy();
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/lib/tools.ts', maxBytes: 200_000 }]]);
    expect(screen.queryByRole('region', { name: 'Choose a file' })).toBeNull();
    expect(editor.state.selection.main.head).toBe(editor.state.doc.line(30).from);
  });

  it('cancelling an ambiguous reference closes the pane without opening any candidate', async () => {
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? { status: 'ambiguous', paths: ['src/api/tools.ts', 'src/lib/tools.ts'] } : {});
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await screen.findByRole('region', { name: 'Choose a file' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Choose a file' })).toBeNull();
    expect(target()).toBeUndefined();
    expect(reads()).toHaveLength(0);
  });

  it.each(['missing', 'incomplete'])('does not read a guessed path after a %s lookup and offers an inline retry', async (status) => {
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? { status } : {});
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'api/tools.ts'));
    expect((await screen.findByRole('alert')).textContent).toMatch(status === 'missing' ? /^api\/tools.ts was not found in G:\/proj\/a$/ : /full.*path/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(reads()).toHaveLength(0);
    expect(useStore.getState().toasts).toEqual([]);
    expect(target()?.path).toBe('api/tools.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByTestId('file-pane')).toBeNull();
  });

  it('a failed request keeps the file already on screen', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return request.path === 'gone.ts' ? { status: 'missing' } : { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: 'first file', truncated: false };
      return {};
    });
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'src/first.ts'));
    await expectEditor('first file');
    act(() => useStore.getState().revealFile(session.id, 'gone.ts'));
    expect((await screen.findByRole('alert')).textContent).toBe('gone.ts was not found in G:/proj/a');
    expect(screen.getByRole('region', { name: 'Preview: src/first.ts' })).toBeTruthy();
    await expectEditor('first file');
  });

  it('ignores an older resolution when a newer reference has already opened', async () => {
    let resolveOld!: (result: unknown) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    invokeMock.mockImplementation(async (channel: string, request: { path?: string }) => {
      if (channel === 'fs:resolve') return request.path === 'old.ts' ? old : { status: 'resolved', path: 'src/new.ts' };
      if (channel === 'fs:read') return { content: 'new content', truncated: false };
      return {};
    });
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'old.ts'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:resolve', expect.objectContaining({ path: 'old.ts' })));
    act(() => useStore.getState().revealFile(session.id, 'new.ts'));
    await expectEditor('new content');
    await act(async () => { resolveOld({ status: 'resolved', path: 'src/old.ts' }); await old; });
    expect(screen.getByRole('region', { name: 'Preview: src/new.ts' })).toBeTruthy();
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/new.ts', maxBytes: 200_000 }]]);
  });

  it('resolves only once under StrictMode and still opens the file', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: 'src/tools.ts' };
      if (channel === 'fs:read') return { content: 'strict preview', truncated: false };
      return {};
    });
    render(<StrictMode><FilePreviewPane /></StrictMode>);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await expectEditor('strict preview');
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'fs:resolve')).toHaveLength(1);
    expect(reads()).toHaveLength(1);
  });

  it('cancelling a pending lookup closes the pane and discards its result', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? pending : {});
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { resolve({ status: 'resolved', path: 'src/tools.ts' }); await pending; });
    expect(reads()).toHaveLength(0);
    expect(target()).toBeUndefined();
  });

  it('closes the preview and discards a pending lookup when its session leaves the layout', async () => {
    let resolve!: (result: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const other = { ...session, id: 'other', cwd: 'G:/other' };
    useStore.setState({ sessions: [session, other] });
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:resolve' ? pending : []);
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'tools.ts'));
    await screen.findByRole('status');
    await act(async () => { await useStore.getState().setActive(other.id); });
    expect(useStore.getState().layout.panes.map((p) => p.sessionId)).toEqual([other.id]);
    await act(async () => { resolve({ status: 'resolved', path: 'src/tools.ts' }); await pending; });
    expect(target()).toBeUndefined();
    expect(screen.queryByTestId('file-pane')).toBeNull();
    expect(reads()).toHaveLength(0);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('retains exact-path opening when the transport does not offer resolution', async () => {
    const harness = window.harness as unknown as { can?: (channel: string) => boolean };
    harness.can = (channel) => channel !== 'fs:resolve';
    try {
      invokeMock.mockImplementation(async (channel: string) => channel === 'fs:read' ? { content: 'legacy preview', truncated: false } : {});
      render(<FilePreviewPane />);
      act(() => useStore.getState().revealFile(session.id, 'src/tools.ts'));
      await expectEditor('legacy preview');
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
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'runs/hour_bias/window_bias.png'));
    const img = await screen.findByRole('img', { name: 'runs/hour_bias/window_bias.png' });
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(screen.queryByRole('textbox', { name: 'File contents' })).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('fs:readImage', { sessionId: session.id, path: 'runs/hour_bias/window_bias.png' });
    expect(reads()).toHaveLength(0);
  });

  it('says an oversized image is too large instead of rendering it', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:readImage') return { mimeType: 'image/jpeg', data: '', size: 25_000_000, tooLarge: true };
      return {};
    });
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'big.jpg'));
    expect(await screen.findByText('Image is 25.0 MB, too large to preview.')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'big.jpg' })).toBeNull();
  });

  it('resolves an absolute mention inside the session folder', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: 'hello', truncated: false };
      return {};
    });
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'G:/proj/a/src/hello.ts'));
    await expectEditor('hello');
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }]]);
  });

  it('shows a file outside the session folder in File Explorer without reading or previewing it', async () => {
    invokeMock.mockImplementation(async (channel: string) => (channel === 'app:showInFolder' ? { ok: true } : {}));
    act(() => useStore.getState().revealFile(session.id, 'G:/elsewhere/SideGuard-Q-2026-10.zip'));
    // The file manager's name follows the platform, which the hoisted imports read before the stub above.
    await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([
      ['info', expect.stringMatching(/^Showing SideGuard-Q-2026-10\.zip in .+: files outside this session cannot be previewed here$/)]
    ]));
    expect(invokeMock).toHaveBeenCalledWith('app:showInFolder', { sessionId: session.id, path: 'G:/elsewhere/SideGuard-Q-2026-10.zip' });
    expect(reads()).toHaveLength(0);
    expect(target()).toBeUndefined();
  });

  it('refuses a mention outside the session folder where the host cannot show it', async () => {
    const harness = window.harness as unknown as { can?: (channel: string) => boolean };
    harness.can = (channel) => channel !== 'app:showInFolder';
    try {
      act(() => useStore.getState().revealFile(session.id, 'G:/elsewhere/secrets.ts'));
      await waitFor(() => expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['error', 'Cannot open files outside G:/proj/a']]));
      expect(reads()).toHaveLength(0);
      expect(invokeMock).not.toHaveBeenCalledWith('app:showInFolder', expect.anything());
      expect(target()).toBeUndefined();
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
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'SideGuard-Q-2026-10.zip'));
    expect((await screen.findByRole('alert')).textContent).toBe('SideGuard-Q-2026-10.zip was not found in G:\\proj\\a');
    expect(useStore.getState().toasts).toEqual([]);
  });

  it('does not edit or save a binary file and offers its folder instead', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return { content: '', truncated: false, binary: true };
      if (channel === 'app:showInFolder') return { ok: true };
      return {};
    });
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'dist/bundle.zip'));
    expect(await screen.findByText('Binary file, no text preview.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'File contents' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    pressSave(screen.getByRole('region', { name: 'Preview: dist/bundle.zip' }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /^Show in / }));
    expect(invokeMock).toHaveBeenCalledWith('app:showInFolder', { sessionId: session.id, path: 'G:/proj/a/dist/bundle.zip' });
  });

  it('follows a link inside a previewed markdown file relative to that file', async () => {
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:resolve') return { status: 'resolved', path: request.path };
      if (channel === 'fs:read') return request.path === 'docs/guide.md' ? { content: 'Read [the code](../src/a.ts#L2).', truncated: false } : { content: 'code body', truncated: false };
      return {};
    });
    render(<FilePreviewPane />);
    act(() => useStore.getState().revealFile(session.id, 'docs/guide.md'));
    await expectEditor('Read [the code](../src/a.ts#L2).');
    expect(screen.queryByRole('link', { name: 'the code' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show markdown preview' }));
    fireEvent.click(await screen.findByRole('link', { name: 'the code' }));
    expect(target()).toMatchObject({ path: 'src/a.ts', line: 2 });
    await expectEditor('code body');
  });
});

describe('file editor saves', () => {
  it('writes only on Ctrl+S and preserves the BOM and CRLF in both IPC strings', async () => {
    const path = 'docs/guide.md';
    const original = '\uFEFF# Guide\r\nFirst line\r\n';
    const edited = '# Guide\nRevised line\n';
    let finishSave!: () => void;
    const pending = new Promise<void>((resolve) => { finishSave = resolve; });
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:read') return { content: original, truncated: false };
      if (channel === 'fs:writeText') return pending;
      return {};
    });
    render(<FilePreviewPane />);
    openExact(path);
    const editor = await findEditor();
    expect(editor.state.doc.toString()).toBe('# Guide\nFirst line\n');
    expect(saveButton().disabled).toBe(true);
    pressSave(editor);

    changeEditor(editor, edited);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(writes()).toHaveLength(0);
    pressSave(editor);
    expect(writes()).toEqual([['fs:writeText', {
      sessionId: session.id, path, content: '\uFEFF# Guide\r\nRevised line\r\n', expectedContent: original
    }]]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving…' }).disabled).toBe(true);
    await act(async () => { finishSave(); await pending; });
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(editor.state.doc.toString()).toBe(edited);
  });

  it('retains a rejected draft for retry without leaking it into another opened file', async () => {
    const path = 'docs/notes.txt';
    const otherPath = 'src/notes.txt';
    const original = 'original notes';
    const draft = 'revised notes';
    let rejectSave = true;
    invokeMock.mockImplementation(async (channel: string, request: { path: string }) => {
      if (channel === 'fs:read') return { content: request.path === path ? original : 'other notes', truncated: false };
      if (channel === 'fs:writeText') {
        if (rejectSave) throw new Error('File changed on disk');
        return undefined;
      }
      return {};
    });
    render(<FilePreviewPane />);
    openExact(path);
    changeEditor(await findEditor(), draft);
    fireEvent.click(saveButton());
    await waitFor(() => expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'File changed on disk' }));
    await expectEditor(draft);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);

    openExact(otherPath);
    await waitFor(() => expectEditor('other notes'));
    expect(saveButton().disabled).toBe(true);
    openExact(path);
    await waitFor(() => expectEditor(draft));
    const write = ['fs:writeText', { sessionId: session.id, path, content: draft, expectedContent: original }];
    expect(writes()).toEqual([write]);

    rejectSave = false;
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(writes()).toEqual([write, write]);
    await expectEditor(draft);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('reopens a file against the new baseline if its save was still pending', async () => {
    const path = 'notes.txt';
    let disk = 'before';
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    invokeMock.mockImplementation(async (channel: string, request: { content: string }) => {
      if (channel === 'fs:read') return { content: disk, truncated: false };
      if (channel === 'fs:writeText') { await pending; disk = request.content; }
      return undefined;
    });
    render(<FilePreviewPane />);
    openExact(path);
    const editor = await findEditor();
    changeEditor(editor, 'after');
    pressSave(editor);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    openExact(path);
    expect(reads()).toHaveLength(1);
    await act(async () => { finish(); await pending; });
    await expectEditor('after');
    expect(saveButton().disabled).toBe(true);
    changeEditor(await findEditor(), 'next');
    fireEvent.click(saveButton());
    await waitFor(() => expect(disk).toBe('next'));
    expect(writes().at(-1)?.[1]).toMatchObject({ path, expectedContent: 'after' });
  });

  it('shows a truncated text preview as read-only and will not save it', async () => {
    invokeMock.mockImplementation(async (channel: string) => channel === 'fs:read' ? { content: 'partial text', truncated: true } : undefined);
    render(<FilePreviewPane />);
    openExact('large.txt');
    const editor = await findEditor();
    expect(editor.state.doc.toString()).toBe('partial text');
    expect(editor.state.readOnly).toBe(true);
    expect(editor.contentDOM.getAttribute('aria-readonly')).toBe('true');
    expect(screen.getByRole('status').textContent).toMatch(/truncated.*read-only/i);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    pressSave(editor);
    expect(writes()).toHaveLength(0);
  });
});

describe('the right-panel Files tab', () => {
  it('a file row opens its exact path in the file pane and marks the row', async () => {
    useStore.setState({ panelTab: 'files', panelOpen: true });
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'fs:list') return [{ name: 'hello.ts', path: 'src/hello.ts', isDir: false, size: 12 }];
      if (channel === 'fs:read') return { content: 'row preview', truncated: false };
      return {};
    });
    render(<><RightPanel session={session} /><FilePreviewPane /></>);
    const row = await screen.findByRole('button', { name: /hello\.ts/ });
    fireEvent.click(row);
    await expectEditor('row preview');
    expect(target()).toMatchObject({ path: 'src/hello.ts', exact: true });
    expect(invokeMock).not.toHaveBeenCalledWith('fs:resolve', expect.anything());
    expect(reads()).toEqual([['fs:read', { sessionId: session.id, path: 'src/hello.ts', maxBytes: 200_000 }]]);
    await waitFor(() => expect(row.className).toContain('active'));
  });

  it('a folder mention opens the Files tab on that folder without a file preview', async () => {
    invokeMock.mockImplementation(async (channel: string) => (channel === 'fs:list' ? [] : {}));
    act(() => useStore.getState().revealFile(session.id, 'src/main/harness/'));
    expect(useStore.getState()).toMatchObject({ panelTab: 'files', panelOpen: true, fileReveal: { sessionId: session.id, path: 'src/main/harness/' } });
    expect(target()).toBeUndefined();
    render(<RightPanel session={session} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:list', { sessionId: session.id, relPath: 'src/main/harness' }));
    expect(useStore.getState().fileReveal).toBeNull();
  });
});
