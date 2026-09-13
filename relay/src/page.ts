/** code.vocs.io page logic (docs/REMOTE-ACCESS.md): pairing, then a read-only view of the
 *  paired desktop's sessions, transcripts and approval prompts. DOM layer over RelayClient. */
import { RelayClient } from './web-client';
import type { TranscriptItem } from '../../src/shared/types';

const client = new RelayClient({ storage: localStorageApi() });
let sessions: Array<{ id: string; title: string; status: string }> = [];
let active: string | null = null;

function localStorageApi() {
  return {
    get: (k: string) => window.localStorage.getItem(k),
    set: (k: string, v: string) => window.localStorage.setItem(k, v),
    remove: (k: string) => window.localStorage.removeItem(k)
  };
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function show(id: string): void {
  for (const section of document.querySelectorAll('[data-screen]')) {
    (section as HTMLElement).hidden = (section as HTMLElement).id !== id;
  }
}

function setConnection(state: string): void {
  el('conn').textContent = state;
}

function boot(): void {
  el('pair-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const relay = (el('relay') as HTMLInputElement).value.trim();
    const code = (el('code') as HTMLInputElement).value.trim();
    const name = (el('device-name') as HTMLInputElement).value.trim() || 'Browser';
    void startPairing(relay, code, name);
  });
  el('logout').addEventListener('click', () => {
    client.logout();
    location.reload();
  });
  if (client.restore()) void enter();
  else show('screen-pair');
}

async function startPairing(relay: string, code: string, name: string): Promise<void> {
  show('screen-pairing');
  try {
    await client.pair({ relayBase: relay, code, deviceName: name });
    await enter();
  } catch (e) {
    el('pair-error').textContent = e instanceof Error ? e.message : String(e);
    show('screen-pair');
  }
}

async function enter(): Promise<void> {
  show('screen-app');
  try {
    await client.connect(() => {
      setConnection('reconnecting…');
      // A dropped socket retries until it succeeds; the page keeps its last transcript.
      const retry = setInterval(() => {
        if (!client.hasCredentials()) return;
        void client
          .connect()
          .then(() => {
            setConnection('connected');
            clearInterval(retry);
          })
          .catch(() => undefined);
      }, 3000);
    });
  } catch (e) {
    setConnection(`connection failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  setConnection('connected');
  client.onPush((channel, payload) => void onPush(channel, payload));
  await refreshSessions();
}

async function refreshSessions(): Promise<void> {
  try {
    sessions = (await client.invoke('sessions:list', null)) as typeof sessions;
    const list = el('session-list');
    list.innerHTML = sessions
      .map((s) => `<button class="session-row" data-id="${esc(s.id)}"><span>${esc(s.title)}</span><small>${esc(s.status)}</small></button>`)
      .join('');
    for (const row of Array.from(list.querySelectorAll('button'))) {
      row.addEventListener('click', () => void openSession((row as HTMLElement).dataset.id!));
    }
    const first = sessions[0]?.id;
    if (first) await openSession(first);
  } catch (e) {
    setConnection(`failed to list sessions: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openSession(id: string): Promise<void> {
  active = id;
  const items = (await client.invoke('sessions:transcript', { id })) as TranscriptItem[];
  renderTranscript(items);
  for (const row of Array.from(document.querySelectorAll('.session-row'))) row.classList.toggle('active', (row as HTMLElement).dataset.id === id);
}

function renderTranscript(items: TranscriptItem[]): void {
  const root = el('transcript');
  root.innerHTML = items
    .map((i) => {
      switch (i.kind) {
        case 'user':
          return `<div class="msg user">${esc(i.text)}</div>`;
        case 'assistant':
          return `<div class="msg assistant">${esc(i.text)}</div>`;
        case 'tool':
          return `<div class="msg tool"><b>${esc(i.name)}</b>${i.summary ? ` — ${esc(i.summary)}` : ''} <small>[${esc(i.status)}]</small></div>`;
        case 'approval':
          return renderApproval(i);
        case 'info':
          return `<div class="msg info">${esc(i.text)}</div>`;
        default:
          return '';
      }
    })
    .join('');
  root.scrollTop = root.scrollHeight;
}

function renderApproval(item: Extract<TranscriptItem, { kind: 'approval' }>): string {
  const requestId = item.request.id;
  if (item.decision) return `<div class="msg approval decided"><b>Approval</b> <small>decided: ${esc(item.decision.optionId)}</small></div>`;
  return `<div class="msg approval"><b>Approval needed</b><div class="approval-actions" data-request="${esc(requestId)}"><button data-decision="allow">Allow</button><button data-decision="deny" class="danger">Deny</button></div></div>`;
}

async function onPush(channel: string, payload: unknown): Promise<void> {
  if (channel === 'push:sessionEvent' && payload) {
    const env = payload as { sessionId?: string };
    if (active && env.sessionId === active) await openSession(active);
    return;
  }
  if (channel === 'push:sessionsChanged') await refreshSessions();
}

document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('button[data-decision]') as HTMLElement | null;
  const wrap = btn?.closest('.approval-actions') as HTMLElement | null;
  if (!btn || !wrap) return;
  const requestId = wrap.dataset.request;
  const decision = { optionId: btn.dataset.decision === 'allow' ? 'allow' : 'deny' };
  if (requestId) void client.invoke('approvals:respond', { sessionId: active, requestId, decision });
});

boot();