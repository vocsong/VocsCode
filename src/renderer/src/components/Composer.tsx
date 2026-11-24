/** Prompt input: slash commands, @file mentions, and steer-vs-queue while a turn is running. */
import React, { useEffect, useRef, useState } from 'react';
import type { EffortLevel, FileAttachment, ImageAttachment, PermissionMode, SessionMeta } from '../../../shared/types';
import { formatDoctorReport } from '../../../shared/doctor';
import { HARNESS_BY_ID, SLASH_COMMANDS, effortOptionsFor } from '../../../shared/harness-meta';
import { harnessRoutedText, slashEntries, type HarnessCommand, type SlashEntry } from '../../../shared/harness-commands';
import { harnessCommandNote, useHarnessCommandList } from '../harness-commands';
import { MAX_HOUSEKEEP_RECENT_DAYS } from '../../../shared/housekeep';
import { modelName, parseTypedModel } from '../../../shared/model-names';
import { canInvoke, invoke } from '../api';
import { FileAttachmentChips, readAttachments } from '../attachments';
import { fmtCost, fmtTokens } from '../format';
import { canHousekeepHere, openHousekeep } from '../housekeep';
import { openSettings } from './SettingsView';
import { useSessionModels } from '../models';
import { setSessionEffort } from '../sessionActions';
import { NO_COMPOSER_HISTORY, useStore } from '../store';
import * as host from '../terminal/host';
import { Button, Dropdown, Icon, MenuItem } from './ui';
import { insertTranscript } from '../../../shared/dictation';
import { DictationControl, type DictationHandle } from './DictationControl';
import { SessionControls, SessionMeter } from './SessionControls';
import { useUiMode } from '../ui-mode';

/** With one pane the composer is the only one; in a split, only the active pane's takes focus and inserts. */
function ownsComposerFocus(sessionId: string): boolean {
  const st = useStore.getState();
  return st.layout.panes.length === 1 || st.activeId === sessionId;
}

/** Where the pane hands files dropped anywhere on it; set only while a writable composer is mounted. */
export type AttachFilesRef = React.MutableRefObject<((files: File[]) => void) | null>;

const NO_HARNESS_COMMANDS: HarnessCommand[] = [];

/** The idle prompt's hint, shorter in the minimalist Zen interface. */
const IDLE_PLACEHOLDER = {
  standard: 'Message the agent… @ files · / commands · ! shell',
  zen: 'Ask anything…'
} as const;

export function Composer({ session, attachRef }: { session: SessionMeta; attachRef?: AttachFilesRef }) {
  const setDraft = useStore((s) => s.setDraft);
  // Seed from the per-session draft kept in the store, so switching away and back preserves the text.
  const [text, setText] = useState(() => useStore.getState().drafts[session.id] ?? '');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number; results: string[]; index: number } | null>(null);
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null);
  // History lives in the store, not here: App mounts the composer with `key={session.id}`, so a local
  // copy would be thrown away the moment the user switched sessions and came back.
  const history = useStore((s) => s.composerHistory[session.id] ?? NO_COMPOSER_HISTORY);
  const pushHistory = useStore((s) => s.pushComposerHistory);
  // The browse position stays local — it is a caret-like cursor, not part of the session's record.
  const [histIdx, setHistIdx] = useState(-1);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dictation = useRef<DictationHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.settings?.providers) ?? [];
  const composerInsert = useStore((s) => s.composerInsert);
  const clearComposerInsert = useStore((s) => s.clearComposerInsert);
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  /** `!cmd` runs locally in the terminal; the Run button replaces send/steer/queue while it is typed. */
  const shellDraft = text.trimStart().startsWith('!');
  const harness = HARNESS_BY_ID[session.config.harness];
  const caps = harness.capabilities;
  const uiMode = useUiMode();
  const { models } = useSessionModels(session);
  const currentModel = session.activeModel ?? session.config.model;
  const currentInfo = models.find((m) => currentModel && m.id === currentModel.model && m.provider === currentModel.provider);

  // Only warn when the catalog is explicit. An unknown capability (undefined) is not a claim.
  const visionWarning =
    currentModel && currentInfo?.supportsImages === false
      ? {
          model: modelName(currentModel.provider, currentModel.model),
          detail: caps.dropsUnsupportedImages
            ? `${harness.name} strips the attachment before it reaches the model, so an override here alone will not help — its own model catalog has to list image input too.`
            : 'The provider may reject the request or silently ignore the image.'
        }
      : null;

  const markVisionCapable = async () => {
    if (!currentModel) return;
    try {
      await invoke('models:setOverride', { provider: currentModel.provider, model: currentModel.model, supportsImages: true });
      toast(`${modelName(currentModel.provider, currentModel.model)} is now treated as vision-capable. Undo it under Settings → Providers.`, 'success');
    } catch (e) {
      toast(`Could not save the override: ${(e as Error).message}`, 'error');
    }
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  }, [text]);

  // A split (or a resized window) narrows the box without changing the text: fit it again.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 320) + 'px';
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    // A pane opening beside the one being typed in must not steal the caret.
    if (!el || !ownsComposerFocus(session.id)) return;
    el.focus();
    // Put the caret at the end of a restored draft so typing continues where it left off.
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [session.id]);

  // Mirror every draft change (typed, inserted, history-navigated, cleared after send) into the store.
  useEffect(() => {
    setDraft(session.id, text);
  }, [text, session.id, setDraft]);

  // Text handed over from elsewhere (the terminal's "send to agent") lands below the current draft.
  useEffect(() => {
    // Inserts go to the active session; the composer of another pane leaves them for it.
    if (!composerInsert || !ownsComposerFocus(session.id)) return;
    const insert = composerInsert.text;
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${insert}` : insert));
    clearComposerInsert();
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [composerInsert, clearComposerInsert, session.id]);

  useEffect(() => {
    if (!mention) return;
    // Debounced so typing does not fire an uncancellable full-tree walk per keystroke; results are
    // cleared while a search is in flight instead of seeding the popover with the previous query's.
    setMention((m) => (m ? { ...m, results: [], index: 0 } : m));
    setMentionError(null);
    const query = mention.query;
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke('fs:search', { sessionId: session.id, query, limit: 12 })
        .then((results) => {
          if (!cancelled) setMention((m) => (m && m.query === query ? { ...m, results, index: 0 } : m));
        })
        .catch(() => {
          if (!cancelled) setMentionError('Search unavailable');
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention?.query, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reportedCommands = useHarnessCommandList(session);
  const harnessCommands = reportedCommands ?? NO_HARNESS_COMMANDS;
  const slashMatches: SlashEntry[] = slash
    ? slashEntries({
        query: slash.query,
        app: SLASH_COMMANDS,
        harness: harnessCommands,
        // The app's /compact already asks the harness to compact; a second row would do the same.
        delegated: ['compact'],
        nativeGoal: session.nativeGoal
      })
    : [];
  const harnessNote = harnessCommandNote(harness, reportedCommands);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Arrow keys can walk past the popover's visible rows; keep the highlighted one in view.
  useEffect(() => {
    popoverRef.current?.querySelector<HTMLElement>('.popover-item.active')?.scrollIntoView?.({ block: 'nearest' });
  }, [slash?.index, slash?.query]);
  const isCompleteCommand = (query: string) => {
    const q = query.toLowerCase();
    return SLASH_COMMANDS.some((c) => c.name === q) || harnessCommands.some((c) => c.name.toLowerCase() === q || c.aliases?.some((a) => a.toLowerCase() === q));
  };
  /** Puts a picked row in the box: `/name ` (or `//name ` for a shadowed harness command), ready for arguments. */
  const pickSlash = (entry: SlashEntry) => {
    setText(`/${entry.insert} `);
    setSlash(null);
    ref.current?.focus();
  };

  /** Runs `!` draft in the session's shell: switch to the Terminal tab and type it in. Nothing reaches the harness. */
  const runShell = async (command: string) => {
    await host.runInTerminal(session.id, command);
  };

  const send = async (mode: 'now' | 'steer' | 'queue' = 'now') => {
    const t = text.trim();
    if (!t && !images.length && !files.length) return;
    // Clears the draft and every popover/filter state derived from it. setText is programmatic here,
    // so onChange never fires — without this the stale mention/slash state keeps its key handling
    // alive and swallows ArrowUp/ArrowDown, breaking input history right after a send.
    const clearDraft = () => {
      setText('');
      setMention(null);
      setMentionError(null);
      setSlash(null);
      setHistIdx(-1);
    };
    const typedCommand = t.startsWith('/') ? t.slice(1).split(/\s+/)[0] : '';
    if (typedCommand === 'housekeep') {
      if (images.length || files.length) { toast('Housekeep cannot include attachments.', 'error'); return; }
      const arg = t.slice('/housekeep'.length).trim().toLowerCase();
      const days = /^\d+$/.test(arg) ? Number(arg) : undefined;
      if (arg && arg !== 'sessions' && arg !== 'settings' && (days === undefined || days > MAX_HOUSEKEEP_RECENT_DAYS)) {
        toast(`Usage: /housekeep [days|sessions|settings]. Enter a whole number from 0 to ${MAX_HOUSEKEEP_RECENT_DAYS} for a one-time override.`, 'info');
        return;
      }
      if (!canHousekeepHere()) { toast('Housekeep is available in the desktop app.', 'info'); return; }
      clearDraft();
      setDraft(session.id, '');
      if (arg === 'settings') openSettings('housekeep');
      else openHousekeep(days);
      return;
    }
    // `//name` is the explicit route to a harness command an app command shadows: one slash comes
    // off and the rest goes to the harness as an ordinary message (shared/harness-commands.ts).
    const routed = harnessRoutedText(t, SLASH_COMMANDS.map((c) => c.name));
    // A command the harness owns itself is prompt text, not an app command: `/goal` on a session whose
    // harness has its own goal goes to the harness verbatim (see shared/goal-driver.ts). The rest of
    // the send path is unchanged, so history and draft handling stay correct for free.
    if (typedCommand && typedCommand === session.nativeGoal?.toLowerCase()) {
      toast(`${harness.name} answers /${typedCommand} itself — sent to the harness.`, 'info');
      useStore.getState().setPanelTab('goal');
    } else if (typedCommand && SLASH_COMMANDS.some((c) => c.name === typedCommand)) {
      if (files.length) { toast('App commands cannot include file attachments. Remove them or send a regular message.', 'error'); return; }
      // Known commands are cleared right away so long-running ones (/pr, /merge…) do not leave the
      // composer looking frozen; their progress and outcome appear as info lines in the transcript.
      clearDraft();
      void runSlash(t).catch((e) => toast(String((e as Error).message ?? e), 'error'));
      return;
    }
    if (t.startsWith('!')) {
      if (files.length) { toast('Shell commands cannot include file attachments. Remove them first.', 'error'); return; }
      const command = t.slice(1).trim();
      pushHistory(session.id, t);
      clearDraft();
      if (command) await runShell(command);
      else toast('Type a command after ! — for example !git status', 'info');
      return;
    }
    const input = { text: routed ?? t, images: images.length ? images : undefined, files: files.length ? files : undefined, mode: busy ? mode : 'now' as const };
    pushHistory(session.id, t);
    clearDraft();
    setImages((current) => current.filter((image) => !images.includes(image)));
    setFiles((current) => current.filter((file) => !files.includes(file)));
    try {
      await invoke('sessions:send', { id: session.id, input });
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
      // Keep a newer draft intact if the rejected send settled after the user began typing again.
      setText((current) => current ? `${t}${t ? '\n\n' : ''}${current}` : t);
      setImages((current) => [...images, ...current]);
      setFiles((current) => [...files, ...current]);
    }
  };

  const runSlash = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const store = useStore.getState();
    switch (cmd) {
      case 'help': {
        // A transcript note, not a toast: with a harness's skills listed it runs to many lines.
        const own = slashEntries({ query: '', app: SLASH_COMMANDS, harness: harnessCommands, delegated: ['compact'], nativeGoal: session.nativeGoal }).filter((c) => c.source === 'harness');
        const lines = [
          `Vocs Code: ${SLASH_COMMANDS.map((c) => '/' + c.name).join(' ')}`,
          own.length ? `${harness.name}: ${own.map((c) => '/' + c.insert).join(' ')}` : harnessNote ?? '',
          ...(own.some((c) => c.shadowed) ? [`A doubled slash (//name) runs ${harness.name}'s own command where Vocs Code has one of the same name.`] : []),
          'Enter send · Shift+Enter newline · Esc stop · ! shell · @ files · Ctrl+K palette'
        ].filter(Boolean);
        store.setLocalInfo(session.id, `local-help-${session.id}`, lines.join('\n'));
        return true;
      }
      case 'doctor': {
        // Runtimes are probed live (each probe can cost a process spawn), so the note shows up right
        // away and is replaced by the report. Renderer-local like the other command notes: it is a
        // reading of this machine at this moment, not part of the conversation.
        const noteId = `local-doctor-${session.id}`;
        store.setLocalInfo(session.id, noteId, 'Checking harness runtimes and provider keys…', { pending: true });
        try {
          const [info, report] = await Promise.all([invoke('app:info', undefined), invoke('app:doctor', undefined)]);
          const { text, level } = formatDoctorReport(report, info);
          store.setLocalInfo(session.id, noteId, text, { level });
        } catch (e) {
          store.setLocalInfo(session.id, noteId, `Doctor failed: ${String((e as Error).message ?? e)}`, { level: 'error' });
        }
        return true;
      }
      case 'model': {
        if (!arg) {
          toast('Usage: /model provider/model', 'error');
          return true;
        }
        const ref = parseTypedModel(arg, providers.map((p) => p.id), session.activeModel?.provider ?? 'anthropic');
        await invoke('sessions:setModel', { id: session.id, model: ref }).catch((e) => toast(String(e.message ?? e), 'error'));
        return true;
      }
      case 'mode':
        if (!caps.permissionModes.includes(arg as PermissionMode)) {
          toast(`Modes: ${caps.permissionModes.join(', ')}`, 'error');
          return true;
        }
        await invoke('sessions:setPermissionMode', { id: session.id, mode: arg as PermissionMode });
        return true;
      case 'effort': {
        if (!caps.effort) {
          toast(`${harness.name} does not support reasoning effort.`, 'error');
          return true;
        }
        const efforts = effortOptionsFor(harness, currentInfo);
        if (!efforts.length) {
          toast(`${currentInfo?.displayName ?? 'This model'} does not support reasoning effort.`, 'error');
          return true;
        }
        if (!efforts.includes(arg as EffortLevel)) {
          toast(`Efforts: ${efforts.join(', ')}`, 'error');
          return true;
        }
        await setSessionEffort(session.id, arg as EffortLevel, toast);
        return true;
      }
      case 'goal': {
        const sub = rest[0];
        if (!sub || sub === 'status') {
          const g = session.goal;
          toast(g ? `Goal (${g.status}, ${g.iterations}/${g.maxIterations}): ${g.objective}` : 'No goal set. Use /goal <objective>.', 'info');
          store.setPanelTab('goal');
          return true;
        }
        if (['pause', 'resume', 'clear', 'complete'].includes(sub)) {
          await invoke('sessions:goal', { id: session.id, action: sub as 'pause' | 'resume' | 'clear' | 'complete' });
          return true;
        }
        await invoke('sessions:goal', { id: session.id, action: 'set', objective: arg });
        store.setPanelTab('goal');
        return true;
      }
      case 'diff':
        store.setPanelTab('changes');
        return true;
      case 'mcp':
        store.setPanelTab('mcp');
        return true;
      case 'cost':
        toast(`${fmtCost(session.usage.costUsd)} · ${fmtTokens(session.usage.inputTokens)} in / ${fmtTokens(session.usage.outputTokens)} out · ${session.usage.turns} turns`, 'info');
        store.setPanelTab('usage');
        return true;
      case 'compact': {
        const noteId = `local-compact-${session.id}`;
        store.setLocalInfo(session.id, noteId, 'Compacting context…', { pending: true });
        const r = await invoke('sessions:compact', { id: session.id });
        store.setLocalInfo(session.id, noteId, r.ok ? 'Context compacted' : r.detail ?? 'Not supported', { level: r.ok ? 'info' : 'error' });
        return true;
      }
      case 'clear':
        await invoke('sessions:clearTranscript', { id: session.id });
        store.clearTranscriptLocal(session.id);
        return true;
      case 'rename':
        if (arg) await invoke('sessions:rename', { id: session.id, title: arg });
        return true;
      case 'export': {
        const r = await invoke('sessions:export', { id: session.id });
        if (r.path) toast(`Exported to ${r.path}`, 'success');
        return true;
      }
      case 'open':
        if (arg === 'editor') await invoke('app:openInEditor', { path: session.cwd, sessionId: session.id }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error'));
        else if (arg === 'terminal') await invoke('app:openTerminal', { cwd: session.cwd }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error'));
        else await invoke('app:openPath', { path: session.cwd, sessionId: session.id });
        return true;
      case 'worktree':
        toast(session.worktreeBranch ? `Worktree ${session.cwd} on branch ${session.worktreeBranch}` : 'This session runs directly in the project folder.', 'info');
        return true;
      case 'pr': {
        if (!arg) {
          toast('Usage: /pr <base branch> — pushes this branch and opens a PR into it.', 'error');
          return true;
        }
        // Push + gh pr create can take tens of seconds; show progress here, then let the main
        // process's persistent transcript note carry the outcome (it survives a restart).
        const noteId = `local-pr-${session.id}`;
        store.setLocalInfo(session.id, noteId, `Pushing this branch and opening a PR into ${arg}…`, { pending: true });
        try {
          await invoke('git:pr', { sessionId: session.id, base: arg });
        } catch (e) {
          store.setLocalInfo(session.id, noteId, `Failed to open the PR: ${String((e as Error).message ?? e)}`, { level: 'error' });
          return true;
        }
        store.setLocalInfo(session.id, noteId, null);
        return true;
      }
      case 'merge': {
        const noteId = `local-merge-${session.id}`;
        store.setLocalInfo(session.id, noteId, 'Merging the open PR for this branch…', { pending: true });
        try {
          await invoke('git:merge', { sessionId: session.id, base: arg || undefined });
        } catch (e) {
          store.setLocalInfo(session.id, noteId, `Failed to merge the PR: ${String((e as Error).message ?? e)}`, { level: 'error' });
          return true;
        }
        store.setLocalInfo(session.id, noteId, null);
        return true;
      }
      case 'stop':
        await invoke('sessions:interrupt', { id: session.id });
        return true;
      default:
        return false; // let the harness handle unknown slash commands (e.g. Claude Code's own)
    }
  };

  /** A transcript goes in at the caret (replacing a selection), and the caret ends up after it. */
  const insertDictation = (said: string) => {
    const el = ref.current;
    // The clip finished after the user switched sessions: it belongs to this session's draft.
    if (!el) {
      const draft = useStore.getState().drafts[session.id] ?? '';
      setDraft(session.id, insertTranscript(draft, draft.length, draft.length, said).text);
      return;
    }
    const current = el?.value ?? text;
    const { text: next, caret } = insertTranscript(current, el?.selectionStart ?? current.length, el?.selectionEnd ?? current.length, said);
    setText(next);
    setHistIdx(-1);
    requestAnimationFrame(() => {
      const box = ref.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') {
      e.preventDefault();
      dictation.current?.toggle();
      return;
    }
    if (mention && mention.results.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention({ ...mention, index: (mention.index + 1) % mention.results.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({ ...mention, index: (mention.index - 1 + mention.results.length) % mention.results.length });
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pickMention(mention.results[mention.index]);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (slash && slashMatches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlash({ ...slash, index: (slash.index + 1) % slashMatches.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlash({ ...slash, index: (slash.index - 1 + slashMatches.length) % slashMatches.length });
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        pickSlash(slashMatches[slash.index]);
        return;
      }
      // Enter on a partly typed name takes the highlighted row instead of sending `/rev` as a
      // message; a complete name (`/stop`, `/review`) still runs straight away.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isCompleteCommand(slash.query)) {
        e.preventDefault();
        pickSlash(slashMatches[slash.index]);
        return;
      }
      if (e.key === 'Escape') {
        setSlash(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(busy && caps.steer ? 'steer' : busy ? 'queue' : 'now');
      return;
    }
    if (e.key === 'Escape') {
      if (busy && !text) void invoke('sessions:interrupt', { id: session.id });
      return;
    }
    // Input history: ArrowUp walks back through earlier prompts, ArrowDown returns toward the draft.
    const browsing = histIdx >= 0 && text === history[histIdx];
    if (e.key === 'ArrowUp' && history.length && (!text || browsing)) {
      e.preventDefault();
      const i = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(i);
      setText(history[i]);
      return;
    }
    if (e.key === 'ArrowDown' && browsing) {
      e.preventDefault();
      const i = histIdx - 1;
      setHistIdx(i);
      setText(i >= 0 ? history[i] : '');
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v);
    const pos = e.target.selectionStart ?? v.length;
    const before = v.slice(0, pos);
    const at = before.match(/(?:^|\s)@([\w./\\-]*)$/);
    if (at) setMention({ query: at[1], start: pos - at[1].length - 1, results: mention?.results ?? [], index: 0 });
    else setMention(null);
    // Harness names carry `-`, `:` and `.` (`security-review`, `skill:pdf`, `plugin:deploy`).
    const sl = v.match(/^\/([\w:.-]*)$/);
    setSlash(sl ? { query: sl[1], index: 0 } : null);
  };

  const pickMention = (file: string) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    setText(`${before}@${file} ${after}`);
    setMention(null);
    ref.current?.focus();
  };

  const addFiles = async (list: Iterable<File>) => {
    const chosen = [...list];
    const added = await readAttachments(chosen, (message) => toast(message, 'error'));
    setImages((prev) => [...prev, ...added.images]);
    setFiles((prev) => [...prev, ...added.files]);
  };

  // A file dropped anywhere on the pane lands here, and the caret follows so typing can go on.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    if (!attachRef) return;
    attachRef.current = (dropped) => {
      void addFilesRef.current(dropped);
      ref.current?.focus();
    };
    return () => {
      attachRef.current = null;
    };
  }, [attachRef]);

  const onPaste = (e: React.ClipboardEvent) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    void addFiles(pasted);
  };

  const secondaryItems = (close: () => void) => <>
    <MenuItem onClick={() => { close(); fileInput.current?.click(); }}>Attach files</MenuItem>
    <MenuItem hint={`${fmtCost(session.usage.costUsd)}${session.usage.contextWindow && session.usage.contextTokens ? ` · ${Math.round(100 * session.usage.contextTokens / session.usage.contextWindow)}% context` : ''}`} onClick={() => { close(); useStore.getState().setPanelTab('usage'); }}>Session usage</MenuItem>
    {(session.queued ?? 0) > 0 && <div className="run-more-note" role="status">{session.queued} messages waiting for the current turn</div>}
  </>;

  return (
    <div className="composer">
      {mention && (mention.results.length > 0 || mentionError) && (
        <div className="popover">
          {mentionError ? (
            <div className="popover-item muted"><Icon name="alert" size={12} /> {mentionError}</div>
          ) : mention.results.map((r, i) => (
            <button key={r} type="button" className={`popover-item mono ${i === mention.index ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickMention(r); }}>
              <Icon name="file" size={12} /> {r}
            </button>
          ))}
        </div>
      )}
      {slash && slashMatches.length > 0 && (
        <div className="popover slash-popover" ref={popoverRef} role="listbox" aria-label="Slash commands">
          {slashMatches.map((c, i) => (
            <React.Fragment key={`${c.source}:${c.insert}`}>
              {(i === 0 || slashMatches[i - 1].source !== c.source) && (
                <div className="slash-section" role="presentation">{c.source === 'app' ? 'Vocs Code' : harness.name}</div>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === slash.index}
                data-source={c.source}
                className={`popover-item slash-item ${i === slash.index ? 'active' : ''}`}
                title={c.shadowed ? `Vocs Code has its own /${c.insert.slice(1)}; //${c.insert.slice(1)} sends this one to ${harness.name}.` : undefined}
                onMouseDown={(e) => { e.preventDefault(); pickSlash(c); }}
              >
                <span className="mono slash-name">/{c.insert}</span>
                {c.args && <span className="muted slash-args">{c.args}</span>}
                {c.kind && c.kind !== 'command' && <span className="slash-kind">{c.kind}</span>}
                <span className="spacer" />
                <span className="muted small slash-desc">{c.shadowed ? [`${harness.name}'s own`, c.description].filter(Boolean).join(' · ') : c.description}</span>
              </button>
            </React.Fragment>
          ))}
          {harnessNote && <div className="slash-note muted small" role="note">{harnessNote}</div>}
        </div>
      )}
      {images.length > 0 && (
        <>
          {visionWarning && (
            <div className="composer-warn">
              <Icon name="alert" size={14} />
              <span>
                <strong>{visionWarning.model}</strong> is listed as text-only. {visionWarning.detail}
              </span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => void markVisionCapable()} title="Record an override in Settings → Providers so this model is treated as vision-capable">
                It does accept images
              </Button>
            </div>
          )}
          <div className="attachments">
            {images.map((im, i) => (
              <div key={i} className="attachment">
                <img src={`data:${im.mimeType};base64,${im.data}`} alt={im.name ?? 'image'} />
                <button type="button" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <FileAttachmentChips files={files} onRemove={(i) => setFiles((current) => current.filter((_, j) => j !== i))} />
      <div className="composer-box">
        <textarea
          ref={ref}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={busy ? (caps.steer ? 'Steer the agent… (Enter sends now; send menu to queue)' : 'Queue a follow-up… (sent after this turn)') : IDLE_PLACEHOLDER[uiMode]}
          rows={1}
          spellCheck
        />
        <div className="composer-actions">
          <button type="button" className="icon-btn composer-attach" title="Attach files" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
            <Icon name="plus" size={16} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles([...e.target.files]); e.target.value = ''; }} />
          <SessionControls session={session} />
          <span className="spacer" />
          {(session.queued ?? 0) > 0 && <span className="queued-hint" title="Messages waiting for the current turn">{session.queued}<span className="queued-label"> queued</span></span>}
          <SessionMeter session={session} />
          {canInvoke('dictation:transcribe') ? <DictationControl ref={dictation} onText={insertDictation} menuItems={secondaryItems} /> : (
            <Dropdown align="right" width={260} trigger={() => <button type="button" className="icon-btn" title="Composer options" aria-label="Composer options"><Icon name="more" size={16} /></button>}>
              {secondaryItems}
            </Dropdown>
          )}
          {shellDraft ? (
            <Button size="sm" variant="primary" icon="terminal" onClick={() => void send()} disabled={!text.trim().slice(1).trim()} title="Run in this session's terminal without sending anything to the agent">
              Run
            </Button>
          ) : busy ? (
            <>
              <div className="composer-send-group">
                <Button size="sm" variant="primary" icon={caps.steer ? 'arrowUp' : 'clock'} onClick={() => void send(caps.steer ? 'steer' : 'queue')} title={caps.steer ? 'Steer now (Enter)' : 'Queue (Enter)'} aria-label={caps.steer ? 'Steer' : 'Queue'}>
                  <span className="composer-send-label">{caps.steer ? 'Steer' : 'Queue'}</span>
                </Button>
                {caps.steer && caps.queue && <Dropdown align="right" width={240} trigger={() => <Button size="sm" variant="primary" className="composer-send-options" icon="chevron" title="Send options" aria-label="Send options" />}>
                  {(close) => <MenuItem hint="After the current turn" onClick={() => { close(); void send('queue'); }}>Queue</MenuItem>}
                </Dropdown>}
              </div>
              <Button size="sm" variant="danger" icon="stop" className="btn-icon" onClick={() => void invoke('sessions:interrupt', { id: session.id })} title="Interrupt (Esc)" />
            </>
          ) : (
            <Button size="sm" variant="primary" icon="arrowUp" className="send-btn" onClick={() => void send()} disabled={!text.trim() && !images.length && !files.length} title="Send (Enter) · Shift+Enter for a new line" aria-label="Send" />
          )}
        </div>
      </div>
    </div>
  );
}

export async function fileToAttachment(f: File): Promise<ImageAttachment> {
  const buf = await f.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mimeType: f.type || 'image/png', data: btoa(binary), name: f.name };
}
