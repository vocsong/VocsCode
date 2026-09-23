/** code.vocs.io page logic (docs/REMOTE-ACCESS.md): pairing, then a read-only view of the
 *  paired desktop's sessions, transcripts and approval prompts. DOM layer over RelayClient. */
import { RelayClient, relayBaseFor } from './web-client';
import { PAIRING_CODE_PATTERN } from '../../src/shared/pairing';
import type { TranscriptItem } from '../../src/shared/types';

const client = new RelayClient({ storage: localStorageApi() });
let sessions: Array<{ id: string; title: string; status: string }> = [];
let active: string | null = null;
let activeStatus = 'idle';
/** Desktop view-only policy (P4): read-only, so every write control is hidden. */
let viewOnly = false;
/** 'live' = driving the desktop; 'mirror' = reading the encrypted snapshots it left behind. */
let mode: 'live' | 'mirror' = 'live';
let reconnectTimer: ReturnType<typeof setInterval> | null = null;
let connecting = false;

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
  const params = new URLSearchParams(window.location.search);
  if (params.has('code')) {
    const codes = params.getAll('code');
    const code = codes[0]?.trim().toUpperCase() ?? '';
    if (codes.length === 1 && PAIRING_CODE_PATTERN.test(code)) {
      (el('code') as HTMLInputElement).value = code;
    } else {
      el('pair-error').textContent = 'Invalid code in pairing link. Enter the code shown on the desktop.';
    }
    // A pairing code is short-lived but should not linger in the address bar or browser history.
    params.delete('code');
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
  }
  el('pair-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = (el('code') as HTMLInputElement).value.trim();
    const name = (el('device-name') as HTMLInputElement).value.trim() || 'Browser';
    void startPairing(code, name);
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
  void loadAccount();
}

/** The login gate is on the landing origin. A local/ungated preview has no /v1/me, so keep
 *  account sign-out hidden there; unpairing this browser remains a separate device action. */
async function loadAccount(): Promise<void> {
  try {
    const res = await fetch('/v1/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { login?: unknown };
    if (typeof body.login !== 'string' || !body.login) return;
    for (const form of document.querySelectorAll<HTMLFormElement>('.account-signout')) {
      const label = form.querySelector('.account-name');
      if (label) label.textContent = `@${body.login}`;
      form.hidden = false;
    }
  } catch {
    // Pre-gate deployments do not have /v1/me. Never expose an account control without it.
  }
}

async function sendComposer(): Promise<void> {
  const box = el('composer') as HTMLTextAreaElement;
  const text = box.value.trim();
  if (!text || !active || viewOnly || mode === 'mirror') return;
  box.value = '';
  try {
    await client.invoke('sessions:send', { id: active, input: { text } });
  } catch (e) {
    setConnection(`send failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function actOnActive(channel: string, request: unknown): Promise<void> {
  if (!active || mode === 'mirror') return;
  try {
    await client.invoke(channel, request ? { id: active, ...request } : { id: active });
  } catch (e) {
    setConnection(`${channel} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toggleNewSession(open: boolean): Promise<void> {
  if (open && mode === 'mirror') return;
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
  if (mode === 'mirror') return;
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

async function startPairing(code: string, name: string): Promise<void> {
  show('screen-pairing');
  try {
    await client.pair({ relayBase: relayBaseFor(window.location.origin, relayOverride()), code, deviceName: name });
    await enter();
  } catch (e) {
    el('pair-error').textContent = e instanceof Error ? e.message : String(e);
    show('screen-pair');
  }
}

/** The web app is served by the relay that routes it, so the base is this page's own origin;
 *  `?relay=` is the development escape hatch for pointing one build at another deployment. */
function relayOverride(): string | null {
  return new URLSearchParams(window.location.search).get('relay');
}

async function enter(): Promise<void> {
  show('screen-app');
  client.onPush((channel, payload) => void onPush(channel, payload));
  await connectLoop();
}

/** Connects to the desktop; on failure shows the offline mirror and keeps retrying. */
async function connectLoop(): Promise<void> {
  if (connecting || !client.hasCredentials()) return;
  connecting = true;
  try {
    await client.connect(() => {
      setConnection('reconnecting…');
      scheduleReconnect();
    });
  } catch {
    connecting = false;
    await showMirror();
    scheduleReconnect();
    return;
  }
  connecting = false;
  mode = 'live';
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  setConnection('connected');
  await loadPolicy();
  await refreshSessions();
}

function scheduleReconnect(): void {
  if (reconnectTimer || !client.hasCredentials()) return;
  reconnectTimer = setInterval(() => void connectLoop(), 3000);
}

/** The desktop's view-only policy hides write controls before the first render of a transcript. */
async function loadPolicy(): Promise<void> {
  try {
    const settings = (await client.invoke('settings:get', null)) as { remote?: { viewOnly?: boolean } };
    applyPolicy(settings.remote?.viewOnly === true);
  } catch {
    // An older host has no remote policy; stay interactive, matching P3 behavior.
  }
}

/** Renders the sealed snapshots the desktop uploaded, entirely offline. */
async function showMirror(): Promise<void> {
  if (!client.hasMirror()) {
    setConnection('desktop offline');
    return;
  }
  try {
    const index = await client.mirrorIndex();
    if (!index) {
      setConnection('desktop offline — no mirror uploaded yet');
      return;
    }
    mode = 'mirror';
    sessions = index.sessions.map((s) => ({ id: s.id, title: s.title, status: s.status }));
    renderSessionList();
    setConnection(`offline — mirrored from ${index.hostName}`);
    updateWriteControls();
    const first = sessions[0]?.id;
    if (first) await openSession(first);
  } catch (e) {
    setConnection(`desktop offline — ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function refreshSessions(): Promise<void> {
  mode = 'live';
  try {
    sessions = (await client.invoke('sessions:list', null)) as typeof sessions;
    renderSessionList();
    updateWriteControls();
    const first = sessions[0]?.id;
    if (first) await openSession(first);
  } catch {
    // The desktop answered on connect but is gone now; fall back to what it mirrored.
    await showMirror();
  }
}

async function openSession(id: string): Promise<void> {
  active = id;
  const meta = sessions.find((s) => s.id === id);
  if (mode === 'mirror') {
    const snapshot = await client.mirrorSession(id);
    if (!snapshot || active !== id) return;
    renderTranscript(snapshot.items);
    activeStatus = snapshot.status;
    (el('active-title') as HTMLElement).textContent = `${snapshot.title} · ${snapshot.status}${snapshot.truncated ? ' · earlier history trimmed' : ''}`;
  } else {
    const items = (await client.invoke('sessions:transcript', { id })) as TranscriptItem[];
    if (active !== id) return;
    renderTranscript(items);
    activeStatus = meta?.status ?? 'idle';
    (el('active-title') as HTMLElement).textContent = meta ? `${meta.title} · ${activeStatus}` : '';
  }
  syncControls();
  for (const row of Array.from(document.querySelectorAll('.session-row'))) row.classList.toggle('active', (row as HTMLElement).dataset.id === id);
}

function isRunning(status: string): boolean {
  return status === 'running' || status === 'starting' || status === 'awaiting';
}

/** Interrupt/stop show only while driving a live session — never in view-only or mirror mode. */
function syncControls(): void {
  const running = mode === 'live' && !viewOnly && isRunning(activeStatus);
  (el('act-interrupt') as HTMLElement).hidden = !running;
  (el('act-stop') as HTMLElement).hidden = !running;
}

/** Apply the desktop's view-only policy; the mirror is read-only regardless of what it said. */
function applyPolicy(next: boolean): void {
  viewOnly = next;
  updateWriteControls();
}

function updateWriteControls(): void {
  const readOnly = viewOnly || mode === 'mirror';
  const badge = el('policy');
  badge.toggleAttribute('hidden', !readOnly);
  badge.textContent = mode === 'mirror' ? 'mirrored' : readOnly ? 'view-only' : '';
  for (const id of ['composer', 'send', 'new-session']) (el(id) as HTMLButtonElement | HTMLTextAreaElement).toggleAttribute('disabled', readOnly);
  syncControls();
  if (readOnly) el('new-session-panel').setAttribute('hidden', '');
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
  if (viewOnly || mode === 'mirror') return `<div class="msg approval"><b>Approval needed</b><small> — decide on the desktop${mode === 'mirror' ? ' (mirrored history)' : ' (view-only)'}</small></div>`;
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
  // A mirror is a snapshot: live events from a reconnecting socket do not apply to it.
  if (mode === 'mirror') return;
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