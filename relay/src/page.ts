/** code.vocs.io page logic (docs/REMOTE-ACCESS.md): pairing, then a read-only view of the
 *  paired desktop's sessions, transcripts and approval prompts. DOM layer over RelayClient. */
import { RelayClient } from './web-client';
import type { TranscriptItem } from '../../src/shared/types';

const client = new RelayClient({ storage: localStorageApi() });
let sessions: Array<{ id: string; title: string; status: string }> = [];
let active: string | null = null;
let activeStatus = 'idle';
/** Desktop view-only policy (P4): read-only, so every write control is hidden. */
let viewOnly = false;

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
  el('new-session').addEventListener('click', () => void toggleNewSession(true));
  el('ns-cancel').addEventListener('click', () => void toggleNewSession(false));
  el('ns-create').addEventListener('click', () => void createSession());
  el('devices').addEventListener('click', () => void toggleDevices());
  el('devices-close').addEventListener('click', () => el('devices-panel').setAttribute('hidden', ''));
  el('send').addEventListener('click', () => void sendComposer());
  el('act-interrupt').addEventListener('click', () => void actOnActive('sessions:interrupt', null));
  el('act-stop').addEventListener('click', () => void actOnActive('sessions:stop', null));
  const composer = el('composer') as HTMLTextAreaElement;
  composer.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void sendComposer();
    }
  });
  if (client.restore()) void enter();
  else show('screen-pair');
}

async function sendComposer(): Promise<void> {
  const box = el('composer') as HTMLTextAreaElement;
  const text = box.value.trim();
  if (!text || !active || viewOnly) return;
  box.value = '';
  try {
    await client.invoke('sessions:send', { id: active, input: { text } });
  } catch (e) {
    setConnection(`send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function actOnActive(channel: string, request: unknown): Promise<void> {
  if (!active) return;
  try {
    await client.invoke(channel, request ? { id: active, ...request } : { id: active });
  } catch (e) {
    setConnection(`${channel} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toggleNewSession(open: boolean): Promise<void> {
  el('new-session-panel').toggleAttribute('hidden', !open);
  if (!open) return;
  // Folders from the host's settings; harnesses from live availability.
  try {
    const settings = (await client.invoke('settings:get', null)) as { folders?: string[]; recentProjects?: string[] };
    const folders = [...new Set([...(settings.folders ?? []), ...(settings.recentProjects ?? [])])];
    (el('known-folders') as HTMLDataListElement).innerHTML = folders.map((f) => `<option value="${esc(f)}"></option>`).join('');
    const availability = (await client.invoke('harness:availability', null)) as Record<string, { available: boolean }>;
    (el('ns-harness') as HTMLSelectElement).innerHTML = Object.entries(availability)
      .map(([id, a]) => `<option value="${esc(id)}">${esc(id)}${a.available ? '' : ' (not installed)'}</option>`)
      .join('');
  } catch (e) {
    (el('ns-error') as HTMLElement).textContent = e instanceof Error ? e.message : String(e);
  }
}

async function createSession(): Promise<void> {
  const folder = (el('ns-folder') as HTMLInputElement).value.trim();
  const harness = (el('ns-harness') as HTMLSelectElement).value;
  const title = (el('ns-title') as HTMLInputElement).value.trim() || undefined;
  const initialPrompt = (el('ns-prompt') as HTMLInputElement).value.trim() || undefined;
  if (!folder) {
    el('ns-error').textContent = 'A folder path on the host machine is required.';
    return;
  }
  try {
    const created = (await client.invoke('sessions:create', {
      config: { harness, projectRoot: folder, permissionMode: 'ask' },
      title,
      initialPrompt
    })) as { id: string };
    el('new-session-panel').setAttribute('hidden', '');
    await refreshSessions();
    await openSession(created.id);
  } catch (e) {
    el('ns-error').textContent = e instanceof Error ? e.message : String(e);
  }
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
  // The desktop's view-only policy hides write controls before the first render of a transcript.
  try {
    const settings = (await client.invoke('settings:get', null)) as { remote?: { viewOnly?: boolean } };
    applyPolicy(settings.remote?.viewOnly === true);
  } catch {
    // An older host has no remote policy; stay interactive, matching P3 behavior.
  }
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
  const meta = sessions.find((s) => s.id === id);
  activeStatus = meta?.status ?? 'idle';
  (el('active-title') as HTMLElement).textContent = meta ? `${meta.title} · ${activeStatus}` : '';
  syncControls();
  for (const row of Array.from(document.querySelectorAll('.session-row'))) row.classList.toggle('active', (row as HTMLElement).dataset.id === id);
}

function isRunning(status: string): boolean {
  return status === 'running' || status === 'starting' || status === 'awaiting';
}

/** Interrupt/stop show only when the active session is live — and never in view-only mode. */
function syncControls(): void {
  const running = !viewOnly && isRunning(activeStatus);
  (el('act-interrupt') as HTMLElement).hidden = !running;
  (el('act-stop') as HTMLElement).hidden = !running;
}

/** Apply the desktop's view-only policy: hide every control that would write. */
function applyPolicy(next: boolean): void {
  viewOnly = next;
  const badge = el('policy');
  badge.toggleAttribute('hidden', !viewOnly);
  badge.textContent = viewOnly ? 'view-only' : '';
  for (const id of ['composer', 'send', 'new-session']) (el(id) as HTMLButtonElement | HTMLTextAreaElement).toggleAttribute('disabled', viewOnly);
  syncControls();
  if (viewOnly) el('new-session-panel').setAttribute('hidden', '');
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
  if (viewOnly) return `<div class="msg approval"><b>Approval needed</b><small> — decide on the desktop (view-only)</small></div>`;
  return `<div class="msg approval"><b>Approval needed</b><div class="approval-actions" data-request="${esc(requestId)}"><button data-decision="allow">Allow</button><button data-decision="deny" class="danger">Deny</button></div></div>`;
}

/** Device management (P4): list the account's paired devices, revoke any of them. */
async function toggleDevices(): Promise<void> {
  const panel = el('devices-panel');
  const opening = panel.hasAttribute('hidden');
  panel.toggleAttribute('hidden', !opening);
  if (opening) await refreshDevices();
}

async function refreshDevices(): Promise<void> {
  const list = el('device-list');
  el('devices-error').textContent = '';
  list.innerHTML = '<p class="muted small">Loading…</p>';
  try {
    const devices = await client.listDevices();
    list.innerHTML = devices
      .map(
        (d) =>
          `<div class="device-row"><span>${esc(d.kind === 'host' ? 'Computer' : 'Browser')}: ${esc(d.name)}<br><small class="muted">${esc(d.platform)} · last seen ${esc(new Date(d.lastSeen).toLocaleString())}</small></span><button class="danger" data-revoke="${esc(d.deviceId)}">Revoke</button></div>`
      )
      .join('');
  } catch (e) {
    el('devices-error').textContent = e instanceof Error ? e.message : String(e);
  }
}

async function onPush(channel: string, payload: unknown): Promise<void> {
  if (channel === 'push:remotePolicy') {
    applyPolicy((payload as { viewOnly?: boolean } | null)?.viewOnly === true);
    return;
  }
  if (channel === 'push:sessionEvent' && payload) {
    const env = payload as { sessionId?: string; event?: { type?: string; status?: string } };
    if (active && env.sessionId === active) {
      if (env.event?.type === 'status' && env.event.status) {
        activeStatus = env.event.status;
        const meta = sessions.find((s) => s.id === active);
        (el('active-title') as HTMLElement).textContent = meta ? `${meta.title} · ${activeStatus}` : '';
        syncControls();
      }
      await openSession(active);
    }
    return;
  }
  if (channel === 'push:sessionsChanged') {
    sessions = (payload as typeof sessions) ?? sessions;
    renderSessionList();
    if (active) await openSession(active);
  }
}

function renderSessionList(): void {
  const list = el('session-list');
  list.innerHTML = sessions
    .map((s) => `<button class="session-row" data-id="${esc(s.id)}"><span>${esc(s.title)}</span><small>${esc(s.status)}</small></button>`)
    .join('');
  for (const row of Array.from(list.querySelectorAll('button'))) {
    row.addEventListener('click', () => void openSession((row as HTMLElement).dataset.id!));
  }
}

document.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const revoke = target.closest('button[data-revoke]') as HTMLElement | null;
  if (revoke?.dataset.revoke) {
    void client
      .revokeDevice(revoke.dataset.revoke)
      .then(() => refreshDevices())
      .catch((e) => {
        el('devices-error').textContent = e instanceof Error ? e.message : String(e);
      });
    return;
  }
  const btn = target.closest('button[data-decision]') as HTMLElement | null;
  const wrap = btn?.closest('.approval-actions') as HTMLElement | null;
  if (!btn || !wrap) return;
  const requestId = wrap.dataset.request;
  const decision = { optionId: btn.dataset.decision === 'allow' ? 'allow' : 'deny' };
  if (requestId) void client.invoke('approvals:respond', { sessionId: active, requestId, decision });
});

boot();