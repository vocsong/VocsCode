/** code.vocs.io page logic (docs/REMOTE-ACCESS.md): pairing, then the paired computers' sessions,
 *  transcripts and approval prompts. DOM layer over RelayClient. A browser can pair with several
 *  computers; the switcher in the top bar picks the one to drive and shows which are online. */
import { PairingRevokedError, RelayClient, relayBaseFor, type PairingVault, type VaultState } from './web-client';
import { CONNECT_HASH_PATTERN, connectCheckCode, PAIRING_CODE_PATTERN } from '../../src/shared/pairing';
import type { TerminalInfo } from '../../src/shared/terminal';
import type { RemoteDeviceInfo, TranscriptItem } from '../../src/shared/types';

/** Pairings (with their non-extractable keys) live in IndexedDB: structured clone keeps a
 *  CryptoKey usable without ever making it readable, which localStorage cannot. */
function indexedDbVault(): PairingVault {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable'));
        return;
      }
      const request = indexedDB.open('vocs-code-remote', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vault');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('vault', mode);
      const request = work(tx.objectStore('vault'));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('IndexedDB transaction failed'));
      };
    });
  };
  return {
    load: async () => ((await run('readonly', (store) => store.get('state'))) as VaultState | undefined) ?? null,
    save: async (state) => {
      await run('readwrite', (store) => store.put(state, 'state'));
    },
    clear: async () => {
      await run('readwrite', (store) => store.delete('state'));
    }
  };
}

function localStorageApi() {
  return {
    get: (k: string) => window.localStorage.getItem(k),
    set: (k: string, v: string) => window.localStorage.setItem(k, v),
    remove: (k: string) => window.localStorage.removeItem(k)
  };
}

const client = new RelayClient({ vault: indexedDbVault(), legacy: localStorageApi() });
let sessions: Array<{ id: string; title: string; status: string }> = [];
let active: string | null = null;
let activeStatus = 'idle';
/** Desktop view-only policy (P4): read-only, so every write control is hidden. */
let viewOnly = false;
/** 'live' = driving the desktop; 'mirror' = reading the encrypted snapshots it left behind. */
let mode: 'live' | 'mirror' = 'live';
let reconnectTimer: ReturnType<typeof setInterval> | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let connecting = false;
/** Which paired computers have a relay connection right now (from the device list). */
let online = new Map<string, boolean>();
/** Signed in with GitHub on the landing (its login gate): the account's computers can be listed,
 *  added and paired without a code. Settled once, at boot. */
let accountReady: Promise<boolean> = Promise.resolve(false);

/** The transcript window: newest items first, older pages on request (docs §8.5). */
const PAGE = 150;
let windowStart = 0;
let windowItems: TranscriptItem[] = [];
/** Streaming turns push many events: coalesce them into at most one refresh in flight. */
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
/** The read-only terminal view (P3.5): polled while open, one request in flight at a time. */
let terminalOpen = false;
let terminalTimer: ReturnType<typeof setInterval> | null = null;
let terminalBusy = false;

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

function notice(text: string): void {
  const box = el('notice');
  box.textContent = text;
  box.hidden = !text;
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  // Connect with GitHub: the desktop that opened this page is known only by this hash.
  let connectHash: string | null = null;
  if (params.has('connect')) {
    const hashes = params.getAll('connect');
    if (hashes.length === 1 && CONNECT_HASH_PATTERN.test(hashes[0] ?? '')) connectHash = hashes[0]!;
    params.delete('connect');
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
  }
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
  el('pair-cancel').addEventListener('click', () => {
    if (client.hasCredentials()) show('screen-app');
  });
  el('add-host').addEventListener('click', () => openPairScreen());
  el('host-select').addEventListener('change', (ev) => void switchHost((ev.target as HTMLSelectElement).value));
  el('logout').addEventListener('click', () => void unpairActive());
  el('new-session').addEventListener('click', () => void toggleNewSession(true));
  el('ns-cancel').addEventListener('click', () => void toggleNewSession(false));
  el('ns-create').addEventListener('click', () => void createSession());
  el('devices').addEventListener('click', () => void toggleDevices());
  el('devices-close').addEventListener('click', () => el('devices-panel').setAttribute('hidden', ''));
  el('load-earlier').addEventListener('click', () => void loadEarlier());
  el('send').addEventListener('click', () => void sendComposer());
  el('act-interrupt').addEventListener('click', () => void actOnActive('sessions:interrupt', null));
  el('act-stop').addEventListener('click', () => void actOnActive('sessions:stop', null));
  el('act-terminal').addEventListener('click', () => void toggleTerminal());
  el('terminal-select').addEventListener('change', () => void pollTerminal());
  const composer = el('composer') as HTMLTextAreaElement;
  composer.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void sendComposer();
    }
  });
  el('connect-cancel').addEventListener('click', () => (client.hasCredentials() ? void enter() : openPairScreen()));
  client.onPush((channel, payload) => void onPush(channel, payload));
  client.onPairingsChanged(() => renderHosts());
  accountReady = loadAccount();
  let restored = false;
  try {
    restored = await client.restore();
  } catch {
    // Without IndexedDB the page cannot keep a key it cannot read out. Refuse rather than fall
    // back to storing exportable keys.
    el('pair-error').textContent = 'This browser cannot store pairing keys securely (IndexedDB is unavailable, for example in some private windows). Use a regular window to pair.';
    (el('pair-form').querySelector('button[type="submit"]') as HTMLButtonElement).disabled = true;
    show('screen-pair');
    return;
  }
  if (connectHash) {
    if (await accountReady) {
      openConnectScreen(connectHash);
      return;
    }
    el('pair-error').textContent = 'This page was opened to add a computer, but signing in is not available here. Use a pairing code instead.';
  }
  if (restored) void enter();
  else openPairScreen();
}

/** Connect with GitHub, in the browser the desktop opened: add that computer to the account,
 *  then pair this browser with it. The desktop still asks for Allow before this browser gets in. */
function openConnectScreen(connectHash: string): void {
  el('connect-code').textContent = connectCheckCode(connectHash);
  el('connect-status').textContent = '';
  el('connect-error').textContent = '';
  const add = el('connect-add') as HTMLButtonElement;
  add.disabled = false;
  add.onclick = () => void addThisComputer(connectHash);
  show('screen-connect');
}

async function addThisComputer(connectHash: string): Promise<void> {
  const add = el('connect-add') as HTMLButtonElement;
  const status = el('connect-status');
  add.disabled = true;
  el('connect-error').textContent = '';
  const base = relayBaseFor(window.location.origin, relayOverride());
  try {
    status.textContent = 'Adding the computer…';
    await client.addComputer(base, connectHash);
    status.textContent = 'Waiting for the computer to finish connecting…';
    let added: { status: string; hostDeviceId?: string } = { status: 'granted' };
    for (let i = 0; i < 90 && added.status !== 'redeemed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      added = await client.addedComputer(base, connectHash);
      if (added.status === 'missing') throw new Error('the request expired; click Connect with GitHub in Vocs Code again');
    }
    if (added.status !== 'redeemed' || !added.hostDeviceId) throw new Error('the computer did not finish connecting; is Vocs Code still open on it?');
    status.textContent = 'Added. Now click Allow in Vocs Code on the computer to pair this browser.';
    const name = (el('connect-device-name') as HTMLInputElement).value.trim() || 'Browser';
    await pairThroughAccount(added.hostDeviceId, name);
  } catch (e) {
    el('connect-error').textContent = e instanceof Error ? e.message : String(e);
    add.disabled = false;
    status.textContent = '';
  }
}

/** Signed in: ask one of the account's computers to pair this browser; no code to carry. */
async function pairThroughAccount(hostDeviceId: string, name: string): Promise<void> {
  show('screen-pairing');
  try {
    await client.pairWithHost({ relayBase: relayBaseFor(window.location.origin, relayOverride()), hostDeviceId, deviceName: name });
    notice('');
    resetView();
    await enter();
  } catch (e) {
    el('pair-error').textContent = e instanceof Error ? e.message : String(e);
    openPairScreen();
  }
}

/** Signed in: the account's computers on the pair screen, each paired with one click. */
async function renderOwnerHosts(): Promise<void> {
  const box = el('owner-hosts');
  if (!(await accountReady)) return;
  let hosts: Awaited<ReturnType<typeof client.ownerHosts>>;
  try {
    hosts = await client.ownerHosts(relayBaseFor(window.location.origin, relayOverride()));
  } catch {
    // Signed in but owner actions are not set up on this relay: the code form still works.
    box.hidden = true;
    return;
  }
  const paired = new Set(client.pairings().map((p) => p.hostDeviceId));
  const list = el('owner-host-list');
  list.replaceChildren(
    ...hosts.map((host) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = host.name;
      const state = document.createElement('span');
      state.className = 'muted';
      state.textContent = paired.has(host.deviceId) ? ' · paired' : host.online ? ' · online' : ' · offline';
      label.append(state);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.dataset.host = host.deviceId;
      button.textContent = paired.has(host.deviceId) ? 'Open' : 'Pair';
      button.disabled = !paired.has(host.deviceId) && !host.online;
      button.title = button.disabled ? 'Open Vocs Code on that computer first' : '';
      button.addEventListener('click', () => {
        if (paired.has(host.deviceId)) {
          void (async () => {
            await client.select(host.deviceId);
            resetView();
            await enter();
          })();
        } else void pairThroughAccount(host.deviceId, (el('device-name') as HTMLInputElement).value.trim() || 'Browser');
      });
      item.append(label, button);
      return item;
    })
  );
  el('owner-hosts-empty').hidden = hosts.length > 0;
  box.hidden = false;
}

/** The login gate is on the landing origin. A local/ungated preview has no /v1/me, so keep
 *  account sign-out hidden there; unpairing this browser remains a separate device action. */
async function loadAccount(): Promise<boolean> {
  try {
    const res = await fetch('/v1/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { login?: unknown };
    if (typeof body.login !== 'string' || !body.login) return false;
    for (const form of document.querySelectorAll<HTMLFormElement>('.account-signout')) {
      const label = form.querySelector('.account-name');
      if (label) label.textContent = `@${body.login}`;
      form.hidden = false;
    }
    return true;
  } catch {
    // Pre-gate deployments do not have /v1/me. Never expose an account control without it.
    return false;
  }
}

/** The pairing form, first run or "Add a computer": Cancel returns to the app when paired. */
function openPairScreen(): void {
  el('pair-cancel').toggleAttribute('hidden', !client.hasCredentials());
  el('pair-title').textContent = client.hasCredentials() ? 'Add a computer' : 'Vocs Code';
  show('screen-pair');
  void renderOwnerHosts();
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
  el('pair-error').textContent = '';
  show('screen-pairing');
  try {
    await client.pair({ relayBase: relayBaseFor(window.location.origin, relayOverride()), code, deviceName: name });
    (el('code') as HTMLInputElement).value = '';
    notice('');
    resetView();
    await enter();
  } catch (e) {
    el('pair-error').textContent = e instanceof Error ? e.message : String(e);
    openPairScreen();
  }
}

/** The web app is served by the relay that routes it, so the base is this page's own origin;
 *  `?relay=` is the development escape hatch for pointing one build at another deployment. */
function relayOverride(): string | null {
  return new URLSearchParams(window.location.search).get('relay');
}

async function enter(): Promise<void> {
  show('screen-app');
  renderHosts();
  presenceTimer ??= setInterval(() => void refreshPresence(), 15_000);
  void refreshPresence();
  await connectLoop(true);
}

/** The switcher: one entry per paired computer, with whether it is reachable right now. */
function renderHosts(): void {
  const select = el('host-select') as HTMLSelectElement;
  const current = client.credentials();
  select.innerHTML = client
    .pairings()
    .map((p) => {
      const state = online.has(p.hostDeviceId) ? (online.get(p.hostDeviceId) ? 'online' : 'offline') : '…';
      return `<option value="${esc(p.hostDeviceId)}"${p === current ? ' selected' : ''}>${esc(p.hostName ?? 'Computer')} · ${state}</option>`;
    })
    .join('');
  select.disabled = client.pairings().length < 2;
}

async function refreshPresence(): Promise<void> {
  if (!client.hasCredentials()) return;
  try {
    const devices = await client.listDevices();
    online = new Map(devices.filter((d) => d.kind === 'host').map((d) => [d.deviceId, d.online === true]));
    // A paired computer missing from the registry was revoked; the relay no longer routes to it.
    for (const p of client.pairings()) if (!online.has(p.hostDeviceId)) online.set(p.hostDeviceId, false);
    renderHosts();
  } catch (e) {
    if (e instanceof PairingRevokedError) await pairingEnded(e);
  }
}

async function switchHost(hostDeviceId: string): Promise<void> {
  if (hostDeviceId === client.credentials()?.hostDeviceId) return;
  await client.select(hostDeviceId);
  resetView();
  await connectLoop(true);
}

function resetView(): void {
  closeTerminal();
  sessions = [];
  active = null;
  mode = 'live';
  windowItems = [];
  windowStart = 0;
  renderSessionList();
  renderTranscript();
  (el('active-title') as HTMLElement).textContent = '';
}

async function unpairActive(): Promise<void> {
  const current = client.credentials();
  if (!current) return;
  await client.unpair();
  notice(`Unpaired from ${current.hostName ?? 'the computer'}.`);
  await afterPairingRemoved();
}

/** The relay revoked the pairing (from another device, or the desktop pulled the kill switch). */
async function pairingEnded(e: PairingRevokedError): Promise<void> {
  notice(`This browser is no longer paired with ${e.hostName}. Pair again from the desktop if you still need it.`);
  await afterPairingRemoved();
}

async function afterPairingRemoved(): Promise<void> {
  resetView();
  if (client.hasCredentials()) {
    renderHosts();
    await connectLoop(true);
    return;
  }
  if (reconnectTimer) clearInterval(reconnectTimer);
  if (presenceTimer) clearInterval(presenceTimer);
  reconnectTimer = presenceTimer = null;
  openPairScreen();
}

/** Connects to the active computer; on failure shows the offline mirror and keeps retrying. */
async function connectLoop(force = false): Promise<void> {
  if ((connecting && !force) || !client.hasCredentials()) return;
  connecting = true;
  const target = client.credentials();
  setConnection('connecting…');
  try {
    await client.connect(() => {
      setConnection('reconnecting…');
      scheduleReconnect();
    });
  } catch (e) {
    connecting = false;
    if (e instanceof PairingRevokedError) {
      await pairingEnded(e);
      return;
    }
    if (client.credentials() !== target) return; // switched meanwhile
    await showMirror();
    scheduleReconnect();
    return;
  }
  connecting = false;
  if (client.credentials() !== target) return;
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
    // A mirror sealed under a key rotated since this browser last connected cannot be opened.
    const message = e instanceof Error && e.name === 'OperationError' ? 'the mirror was re-keyed; connect once while the desktop is online' : e instanceof Error ? e.message : String(e);
    setConnection(`desktop offline — ${message}`);
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

type Page = { items: TranscriptItem[]; start: number; total: number };

async function openSession(id: string): Promise<void> {
  active = id;
  const meta = sessions.find((s) => s.id === id);
  if (mode === 'mirror') {
    const snapshot = await client.mirrorSession(id);
    if (!snapshot || active !== id) return;
    windowItems = snapshot.items;
    windowStart = 0;
    renderTranscript(true);
    activeStatus = snapshot.status;
    (el('active-title') as HTMLElement).textContent = `${snapshot.title} · ${snapshot.status}${snapshot.truncated ? ' · earlier history trimmed' : ''}`;
  } else {
    // Newest page first: a long session does not replay whole over a phone connection.
    const page = (await client.invoke('sessions:transcriptPage', { id, limit: PAGE })) as Page;
    if (active !== id) return;
    windowItems = page.items;
    windowStart = page.start;
    renderTranscript(true);
    activeStatus = meta?.status ?? 'idle';
    (el('active-title') as HTMLElement).textContent = meta ? `${meta.title} · ${activeStatus}` : '';
  }
  syncControls();
  if (terminalOpen) void refreshTerminals();
  for (const row of Array.from(document.querySelectorAll('.session-row'))) row.classList.toggle('active', (row as HTMLElement).dataset.id === id);
}

/** Read-only terminal view (docs/REMOTE-ACCESS.md P3.5, read-only first): the desktop's terminals
 *  for the active session as plain text, refreshed once a second while open. The desktop never
 *  attaches, resizes or pauses a terminal for it, and nothing can be typed from here. */
async function toggleTerminal(): Promise<void> {
  if (terminalOpen) {
    closeTerminal();
    return;
  }
  terminalOpen = true;
  el('terminal-panel').hidden = false;
  await refreshTerminals();
}

function closeTerminal(): void {
  terminalOpen = false;
  el('terminal-panel').hidden = true;
  if (terminalTimer) clearInterval(terminalTimer);
  terminalTimer = null;
}

async function refreshTerminals(): Promise<void> {
  const id = active;
  if (!terminalOpen || !id || mode !== 'live') return closeTerminal();
  const screen = el('terminal-screen');
  let mine: TerminalInfo[];
  try {
    mine = ((await client.invoke('terminal:list', null)) as TerminalInfo[]).filter((t) => t.sessionId === id);
  } catch {
    // A desktop from before remote terminals refuses the channel.
    screen.textContent = 'This computer does not share terminals yet. Update Vocs Code on it.';
    return;
  }
  if (active !== id || !terminalOpen) return;
  const select = el('terminal-select') as HTMLSelectElement;
  const previous = select.value;
  select.innerHTML = mine.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}${t.exit ? ' (exited)' : ''}</option>`).join('');
  if (mine.some((t) => t.id === previous)) select.value = previous;
  if (!mine.length) {
    screen.textContent = 'No terminal is open for this session on the desktop.';
    return;
  }
  terminalTimer ??= setInterval(() => void pollTerminal(), 1000);
  await pollTerminal();
}

async function pollTerminal(): Promise<void> {
  const terminalId = (el('terminal-select') as HTMLSelectElement).value;
  if (!terminalOpen || !terminalId || mode !== 'live' || terminalBusy) return;
  terminalBusy = true;
  try {
    const view = (await client.invoke('terminal:screen', { terminalId, lines: 200 })) as { lines: string[] };
    if (!terminalOpen || (el('terminal-select') as HTMLSelectElement).value !== terminalId) return;
    const screen = el('terminal-screen');
    const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
    screen.textContent = view.lines.join('\n');
    if (atBottom) screen.scrollTop = screen.scrollHeight;
  } catch {
    // The terminal closed or the desktop left; the next list refresh or reconnect decides.
  } finally {
    terminalBusy = false;
  }
}

/** Re-reads the loaded window (and anything appended after it). One refresh runs at a time; events
 *  that arrive meanwhile fold into a single follow-up. */
function refreshTranscript(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      const id = active;
      if (!id || mode !== 'live') break;
      try {
        const page = (await client.invoke('sessions:transcriptPage', { id, start: windowStart })) as Page;
        if (active !== id || mode !== 'live') break;
        windowItems = page.items;
        windowStart = page.start;
        renderTranscript(false);
      } catch {
        break;
      }
    } while (refreshAgain);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function loadEarlier(): Promise<void> {
  const id = active;
  if (!id || mode !== 'live' || windowStart === 0) return;
  const page = (await client.invoke('sessions:transcriptPage', { id, start: Math.max(0, windowStart - PAGE), end: windowStart })) as Page;
  if (active !== id) return;
  windowItems = [...page.items, ...windowItems];
  windowStart = page.start;
  renderTranscript(false, true);
}

function isRunning(status: string): boolean {
  return status === 'running' || status === 'starting' || status === 'awaiting';
}

/** Interrupt/stop show only while driving a live session — never in view-only or mirror mode. */
function syncControls(): void {
  const running = mode === 'live' && !viewOnly && isRunning(activeStatus);
  (el('act-interrupt') as HTMLElement).hidden = !running;
  (el('act-stop') as HTMLElement).hidden = !running;
  // Viewing is read-only, so view-only mode keeps it; a mirror has no live terminal.
  (el('act-terminal') as HTMLElement).hidden = mode !== 'live' || !active;
  if (mode !== 'live' && terminalOpen) closeTerminal();
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

/** `jumpToEnd` for a newly opened session; `keepOffset` when older items were prepended. */
function renderTranscript(jumpToEnd = false, keepOffset = false): void {
  const root = el('transcript');
  const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 40;
  const fromBottom = root.scrollHeight - root.scrollTop;
  const earlier = el('load-earlier') as HTMLButtonElement;
  earlier.hidden = mode !== 'live' || windowStart === 0;
  earlier.textContent = `Load earlier messages (${windowStart})`;
  root.innerHTML = windowItems
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
  if (keepOffset) root.scrollTop = root.scrollHeight - fromBottom;
  else if (jumpToEnd || atBottom) root.scrollTop = root.scrollHeight;
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
    const own = client.credentials()?.webDeviceId;
    list.innerHTML = devices.map((d) => deviceRow(d, d.deviceId === own)).join('');
  } catch (e) {
    if (e instanceof PairingRevokedError) {
      await pairingEnded(e);
      return;
    }
    el('devices-error').textContent = e instanceof Error ? e.message : String(e);
  }
}

function deviceRow(d: RemoteDeviceInfo, self: boolean): string {
  const what = d.kind === 'host' ? 'Computer' : 'Browser';
  const state = d.online ? 'online now' : `last seen ${new Date(d.lastSeen).toLocaleString()}`;
  return `<div class="device-row"><span>${esc(what)}: ${esc(d.name)}${self ? ' <small class="muted">(this browser)</small>' : ''}<br><small class="muted">${esc(d.platform)} · ${esc(state)}</small></span><button class="danger" data-revoke="${esc(d.deviceId)}">Revoke</button></div>`;
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
      await refreshTranscript();
    }
    return;
  }
  if (channel === 'push:sessionsChanged') {
    sessions = (payload as typeof sessions) ?? sessions;
    renderSessionList();
    if (active) await refreshTranscript();
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
    const before = client.pairings().length;
    void client
      .revokeDevice(revoke.dataset.revoke)
      .then(async () => {
        // Revoking this browser, or a computer it was paired with, ends those pairings here too.
        if (client.pairings().length < before) await afterPairingRemoved();
        else await refreshDevices();
      })
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

void boot();
