"use strict";
(() => {
  // src/shared/crypto.ts
  var subtle = globalThis.crypto.subtle;
  var enc = new TextEncoder();
  function publicOf(identity) {
    return { sig: identity.sig.pub, enc: identity.enc.pub };
  }
  async function generateIdentity() {
    const sig = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ecdh2 = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    return {
      sig: { pub: await subtle.exportKey("jwk", sig.publicKey), priv: await subtle.exportKey("jwk", sig.privateKey) },
      enc: { pub: await subtle.exportKey("jwk", ecdh2.publicKey), priv: await subtle.exportKey("jwk", ecdh2.privateKey) }
    };
  }
  async function sign(identity, data) {
    const key = await subtle.importKey("jwk", identity.sig.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, canonical(data));
    return toB64Url(sig);
  }
  async function verify(peer, data, sigB64) {
    const key = await subtle.importKey("jwk", peer.sig, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64Url(sigB64), canonical(data));
  }
  function helloPayload(hello) {
    return ["hs1", hello.eph, hello.id, hello.ts];
  }
  function replyPayload(hello, reply) {
    return ["hs1", hello.eph, hello.id, hello.ts, "hs2", reply.eph, reply.id, reply.ts];
  }
  async function createHello(identity) {
    const eph = await freshEph();
    const hello = { t: "hs1", eph: eph.pub, id: publicOf(identity), ts: Date.now(), sig: "" };
    hello.sig = await sign(identity, helloPayload(hello));
    return { hello, ephPriv: eph.priv };
  }
  async function clientFinish(hello, ephPriv, reply, expectedHost, clientIdentity) {
    if (stable(reply.id) !== stable(expectedHost)) throw new Error("handshake: unknown host identity");
    if (!await verify(expectedHost, replyPayload(hello, reply), reply.sig)) throw new Error("handshake: bad host signature");
    const key = await deriveSessionKey({ ephPriv, peerEph: reply.eph, authPriv: clientIdentity.enc.priv, peerAuthPub: reply.id.enc, transcript: [hello, reply] });
    return { key, salt: newSalt() };
  }
  async function freshEph() {
    const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    return { pub: await subtle.exportKey("jwk", pair.publicKey), priv: await subtle.exportKey("jwk", pair.privateKey) };
  }
  async function ecdh(privJwk, peerPubJwk) {
    const priv = await subtle.importKey("jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const peer = await subtle.importKey("jwk", peerPubJwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
    return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256));
  }
  async function deriveSessionKey(input) {
    const ephBits = await ecdh(input.ephPriv, input.peerEph);
    const authBits = await ecdh(input.authPriv, input.peerAuthPub);
    const material = new Uint8Array(64);
    material.set(ephBits, 0);
    material.set(authBits, 32);
    const info = await subtle.digest("SHA-256", enc.encode(stable(input.transcript)));
    const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info }, await subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]), 256);
    return subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  function canonical(data) {
    return enc.encode(stable(data));
  }
  function stable(value) {
    if (value === void 0) return "null";
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      const o = value;
      return `{${Object.keys(o).filter((k) => o[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }
  function toB64Url(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const byte of b) s += String.fromCharCode(byte);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromB64Url(s) {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  }
  function newSalt() {
    return crypto.getRandomValues(new Uint8Array(16));
  }
  async function sealFrame(key, salt, seq, plaintext) {
    const ct = await subtle.encrypt({ name: "AES-GCM", iv: nonceOf(salt, seq), tagLength: 128 }, key, canonical(plaintext));
    return { salt: toB64Url(salt), seq, ct: toB64Url(ct) };
  }
  async function openFrame(key, frame) {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: nonceOf(fromB64Url(frame.salt), frame.seq), tagLength: 128 }, key, fromB64Url(frame.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function nonceOf(salt, seq) {
    const nonce = new Uint8Array(12);
    nonce.set(salt.subarray(0, 4), 0);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(seq));
    return nonce;
  }

  // relay/src/web-client.ts
  var CREDS_KEY = "vocs-web-credentials";
  var RelayClient = class {
    constructor(deps) {
      this.deps = deps;
    }
    creds = null;
    socket = null;
    session = null;
    nextId = 0;
    outCounter = 0;
    pending = /* @__PURE__ */ new Map();
    pushListeners = /* @__PURE__ */ new Set();
    hsWaiter = null;
    hasCredentials() {
      return !!this.deps.storage.get(CREDS_KEY);
    }
    restore() {
      const raw = this.deps.storage.get(CREDS_KEY);
      if (!raw) return false;
      try {
        this.creds = JSON.parse(raw);
        return true;
      } catch {
        this.deps.storage.remove(CREDS_KEY);
        return false;
      }
    }
    logout() {
      this.socket?.close();
      this.socket = null;
      this.session = null;
      this.creds = null;
      this.deps.storage.remove(CREDS_KEY);
    }
    /** Enters a pairing code, claims it with a fresh identity, polls until the desktop approves. */
    async pair(input) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const base = input.relayBase.replace(/\/$/, "");
      const code = input.code.trim().toUpperCase();
      const identity = await generateIdentity();
      const claim = await doFetch(`${base}/v1/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, webPub: publicOf(identity), name: input.deviceName })
      });
      if (!claim.ok) throw new Error(`claim failed: ${claim.status}`);
      const now = this.deps.now ?? Date.now;
      const deadline = now() + 5 * 6e4;
      for (; ; ) {
        if (now() >= deadline) throw new Error("pairing timed out");
        await new Promise((r) => setTimeout(r, 1200));
        const poll = await (await doFetch(`${base}/v1/pair/poll?code=${encodeURIComponent(code)}`)).json();
        if (poll.status === "approved") {
          this.creds = { relayBase: base, webToken: poll.webToken, webDeviceId: poll.webDeviceId, hostPub: poll.hostPub, hostDeviceId: poll.hostDeviceId, identity };
          this.deps.storage.set(CREDS_KEY, JSON.stringify(this.creds));
          return this.creds;
        }
        if (poll.status === "denied") throw new Error("pairing denied on the desktop");
        if (poll.status === "expired") throw new Error("pairing code expired");
      }
    }
    /** Opens the relay socket and performs the e2e handshake with the paired host. */
    async connect(onClose) {
      if (!this.creds) throw new Error("not paired");
      const base = this.creds.relayBase.replace(/^http/, "ws").replace(/\/$/, "");
      const url = `${base}/v1/ws/client?device=${encodeURIComponent(this.creds.webDeviceId)}&token=${encodeURIComponent(this.creds.webToken)}`;
      const handleDrop = () => {
        this.socket = null;
        this.session = null;
        onClose?.();
      };
      this.socket = this.deps.wsFactory ? this.deps.wsFactory(url, (raw) => this.onMessage(raw), handleDrop) : browserSocket(url, (raw) => this.onMessage(raw), handleDrop);
      this.socket.send(JSON.stringify({ t: "hello", host: this.creds.hostDeviceId }));
      const { hello, ephPriv } = await createHello(this.creds.identity);
      this.socket.send(JSON.stringify({ t: "hs", seq: 0, payload: hello }));
      const reply = await new Promise((resolve, reject) => {
        this.hsWaiter = { resolve, reject };
        setTimeout(() => reject(new Error("handshake timed out")), 1e4);
      });
      const session = await clientFinish(hello, ephPriv, reply, this.creds.hostPub, this.creds.identity);
      this.session = { key: session.key, salt: session.salt };
    }
    onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "hs" && this.hsWaiter) {
        this.hsWaiter.resolve(msg.payload);
        this.hsWaiter = null;
        return;
      }
      if (msg.t === "d" && this.session) {
        void this.onSealed(this.session, msg.payload);
      }
    }
    async onSealed(session, sealed) {
      let inner;
      try {
        inner = await openFrame(session.key, sealed);
      } catch {
        return;
      }
      if (inner.type === "result" && typeof inner.id === "number") {
        const entry = this.pending.get(inner.id);
        if (!entry) return;
        this.pending.delete(inner.id);
        if (inner.ok) entry.resolve(inner.value);
        else entry.reject(new Error(String(inner.error ?? "invoke failed")));
        return;
      }
      if (inner.type === "push" && inner.channel) {
        for (const l of [...this.pushListeners]) l(inner.channel, inner.payload);
      }
    }
    onPush(listener) {
      this.pushListeners.add(listener);
      return () => this.pushListeners.delete(listener);
    }
    /** E2E invoke. Approval decisions are signed inside the channel (§6.8). */
    async invoke(channel, request) {
      if (!this.session) throw new Error("not connected");
      const id = ++this.nextId;
      const inner = { type: "invoke", id, channel, request };
      if (channel === "approvals:respond" && this.creds) inner.sig = await sign(this.creds.identity, request);
      const sealed = await sealFrame(this.session.key, this.session.salt, ++this.outCounter, inner);
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.socket?.send(JSON.stringify({ t: "d", seq: sealed.seq, payload: sealed }));
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error("invoke timed out"));
        }, 3e4);
      });
    }
    credentials() {
      return this.creds;
    }
    /** Lists every device paired with the account (P4 device management), via the relay REST surface. */
    async listDevices() {
      if (!this.creds) return [];
      const doFetch = this.deps.fetchImpl ?? fetch;
      const base = this.creds.relayBase.replace(/\/$/, "");
      const res = await doFetch(`${base}/v1/devices?device=${encodeURIComponent(this.creds.webDeviceId)}&token=${encodeURIComponent(this.creds.webToken)}`);
      if (!res.ok) throw new Error(`devices failed: ${res.status}`);
      return await res.json();
    }
    /** Revokes any paired device — another browser, the desktop, or this browser itself. */
    async revokeDevice(deviceId) {
      if (!this.creds) return;
      const doFetch = this.deps.fetchImpl ?? fetch;
      const base = this.creds.relayBase.replace(/\/$/, "");
      const url = `${base}/v1/devices?device=${encodeURIComponent(this.creds.webDeviceId)}&token=${encodeURIComponent(this.creds.webToken)}&target=${encodeURIComponent(deviceId)}`;
      const res = await doFetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
    }
  };
  function browserSocket(url, onMessage, onClose) {
    const ws = new WebSocket(url);
    ws.addEventListener("message", (ev) => onMessage(String(ev.data)));
    ws.addEventListener("close", () => onClose());
    return {
      send: (raw) => ws.send(raw),
      close: () => ws.close()
    };
  }

  // relay/src/page.ts
  var client = new RelayClient({ storage: localStorageApi() });
  var sessions = [];
  var active = null;
  var activeStatus = "idle";
  var viewOnly = false;
  function localStorageApi() {
    return {
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
      remove: (k) => window.localStorage.removeItem(k)
    };
  }
  function el(id) {
    const e = document.getElementById(id);
    if (!e) throw new Error(`missing #${id}`);
    return e;
  }
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function show(id) {
    for (const section of document.querySelectorAll("[data-screen]")) {
      section.hidden = section.id !== id;
    }
  }
  function setConnection(state) {
    el("conn").textContent = state;
  }
  function boot() {
    el("pair-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const relay = el("relay").value.trim();
      const code = el("code").value.trim();
      const name = el("device-name").value.trim() || "Browser";
      void startPairing(relay, code, name);
    });
    el("logout").addEventListener("click", () => {
      client.logout();
      location.reload();
    });
    el("new-session").addEventListener("click", () => void toggleNewSession(true));
    el("ns-cancel").addEventListener("click", () => void toggleNewSession(false));
    el("ns-create").addEventListener("click", () => void createSession());
    el("devices").addEventListener("click", () => void toggleDevices());
    el("devices-close").addEventListener("click", () => el("devices-panel").setAttribute("hidden", ""));
    el("send").addEventListener("click", () => void sendComposer());
    el("act-interrupt").addEventListener("click", () => void actOnActive("sessions:interrupt", null));
    el("act-stop").addEventListener("click", () => void actOnActive("sessions:stop", null));
    const composer = el("composer");
    composer.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void sendComposer();
      }
    });
    if (client.restore()) void enter();
    else show("screen-pair");
  }
  async function sendComposer() {
    const box = el("composer");
    const text = box.value.trim();
    if (!text || !active || viewOnly) return;
    box.value = "";
    try {
      await client.invoke("sessions:send", { id: active, input: { text } });
    } catch (e) {
      setConnection(`send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function actOnActive(channel, request) {
    if (!active) return;
    try {
      await client.invoke(channel, request ? { id: active, ...request } : { id: active });
    } catch (e) {
      setConnection(`${channel} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function toggleNewSession(open) {
    el("new-session-panel").toggleAttribute("hidden", !open);
    if (!open) return;
    try {
      const settings = await client.invoke("settings:get", null);
      const folders = [.../* @__PURE__ */ new Set([...settings.folders ?? [], ...settings.recentProjects ?? []])];
      el("known-folders").innerHTML = folders.map((f) => `<option value="${esc(f)}"></option>`).join("");
      const availability = await client.invoke("harness:availability", null);
      el("ns-harness").innerHTML = Object.entries(availability).map(([id, a]) => `<option value="${esc(id)}">${esc(id)}${a.available ? "" : " (not installed)"}</option>`).join("");
    } catch (e) {
      el("ns-error").textContent = e instanceof Error ? e.message : String(e);
    }
  }
  async function createSession() {
    const folder = el("ns-folder").value.trim();
    const harness = el("ns-harness").value;
    const title = el("ns-title").value.trim() || void 0;
    const initialPrompt = el("ns-prompt").value.trim() || void 0;
    if (!folder) {
      el("ns-error").textContent = "A folder path on the host machine is required.";
      return;
    }
    try {
      const created = await client.invoke("sessions:create", {
        config: { harness, projectRoot: folder, permissionMode: "ask" },
        title,
        initialPrompt
      });
      el("new-session-panel").setAttribute("hidden", "");
      await refreshSessions();
      await openSession(created.id);
    } catch (e) {
      el("ns-error").textContent = e instanceof Error ? e.message : String(e);
    }
  }
  async function startPairing(relay, code, name) {
    show("screen-pairing");
    try {
      await client.pair({ relayBase: relay, code, deviceName: name });
      await enter();
    } catch (e) {
      el("pair-error").textContent = e instanceof Error ? e.message : String(e);
      show("screen-pair");
    }
  }
  async function enter() {
    show("screen-app");
    try {
      await client.connect(() => {
        setConnection("reconnecting\u2026");
        const retry = setInterval(() => {
          if (!client.hasCredentials()) return;
          void client.connect().then(() => {
            setConnection("connected");
            clearInterval(retry);
          }).catch(() => void 0);
        }, 3e3);
      });
    } catch (e) {
      setConnection(`connection failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setConnection("connected");
    client.onPush((channel, payload) => void onPush(channel, payload));
    try {
      const settings = await client.invoke("settings:get", null);
      applyPolicy(settings.remote?.viewOnly === true);
    } catch {
    }
    await refreshSessions();
  }
  async function refreshSessions() {
    try {
      sessions = await client.invoke("sessions:list", null);
      const list = el("session-list");
      list.innerHTML = sessions.map((s) => `<button class="session-row" data-id="${esc(s.id)}"><span>${esc(s.title)}</span><small>${esc(s.status)}</small></button>`).join("");
      for (const row of Array.from(list.querySelectorAll("button"))) {
        row.addEventListener("click", () => void openSession(row.dataset.id));
      }
      const first = sessions[0]?.id;
      if (first) await openSession(first);
    } catch (e) {
      setConnection(`failed to list sessions: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function openSession(id) {
    active = id;
    const items = await client.invoke("sessions:transcript", { id });
    renderTranscript(items);
    const meta = sessions.find((s) => s.id === id);
    activeStatus = meta?.status ?? "idle";
    el("active-title").textContent = meta ? `${meta.title} \xB7 ${activeStatus}` : "";
    syncControls();
    for (const row of Array.from(document.querySelectorAll(".session-row"))) row.classList.toggle("active", row.dataset.id === id);
  }
  function isRunning(status) {
    return status === "running" || status === "starting" || status === "awaiting";
  }
  function syncControls() {
    const running = !viewOnly && isRunning(activeStatus);
    el("act-interrupt").hidden = !running;
    el("act-stop").hidden = !running;
  }
  function applyPolicy(next) {
    viewOnly = next;
    const badge = el("policy");
    badge.toggleAttribute("hidden", !viewOnly);
    badge.textContent = viewOnly ? "view-only" : "";
    for (const id of ["composer", "send", "new-session"]) el(id).toggleAttribute("disabled", viewOnly);
    syncControls();
    if (viewOnly) el("new-session-panel").setAttribute("hidden", "");
  }
  function renderTranscript(items) {
    const root = el("transcript");
    root.innerHTML = items.map((i) => {
      switch (i.kind) {
        case "user":
          return `<div class="msg user">${esc(i.text)}</div>`;
        case "assistant":
          return `<div class="msg assistant">${esc(i.text)}</div>`;
        case "tool":
          return `<div class="msg tool"><b>${esc(i.name)}</b>${i.summary ? ` \u2014 ${esc(i.summary)}` : ""} <small>[${esc(i.status)}]</small></div>`;
        case "approval":
          return renderApproval(i);
        case "info":
          return `<div class="msg info">${esc(i.text)}</div>`;
        default:
          return "";
      }
    }).join("");
    root.scrollTop = root.scrollHeight;
  }
  function renderApproval(item) {
    const requestId = item.request.id;
    if (item.decision) return `<div class="msg approval decided"><b>Approval</b> <small>decided: ${esc(item.decision.optionId)}</small></div>`;
    if (viewOnly) return `<div class="msg approval"><b>Approval needed</b><small> \u2014 decide on the desktop (view-only)</small></div>`;
    return `<div class="msg approval"><b>Approval needed</b><div class="approval-actions" data-request="${esc(requestId)}"><button data-decision="allow">Allow</button><button data-decision="deny" class="danger">Deny</button></div></div>`;
  }
  async function toggleDevices() {
    const panel = el("devices-panel");
    const opening = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !opening);
    if (opening) await refreshDevices();
  }
  async function refreshDevices() {
    const list = el("device-list");
    el("devices-error").textContent = "";
    list.innerHTML = '<p class="muted small">Loading\u2026</p>';
    try {
      const devices = await client.listDevices();
      list.innerHTML = devices.map(
        (d) => `<div class="device-row"><span>${esc(d.kind === "host" ? "Computer" : "Browser")}: ${esc(d.name)}<br><small class="muted">${esc(d.platform)} \xB7 last seen ${esc(new Date(d.lastSeen).toLocaleString())}</small></span><button class="danger" data-revoke="${esc(d.deviceId)}">Revoke</button></div>`
      ).join("");
    } catch (e) {
      el("devices-error").textContent = e instanceof Error ? e.message : String(e);
    }
  }
  async function onPush(channel, payload) {
    if (channel === "push:remotePolicy") {
      applyPolicy(payload?.viewOnly === true);
      return;
    }
    if (channel === "push:sessionEvent" && payload) {
      const env = payload;
      if (active && env.sessionId === active) {
        if (env.event?.type === "status" && env.event.status) {
          activeStatus = env.event.status;
          const meta = sessions.find((s) => s.id === active);
          el("active-title").textContent = meta ? `${meta.title} \xB7 ${activeStatus}` : "";
          syncControls();
        }
        await openSession(active);
      }
      return;
    }
    if (channel === "push:sessionsChanged") {
      sessions = payload ?? sessions;
      renderSessionList();
      if (active) await openSession(active);
    }
  }
  function renderSessionList() {
    const list = el("session-list");
    list.innerHTML = sessions.map((s) => `<button class="session-row" data-id="${esc(s.id)}"><span>${esc(s.title)}</span><small>${esc(s.status)}</small></button>`).join("");
    for (const row of Array.from(list.querySelectorAll("button"))) {
      row.addEventListener("click", () => void openSession(row.dataset.id));
    }
  }
  document.addEventListener("click", (ev) => {
    const target = ev.target;
    const revoke = target.closest("button[data-revoke]");
    if (revoke?.dataset.revoke) {
      void client.revokeDevice(revoke.dataset.revoke).then(() => refreshDevices()).catch((e) => {
        el("devices-error").textContent = e instanceof Error ? e.message : String(e);
      });
      return;
    }
    const btn = target.closest("button[data-decision]");
    const wrap = btn?.closest(".approval-actions");
    if (!btn || !wrap) return;
    const requestId = wrap.dataset.request;
    const decision = { optionId: btn.dataset.decision === "allow" ? "allow" : "deny" };
    if (requestId) void client.invoke("approvals:respond", { sessionId: active, requestId, decision });
  });
  boot();
})();
