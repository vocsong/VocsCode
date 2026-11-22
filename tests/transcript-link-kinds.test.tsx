/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptCapabilitiesProvider } from '../src/renderer/src/capabilities';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { renderMarkdown } from '../src/renderer/src/markdown';
import { singlePaneLayout } from '../src/renderer/src/panes';
import { useStore } from '../src/renderer/src/store';
import type { MissionRecord } from '../src/shared/mission';
import type { SessionMeta } from '../src/shared/types';

const host = vi.hoisted(() => ({ web: false, invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', async (original) => ({
  ...await original<typeof import('../src/renderer/src/api')>(),
  get isWeb() { return host.web; },
  platform: 'win32',
  invoke: host.invoke
}));

const session: SessionMeta = {
  id: 'session', title: 'Session', cwd: 'G:/proj/a', status: 'idle', createdAt: 1, updatedAt: 1,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' }, harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
};
const prUrl = 'https://github.com/example/repo/pull/42';
const issueUrl = 'https://github.com/example/repo/issues/42';
const imagePath = 'tests/artifacts/fast-mode-new-session.png';
const image = { mimeType: 'image/png', data: 'aGVsbG8=', size: 5, tooLarge: false };
const initial = useStore.getState();

function mount(text: string, current = session, activeId = current.id) {
  useStore.setState({
    sessions: [current], activeId, layout: singlePaneLayout(current.id), loaded: { [current.id]: true },
    transcripts: { [current.id]: [{ id: 'reply', kind: 'assistant', ts: 2, text }] }
  });
  const body = <Transcript session={current} />;
  return render(host.web ? (
    <TranscriptCapabilitiesProvider value={{ contextMenu: false, editAndResend: false, openFile: false }}>{body}</TranscriptCapabilitiesProvider>
  ) : body);
}
const link = (name: string) => screen.getByRole('link', { name });
const kind = (el: HTMLElement) => el.dataset.linkKind;

beforeEach(() => {
  host.web = false;
  host.invoke.mockReset().mockImplementation(async (channel: string, request: { path?: string }) => {
    if (channel === 'fs:readImage') return request.path === imagePath ? image : null;
    if (channel === 'app:showInFolder') return { ok: true };
    return {};
  });
  Object.defineProperty(window, 'harness', { configurable: true, value: { platform: 'win32', invoke: host.invoke, on: () => () => undefined } });
});
afterEach(() => {
  cleanup();
  useStore.setState(initial, true);
});

describe('transcript link destinations', () => {
  it('distinguishes source links, folder actions, image files and Explorer by their actual targets', async () => {
    const user = userEvent.setup();
    mount([
      'See [`static-models.ts`](/G:/proj/a/src/main/models/static-models.ts:17) and `src/hello.ts:300`.',
      '[Sources](src/) [Workspace](G:/proj/a/) [Screenshot](<shots/Screenshot (2).png>)',
      '[Outside PNG](G:/elsewhere/shot.png)'
    ].join('\n\n'));
    const explicit = link('static-models.ts');
    const mention = link('src/hello.ts:300');
    expect([explicit, mention, link('Sources'), link('Workspace'), link('Screenshot'), link('Outside PNG')].map(kind))
      .toEqual(['file', 'file', 'folder', 'folder', 'image-file', 'explorer']);
    expect(explicit.querySelector('code')?.dataset.linkKind).toBeUndefined();
    expect(host.invoke).not.toHaveBeenCalled();

    explicit.focus();
    await user.keyboard('{Enter}');
    expect(useStore.getState().layout.filePreview).toMatchObject({ path: 'src/main/models/static-models.ts', line: 17 });
    mention.focus();
    await user.keyboard(' ');
    expect(useStore.getState().layout.filePreview).toMatchObject({ path: 'src/hello.ts', line: 300 });
    await user.click(link('Sources'));
    expect(useStore.getState()).toMatchObject({ panelTab: 'files', panelOpen: true, fileReveal: { path: 'src/' } });
    await user.click(link('Screenshot'));
    expect(useStore.getState().layout.filePreview?.path).toBe('shots/Screenshot (2).png');
    await user.click(link('Outside PNG'));
    expect(host.invoke.mock.calls).toEqual([['app:showInFolder', { sessionId: session.id, path: 'G:/elsewhere/shot.png' }]]);
  });

  it('updates the PR kind with active session and keeps issues, PR subpages and URL labels external', async () => {
    const user = userEvent.setup();
    const prFilesUrl = `${prUrl}/files`;
    mount(`[Overview](${prUrl}) [Issue](${issueUrl}) [PR files](${prFilesUrl}) [Screenshot](https://example.com/shot.png)`, session, 'other');
    const pr = link('Overview');
    expect([pr, link('Issue'), link('PR files'), link('Screenshot')].map(kind)).toEqual(['external', 'external', 'external', 'external']);
    await user.click(pr);
    expect(host.invoke.mock.calls).toEqual([['app:openExternal', { url: prUrl }]]);
    expect(useStore.getState().gitPullRequestPreview).toBeNull();

    act(() => useStore.setState({ activeId: session.id }));
    expect(kind(pr)).toBe('pr');
    pr.focus();
    await user.keyboard('{Enter}');
    expect(useStore.getState()).toMatchObject({ panelTab: 'branches', gitPanelView: 'prs', gitPullRequestPreview: { number: 42, sessionId: session.id } });
    await user.click(link('Issue'));
    expect(host.invoke.mock.calls).toEqual([
      ['app:openExternal', { url: prUrl }], ['git:pullRequest', { sessionId: session.id, url: prUrl }], ['app:openExternal', { url: issueUrl }]
    ]);
  });

  it('uses the Mission file workspace without intercepting PRs from the active lead', async () => {
    const lead: SessionMeta = { ...session, mission: { missionId: 'mission', role: 'lead', generation: 1, requestedTools: [], sourceAccess: 'assigned_workspace', reasoningDefault: true } };
    const workspaces: MissionRecord['workspaces'] = [{ id: 'lead', role: 'lead', path: 'G:/mission/lead', ownerSessionId: lead.id, branch: 'lead', base: { baseCommitSha: 'base', contentHash: 'hash' } }];
    useStore.setState({ missions: { mission: { workspaces } as MissionRecord } });
    mount(`[Overview](${prUrl}) [Lead file](G:/mission/lead/index.ts) [Outside](G:/proj/a/index.ts)`, lead);
    expect([link('Overview'), link('Lead file'), link('Outside')].map(kind)).toEqual(['external', 'file', 'explorer']);
    fireEvent.click(link('Lead file'));
    expect(useStore.getState().layout.filePreview).toMatchObject({ path: 'index.ts', missionWorkspaceId: 'lead' });
    fireEvent.click(link('Overview'));
    expect(host.invoke.mock.calls).toEqual([['app:openExternal', { url: prUrl }]]);
  });

  it('leaves web file refs and refused local actions uncolored and out of the tab order', async () => {
    Object.defineProperty(window.harness, 'can', { value: (channel: string) => channel !== 'app:showInFolder' });
    const md = `[Overview](${prUrl}) [Outside](G:/elsewhere/index.ts) \`src/store.ts\` ![Local](${imagePath})`;
    const desktop = mount(md);
    expect(kind(screen.getByText('Outside'))).toBeUndefined();
    expect(screen.getByText('Outside').hasAttribute('tabindex')).toBe(false);
    fireEvent.click(screen.getByText('Outside'));
    expect(host.invoke).not.toHaveBeenCalledWith('app:showInFolder', expect.anything());
    expect(useStore.getState().layout.filePreview).toBeUndefined();
    desktop.unmount();
    host.invoke.mockClear();
    host.web = true;
    mount(md);
    expect(kind(link('Overview'))).toBe('external');
    expect(screen.queryByRole('link', { name: 'src/store.ts' })).toBeNull();
    expect(kind(screen.getByText('src/store.ts'))).toBeUndefined();
    fireEvent.click(screen.getByText('src/store.ts'));
    fireEvent.click(link('Overview'));
    expect(host.invoke.mock.calls).toEqual([['app:openExternal', { url: prUrl }]]);
  });

  it('marks only hydrated image buttons, preserving their keyboard preview and image cache on pane changes', async () => {
    const user = userEvent.setup();
    mount(`[Overview](${prUrl})\n\n![Screenshot](${imagePath})\n\n![Missing](missing.png)`);
    const preview = await screen.findByRole('button', { name: 'Preview Screenshot' });
    expect(kind(preview)).toBe('image-preview');
    const missing = await screen.findByText('Missing (image unavailable)');
    expect(kind(missing)).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Preview Missing' })).toBeNull();
    act(() => useStore.setState({ activeId: 'other' }));
    expect(screen.getByRole('button', { name: 'Preview Screenshot' })).toBe(preview);
    preview.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy();
    expect(host.invoke.mock.calls).toEqual([
      ['fs:readImage', { sessionId: session.id, path: imagePath }], ['fs:readImage', { sessionId: session.id, path: 'missing.png' }]
    ]);
  });

  it('strips authored kinds and unsafe hrefs without affecting real links or fenced code copy', async () => {
    const user = userEvent.setup();
    const md = [
      '[Mail](mailto:dev@example.com) [Jump](#here) `node.js`',
      '<a href="javascript:alert(1)" data-link-kind="pr">Unsafe</a> <span data-link-kind="folder">Forged</span>',
      '<a href="https://example.com" data-link-kind="pr">Site</a>',
      '```ts\nconst foo = 1;\n```'
    ].join('\n\n');
    mount(md);
    expect(['Mail', 'Jump', 'node.js', 'Unsafe', 'Forged'].map((text) => kind(screen.getByText(text)))).toEqual(Array(5).fill(undefined));
    expect(screen.getByText('Unsafe').hasAttribute('href')).toBe(false);
    expect(kind(link('Site'))).toBe('external');
    expect(renderMarkdown(md, { fileLinks: true, fileBase: 'docs' })).not.toContain('data-link-kind');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('const foo = 1;'));
    expect(host.invoke).not.toHaveBeenCalled();
  });
});
