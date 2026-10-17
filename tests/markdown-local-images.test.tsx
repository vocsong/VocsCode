/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import { renderMarkdown } from '../src/renderer/src/markdown';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import type { WorkspaceImage } from '../src/shared/image-files';

const platform = vi.hoisted(() => ({ web: false }));
vi.mock('../src/renderer/src/api', async (original) => ({
  ...await original<typeof import('../src/renderer/src/api')>(),
  get isWeb() { return platform.web; }
}));
const invoke = vi.fn();
const image: WorkspaceImage = { mimeType: 'image/png', data: 'aGVsbG8=', size: 5, tooLarge: false };
const session = (id = 'worktree', cwd = 'G:/project/.vocs-code/worktrees/fast mode') => ({
  id, cwd, title: id, status: 'idle', config: { harness: 'native' }, harnessRef: {}, usage: {}
}) as unknown as SessionMeta;
const answer = (text: string, streaming = false): TranscriptItem => ({ id: 'answer', kind: 'assistant', phase: 'final', ts: 1, text, streaming });
function mount(text: string, scope = session(), streaming = false, strict = false) {
  useStore.setState({ sessions: [session('other', 'G:/project'), scope], transcripts: { [scope.id]: [answer(text, streaming)] }, loaded: { [scope.id]: true }, searchJump: null });
  return render(strict ? <StrictMode><Transcript session={scope} /></StrictMode> : <Transcript session={scope} />);
}
function update(text: string, scope = session(), streaming = false) {
  act(() => useStore.setState({ transcripts: { [scope.id]: [answer(text, streaming)] } }));
}
const reads = () => invoke.mock.calls.filter(([channel]) => channel === 'fs:readImage');

beforeEach(() => {
  platform.web = false;
  invoke.mockReset().mockResolvedValue(image);
  Object.defineProperty(window, 'harness', { configurable: true, value: { platform: 'win32', invoke, on: () => () => undefined } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useStore.setState({ sessions: [], transcripts: {}, loaded: {}, searchJump: null });
});

describe('assistant workspace markdown images', () => {
  it('keeps sanitized HTML inert and ordinary markdown policy unchanged', () => {
    const md = '![New Session](tests/artifacts/fast-mode-new-session.png)';
    const html = renderMarkdown(md, { fileLinks: true });
    expect(html).toContain('data-local-image="tests/artifacts/fast-mode-new-session.png"');
    expect(html).not.toContain('<img');
    expect(html).toContain('New Session');
    expect(renderMarkdown(md)).not.toContain('data-local-image');
    expect(renderMarkdown('![remote](https://example.com/a.png)')).toContain('src="https://example.com/a.png"');
    expect(renderMarkdown('<img src="file:///private/shot.png">')).not.toContain('src=');
  });

  it.each([
    ['tests/artifacts/fast-mode-new-session.png', 'tests/artifacts/fast-mode-new-session.png', session()],
    ['<tests/artifacts/New Session.png>', 'tests/artifacts/New Session.png', session()],
    ['tests/artifacts/New%20Session.png', 'tests/artifacts/New Session.png', session()],
    ['<G:/project/.vocs-code/worktrees/fast mode/tests/artifacts/New Session.png>', 'tests/artifacts/New Session.png', session()],
    ['G:%5Cproject%5C.vocs-code%5Cworktrees%5Cfast%20mode%5Cshot.png', 'shot.png', session()],
    ['</srv/worktree/fast mode/shot.png>', 'shot.png', session('posix', '/srv/worktree/fast mode')],
    ['/tests/shot.png', 'tests/shot.png', session()]
  ])('reads %s only in its exact session workspace', async (href, path, scope) => {
    const { container } = mount(`![New Session](${href})`, scope);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8='));
    expect(reads()).toEqual([['fs:readImage', { sessionId: scope.id, path }]]);
    expect(container.querySelector('img')?.alt).toBe('New Session');
    expect(container.querySelector('img')?.style.maxWidth).toBe('100%');
    expect(container.querySelector('img')?.style.height).toBe('auto');
    // The parser cache contains only the inert placeholder, never session data.
    expect(renderMarkdown(`![New Session](${href})`, { fileLinks: true })).not.toContain('base64');
  });

  it('opens the clicked image in the full preview and navigates only available images in message order', async () => {
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(image).mockResolvedValueOnce({ ...image, data: 'bmV3' });
    mount('![Missing](missing.png)\n\n![First](one.png)\n\n![Second](two.png)');
    const preview = await screen.findByRole('button', { name: 'Preview Second' });
    expect(screen.queryByRole('button', { name: 'Preview Missing' })).toBeNull();
    fireEvent.click(within(preview).getByRole('img'));
    const dialog = screen.getByRole('dialog', { name: 'Image preview' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('data:image/png;base64,bmV3');
    expect(within(dialog).getByText('Second (2/2)')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('img'));
    expect(screen.getByRole('dialog')).toBe(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Previous image' }));
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(within(dialog).getByText('First (1/2)')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(within(dialog).getByText('Second (2/2)')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview First' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(preview);
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(reads()).toHaveLength(3);
  });

  it.each(['{Enter}', ' '])('previews a linked image with %s without opening its enclosing link', async (key) => {
    const user = userEvent.setup();
    useStore.setState({ fileReveal: null });
    mount('<a data-file="notes.md" role="link" tabindex="0">![Linked screenshot](shot.png)</a>');
    const preview = await screen.findByRole('button', { name: 'Preview Linked screenshot' });
    preview.focus();
    await user.keyboard(key);
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close image preview' });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(close);
    expect(useStore.getState().fileReveal).toBeNull();
    expect(invoke.mock.calls.every(([channel]) => channel === 'fs:readImage')).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(preview);
    await user.click(preview);
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy();
    expect(useStore.getState().fileReveal).toBeNull();
    expect(reads()).toHaveLength(1);
  });

  it('previews the current streamed image after HTML replacement without rereading it', async () => {
    mount('![Old caption](shot.png)', session(), true);
    await screen.findByRole('button', { name: 'Preview Old caption' });
    update('![New caption](./shot.png)\n\nThe final answer.');
    fireEvent.click(await screen.findByRole('button', { name: 'Preview New caption' }));
    const dialog = screen.getByRole('dialog', { name: 'Image preview' });
    expect(within(dialog).getByRole('img', { name: 'New caption' }).getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(within(dialog).queryByRole('button', { name: 'Next image' })).toBeNull();
    expect(reads()).toHaveLength(1);
  });

  it('keeps the gallery scoped to the clicked message rather than the whole transcript', async () => {
    const { container } = mount('![First message](one.png)');
    await screen.findByRole('button', { name: 'Preview First message' });
    act(() => useStore.setState((state) => ({ transcripts: { worktree: [...state.transcripts.worktree!, { ...answer('![Other message](two.png)'), id: 'other-answer' }] } })));
    await screen.findByRole('button', { name: 'Preview Other message' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview First message' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'First message' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Next image' })).toBeNull();
    expect(container.querySelectorAll('.md img')).toHaveLength(2);
    expect(reads()).toHaveLength(2);
  });

  it('restores keyboard focus to a replaced screenshot trigger when streaming continues during preview', async () => {
    const user = userEvent.setup();
    mount('![Old caption](shot.png)', session(), true);
    await user.click(await screen.findByRole('button', { name: 'Preview Old caption' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    update('![New caption](./shot.png)\n\nMore streamed text.');
    const replacement = await screen.findByRole('button', { name: 'Preview New caption' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(replacement);
    expect(reads()).toHaveLength(1);
  });

  it('denies non-images, traversal, outside absolute paths, URLs and custom schemes before IPC', async () => {
    const hrefs = ['notes.txt', '../secret.png', 'shots/%2e%2e/secret.png', 'G:/project/private.png', '//server/share/a.png', 'file:///G:/project/a.png', 'https://example.com/a.png', 'data:image/png;base64,aGVsbG8=', 'custom:shot.png', 'bad%ZZ.png', 'shot.png?query', 'shot%00.png'];
    const { container } = mount(hrefs.map((href, i) => `![denied ${i}](${href})`).join('\n\n'));
    await act(async () => {});
    expect(reads()).toHaveLength(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('denied 0');
    expect(container.textContent).toContain('unavailable');
  });

  it('drops all web images and never reads even inert raw markup', async () => {
    platform.web = true;
    const { container } = mount('![web](shot.png)\n\n<img src="https://example.com/a.png">\n\n<svg><image href="https://example.com/tracker.png"/><filter><feImage href="https://example.com/filter.png"/></filter></svg>\n\n<span data-local-image="shot.png">raw</span>');
    await act(async () => {});
    expect(reads()).toHaveLength(0);
    expect(container.querySelector('img, image, feImage')).toBeNull();
  });

  it.each([
    null,
    { ...image, tooLarge: true, data: '', size: 20_000_001 },
    { ...image, mimeType: 'text/html' },
    { ...image, data: 'not base64!' },
    { ...image, data: 'A'.repeat(5_600_000), size: 4_200_000 }
  ])('shows a visible unavailable fallback for missing, capped or invalid responses', async (response) => {
    invoke.mockResolvedValue(response);
    const { container } = mount('![Unavailable screenshot](shot.png)');
    await waitFor(() => expect(container.textContent).toContain('Unavailable screenshot (image unavailable)'));
    expect(reads()).toHaveLength(1);
    expect(container.querySelector('img')).toBeNull();
    update('![Unavailable screenshot](shot.png)\n\nMore text');
    await act(async () => {});
    expect(reads()).toHaveLength(1);
  });

  it('falls back visibly on a rejected read or failed image decode', async () => {
    invoke.mockRejectedValueOnce(new Error('missing'));
    const { container } = mount('![Missing](missing.png)\n\n![Invalid pixels](shot.png)');
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    fireEvent.error(container.querySelector('img')!);
    expect(container.textContent).toContain('Missing (image unavailable)');
    expect(container.textContent).toContain('Invalid pixels (image unavailable)');
    expect(container.querySelector('img')).toBeNull();
  });

  it('deduplicates pending and completed reads through streaming HTML replacements', async () => {
    let resolve!: (value: WorkspaceImage) => void;
    invoke.mockImplementation(() => new Promise<WorkspaceImage>((done) => { resolve = done; }));
    const { container } = mount('![First](shot.png)\n\n![Again](./shot.png)', session(), true);
    await waitFor(() => expect(reads()).toHaveLength(1));
    update('![Newest](shot.png)\n\nStreaming done');
    await act(async () => { resolve(image); });
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.alt).toBe('Newest');
    update('![Final](shot.png)\n\nMore');
    await waitFor(() => expect(container.querySelector('img')?.alt).toBe('Final'));
    expect(reads()).toHaveLength(1);
  });

  it('ignores late results after HTML replacement and unmount', async () => {
    let resolve!: (value: WorkspaceImage) => void;
    invoke.mockImplementation(() => new Promise<WorkspaceImage>((done) => { resolve = done; }));
    const view = mount('![Old](old.png)');
    await waitFor(() => expect(reads()).toHaveLength(1));
    const oldPlaceholder = view.container.querySelector('[data-local-image]')!;
    update('No image now');
    await act(async () => { resolve(image); });
    expect(oldPlaceholder.querySelector('img')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    update('![Unmount](unmount.png)');
    await waitFor(() => expect(reads()).toHaveLength(2));
    const removed = view.container.querySelector('[data-local-image]')!;
    view.unmount();
    await act(async () => { resolve(image); });
    expect(removed.querySelector('img')).toBeNull();
  });

  it('does not reuse or display images from another session with identical HTML', async () => {
    let resolveOld!: (value: WorkspaceImage) => void;
    invoke.mockImplementationOnce(() => new Promise<WorkspaceImage>((done) => { resolveOld = done; })).mockResolvedValue({ ...image, data: 'bmV3' });
    const view = mount('![Scoped](shot.png)');
    await waitFor(() => expect(reads()).toHaveLength(1));
    const next = session('next', '/work/next');
    act(() => useStore.setState({ sessions: [next], transcripts: { next: [answer('![Scoped](shot.png)')] }, loaded: { next: true } }));
    view.rerender(<Transcript session={next} />);
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,bmV3'));
    await act(async () => { resolveOld(image); });
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,bmV3');
    expect(reads()).toEqual([['fs:readImage', { sessionId: 'worktree', path: 'shot.png' }], ['fs:readImage', { sessionId: 'next', path: 'shot.png' }]]);
  });

  it('accepts a valid one-megabyte response without recursive base64 validation', async () => {
    const data = 'A'.repeat(1_398_100) + 'AA==';
    invoke.mockResolvedValue({ ...image, data, size: 1_048_576 });
    const { container } = mount('![Large screenshot](large.png)');
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')?.length).toBe(data.length + 'data:image/png;base64,'.length));
    expect(reads()).toHaveLength(1);
  });

  it('bounds retained image data as well as request count', async () => {
    const data = 'A'.repeat(2_796_200) + 'AAA=';
    invoke.mockResolvedValue({ ...image, data, size: 2_097_152 });
    const { container } = mount('![First](one.png)\n\n![Second](two.png)\n\n![Third](three.png)');
    await waitFor(() => expect(reads()).toHaveLength(3));
    await act(async () => {});
    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(container.textContent).toContain('Third (image unavailable)');
    update('![Third](three.png)\n\nNew prefix');
    await act(async () => {});
    expect(reads()).toHaveLength(3);
    expect(container.querySelector('img')).toBeNull();
  });

  it('does not duplicate reads when React replays mount effects', async () => {
    const { container } = mount('![Screenshot](shot.png)', session(), false, true);
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8='));
    expect(reads()).toHaveLength(1);
  });

  it('bounds automatic reads per message across growing streaming prefixes', async () => {
    const md = Array.from({ length: 12 }, (_, i) => `![Image ${i}](shot${i}.png)`).join('\n\n');
    const { container } = mount(md);
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(8));
    expect(reads()).toHaveLength(8);
    update(`${md}\n\n![More](more.png)`);
    await act(async () => {});
    expect(reads()).toHaveLength(8);
    expect(container.textContent).toContain('More (image unavailable)');
  });
});
