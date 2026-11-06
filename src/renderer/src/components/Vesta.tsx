/** Vesta: a floating assistant that drives the app through its capability allowlist.
 *  Portalled to the body and mounted outside the view switch, so it stays put wherever
 *  the user goes and wherever they drag it. Minimized, it lives in the title bar
 *  (VestaLauncher) instead of floating over the composer and the side panel. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentItem, AgentProposal } from '../../../shared/agent';
import { AGENT_NAME } from '../../../shared/agent';
import type { ImageAttachment } from '../../../shared/types';
import { invoke } from '../api';
import { useStore, toastError } from '../store';
import { fileToAttachment } from './Composer';
import { askConfirm, Button, Icon, Spinner } from './ui';

const PANEL_W = 360;
/** Tallest the expanded panel grows before the transcript starts scrolling. */
const PANEL_H = 460;
/** The panel hangs from a point this far below `y` (the height the minimized avatar used to have). */
const AVATAR = 52;
/** Gap kept between the panel and the window edge. */
const MARGIN = 8;
/** Where a panel that has never been moved parks: bottom-right, clear of the composer. */
const PARK_MARGIN = 24;
/** Pointer travel below this counts as a click, not a drag. */
const DRAG_SLOP = 4;

/** `y` is the top of the avatar square. The panel hangs from the avatar's bottom edge and grows
 *  upward, so how far up the avatar may travel depends on how tall the panel currently is. */
interface Point {
  x: number;
  y: number;
}

function clamp(p: Point, w: number, h: number): Point {
  const minY = MARGIN + Math.max(0, h - AVATAR);
  const maxY = Math.max(minY, window.innerHeight - AVATAR - MARGIN);
  const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
  return {
    x: Math.round(Math.min(Math.max(MARGIN, p.x), maxX)),
    y: Math.round(Math.min(Math.max(minY, p.y), maxY))
  };
}

export function Vesta() {
  const settings = useStore((s) => s.settings);
  const agent = useStore((s) => s.agent);
  const activeId = useStore((s) => s.activeId);
  const view = useStore((s) => s.view);
  const prefill = useStore((s) => s.agentPrefill);
  const stored = settings?.agent;

  // Collapsed lives in settings so other parts of the UI can open Vesta (see store.openVesta).
  const collapsed = stored?.collapsed !== false;
  const [pos, setPos] = useState<Point | null>(null);
  const [text, setText] = useState('');
  /** Images pasted into the composer, waiting for the next send. */
  const [images, setImages] = useState<ImageAttachment[]>([]);
  /** Measured height of the rendered panel, so growth can be anchored at the bottom edge. */
  const [panelH, setPanelH] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const width = collapsed ? AVATAR : PANEL_W;
  const height = collapsed ? AVATAR : panelH;

  // First paint: use the stored corner, else park it bottom-right out of the composer's way.
  useLayoutEffect(() => {
    if (pos) return;
    const x = typeof stored?.x === 'number' ? stored.x : window.innerWidth - PANEL_W - PARK_MARGIN;
    const y = typeof stored?.y === 'number' ? stored.y : window.innerHeight - AVATAR - PARK_MARGIN;
    // An expanded panel is given its tallest shape up front, so a stored position cannot leave
    // the header above the top of the window.
    setPos(clamp({ x, y }, width, collapsed ? AVATAR : PANEL_H));
  }, [pos, stored?.x, stored?.y, width, collapsed]);

  // Expanding after the avatar was dragged near the top pulls the panel down just enough to fit.
  const wasCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    if (wasCollapsed.current === collapsed) return;
    wasCollapsed.current = collapsed;
    if (collapsed) return;
    setPos((p) => (p ? clamp(p, PANEL_W, panelH || PANEL_H) : p));
  }, [collapsed, panelH]);

  // Track the rendered height so a drag cannot push the panel's header off the top of the window.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setPanelH(el.getBoundingClientRect().height || el.offsetHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [collapsed]);

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p, width, height) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width, height]);

  useEffect(() => {
    if (!collapsed) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [agent.items, collapsed]);

  useEffect(() => {
    if (!prefill || collapsed) return;
    setText(prefill.text);
    inputRef.current?.focus();
  }, [prefill, collapsed]);

  const persist = useCallback((patch: { x?: number; y?: number; collapsed?: boolean }) => {
    void invoke('settings:update', { agent: { ...(useStore.getState().settings?.agent ?? {}), ...patch } }).catch(() => undefined);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!pos) return;
    if ((e.target as HTMLElement).closest('button, textarea, input, a')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Offsets are kept from the anchor (the avatar's bottom edge) so grabbing the header of an
    // expanded panel does not make it jump by its own height.
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - (pos.y + AVATAR), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const next = { x: e.clientX - d.dx, y: e.clientY - d.dy - AVATAR };
    if (Math.abs(next.x - (pos?.x ?? 0)) > DRAG_SLOP || Math.abs(next.y - (pos?.y ?? 0)) > DRAG_SLOP) d.moved = true;
    setPos(clamp(next, width, height));
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved && pos) persist({ x: Math.round(pos.x), y: Math.round(pos.y) });
  };

  const toggle = () => persist({ collapsed: !collapsed });

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const pasted = await Promise.all(files.map(fileToAttachment));
    setImages((prev) => [...prev, ...pasted]);
    inputRef.current?.focus();
  };

  const send = () => {
    const message = text.trim();
    if (agent.busy || (!message && !images.length)) return;
    const outgoing = images;
    setText('');
    setImages([]);
    void invoke('agent:send', { text: message, context: { sessionId: activeId ?? undefined, view }, images: outgoing.length ? outgoing : undefined }).catch(toastError);
  };

  if (!settings || settings.agent?.enabled === false || !pos) return null;

  // Anchored by the bottom edge: the panel's foot stays put and the transcript grows upward,
  // which also means "drag it to the bottom" really does reach the bottom of the window.
  const anchorBottom = pos.y + AVATAR;
  const bottom = Math.max(MARGIN, window.innerHeight - anchorBottom);
  const maxHeight = Math.max(160, Math.min(PANEL_H, anchorBottom - MARGIN, window.innerHeight - 2 * MARGIN));
  const style: React.CSSProperties = { left: pos.x, bottom, width: PANEL_W, maxHeight };

  // Minimized, Vesta is the title bar's launcher (VestaLauncher); nothing floats over the workspace.
  if (collapsed) return null;

  return createPortal(
    <div ref={boxRef} className="vesta vesta-panel" style={style} role="dialog" aria-label={AGENT_NAME}>
      <div className="vesta-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <Icon name="sparkles" size={15} />
        <strong>{AGENT_NAME}</strong>
        {agent.model && <span className="vesta-model" title="Model answering — set it under Settings → General">{agent.model}</span>}
        <span className="spacer" />
        <button className="icon-btn" title="Clear the conversation" aria-label="Clear the conversation" onClick={() => void invoke('agent:reset', undefined).catch(toastError)}>
          <Icon name="trash" size={13} />
        </button>
        <button className="icon-btn" title="Minimize to the title bar" aria-label="Minimize" onClick={toggle}>
          <Icon name="minus" size={13} />
        </button>
      </div>

      <div className="vesta-list" ref={listRef}>
        {agent.unavailable ? (
          <div className="vesta-empty">
            <Icon name="alert" size={15} />
            <span>{agent.unavailable}</span>
          </div>
        ) : agent.items.length === 0 ? (
          <div className="vesta-empty">
            <span>
              I can set up MCP servers, start sessions and tidy branches — and I can look at an image you paste in. Try{' '}
              <em>“set up the https://mcp.example.com/mcp server”</em> or <em>“which branches here are older than a day?”</em>
            </span>
          </div>
        ) : (
          agent.items.map((item) => <VestaRow key={item.id} item={item} />)
        )}
      </div>

      <div className="vesta-compose">
        {images.length > 0 && (
          <div className="vesta-attachments">
            {images.map((im, i) => (
              <div key={i} className="attachment">
                <img src={`data:${im.mimeType};base64,${im.data}`} alt={im.name ?? 'Pasted image'} />
                <button type="button" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove image">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="vesta-compose-row">
          <textarea
            ref={inputRef}
            value={text}
            rows={2}
            placeholder={`Ask ${AGENT_NAME}…`}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {agent.busy ? (
            <button className="icon-btn danger" title="Stop" aria-label="Stop" onClick={() => void invoke('agent:cancel', undefined).catch(toastError)}>
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button className="icon-btn" title="Send" aria-label="Send" disabled={!text.trim() && !images.length} onClick={send}>
              <Icon name="send" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Vesta's place in the title bar: opens the panel, closes it again, and shows when Vesta is working. */
export function VestaLauncher() {
  const enabled = useStore((s) => !!s.settings?.onboardingDone && s.settings.agent?.enabled !== false);
  const collapsed = useStore((s) => s.settings?.agent?.collapsed !== false);
  const busy = useStore((s) => s.agent.busy);
  if (!enabled) return null;
  const toggle = () => {
    const current = useStore.getState().settings?.agent ?? {};
    void invoke('settings:update', { agent: { ...current, collapsed: !collapsed } }).catch(toastError);
  };
  return (
    <button
      type="button"
      className={`titlebar-vesta ${collapsed ? '' : 'open'} ${busy ? 'busy' : ''}`}
      aria-label={collapsed ? `Open ${AGENT_NAME}` : `Minimize ${AGENT_NAME}`}
      aria-pressed={!collapsed}
      title={`${AGENT_NAME} — the in-app assistant`}
      onClick={toggle}
    >
      {busy ? <Spinner size={12} /> : <Icon name="sparkles" size={14} />}
      <span>{AGENT_NAME}</span>
    </button>
  );
}

function VestaRow({ item }: { item: AgentItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="vesta-msg vesta-user">
          {!!item.images?.length && (
            <div className="vesta-msg-images">
              {item.images.map((im, i) => (
                <img key={i} src={`data:${im.mimeType};base64,${im.data}`} alt={im.name ?? 'Pasted image'} />
              ))}
            </div>
          )}
          {item.text}
        </div>
      );
    case 'assistant':
      return <div className="vesta-msg vesta-assistant">{item.text}</div>;
    case 'error':
      return (
        <div className="vesta-msg vesta-err">
          <Icon name="alert" size={12} /> {item.text}
        </div>
      );
    case 'tool':
      return (
        <div className={`vesta-tool ${item.ok ? '' : 'failed'}`} title={item.detail}>
          <Icon name={item.ok ? 'check' : 'alert'} size={11} /> <span>{item.summary}</span>
        </div>
      );
    case 'proposal':
      return <ProposalCard proposal={item.proposal} />;
  }
}

function ProposalCard({ proposal }: { proposal: AgentProposal }) {
  const pending = proposal.status === 'pending';
  const danger = proposal.tier === 'destructive';
  const decide = async (approve: boolean) => {
    if (approve && danger) {
      const ok = await askConfirm({
        title: proposal.actions.length === 1 ? proposal.actions[0].summary : `Apply ${proposal.actions.length} destructive changes?`,
        body: (
          <ul className="vesta-confirm-list">
            {proposal.actions.map((a, i) => (
              <li key={i}>{a.summary}</li>
            ))}
          </ul>
        ),
        confirmLabel: 'Apply',
        danger: true
      });
      if (!ok) return;
    }
    await invoke('agent:resolve', { proposalId: proposal.id, approve }).catch(toastError);
  };
  return (
    <div className={`vesta-proposal ${danger ? 'danger' : ''} ${proposal.status}`}>
      <div className="vesta-proposal-head">
        <Icon name={danger ? 'alert' : 'bolt'} size={12} />
        <span>{proposal.title}</span>
      </div>
      <ul>
        {proposal.actions.map((a, i) => (
          <li key={i}>
            <span>{a.summary}</span>
            {proposal.results?.[i] && <em className={proposal.results[i] === 'Done' ? 'ok' : 'bad'}>{proposal.results[i]}</em>}
          </li>
        ))}
      </ul>
      {pending ? (
        <div className="vesta-proposal-actions">
          <Button size="sm" variant={danger ? 'danger' : 'primary'} onClick={() => void decide(true)}>
            {proposal.actions.length === 1 ? 'Apply' : `Apply all ${proposal.actions.length}`}
          </Button>
          <Button size="sm" onClick={() => void decide(false)}>
            Decline
          </Button>
        </div>
      ) : (
        <div className="vesta-proposal-status">{proposal.status}</div>
      )}
    </div>
  );
}
