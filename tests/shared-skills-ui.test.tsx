/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, can } = vi.hoisted(() => {
  const invoke = vi.fn();
  const can = vi.fn();
  (window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke, can, on: () => () => undefined };
  return { invoke, can };
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { SkillsView } from '../src/renderer/src/components/SkillsView';
import { useStore } from '../src/renderer/src/store';
import type { SharedSkillDocument } from '../src/shared/shared-skills';
import type { SessionMeta } from '../src/shared/types';

const example = {
  name: 'summarize-notes', description: 'Summarize notes', revision: 'a'.repeat(64), reviewed: true,
  content: 'Read the notes, then list decisions. The literal label is <strong>Decisions</strong>.'
} satisfies SharedSkillDocument;
const other = { ...example, name: 'summarize-plan', description: 'Summarize the plan', revision: 'b'.repeat(64), content: 'List the steps in the plan.' };
const session = {
  id: 's_one', title: 'Active session', createdAt: 0, updatedAt: 0, cwd: '.', status: 'idle', harnessRef: {},
  config: { harness: 'pi', projectRoot: '.', permissionMode: 'ask' },
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }
} as SessionMeta;

const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel).map(([, input]) => input);
const toast = () => useStore.getState().toasts.at(-1)?.text;
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const type = (el: HTMLTextAreaElement, value: string) => fireEvent.change(el, { target: { value } });
const renderComposer = (meta = session) => {
  const view = render(<Composer session={meta} />);
  return { ...view, input: screen.getByRole<HTMLTextAreaElement>('textbox') };
};
const info = ({ content: _content, ...summary }: SharedSkillDocument) => summary;

beforeEach(() => {
  invoke.mockReset();
  can.mockReset().mockReturnValue(true);
  useStore.setState({ sessions: [session], activeId: session.id, view: 'chat', drafts: {}, toasts: [], missionArmed: {}, composerHistory: {} });
});
afterEach(cleanup);

describe('Shared skill library', () => {
  it('defaults to Shared, creates and edits plaintext, and reviews or disables the displayed revision only', async () => {
    const created = { ...example, reviewed: false };
    const edited = { ...created, content: `${created.content}\nList follow-ups.`, revision: 'c'.repeat(64) };
    invoke.mockImplementation(async (channel: string, input: { enabled?: boolean }) => {
      switch (channel) {
        case 'sharedSkills:list': return [];
        case 'sharedSkills:create': return created;
        case 'sharedSkills:save': return edited;
        case 'sharedSkills:review': return { ...info(edited), reviewed: input.enabled };
      }
    });

    const { container } = render(<SkillsView />);
    expect(screen.getByRole('tab', { name: 'Shared' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Native & built-in' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('~/.agents/skills')).toBeTruthy();
    await screen.findByText('No shared skills yet.');
    expect(calls('skills:list')).toEqual([]);
    fireEvent.click(button('New shared skill'));
    const form = within(screen.getByRole('dialog', { name: 'New shared skill' }));
    fireEvent.change(form.getByRole('textbox', { name: 'Name' }), { target: { value: created.name } });
    fireEvent.change(form.getByRole('textbox', { name: 'Description' }), { target: { value: created.description } });
    fireEvent.click(form.getByRole('button', { name: 'Create' }));
    await screen.findByText(created.content);
    expect(container.querySelector('.shared-skill-content strong')).toBeNull();
    expect(screen.getByText(/provider.*may retain or echo/)).toBeTruthy();
    expect(calls('sharedSkills:create')).toEqual([{ name: created.name, description: created.description }]);
    expect(button('Use in session').disabled).toBe(true);
    expect(calls('sharedSkills:review')).toEqual([]);

    fireEvent.click(button('Edit'));
    type(screen.getByRole('textbox', { name: 'SKILL.md' }), edited.content);
    fireEvent.click(button('Save'));
    await screen.findByText(/List follow-ups/);
    expect(calls('sharedSkills:save')).toEqual([{ name: edited.name, revision: created.revision, content: edited.content }]);
    expect(button('Use in session').disabled).toBe(true);
    fireEvent.click(button('Mark as reviewed'));
    await waitFor(() => expect(button('Use in session').disabled).toBe(false));
    fireEvent.click(button('Disable'));
    await screen.findByRole('button', { name: 'Mark as reviewed' });
    expect(button('Use in session').disabled).toBe(true);
    expect(calls('sharedSkills:review')).toEqual([true, false].map((enabled) => ({ name: edited.name, revision: edited.revision, enabled })));
  });

  it('ignores a late preview and stages only into the active draft without more IPC', async () => {
    const first = Promise.withResolvers<SharedSkillDocument>();
    invoke.mockImplementation(async (channel: string, input: { name: string }) => {
      if (channel === 'sharedSkills:list') return [info(example), info(other)];
      if (channel === 'sharedSkills:read') return input.name === example.name ? first.promise : other;
    });
    useStore.setState({ view: 'skills', drafts: { [session.id]: '!git status', s_other: 'Other draft stays intact' } });
    render(<SkillsView />);
    fireEvent.click(await screen.findByRole('button', { name: /^summarize-notes/ }));
    fireEvent.click(screen.getByRole('button', { name: /^summarize-plan/ }));
    await screen.findByText(other.content);
    await act(async () => first.resolve(example));
    expect(screen.queryByText(example.content)).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter shared skills' }), { target: { value: 'the plan' } });
    expect(screen.queryByRole('button', { name: /^summarize-notes/ })).toBeNull();

    const before = invoke.mock.calls.length;
    fireEvent.click(button('Use in session'));
    expect(toast()).toMatch(/draft was kept/i);
    expect(useStore.getState().drafts[session.id]).toBe('!git status');
    act(() => useStore.getState().setDraft(session.id, 'List changes\nexactly.  '));
    fireEvent.click(button('Use in session'));
    expect(invoke.mock.calls).toHaveLength(before);
    expect(useStore.getState()).toMatchObject({ view: 'chat', drafts: { [session.id]: '/skill summarize-plan List changes\nexactly.  ', s_other: 'Other draft stays intact' } });
  });

  it('does not fetch Shared skills through a transport that disallows them', async () => {
    can.mockImplementation((channel: string) => !channel.startsWith('sharedSkills:'));
    const view = render(<SkillsView />);
    expect(screen.getByText(/available in the desktop app/)).toBeTruthy();
    view.unmount();
    const { input } = renderComposer();
    type(input, '/skill ');
    type(input, '/skill summarize-notes Task');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(toast()).toMatch(/desktop app/i);
    expect(input.value).toBe('/skill summarize-notes Task');
    expect(invoke.mock.calls.filter(([name]) => String(name).startsWith('sharedSkills:'))).toEqual([]);
    expect(calls('sessions:send')).toEqual([]);
  });
});

describe('Shared skills in the composer', () => {
  it('completes reviewed name prefixes by keyboard or pointer and leaves the native routes alone', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'sharedSkills:list'
      ? [info(other), info(example), { ...info(example), name: 'summarize-private', reviewed: false }]
      : undefined);
    const { input } = renderComposer();
    type(input, '/skil');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/skill ');
    const options = within(await screen.findByRole('listbox', { name: 'Shared skills' }));
    expect(options.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const selected = options.getByRole('option', { name: /^summarize-plan/ });
    expect(input.getAttribute('aria-activedescendant')).toBe(selected.id);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/skill summarize-plan ');

    type(input, '/skill summar');
    fireEvent.click(await screen.findByRole('option', { name: /^summarize-notes/ }));
    expect(input.value).toBe('/skill summarize-notes ');
    expect(calls('sharedSkills:invoke')).toEqual([]);
    type(input, '/skill:pdf task');
    fireEvent.keyDown(input, { key: 'Enter' });
    type(input, '//skill task');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(calls('sessions:send')).toEqual(['/skill:pdf task', '/skill task'].map((text) => ({ id: session.id, input: { text, mode: 'now' } })));
    expect(calls('sharedSkills:invoke')).toEqual([]);
  });

  it('sends the literal command once across a remount and leaves a concurrently edited draft intact', async () => {
    const send = Promise.withResolvers<{ sent: true }>();
    invoke.mockImplementation(async (channel: string) => channel === 'sharedSkills:invoke' ? send.promise : undefined);
    const text = '/skill\t summarize-notes   Task line one\n line two  ';
    const first = renderComposer();
    type(first.input, text);
    fireEvent.keyDown(first.input, { key: 'Enter' });
    expect(first.input.value).toBe(text);
    first.unmount();
    const { input } = renderComposer();
    fireEvent.click(button('Send'));
    expect(calls('sharedSkills:invoke')).toEqual([{ id: session.id, text }]);
    type(input, 'New text');
    await act(async () => send.resolve({ sent: true }));
    expect(input.value).toBe('New text');
    expect(useStore.getState().composerHistory[session.id]).toEqual([text]);
    expect(calls('sessions:send')).toEqual([]);
    expect(calls('mission:start')).toEqual([]);
  });

  it('clears an unchanged draft only on acceptance and warns instead of replaying an uncertain send', async () => {
    const send = Promise.withResolvers<{ sent: true }>();
    const text = '/skill summarize-notes Task';
    invoke.mockImplementation(async (channel: string) => channel === 'sharedSkills:invoke' ? send.promise : undefined);
    const { input } = renderComposer();
    type(input, text);
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => send.reject(new Error('Transport disconnected')));
    expect(toast()).toMatch(/check the session before retrying/i);
    expect(input.value).toBe(text);
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    expect(calls('sharedSkills:invoke')).toEqual([{ id: session.id, text }]);
    expect(useStore.getState().composerHistory[session.id]).toBeUndefined();

    invoke.mockImplementation(async (channel: string) => channel === 'sharedSkills:invoke' ? { sent: true } : undefined);
    fireEvent.click(button('Send'));
    await waitFor(() => expect(input.value).toBe(''));
    expect(calls('sharedSkills:invoke')).toHaveLength(2);
    expect(calls('sessions:send')).toEqual([]);
  });

  it.each(['running', 'archived', 'armed', 'goal', 'unsupported harness', 'attachments'] as const)('keeps the draft without dispatch when blocked by %s', async (reason) => {
    const meta: SessionMeta = {
      ...session, status: reason === 'running' ? 'running' : 'idle', archived: reason === 'archived',
      goal: reason === 'goal' ? { objective: 'Finish the plan', status: 'active', createdAt: 0, updatedAt: 0, iterations: 0, maxIterations: 1, autoContinue: true } : undefined,
      config: reason === 'unsupported harness' ? { ...session.config, harness: 'native' } : session.config
    };
    useStore.setState({ sessions: [meta], missionArmed: reason === 'armed' ? { [meta.id]: true } : {} });
    const { input, container } = renderComposer(meta);
    if (reason === 'attachments') {
      const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
      const bytes = new Uint8Array([110]).buffer;
      Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes });
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
      await screen.findByRole('button', { name: 'Remove notes.txt' });
    }
    const text = '/skill summarize-notes Task';
    type(input, text);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe(text);
    expect(toast()).toMatch(/idle|archived|Mission mode|attachments|active goal|does not support shared skills/);
    expect(calls('sharedSkills:invoke')).toEqual([]);
    expect(calls('sessions:send')).toEqual([]);
    expect(calls('mission:start')).toEqual([]);
  });
});
