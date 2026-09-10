/** Prompt input: slash commands, @file mentions, and steer-vs-queue while a turn is running. */
import React, { useEffect, useRef, useState } from 'react';
import type { EffortLevel, ImageAttachment, PermissionMode, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID, SLASH_COMMANDS } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { fmtCost, fmtTokens } from '../format';
import { useStore } from '../store';
import { Button, Icon, Kbd } from './ui';

/** Stable fallback so the zustand selector never returns a fresh array (React #185 infinite loop). */
const EMPTY_MODELS: never[] = [];

export function Composer({ session }: { session: SessionMeta }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number; results: string[]; index: number } | null>(null);
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useStore((s) => s.toast);
  const composerInsert = useStore((s) => s.composerInsert);
  const clearComposerInsert = useStore((s) => s.clearComposerInsert);
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  const harness = HARNESS_BY_ID[session.config.harness];
  const caps = harness.capabilities;
  const models = useStore((s) => s.models[session.id] ?? EMPTY_MODELS);
  const currentModel = session.activeModel ?? session.config.model;
  const currentInfo = models.find((m) => currentModel && m.id === currentModel.model && m.provider === currentModel.provider);

  // Only warn when the catalog is explicit. An unknown capability (undefined) is not a claim.
  const visionWarning =
    currentModel && currentInfo?.supportsImages === false
      ? {
          model: currentInfo.displayName,
          detail: caps.dropsUnsupportedImages
            ? `${harness.name} strips the attachment before it reaches the model, so an override here alone will not help — its own model catalog has to list image input too.`
            : 'The provider may reject the request or silently ignore the image.'
        }
      : null;

  const markVisionCapable = async () => {
    if (!currentModel) return;
    try {
      await invoke('models:setOverride', { provider: currentModel.provider, model: currentModel.model, supportsImages: true });
      toast(`${currentInfo?.displayName ?? currentModel.model} is now treated as vision-capable. Undo it under Settings → Providers.`, 'success');
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

  useEffect(() => {
    ref.current?.focus();
  }, [session.id]);

  // Text handed over from elsewhere (the terminal's "send to agent") lands below the current draft.
  useEffect(() => {
    if (!composerInsert) return;
    const insert = composerInsert.text;
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${insert}` : insert));
    clearComposerInsert();
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [composerInsert, clearComposerInsert]);

  useEffect(() => {
    if (!mention) return;
    // Debounced so typing does not fire an uncancellable full-tree walk per keystroke; results are
    // cleared while a search is in flight instead of seeding the popover with the previous query's.
    setMention((m) => (m ? { ...m, results: [], index: 0 } : m));
    const query = mention.query;
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke('fs:search', { sessionId: session.id, query, limit: 12 })
        .then((results) => {
          if (!cancelled) setMention((m) => (m && m.query === query ? { ...m, results, index: 0 } : m));
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention?.query, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const slashMatches = slash ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slash.query.toLowerCase())) : [];

  const send = async (mode: 'now' | 'steer' | 'queue' = 'now') => {
    const t = text.trim();
    if (!t && !images.length) return;
    if (t.startsWith('/') && (await runSlash(t))) {
      setText('');
      return;
    }
    setHistory((h) => [t, ...h.filter((x) => x !== t)].slice(0, 50));
    setHistIdx(-1);
    setText('');
    setImages([]);
    try {
      await invoke('sessions:send', { id: session.id, input: { text: t, images: images.length ? images : undefined, mode: busy ? mode : 'now' } });
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
      setText(t);
    }
  };

  const runSlash = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const store = useStore.getState();
    switch (cmd) {
      case 'help':
        toast(`Commands: ${SLASH_COMMANDS.map((c) => '/' + c.name).join(' ')} · Enter send · Shift+Enter newline · Esc stop · Ctrl+K palette`, 'info');
        return true;
      case 'model': {
        if (!arg) {
          toast('Usage: /model provider/model', 'error');
          return true;
        }
        const [provider, ...m] = arg.includes('/') ? arg.split('/') : [session.activeModel?.provider ?? 'anthropic', arg];
        await invoke('sessions:setModel', { id: session.id, model: { provider, model: m.join('/') } }).catch((e) => toast(String(e.message ?? e), 'error'));
        return true;
      }
      case 'mode':
        if (!caps.permissionModes.includes(arg as PermissionMode)) {
          toast(`Modes: ${caps.permissionModes.join(', ')}`, 'error');
          return true;
        }
        await invoke('sessions:setPermissionMode', { id: session.id, mode: arg as PermissionMode });
        return true;
      case 'effort':
        await invoke('sessions:setEffort', { id: session.id, effort: arg as EffortLevel }).catch((e) => toast(String(e.message ?? e), 'error'));
        return true;
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
      case 'cost':
        toast(`${fmtCost(session.usage.costUsd)} · ${fmtTokens(session.usage.inputTokens)} in / ${fmtTokens(session.usage.outputTokens)} out · ${session.usage.turns} turns`, 'info');
        store.setPanelTab('usage');
        return true;
      case 'compact': {
        const r = await invoke('sessions:compact', { id: session.id });
        toast(r.ok ? 'Compaction requested' : r.detail ?? 'Not supported', r.ok ? 'success' : 'error');
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
        if (arg === 'editor') await invoke('app:openInEditor', { path: session.cwd }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error'));
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
        const pr = await invoke('git:pr', { sessionId: session.id, base: arg }).catch((e): { ok: boolean; url?: string; output?: string } => ({ ok: false, output: String((e as Error).message ?? e) }));
        toast(pr.url ? `PR opened: ${pr.url}` : pr.output ?? 'Failed', pr.ok ? 'success' : 'error');
        return true;
      }
      case 'merge': {
        const merged = await invoke('git:merge', { sessionId: session.id, base: arg || undefined }).catch((e): { ok: boolean; url?: string; output?: string } => ({ ok: false, output: String((e as Error).message ?? e) }));
        toast(merged.url ? `Merged: ${merged.url}` : merged.output ?? 'Failed', merged.ok ? 'success' : 'error');
        return true;
      }
      case 'stop':
        await invoke('sessions:interrupt', { id: session.id });
        return true;
      default:
        return false; // let the harness handle unknown slash commands (e.g. Claude Code's own)
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        setText('/' + slashMatches[slash.index].name + ' ');
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
    const sl = v.match(/^\/(\w*)$/);
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

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const imgs = await Promise.all(files.map(fileToAttachment));
    setImages((prev) => [...prev, ...imgs]);
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const imgs = await Promise.all([...list].filter((f) => f.type.startsWith('image/')).map(fileToAttachment));
    setImages((prev) => [...prev, ...imgs]);
  };

  return (
    <div className="composer">
      {mention && mention.results.length > 0 && (
        <div className="popover">
          {mention.results.map((r, i) => (
            <button key={r} type="button" className={`popover-item mono ${i === mention.index ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); pickMention(r); }}>
              <Icon name="file" size={12} /> {r}
            </button>
          ))}
        </div>
      )}
      {slash && slashMatches.length > 0 && (
        <div className="popover">
          {slashMatches.map((c, i) => (
            <button key={c.name} type="button" className={`popover-item ${i === slash.index ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); setText('/' + c.name + ' '); setSlash(null); ref.current?.focus(); }}>
              <span className="mono">/{c.name}</span> <span className="muted">{c.args}</span> <span className="spacer" /> <span className="muted small">{c.description}</span>
            </button>
          ))}
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
      <div className="composer-box">
        <textarea
          ref={ref}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={busy ? (caps.steer ? 'Steer the agent… (Enter sends now, queue button waits for the turn)' : 'Queue a follow-up… (sent after this turn)') : 'Message the agent… (/ commands, @ files, paste images)'}
          rows={1}
          spellCheck
        />
        <div className="composer-actions">
          <label className="icon-btn" title="Attach image">
            <Icon name="image" size={16} />
            <input type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          </label>
          {busy ? (
            <>
              {caps.queue && (
                <Button size="sm" variant="ghost" onClick={() => void send('queue')} title="Send after the current turn">
                  Queue
                </Button>
              )}
              <Button size="sm" variant="primary" icon={caps.steer ? 'arrowUp' : 'clock'} onClick={() => void send(caps.steer ? 'steer' : 'queue')} title={caps.steer ? 'Steer now' : 'Queue'}>
                {caps.steer ? 'Steer' : 'Queue'}
              </Button>
              <Button size="sm" variant="danger" icon="stop" onClick={() => void invoke('sessions:interrupt', { id: session.id })} title="Interrupt (Esc)" />
            </>
          ) : (
            <Button size="sm" variant="primary" icon="send" onClick={() => void send()} disabled={!text.trim() && !images.length}>
              Send
            </Button>
          )}
        </div>
      </div>
      <div className="composer-hint muted small">
        <Kbd>Enter</Kbd> send · <Kbd>Shift+Enter</Kbd> newline · <Kbd>Esc</Kbd> stop · <Kbd>@</Kbd> files · <Kbd>/</Kbd> commands
        {(session.queued ?? 0) > 0 && <span className="queued-hint"> · {session.queued} queued</span>}
      </div>
    </div>
  );
}

async function fileToAttachment(f: File): Promise<ImageAttachment> {
  const buf = await f.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mimeType: f.type || 'image/png', data: btoa(binary), name: f.name };
}
