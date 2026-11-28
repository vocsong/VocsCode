/** Prompt input: slash commands, @file mentions, and steer-vs-queue while a turn is running. */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FileAttachment, ImageAttachment, ProviderConfig, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID, SLASH_COMMANDS } from '../../../shared/harness-meta';
import { harnessRoutedText, slashEntries, type HarnessCommand, type SlashEntry } from '../../../shared/harness-commands';
import { harnessCommandNote, useHarnessCommandList } from '../harness-commands';
import { MAX_HOUSEKEEP_RECENT_DAYS } from '../../../shared/housekeep';
import { hasOngoingWork } from '../../../shared/ongoing';
import { modelName } from '../../../shared/model-names';
import { missionSupport } from '../../../shared/mission-mode';
import { insertTranscript } from '../../../shared/dictation';
import { isSharedSkillCommand, parseSharedSkillCommand, type SharedSkillInfo } from '../../../shared/shared-skills';
import { canInvoke, invoke, invokeErrorMessage } from '../api';
import { readAttachments } from '../attachments';
import { fmtCost } from '../format';
import { canHousekeepHere, openHousekeep } from '../housekeep';
import { LEAD_HARNESS_NAMES, MISSION_ENDED_TEXT, missionEnded } from '../mission';
import { openSettings } from './SettingsView';
import { useSessionModels } from '../models';
import { NO_COMPOSER_HISTORY, useStore } from '../store';
import * as host from '../terminal/host';
import { useUiMode } from '../ui-mode';
import { Dropdown, Icon, MenuItem } from './ui';
import { DictationControl, type DictationHandle } from './DictationControl';
import { SessionControls, SessionMeter } from './SessionControls';
import { FastModeElectric } from './FastModeElectric';
import { canUseSharedSkills, sharedSkillSessionBlocker } from './SharedSkillsView';
import { ComposerAttachments, fileToAttachment } from './composer/ComposerAttachments';
import { MentionPopover, SlashPopover, type MentionState, type SlashState } from './composer/ComposerPopovers';
import { ComposerSendControls } from './composer/ComposerSendControls';
import { runComposerSlashCommand } from './composer/slash-commands';

export { fileToAttachment };

/** With one pane the composer is the only one; in a split, only the active pane's takes focus and inserts. */
function ownsComposerFocus(sessionId: string): boolean {
  const st = useStore.getState();
  return st.layout.panes.length === 1 || st.activeId === sessionId;
}

/** Where the pane hands files dropped anywhere on it; set only while a writable composer is mounted. */
export type AttachFilesRef = React.MutableRefObject<((files: File[]) => void) | null>;

const NO_HARNESS_COMMANDS: HarnessCommand[] = [];
const NO_PROVIDERS: ProviderConfig[] = [];
// A pane can unmount and remount before the host acknowledges the send.
const pendingSharedSends = new Set<string>();

/** The idle prompt's hint, shorter in the minimalist Zen interface. */
const IDLE_PLACEHOLDER = {
  standard: 'Message the agent… @ files · / commands · ! shell',
  zen: 'Ask anything…'
} as const;

const ONGOING_PLACEHOLDER = {
  standard: 'Background work running… send a message anytime',
  zen: 'Background work running…'
} as const;

export function Composer({ session, attachRef }: { session: SessionMeta; attachRef?: AttachFilesRef }) {
  // Use the per-session draft directly: the Skills view can stage it, and a send may settle across a remount.
  const text = useStore((s) => s.drafts[session.id] ?? '');
  const setText = useCallback((next: string | ((draft: string) => string)) => {
    const st = useStore.getState();
    st.setDraft(session.id, typeof next === 'string' ? next : next(st.drafts[session.id] ?? ''));
  }, [session.id]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const readingAttachments = useRef(0);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [sharedSkills, setSharedSkills] = useState<SharedSkillInfo[]>([]);
  const [sharedIndex, setSharedIndex] = useState(0);
  const [dismissedSharedDraft, setDismissedSharedDraft] = useState<string | null>(null);
  const sharedListId = useId();
  const sharedPopoverRef = useRef<HTMLDivElement>(null);
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
  const providers = useStore((s) => s.settings?.providers) ?? NO_PROVIDERS;
  const composerInsert = useStore((s) => s.composerInsert);
  const clearComposerInsert = useStore((s) => s.clearComposerInsert);
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  /** `!cmd` runs locally in the terminal; the Run button replaces send/steer/queue while it is typed. */
  const shellDraft = text.trimStart().startsWith('!');
  const harness = HARNESS_BY_ID[session.config.harness];
  const caps = harness.capabilities;
  // Mission mode: the switch arms this session's next send; a Lead is always on; an ended mission is read-only.
  const missionRole = session.mission?.role;
  const armed = useStore((s) => !!s.missionArmed[session.id]) && !missionRole;
  const archiving = useStore((s) => !!s.archiving[session.id]);
  const ended = missionEnded(session);
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
  }, [composerInsert, clearComposerInsert, session.id, setText]);

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
  const nativeGoal = session.nativeGoal?.toLowerCase() === 'goal' ? 'goal' : undefined;
  const canListShared = canUseSharedSkills('sharedSkills:list');
  // This is a name prefix, not the command's task. Never offers completions for native /skill:name or //skill.
  const sharedQuery = dismissedSharedDraft === text ? undefined : /^\/skill[ \t]+([a-z0-9-]*)$/.exec(text)?.[1];
  const suggestShared = sharedQuery !== undefined && canListShared && canUseSharedSkills('sharedSkills:invoke') &&
    !sharedSkillSessionBlocker(session, armed, archiving);
  useEffect(() => {
    setSharedSkills([]);
    if (!suggestShared) return;
    let alive = true;
    void invoke('sharedSkills:list', undefined).then((list) => {
      if (alive) setSharedSkills(list.filter((skill) => skill.reviewed));
    }).catch(() => { /* autocomplete is optional; a typed command still goes through the host */ });
    return () => { alive = false; };
  }, [suggestShared, session.id]);
  const sharedMatches = suggestShared ? sharedSkills.filter((skill) => skill.name.startsWith(sharedQuery!))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12) : [];
  const sharedActiveIndex = sharedIndex < sharedMatches.length ? sharedIndex : 0;
  const sharedActive = sharedMatches[sharedActiveIndex];
  useEffect(() => {
    sharedPopoverRef.current?.querySelector<HTMLElement>('.popover-item.active')?.scrollIntoView?.({ block: 'nearest' });
  }, [sharedActive?.name]);
  const pickShared = ({ name, revision }: SharedSkillInfo) => {
    useStore.getState().setDraft(session.id, `/skill ${name} `, { name, revision });
    setMention(null);
    setSlash(null);
    ref.current?.focus();
  };

  const slashMatches: SlashEntry[] = slash
    ? slashEntries({
        query: slash.query,
        app: SLASH_COMMANDS,
        harness: harnessCommands,
        // The app's /compact already asks the harness to compact; a second row would do the same.
        delegated: ['compact'],
        nativeGoal
      }).filter((row) => canListShared || row.source !== 'app' || row.insert !== 'skill')
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
    const st = useStore.getState();
    const original = st.drafts[session.id] ?? '';
    const t = original.trim();
    if (!t && !images.length && !files.length) return;
    if (pendingSharedSends.has(session.id)) {
      toast('Wait for the shared skill send to finish.', 'info');
      return;
    }
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
    // Own this namespace before Mission, app commands or ordinary sends. Don't turn leading whitespace
    // into a shared command by normalizing the draft, and never re-serialize its task arguments.
    if (isSharedSkillCommand(t)) {
      if (!isSharedSkillCommand(original)) {
        toast('Start /skill at the beginning of the draft, without leading spaces.', 'info');
        return;
      }
      if (images.length || files.length || readingAttachments.current) {
        toast('Shared skills cannot include attachments. Remove them before using /skill.', 'error');
        return;
      }
      if (t === '/skill') {
        if (!canUseSharedSkills('sharedSkills:list')) { toast('Shared skills are available in the desktop app.', 'info'); return; }
        clearDraft();
        st.setView('skills');
        return;
      }
      const command = parseSharedSkillCommand(original);
      if (!command) { toast('Usage: /skill <name> [task]', 'info'); return; }
      if (!canUseSharedSkills('sharedSkills:invoke')) { toast('Shared skills are available in the desktop app.', 'info'); return; }
      const latest = st.sessions.find((s) => s.id === session.id) ?? session;
      const blocker = sharedSkillSessionBlocker(latest, !!st.missionArmed[session.id], !!st.archiving[session.id]);
      if (blocker || mode !== 'now') { toast(blocker ?? 'Wait until the session is idle to use a shared skill.', 'info'); return; }
      pendingSharedSends.add(session.id);
      let edited = false;
      const pin = st.draftSharedSkills[session.id];
      const stopWatching = useStore.subscribe((next, previous) => {
        if (next.drafts[session.id] !== previous.drafts[session.id] || next.draftSharedSkills[session.id] !== previous.draftSharedSkills[session.id]) edited = true;
      });
      try {
        const result = await invoke('sharedSkills:invoke', { id: session.id, text: original, ...(pin?.name === command.name ? { revision: pin.revision } : {}) });
        if (result?.sent !== true) throw new Error('No send confirmation was returned.');
        pushHistory(session.id, original);
        if (!edited) clearDraft();
      } catch (e) {
        toast(`Could not confirm the shared skill was sent. Check the session before retrying. ${invokeErrorMessage(e)}`, 'error');
      } finally {
        stopWatching();
        pendingSharedSends.delete(session.id);
      }
      return;
    }
    if (ended) return;
    const [command, ...args] = t.startsWith('/') ? t.slice(1).split(/\s+/) : [''];
    // The popover matches /usage case-insensitively; make sure alternate casing stays local too.
    const typedCommand = command.toLowerCase() === 'usage' ? 'usage' : command;
    // Mission mode: `/mission <task>`, or any prompt while the switch is armed, starts a mission. On a
    // Lead the mission is already on, so `/mission <text>` is just a follow-up for it.
    const missionCommand = typedCommand === 'mission';
    const missionTask = missionCommand ? t.slice('/mission'.length).trim() : t;
    if (missionCommand && missionRole === 'builder') {
      toast('This is a Mission Builder. Message its Lead to change the mission.', 'info');
      return;
    }
    const appCommand = !!typedCommand && !missionCommand && SLASH_COMMANDS.some((c) => c.name === typedCommand);
    if (!missionRole && (missionCommand || (armed && !appCommand && !t.startsWith('!')))) {
      if (!missionSupport(session.config.harness).lead) {
        toast(`${harness.name} cannot lead a mission. Mission mode runs on ${LEAD_HARNESS_NAMES.join(', ')}.`, 'error');
        return;
      }
      if (!canInvoke('mission:start')) {
        toast('Mission mode starts from the desktop app.', 'info');
        return;
      }
      if (!missionTask) {
        toast('Describe the task for the mission, for example /mission add rate limiting to the API.', 'info');
        return;
      }
      const sentImages = images;
      const sentFiles = files;
      pushHistory(session.id, t);
      clearDraft();
      setImages((current) => current.filter((image) => !sentImages.includes(image)));
      setFiles((current) => current.filter((file) => !sentFiles.includes(file)));
      try {
        const { leadId } = await invoke('mission:start', {
          sessionId: session.id,
          input: { text: missionTask, images: sentImages.length ? sentImages : undefined, files: sentFiles.length ? sentFiles : undefined, mode: 'now' }
        });
        useStore.getState().setMissionArmed(session.id, false);
        await useStore.getState().setActive(leadId);
      } catch (e) {
        toast(invokeErrorMessage(e), 'error');
        setText((current) => (current ? `${t}\n\n${current}` : t));
        setImages((current) => [...sentImages, ...current]);
        setFiles((current) => [...sentFiles, ...current]);
      }
      return;
    }
    if (missionCommand && !missionTask && !images.length && !files.length) {
      toast('Usage: /mission <task>', 'info');
      return;
    }
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
      if (arg === 'settings') openSettings('housekeep');
      else openHousekeep(days);
      return;
    }
    // `//name` is the explicit route to a harness command an app command shadows: one slash comes
    // off and the rest goes to the harness as an ordinary message (shared/harness-commands.ts).
    const routed = missionCommand ? missionTask : harnessRoutedText(t, SLASH_COMMANDS.map((c) => c.name));
    // A command the harness owns itself is prompt text, not an app command: `/goal` on a session whose
    // harness has its own goal goes to the harness verbatim (see shared/goal-driver.ts). The rest of
    // the send path is unchanged, so history and draft handling stay correct for free.
    if (nativeGoal && typedCommand === nativeGoal) {
      toast(`${harness.name} answers /${typedCommand} itself — sent to the harness.`, 'info');
      useStore.getState().setPanelTab('goal');
    } else if (appCommand) {
      if (files.length) { toast('App commands cannot include file attachments. Remove them or send a regular message.', 'error'); return; }
      // Known commands are cleared right away so long-running ones (/pr, /merge…) do not leave the
      // composer looking frozen; their progress and outcome appear as info lines in the transcript.
      clearDraft();
      void runComposerSlashCommand(typedCommand, args, {
        session,
        harness,
        currentInfo,
        providers,
        harnessCommands,
        harnessNote,
        nativeGoal,
        toast
      }).catch((e) => toast(String((e as Error).message ?? e), 'error'));
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
      setText((current) => (current ? `${t}${t ? '\n\n' : ''}${current}` : t));
      setImages((current) => [...images, ...current]);
      setFiles((current) => [...files, ...current]);
    }
  };

  /** A transcript goes in at the caret (replacing a selection), and the caret ends up after it. */
  const insertDictation = (said: string) => {
    const el = ref.current;
    // The clip finished after the user switched sessions: it belongs to this session's draft.
    if (!el) {
      const draft = useStore.getState().drafts[session.id] ?? '';
      setText(insertTranscript(draft, draft.length, draft.length, said).text);
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
    if (e.key === 'Enter' && e.repeat && !e.shiftKey && isSharedSkillCommand(text)) {
      e.preventDefault();
      return;
    }
    if (sharedActive && !e.nativeEvent.isComposing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedSharedDraft(text);
        return;
      }
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setSharedIndex((sharedActiveIndex + (e.key === 'ArrowDown' ? 1 : -1) + sharedMatches.length) % sharedMatches.length);
          return;
        }
        // Enter completes a partial name; an exact, selected name can be sent in one step.
        if (e.key === 'Tab' || (e.key === 'Enter' && sharedQuery !== sharedActive.name)) {
          e.preventDefault();
          pickShared(sharedActive);
          return;
        }
      }
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
    setSharedIndex(0);
    setDismissedSharedDraft(null);
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
    ++readingAttachments.current;
    try {
      const added = await readAttachments(list, (message) => toast(message, 'error'));
      setImages((prev) => [...prev, ...added.images]);
      setFiles((prev) => [...prev, ...added.files]);
    } finally { --readingAttachments.current; }
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
      <MentionPopover mention={mention} mentionError={mentionError} onPick={pickMention} />
      <SlashPopover slash={slash} slashMatches={slashMatches} harnessName={harness.name} harnessNote={harnessNote} popoverRef={popoverRef} onPick={pickSlash} />
      {sharedActive && (
        <div id={sharedListId} ref={sharedPopoverRef} className="popover slash-popover" role="listbox" aria-label="Shared skills">
          <div className="slash-section" role="presentation">Shared skills</div>
          {sharedMatches.map((skill, i) => (
            <button key={skill.name} id={`${sharedListId}-${i}`} type="button" tabIndex={-1} role="option" aria-selected={i === sharedActiveIndex}
              className={`popover-item slash-item ${i === sharedActiveIndex ? 'active' : ''}`}
              onPointerDown={(e) => e.preventDefault()} onClick={() => pickShared(skill)}>
              <span className="mono slash-name">{skill.name}</span>
              <span className="spacer" />
              <span className="muted small slash-desc">{skill.description}</span>
            </button>
          ))}
        </div>
      )}
      <ComposerAttachments
        images={images}
        files={files}
        visionWarning={visionWarning}
        onMarkVisionCapable={() => void markVisionCapable()}
        onRemoveImage={(i) => setImages((current) => current.filter((_, j) => j !== i))}
        onRemoveFile={(i) => setFiles((current) => current.filter((_, j) => j !== i))}
      />
      <div className={`composer-box${armed ? ' is-mission' : ''}${ended ? ' is-ended' : ''}`}>
        {session.config.fastMode && <FastModeElectric />}
        <textarea
          ref={ref}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => { if (suggestShared) setDismissedSharedDraft(text); }}
          onFocus={() => setDismissedSharedDraft(null)}
          aria-autocomplete={suggestShared ? 'list' : undefined}
          aria-controls={sharedActive ? sharedListId : undefined}
          aria-activedescendant={sharedActive ? `${sharedListId}-${sharedActiveIndex}` : undefined}
          placeholder={ended
            ? MISSION_ENDED_TEXT
            : armed
              ? 'Describe the mission… a Lead plans it and Builders implement it'
              : busy ? (caps.steer ? 'Steer the agent… (Enter sends now; send menu to queue)' : 'Queue a follow-up… (sent after this turn)')
              : missionRole === 'lead' ? 'Message the Lead…'
              : hasOngoingWork(session) ? ONGOING_PLACEHOLDER[uiMode] : IDLE_PLACEHOLDER[uiMode]}
          aria-label={ended ? MISSION_ENDED_TEXT : undefined}
          disabled={ended}
          rows={1}
          spellCheck
        />
        <div className="composer-actions">
          <button type="button" className="icon-btn composer-attach" title="Attach files" aria-label="Attach files" disabled={ended} onClick={() => fileInput.current?.click()}>
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
          <ComposerSendControls
            session={session}
            ended={ended}
            shellDraft={shellDraft}
            busy={busy}
            caps={caps}
            text={text}
            hasAttachments={images.length > 0 || files.length > 0}
            onSend={(mode) => void send(mode)}
          />
        </div>
      </div>
    </div>
  );
}
