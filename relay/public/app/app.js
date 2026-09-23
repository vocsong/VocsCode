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
  async function importAesKey(b64) {
    return subtle.importKey("raw", fromB64Url(b64), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async function openBlob(key, blob) {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: fromB64Url(blob.iv), tagLength: 128 }, key, fromB64Url(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // relay/src/web-client.ts
  var CREDS_KEY = "vocs-web-credentials";
  function relayBaseFor(origin, override) {
    return (override?.trim() || origin).replace(/\/$/, "");
  }
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
    mirrorCache = null;
    /** Sealed frames that arrive while the handshake reply is still being finished. */
    earlyFrames = [];
    connectAttempt = 0;
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
      this.connectAttempt++;
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
      const { pollToken } = await claim.json();
      if (typeof pollToken !== "string" || !pollToken) throw new Error("claim did not return a poll capability");
      const now = this.deps.now ?? Date.now;
      const deadline = now() + 5 * 6e4;
      for (; ; ) {
        if (now() >= deadline) throw new Error("pairing timed out");
        await new Promise((r) => setTimeout(r, 1200));
        const response = await doFetch(`${base}/v1/pair/poll?code=${encodeURIComponent(code)}`, { headers: { authorization: `Bearer ${pollToken}` } });
        if (!response.ok) throw new Error(`poll failed: ${response.status}`);
        const poll = await response.json();
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
      const creds = this.creds;
      if (!creds) throw new Error("not paired");
      const attempt = ++this.connectAttempt;
      this.socket?.close();
      this.socket = null;
      this.session = null;
      this.earlyFrames = [];
      const base = creds.relayBase.replace(/\/$/, "");
      const response = await (this.deps.fetchImpl ?? fetch)(`${base}/v1/ws/ticket?device=${encodeURIComponent(creds.webDeviceId)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${creds.webToken}` }
      });
      if (!response.ok) throw new Error(`socket ticket failed: ${response.status}`);
      const { ticket } = await response.json();
      if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error("invalid socket ticket");
      if (attempt !== this.connectAttempt || this.creds !== creds) throw new Error("connection superseded");
      const wsBase = base.replace(/^http/, "ws");
      const url = `${wsBase}/v1/ws/client?device=${encodeURIComponent(creds.webDeviceId)}&ticket=${encodeURIComponent(ticket)}`;
      let socket;
      const handleDrop = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.session = null;
        onClose?.();
      };
      const onMessage = (raw) => {
        if (this.socket === socket) this.onMessage(raw);
      };
      socket = this.deps.wsFactory ? this.deps.wsFactory(url, onMessage, handleDrop) : browserSocket(url, onMessage, handleDrop);
      this.socket = socket;
      socket.send(JSON.stringify({ t: "hello", host: creds.hostDeviceId }));
      const { hello, ephPriv } = await createHello(creds.identity);
      if (this.socket !== socket || attempt !== this.connectAttempt || this.creds !== creds) throw new Error("connection superseded");
      socket.send(JSON.stringify({ t: "hs", seq: 0, payload: hello }));
      const reply = await new Promise((resolve, reject) => {
        this.hsWaiter = { resolve, reject };
        setTimeout(() => reject(new Error("handshake timed out")), 1e4);
      });
      if (this.socket !== socket || attempt !== this.connectAttempt) throw new Error("connection superseded");
      const session = await clientFinish(hello, ephPriv, reply, creds.hostPub, creds.identity);
      if (this.socket !== socket || attempt !== this.connectAttempt) throw new Error("connection superseded");
      this.session = { key: session.key, salt: session.salt, inSeq: -1, incoming: Promise.resolve(), outgoing: Promise.resolve() };
      const early = this.earlyFrames;
      this.earlyFrames = [];
      for (const frame of early) this.queueSealed(this.session, frame);
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
      if (msg.t === "d") {
        if (!this.session) {
          if (this.earlyFrames.length < 32) this.earlyFrames.push(msg.payload);
          return;
        }
        this.queueSealed(this.session, msg.payload);
      }
    }
    queueSealed(session, sealed) {
      session.incoming = session.incoming.then(() => this.onSealed(session, sealed)).catch(() => void 0);
    }
    async onSealed(session, sealed) {
      if (this.session !== session || !sealed || !Number.isSafeInteger(sealed.seq) || sealed.seq < 0 || typeof sealed.salt !== "string" || typeof sealed.ct !== "string" || sealed.seq <= session.inSeq || session.inSalt !== void 0 && sealed.salt !== session.inSalt) return;
      let inner;
      try {
        inner = await openFrame(session.key, sealed);
      } catch {
        return;
      }
      if (this.session !== session) return;
      session.inSeq = sealed.seq;
      session.inSalt = sealed.salt;
      if (inner.type === "result" && typeof inner.id === "number") {
        const entry = this.pending.get(inner.id);
        if (!entry) return;
        this.pending.delete(inner.id);
        if (inner.ok) entry.resolve(inner.value);
        else entry.reject(new Error(String(inner.error ?? "invoke failed")));
        return;
      }
      if (inner.type === "mirror.key" && typeof inner.key === "string" && this.creds) {
        this.creds.mirrorKey = inner.key;
        this.deps.storage.set(CREDS_KEY, JSON.stringify(this.creds));
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
      const session = this.session;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const send = session.outgoing.then(async () => {
          if (this.session !== session || !this.socket) throw new Error("not connected");
          const sealed = await sealFrame(session.key, session.salt, ++this.outCounter, inner);
          if (this.session !== session || !this.socket) throw new Error("not connected");
          this.socket.send(JSON.stringify({ t: "d", seq: sealed.seq, payload: sealed }));
        });
        session.outgoing = send.catch(() => void 0);
        void send.catch((e) => {
          if (this.pending.delete(id)) reject(e);
        });
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
      const res = await doFetch(`${base}/v1/devices?device=${encodeURIComponent(this.creds.webDeviceId)}`, { headers: { authorization: `Bearer ${this.creds.webToken}` } });
      if (!res.ok) throw new Error(`devices failed: ${res.status}`);
      return await res.json();
    }
    /** Revokes any paired device — another browser, the desktop, or this browser itself. */
    async revokeDevice(deviceId) {
      if (!this.creds) return;
      const doFetch = this.deps.fetchImpl ?? fetch;
      const base = this.creds.relayBase.replace(/\/$/, "");
      const url = `${base}/v1/devices?device=${encodeURIComponent(this.creds.webDeviceId)}&target=${encodeURIComponent(deviceId)}`;
      const res = await doFetch(url, { method: "DELETE", headers: { authorization: `Bearer ${this.creds.webToken}` } });
      if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
    }
    /** True once the desktop has handed over the mirror key (it does so on every connect). */
    hasMirror() {
      return !!this.creds?.mirrorKey;
    }
    /** The sealed offline session index, opened locally; null when no mirror has been uploaded. */
    async mirrorIndex() {
      const key = await this.mirrorKey();
      if (!key) return null;
      const blob = await this.mirrorFetch("/v1/mirror");
      return blob ? openBlob(key, blob) : null;
    }
    /** One session's sealed transcript snapshot, opened locally. */
    async mirrorSession(sessionId) {
      const key = await this.mirrorKey();
      if (!key) return null;
      const blob = await this.mirrorFetch(`/v1/mirror/${encodeURIComponent(sessionId)}`);
      return blob ? openBlob(key, blob) : null;
    }
    async mirrorKey() {
      if (!this.creds?.mirrorKey) return null;
      if (this.mirrorCache?.secret === this.creds.mirrorKey) return this.mirrorCache.value;
      const value = await importAesKey(this.creds.mirrorKey);
      this.mirrorCache = { secret: this.creds.mirrorKey, value };
      return value;
    }
    /** Reads an opaque mirror blob from the relay; the caller decrypts it. */
    async mirrorFetch(path) {
      if (!this.creds) return null;
      const doFetch = this.deps.fetchImpl ?? fetch;
      const base = this.creds.relayBase.replace(/\/$/, "");
      const query = new URLSearchParams({ host: this.creds.hostDeviceId, device: this.creds.webDeviceId });
      const res = await doFetch(`${base}${path}?${query.toString()}`, { headers: { authorization: `Bearer ${this.creds.webToken}` } });
      if (!res.ok) throw new Error(`mirror fetch failed: ${res.status}`);
      const body = await res.json();
      return body && typeof body.iv === "string" && typeof body.ct === "string" ? { iv: body.iv, ct: body.ct } : null;
    }
  };
  function browserSocket(url, onMessage, onClose) {
    const ws = new WebSocket(url);
    const queued = [];
    let closed = false;
    ws.addEventListener("open", () => {
      if (closed) return;
      for (const raw of queued.splice(0)) ws.send(raw);
    });
    ws.addEventListener("message", (ev) => onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      closed = true;
      queued.length = 0;
      onClose();
    });
    return {
      // A browser WebSocket throws when send() is called before OPEN; connect() must be able
      // to enqueue its hello and handshake immediately, in order, without exposing a retry race.
      send: (raw) => {
        if (closed) throw new Error("socket closed");
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
        else if (ws.readyState === WebSocket.CONNECTING && queued.length < 32) queued.push(raw);
        else throw new Error("socket unavailable");
      },
      close: () => {
        closed = true;
        queued.length = 0;
        ws.close();
      }
    };
  }

  // relay/src/page.ts
  var client = new RelayClient({ storage: localStorageApi() });
  var sessions = [];
  var active = null;
  var activeStatus = "idle";
  var viewOnly = false;
  var mode = "live";
  var reconnectTimer = null;
  var connecting = false;
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
    const params = new URLSearchParams(window.location.search);
    if (params.has("code")) {
      const codes = params.getAll("code");
      const code = codes[0]?.trim().toUpperCase() ?? "";
      if (codes.length === 1 && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code)) {
        el("code").value = code;
      } else {
        el("pair-error").textContent = "Invalid code in pairing link. Enter the code shown on the desktop.";
      }
      params.delete("code");
      const search = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    }
    el("pair-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const code = el("code").value.trim();
      const name = el("device-name").value.trim() || "Browser";
      void startPairing(code, name);
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
    void loadAccount();
  }
  async function loadAccount() {
    try {
      const res = await fetch("/v1/me", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      if (typeof body.login !== "string" || !body.login) return;
      for (const form of document.querySelectorAll(".account-signout")) {
        const label = form.querySelector(".account-name");
        if (label) label.textContent = `@${body.login}`;
        form.hidden = false;
      }
    } catch {
    }
  }
  async function sendComposer() {
    const box = el("composer");
    const text = box.value.trim();
    if (!text || !active || viewOnly || mode === "mirror") return;
    box.value = "";
    try {
      await client.invoke("sessions:send", { id: active, input: { text } });
    } catch (e) {
      setConnection(`send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function actOnActive(channel, request) {
    if (!active || mode === "mirror") return;
    try {
      await client.invoke(channel, request ? { id: active, ...request } : { id: active });
    } catch (e) {
      setConnection(`${channel} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function toggleNewSession(open) {
    if (open && mode === "mirror") return;
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
    if (mode === "mirror") return;
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
  async function startPairing(code, name) {
    show("screen-pairing");
    try {
      await client.pair({ relayBase: relayBaseFor(window.location.origin, relayOverride()), code, deviceName: name });
      await enter();
    } catch (e) {
      el("pair-error").textContent = e instanceof Error ? e.message : String(e);
      show("screen-pair");
    }
  }
  function relayOverride() {
    return new URLSearchParams(window.location.search).get("relay");
  }
  async function enter() {
    show("screen-app");
    client.onPush((channel, payload) => void onPush(channel, payload));
    await connectLoop();
  }
  async function connectLoop() {
    if (connecting || !client.hasCredentials()) return;
    connecting = true;
    try {
      await client.connect(() => {
        setConnection("reconnecting\u2026");
        scheduleReconnect();
      });
    } catch {
      connecting = false;
      await showMirror();
      scheduleReconnect();
      return;
    }
    connecting = false;
    mode = "live";
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    setConnection("connected");
    await loadPolicy();
    await refreshSessions();
  }
  function scheduleReconnect() {
    if (reconnectTimer || !client.hasCredentials()) return;
    reconnectTimer = setInterval(() => void connectLoop(), 3e3);
  }
  async function loadPolicy() {
    try {
      const settings = await client.invoke("settings:get", null);
      applyPolicy(settings.remote?.viewOnly === true);
    } catch {
    }
  }
  async function showMirror() {
    if (!client.hasMirror()) {
      setConnection("desktop offline");
      return;
    }
    try {
      const index = await client.mirrorIndex();
      if (!index) {
        setConnection("desktop offline \u2014 no mirror uploaded yet");
        return;
      }
      mode = "mirror";
      sessions = index.sessions.map((s) => ({ id: s.id, title: s.title, status: s.status }));
      renderSessionList();
      setConnection(`offline \u2014 mirrored from ${index.hostName}`);
      updateWriteControls();
      const first = sessions[0]?.id;
      if (first) await openSession(first);
    } catch (e) {
      setConnection(`desktop offline \u2014 ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function refreshSessions() {
    mode = "live";
    try {
      sessions = await client.invoke("sessions:list", null);
      renderSessionList();
      updateWriteControls();
      const first = sessions[0]?.id;
      if (first) await openSession(first);
    } catch {
      await showMirror();
    }
  }
  async function openSession(id) {
    active = id;
    const meta = sessions.find((s) => s.id === id);
    if (mode === "mirror") {
      const snapshot = await client.mirrorSession(id);
      if (!snapshot || active !== id) return;
      renderTranscript(snapshot.items);
      activeStatus = snapshot.status;
      el("active-title").textContent = `${snapshot.title} \xB7 ${snapshot.status}${snapshot.truncated ? " \xB7 earlier history trimmed" : ""}`;
    } else {
      const items = await client.invoke("sessions:transcript", { id });
      if (active !== id) return;
      renderTranscript(items);
      activeStatus = meta?.status ?? "idle";
      el("active-title").textContent = meta ? `${meta.title} \xB7 ${activeStatus}` : "";
    }
    syncControls();
    for (const row of Array.from(document.querySelectorAll(".session-row"))) row.classList.toggle("active", row.dataset.id === id);
  }
  function isRunning(status) {
    return status === "running" || status === "starting" || status === "awaiting";
  }
  function syncControls() {
    const running = mode === "live" && !viewOnly && isRunning(activeStatus);
    el("act-interrupt").hidden = !running;
    el("act-stop").hidden = !running;
  }
  function applyPolicy(next) {
    viewOnly = next;
    updateWriteControls();
  }
  function updateWriteControls() {
    const readOnly = viewOnly || mode === "mirror";
    const badge = el("policy");
    badge.toggleAttribute("hidden", !readOnly);
    badge.textContent = mode === "mirror" ? "mirrored" : readOnly ? "view-only" : "";
    for (const id of ["composer", "send", "new-session"]) el(id).toggleAttribute("disabled", readOnly);
    syncControls();
    if (readOnly) el("new-session-panel").setAttribute("hidden", "");
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
    if (viewOnly || mode === "mirror") return `<div class="msg approval"><b>Approval needed</b><small> \u2014 decide on the desktop${mode === "mirror" ? " (mirrored history)" : " (view-only)"}</small></div>`;
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
    if (mode === "mirror") return;
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
