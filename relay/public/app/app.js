"use strict";
(() => {
  // src/shared/crypto.ts
  var subtle = globalThis.crypto.subtle;
  var enc = new TextEncoder();
  function publicOf(identity) {
    return { sig: identity.sig.pub, enc: identity.enc.pub };
  }
  async function generateKeyIdentity() {
    const sig = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const ecdh2 = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return {
      sig: { pub: await subtle.exportKey("jwk", sig.publicKey), priv: sig.privateKey },
      enc: { pub: await subtle.exportKey("jwk", ecdh2.publicKey), priv: ecdh2.privateKey }
    };
  }
  async function lockIdentity(identity) {
    return {
      sig: { pub: identity.sig.pub, priv: await subtle.importKey("jwk", identity.sig.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) },
      enc: { pub: identity.enc.pub, priv: await subtle.importKey("jwk", identity.enc.priv, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) }
    };
  }
  function isJwk(key) {
    return typeof key.kty === "string";
  }
  async function signingKey(priv) {
    return isJwk(priv) ? subtle.importKey("jwk", priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) : priv;
  }
  async function agreementKey(priv) {
    return isJwk(priv) ? subtle.importKey("jwk", priv, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) : priv;
  }
  function tokenProofPayload(deviceId, challenge) {
    return ["relay.token", deviceId, challenge];
  }
  function pairingTokenContext(code, webDeviceId) {
    return ["relay.pair-token", code, webDeviceId];
  }
  async function sign(identity, data) {
    const key = await signingKey(identity.sig.priv);
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
  async function ecdh(privKey, peerPubJwk) {
    const priv = await agreementKey(privKey);
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
  async function sealingKey(shared, ephPub, recipientPub) {
    const salt = await subtle.digest("SHA-256", enc.encode(stable([ephPub, recipientPub])));
    const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("vocs-remote/sealed-to-key/v1") },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
  async function openSealedToKey(recipient, sealed, context) {
    const key = await sealingKey(await ecdh(recipient.priv, sealed.eph), sealed.eph, recipient.pub);
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: fromB64Url(sealed.iv), additionalData: canonical(context), tagLength: 128 }, key, fromB64Url(sealed.ct));
    return new TextDecoder().decode(pt);
  }

  // relay/src/web-client.ts
  var LEGACY_CREDENTIALS_KEY = "vocs-web-credentials";
  function relayBaseFor(origin, override) {
    return (override?.trim() || origin).replace(/\/$/, "");
  }
  var ACCESS_REFRESH_MARGIN_MS = 6e4;
  var PairingRevokedError = class extends Error {
    constructor(hostName) {
      super("this browser is no longer paired");
      this.hostName = hostName;
    }
  };
  var RelayClient = class {
    constructor(deps) {
      this.deps = deps;
    }
    list = [];
    /** The active pairing. */
    creds = null;
    socket = null;
    session = null;
    nextId = 0;
    outCounter = 0;
    pending = /* @__PURE__ */ new Map();
    pushListeners = /* @__PURE__ */ new Set();
    changeListeners = /* @__PURE__ */ new Set();
    hsWaiter = null;
    mirrorCache = null;
    /** Sealed frames that arrive while the handshake reply is still being finished. */
    earlyFrames = [];
    connectAttempt = 0;
    /** Short-lived relay access tokens (§6.2) per web device, in memory only. */
    access = /* @__PURE__ */ new Map();
    refreshing = /* @__PURE__ */ new Map();
    hasCredentials() {
      return this.list.length > 0;
    }
    /** Every pairing this browser holds, oldest first. */
    pairings() {
      return [...this.list];
    }
    /** The active pairing. */
    credentials() {
      return this.creds;
    }
    /** Called whenever the set of pairings or the active one changes. */
    onPairingsChanged(listener) {
      this.changeListeners.add(listener);
      return () => this.changeListeners.delete(listener);
    }
    /** Loads the vault, migrating a pairing left in legacy storage. True when any pairing exists. */
    async restore() {
      let state = await this.deps.vault.load();
      if (!state?.pairings.length) state = await this.migrateLegacy() ?? state;
      this.list = state?.pairings ?? [];
      this.creds = this.list.find((p) => p.hostDeviceId === state?.active) ?? this.list[0] ?? null;
      return !!this.creds;
    }
    /** A pairing stored by an older page as extractable JWKs in localStorage: re-import the keys as
     *  non-extractable, keep them in the vault, and delete the exportable copy. */
    async migrateLegacy() {
      const legacy = this.deps.legacy;
      const raw = legacy?.get(LEGACY_CREDENTIALS_KEY);
      if (!legacy || !raw) return null;
      let old;
      try {
        old = JSON.parse(raw);
        if (!old.webDeviceId || !old.hostDeviceId || !old.identity?.sig?.priv) throw new Error("incomplete");
      } catch {
        legacy.remove(LEGACY_CREDENTIALS_KEY);
        return null;
      }
      const migrated = { ...old, identity: await lockIdentity(old.identity), hostName: old.hostName ?? "Computer" };
      const state = { pairings: [migrated], active: migrated.hostDeviceId };
      await this.deps.vault.save(state);
      legacy.remove(LEGACY_CREDENTIALS_KEY);
      return state;
    }
    async persist() {
      await this.deps.vault.save({ pairings: this.list, active: this.creds?.hostDeviceId });
      for (const listener of [...this.changeListeners]) listener();
    }
    /** Makes another pairing active. The caller reconnects. */
    async select(hostDeviceId) {
      const next = this.list.find((p) => p.hostDeviceId === hostDeviceId);
      if (!next || next === this.creds) return;
      this.disconnect();
      this.creds = next;
      this.mirrorCache = null;
      await this.persist();
    }
    disconnect() {
      this.connectAttempt++;
      this.socket?.close();
      this.socket = null;
      this.session = null;
      this.earlyFrames = [];
    }
    /** Forgets every pairing locally, without telling the relay (tests and a full reset). */
    async logout() {
      this.disconnect();
      this.list = [];
      this.creds = null;
      this.access.clear();
      this.deps.legacy?.remove(LEGACY_CREDENTIALS_KEY);
      await this.deps.vault.clear();
      for (const listener of [...this.changeListeners]) listener();
    }
    /** Unpairs the active computer: revokes this browser's device at the relay, then forgets the
     *  pairing locally. A relay that is unreachable or already forgot the device does not keep a
     *  local copy alive. */
    async unpair() {
      const pairing = this.creds;
      if (!pairing) return;
      try {
        await this.revokeDevice(pairing.webDeviceId);
      } catch {
      }
      await this.forget([pairing]);
    }
    async forget(pairings) {
      if (!pairings.length) return;
      if (this.creds && pairings.includes(this.creds)) {
        this.disconnect();
        this.creds = null;
        this.mirrorCache = null;
      }
      for (const p of pairings) this.access.delete(p.webDeviceId);
      this.list = this.list.filter((p) => !pairings.includes(p));
      this.creds ??= this.list[0] ?? null;
      await this.persist();
    }
    /** Enters a pairing code, claims it with a fresh identity, polls until the desktop approves.
     *  The new pairing is added and made active. */
    async pair(input) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const base = input.relayBase.replace(/\/$/, "");
      const code = input.code.trim().toUpperCase();
      const identity = await (this.deps.newIdentity ?? generateKeyIdentity)();
      const claim = await doFetch(`${base}/v1/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, webPub: publicOf(identity), name: input.deviceName })
      });
      if (claim.status === 409) throw new Error("this account already has the maximum number of paired browsers; revoke one first");
      if (!claim.ok) throw new Error(`claim failed: ${claim.status}`);
      const { pollToken } = await claim.json();
      if (typeof pollToken !== "string" || !pollToken) throw new Error("claim did not return a poll capability");
      return this.awaitApproval(base, code, pollToken, identity);
    }
    // --- Signed-in owner (the landing's GitHub session; the landing adds the relay credential) ---
    /** The computers of this account, with presence. */
    async ownerHosts(relayBase) {
      const response = await this.ownerFetch(relayBase, "/v1/owner/hosts");
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("the relay returned no computer list");
      return body.filter((h) => !!h && typeof h === "object" && typeof h.deviceId === "string" && typeof h.name === "string");
    }
    /** Adds the computer that clicked Connect with GitHub, known here only by its connect hash. */
    async addComputer(relayBase, nonceHash) {
      await this.ownerFetch(relayBase, "/v1/owner/enroll-grant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonceHash }) });
    }
    /** Whether that computer has collected its credential yet, and its device id once it has. */
    async addedComputer(relayBase, nonceHash) {
      const response = await this.ownerFetch(relayBase, `/v1/owner/enroll-grant?h=${encodeURIComponent(nonceHash)}`);
      return await response.json();
    }
    /** Asks a registered, online computer to pair this browser: no code to carry. The computer still
     *  shows the request and the user clicks Allow there; then this completes like a code pairing. */
    async pairWithHost(input) {
      const base = input.relayBase.replace(/\/$/, "");
      const identity = await (this.deps.newIdentity ?? generateKeyIdentity)();
      const response = await this.ownerFetch(base, "/v1/owner/pair-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostDeviceId: input.hostDeviceId, webPub: publicOf(identity), name: input.deviceName })
      });
      const { code, pollToken } = await response.json();
      if (typeof code !== "string" || typeof pollToken !== "string" || !pollToken) throw new Error("pairing request did not return a poll capability");
      return this.awaitApproval(base, code, pollToken, identity);
    }
    /** An owner request. It is same-origin, so the browser's default credentials mode already sends
     *  the landing its session cookie; the landing replaces any Authorization with the relay
     *  credential, so none is sent from here. */
    async ownerFetch(relayBase, path, init = {}) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const response = await doFetch(`${relayBase.replace(/\/$/, "")}${path}`, init);
      if (response.ok) return response;
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error("sign in with GitHub first");
      if (response.status === 503) throw new Error("signing in is not available on this relay yet; use a pairing code");
      if (response.status === 409 && body.error === "host-offline") throw new Error("that computer is offline: open Vocs Code on it, then try again");
      if (response.status === 409) throw new Error("this account already has the maximum number of paired devices; revoke one first");
      throw new Error(`request failed: ${response.status}`);
    }
    /** Polls a claimed pairing until the desktop decides, then stores the new pairing. */
    async awaitApproval(base, code, pollToken, identity) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const now = this.deps.now ?? Date.now;
      const deadline = now() + 5 * 6e4;
      for (; ; ) {
        if (now() >= deadline) throw new Error("pairing timed out");
        await new Promise((r) => setTimeout(r, 1200));
        const response = await doFetch(`${base}/v1/pair/poll?code=${encodeURIComponent(code)}`, { headers: { authorization: `Bearer ${pollToken}` } });
        if (!response.ok) throw new Error(`poll failed: ${response.status}`);
        const poll = await response.json();
        if (poll.status === "approved") {
          const webToken = await openSealedToKey(identity.enc, poll.sealedToken, pairingTokenContext(code, poll.webDeviceId));
          const pairing = { relayBase: base, webToken, webDeviceId: poll.webDeviceId, hostDeviceId: poll.hostDeviceId, hostName: poll.hostName ?? "Computer", hostPub: poll.hostPub, identity, pairedAt: now() };
          const previous = this.list.filter((p) => p.hostDeviceId === pairing.hostDeviceId && p.relayBase === base);
          for (const old of previous) await this.revokeWith(old, old.webDeviceId).catch(() => void 0);
          this.disconnect();
          this.list = [...this.list.filter((p) => !previous.includes(p)), pairing];
          this.creds = pairing;
          this.mirrorCache = null;
          await this.persist();
          return pairing;
        }
        if (poll.status === "denied") throw new Error("pairing denied on the desktop");
        if (poll.status === "expired") throw new Error("pairing code expired");
      }
    }
    /** Opens the relay socket and performs the e2e handshake with the active computer. */
    async connect(onClose) {
      const creds = this.creds;
      if (!creds) throw new Error("not paired");
      this.disconnect();
      const attempt = this.connectAttempt;
      const base = creds.relayBase.replace(/\/$/, "");
      const response = await this.relayFetch(creds, "/v1/ws/ticket", { method: "POST" });
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
        if (this.creds.mirrorKey !== inner.key) {
          this.creds.mirrorKey = inner.key;
          await this.persist();
        }
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
    /** A short-lived access token for a pairing, refreshed a minute before expiry (§6.2).
     *  Concurrent callers share one refresh. */
    async accessToken(creds) {
      const cached = this.access.get(creds.webDeviceId);
      if (cached && cached.expiresAt - (this.deps.now ?? Date.now)() > ACCESS_REFRESH_MARGIN_MS) return cached.token;
      let running = this.refreshing.get(creds.webDeviceId);
      if (!running) {
        running = this.refreshAccess(creds).finally(() => this.refreshing.delete(creds.webDeviceId));
        this.refreshing.set(creds.webDeviceId, running);
      }
      return running;
    }
    /** Proof of possession: the refresh credential buys a one-time challenge, this browser's
     *  device key signs it, and only that signature buys an access token. A pairing the relay no
     *  longer knows is forgotten. */
    async refreshAccess(creds) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const base = creds.relayBase.replace(/\/$/, "");
      const query = `?device=${encodeURIComponent(creds.webDeviceId)}`;
      const challengeRes = await doFetch(`${base}/v1/token/challenge${query}`, { method: "POST", headers: { authorization: `Bearer ${creds.webToken}` } });
      if (challengeRes.status === 401) {
        await this.forget(this.list.filter((p) => p === creds));
        throw new PairingRevokedError(creds.hostName ?? "Computer");
      }
      if (!challengeRes.ok) throw new Error(`token challenge failed: ${challengeRes.status}`);
      const { challenge } = await challengeRes.json();
      if (typeof challenge !== "string" || !challenge) throw new Error("relay returned no token challenge");
      const signature = await sign(creds.identity, tokenProofPayload(creds.webDeviceId, challenge));
      const tokenRes = await doFetch(`${base}/v1/token${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${creds.webToken}`, "content-type": "application/json" },
        body: JSON.stringify({ challenge, signature })
      });
      if (!tokenRes.ok) throw new Error(`token request failed: ${tokenRes.status}`);
      const body = await tokenRes.json();
      if (typeof body.accessToken !== "string" || typeof body.expiresAt !== "number") throw new Error("relay returned no access token");
      this.access.set(creds.webDeviceId, { token: body.accessToken, expiresAt: body.expiresAt });
      return body.accessToken;
    }
    /** An authenticated relay REST call as one pairing's device. A 401 means the access token
     *  expired or was dropped: prove possession once more and retry, then report what the relay says. */
    async relayFetch(creds, path, init = {}) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const url = `${creds.relayBase.replace(/\/$/, "")}${path}${path.includes("?") ? "&" : "?"}device=${encodeURIComponent(creds.webDeviceId)}`;
      for (let attempt = 0; ; attempt++) {
        const token = await this.accessToken(creds);
        const res = await doFetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
        if (res.status !== 401 || attempt > 0) return res;
        if (this.access.get(creds.webDeviceId)?.token === token) this.access.delete(creds.webDeviceId);
      }
    }
    /** Lists every device paired with the account (P4 device management), with live presence. */
    async listDevices() {
      if (!this.creds) return [];
      const res = await this.relayFetch(this.creds, "/v1/devices");
      if (!res.ok) throw new Error(`devices failed: ${res.status}`);
      return await res.json();
    }
    /** Revokes any paired device — another browser, a computer, or this browser itself. Local
     *  pairings the revocation ended (this browser's, or ones through a revoked computer) go too. */
    async revokeDevice(deviceId) {
      if (!this.creds) return;
      const revoked = await this.revokeWith(this.creds, deviceId);
      await this.forget(this.list.filter((p) => revoked.includes(p.webDeviceId) || revoked.includes(p.hostDeviceId)));
    }
    async revokeWith(creds, deviceId) {
      const res = await this.relayFetch(creds, `/v1/devices?target=${encodeURIComponent(deviceId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`revoke failed: ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return Array.isArray(body.revoked) ? body.revoked.map(String) : [deviceId];
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
      const res = await this.relayFetch(this.creds, `${path}?host=${encodeURIComponent(this.creds.hostDeviceId)}`);
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

  // src/shared/pairing.ts
  var PAIRING_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
  var CONNECT_HASH_PATTERN = /^[0-9a-f]{64}$/;
  function connectCheckCode(nonceHash) {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 8; i++) code += alphabet[parseInt(nonceHash.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  // relay/src/page.ts
  function indexedDbVault() {
    const open = () => new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = indexedDB.open("vocs-code-remote", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("vault");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    const run = async (mode2, work) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("vault", mode2);
        const request = work(tx.objectStore("vault"));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction failed"));
        };
      });
    };
    return {
      load: async () => await run("readonly", (store) => store.get("state")) ?? null,
      save: async (state) => {
        await run("readwrite", (store) => store.put(state, "state"));
      },
      clear: async () => {
        await run("readwrite", (store) => store.delete("state"));
      }
    };
  }
  function localStorageApi() {
    return {
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
      remove: (k) => window.localStorage.removeItem(k)
    };
  }
  var client = new RelayClient({ vault: indexedDbVault(), legacy: localStorageApi() });
  var sessions = [];
  var active = null;
  var activeStatus = "idle";
  var viewOnly = false;
  var mode = "live";
  var reconnectTimer = null;
  var presenceTimer = null;
  var connecting = false;
  var online = /* @__PURE__ */ new Map();
  var accountReady = Promise.resolve(false);
  var PAGE = 150;
  var windowStart = 0;
  var windowItems = [];
  var refreshing = null;
  var refreshAgain = false;
  var terminalOpen = false;
  var terminalTimer = null;
  var terminalBusy = false;
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
  function notice(text) {
    const box = el("notice");
    box.textContent = text;
    box.hidden = !text;
  }
  async function boot() {
    const params = new URLSearchParams(window.location.search);
    let connectHash = null;
    if (params.has("connect")) {
      const hashes = params.getAll("connect");
      if (hashes.length === 1 && CONNECT_HASH_PATTERN.test(hashes[0] ?? "")) connectHash = hashes[0];
      params.delete("connect");
      const search = params.toString();
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    }
    if (params.has("code")) {
      const codes = params.getAll("code");
      const code = codes[0]?.trim().toUpperCase() ?? "";
      if (codes.length === 1 && PAIRING_CODE_PATTERN.test(code)) {
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
    el("pair-cancel").addEventListener("click", () => {
      if (client.hasCredentials()) show("screen-app");
    });
    el("add-host").addEventListener("click", () => openPairScreen());
    el("host-select").addEventListener("change", (ev) => void switchHost(ev.target.value));
    el("logout").addEventListener("click", () => void unpairActive());
    el("new-session").addEventListener("click", () => void toggleNewSession(true));
    el("ns-cancel").addEventListener("click", () => void toggleNewSession(false));
    el("ns-create").addEventListener("click", () => void createSession());
    el("devices").addEventListener("click", () => void toggleDevices());
    el("devices-close").addEventListener("click", () => el("devices-panel").setAttribute("hidden", ""));
    el("load-earlier").addEventListener("click", () => void loadEarlier());
    el("send").addEventListener("click", () => void sendComposer());
    el("act-interrupt").addEventListener("click", () => void actOnActive("sessions:interrupt", null));
    el("act-stop").addEventListener("click", () => void actOnActive("sessions:stop", null));
    el("act-terminal").addEventListener("click", () => void toggleTerminal());
    el("terminal-select").addEventListener("change", () => void pollTerminal());
    const composer = el("composer");
    composer.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void sendComposer();
      }
    });
    el("connect-cancel").addEventListener("click", () => client.hasCredentials() ? void enter() : openPairScreen());
    client.onPush((channel, payload) => void onPush(channel, payload));
    client.onPairingsChanged(() => renderHosts());
    accountReady = loadAccount();
    let restored = false;
    try {
      restored = await client.restore();
    } catch {
      el("pair-error").textContent = "This browser cannot store pairing keys securely (IndexedDB is unavailable, for example in some private windows). Use a regular window to pair.";
      el("pair-form").querySelector('button[type="submit"]').disabled = true;
      show("screen-pair");
      return;
    }
    if (connectHash) {
      if (await accountReady) {
        openConnectScreen(connectHash);
        return;
      }
      el("pair-error").textContent = "This page was opened to add a computer, but signing in is not available here. Use a pairing code instead.";
    }
    if (restored) void enter();
    else openPairScreen();
  }
  function openConnectScreen(connectHash) {
    el("connect-code").textContent = connectCheckCode(connectHash);
    el("connect-status").textContent = "";
    el("connect-error").textContent = "";
    const add = el("connect-add");
    add.disabled = false;
    add.onclick = () => void addThisComputer(connectHash);
    show("screen-connect");
  }
  async function addThisComputer(connectHash) {
    const add = el("connect-add");
    const status = el("connect-status");
    add.disabled = true;
    el("connect-error").textContent = "";
    const base = relayBaseFor(window.location.origin, relayOverride());
    try {
      status.textContent = "Adding the computer\u2026";
      await client.addComputer(base, connectHash);
      status.textContent = "Waiting for the computer to finish connecting\u2026";
      let added = { status: "granted" };
      for (let i = 0; i < 90 && added.status !== "redeemed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1e3));
        added = await client.addedComputer(base, connectHash);
        if (added.status === "missing") throw new Error("the request expired; click Connect with GitHub in Vocs Code again");
      }
      if (added.status !== "redeemed" || !added.hostDeviceId) throw new Error("the computer did not finish connecting; is Vocs Code still open on it?");
      status.textContent = "Added. Waiting for the computer to come online\u2026";
      for (let i = 0; i < 30; i++) {
        const hosts = await client.ownerHosts(base).catch(() => []);
        if (hosts.some((host) => host.deviceId === added.hostDeviceId && host.online)) break;
        await new Promise((resolve) => setTimeout(resolve, 1e3));
      }
      status.textContent = "Now click Allow in Vocs Code on the computer to pair this browser.";
      const name = el("connect-device-name").value.trim() || "Browser";
      await pairThroughAccount(added.hostDeviceId, name);
    } catch (e) {
      el("connect-error").textContent = e instanceof Error ? e.message : String(e);
      add.disabled = false;
      status.textContent = "";
    }
  }
  async function pairThroughAccount(hostDeviceId, name) {
    show("screen-pairing");
    try {
      await client.pairWithHost({ relayBase: relayBaseFor(window.location.origin, relayOverride()), hostDeviceId, deviceName: name });
      notice("");
      resetView();
      await enter();
    } catch (e) {
      el("pair-error").textContent = e instanceof Error ? e.message : String(e);
      openPairScreen();
    }
  }
  async function renderOwnerHosts() {
    const box = el("owner-hosts");
    if (!await accountReady) return;
    let hosts;
    try {
      hosts = await client.ownerHosts(relayBaseFor(window.location.origin, relayOverride()));
    } catch {
      box.hidden = true;
      return;
    }
    const paired = new Set(client.pairings().map((p) => p.hostDeviceId));
    const list = el("owner-host-list");
    list.replaceChildren(
      ...hosts.map((host) => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = host.name;
        const state = document.createElement("span");
        state.className = "muted";
        state.textContent = paired.has(host.deviceId) ? " \xB7 paired" : host.online ? " \xB7 online" : " \xB7 offline";
        label.append(state);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ghost";
        button.dataset.host = host.deviceId;
        button.textContent = paired.has(host.deviceId) ? "Open" : "Pair";
        button.disabled = !paired.has(host.deviceId) && !host.online;
        button.title = button.disabled ? "Open Vocs Code on that computer first" : "";
        button.addEventListener("click", () => {
          if (paired.has(host.deviceId)) {
            void (async () => {
              await client.select(host.deviceId);
              resetView();
              await enter();
            })();
          } else void pairThroughAccount(host.deviceId, el("device-name").value.trim() || "Browser");
        });
        item.append(label, button);
        return item;
      })
    );
    el("owner-hosts-empty").hidden = hosts.length > 0;
    box.hidden = false;
  }
  async function loadAccount() {
    try {
      const res = await fetch("/v1/me", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return false;
      const body = await res.json();
      if (typeof body.login !== "string" || !body.login) return false;
      for (const form of document.querySelectorAll(".account-signout")) {
        const label = form.querySelector(".account-name");
        if (label) label.textContent = `@${body.login}`;
        form.hidden = false;
      }
      return true;
    } catch {
      return false;
    }
  }
  function openPairScreen() {
    el("pair-cancel").toggleAttribute("hidden", !client.hasCredentials());
    el("pair-title").textContent = client.hasCredentials() ? "Add a computer" : "Vocs Code";
    show("screen-pair");
    void renderOwnerHosts();
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
    el("pair-error").textContent = "";
    show("screen-pairing");
    try {
      await client.pair({ relayBase: relayBaseFor(window.location.origin, relayOverride()), code, deviceName: name });
      el("code").value = "";
      notice("");
      resetView();
      await enter();
    } catch (e) {
      el("pair-error").textContent = e instanceof Error ? e.message : String(e);
      openPairScreen();
    }
  }
  function relayOverride() {
    return new URLSearchParams(window.location.search).get("relay");
  }
  async function enter() {
    show("screen-app");
    renderHosts();
    presenceTimer ??= setInterval(() => void refreshPresence(), 15e3);
    void refreshPresence();
    await connectLoop(true);
  }
  function renderHosts() {
    const select = el("host-select");
    const current = client.credentials();
    select.innerHTML = client.pairings().map((p) => {
      const state = online.has(p.hostDeviceId) ? online.get(p.hostDeviceId) ? "online" : "offline" : "\u2026";
      return `<option value="${esc(p.hostDeviceId)}"${p === current ? " selected" : ""}>${esc(p.hostName ?? "Computer")} \xB7 ${state}</option>`;
    }).join("");
    select.disabled = client.pairings().length < 2;
  }
  async function refreshPresence() {
    if (!client.hasCredentials()) return;
    try {
      const devices = await client.listDevices();
      online = new Map(devices.filter((d) => d.kind === "host").map((d) => [d.deviceId, d.online === true]));
      for (const p of client.pairings()) if (!online.has(p.hostDeviceId)) online.set(p.hostDeviceId, false);
      renderHosts();
    } catch (e) {
      if (e instanceof PairingRevokedError) await pairingEnded(e);
    }
  }
  async function switchHost(hostDeviceId) {
    if (hostDeviceId === client.credentials()?.hostDeviceId) return;
    await client.select(hostDeviceId);
    resetView();
    await connectLoop(true);
  }
  function resetView() {
    closeTerminal();
    sessions = [];
    active = null;
    mode = "live";
    windowItems = [];
    windowStart = 0;
    renderSessionList();
    renderTranscript();
    el("active-title").textContent = "";
  }
  async function unpairActive() {
    const current = client.credentials();
    if (!current) return;
    await client.unpair();
    notice(`Unpaired from ${current.hostName ?? "the computer"}.`);
    await afterPairingRemoved();
  }
  async function pairingEnded(e) {
    notice(`This browser is no longer paired with ${e.hostName}. Pair again from the desktop if you still need it.`);
    await afterPairingRemoved();
  }
  async function afterPairingRemoved() {
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
  async function connectLoop(force = false) {
    if (connecting && !force || !client.hasCredentials()) return;
    connecting = true;
    const target = client.credentials();
    setConnection("connecting\u2026");
    try {
      await client.connect(() => {
        setConnection("reconnecting\u2026");
        scheduleReconnect();
      });
    } catch (e) {
      connecting = false;
      if (e instanceof PairingRevokedError) {
        await pairingEnded(e);
        return;
      }
      if (client.credentials() !== target) return;
      await showMirror();
      scheduleReconnect();
      return;
    }
    connecting = false;
    if (client.credentials() !== target) return;
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
      const message = e instanceof Error && e.name === "OperationError" ? "the mirror was re-keyed; connect once while the desktop is online" : e instanceof Error ? e.message : String(e);
      setConnection(`desktop offline \u2014 ${message}`);
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
      windowItems = snapshot.items;
      windowStart = 0;
      renderTranscript(true);
      activeStatus = snapshot.status;
      el("active-title").textContent = `${snapshot.title} \xB7 ${snapshot.status}${snapshot.truncated ? " \xB7 earlier history trimmed" : ""}`;
    } else {
      const page = await client.invoke("sessions:transcriptPage", { id, limit: PAGE });
      if (active !== id) return;
      windowItems = page.items;
      windowStart = page.start;
      renderTranscript(true);
      activeStatus = meta?.status ?? "idle";
      el("active-title").textContent = meta ? `${meta.title} \xB7 ${activeStatus}` : "";
    }
    syncControls();
    if (terminalOpen) void refreshTerminals();
    for (const row of Array.from(document.querySelectorAll(".session-row"))) row.classList.toggle("active", row.dataset.id === id);
  }
  async function toggleTerminal() {
    if (terminalOpen) {
      closeTerminal();
      return;
    }
    terminalOpen = true;
    el("terminal-panel").hidden = false;
    await refreshTerminals();
  }
  function closeTerminal() {
    terminalOpen = false;
    el("terminal-panel").hidden = true;
    if (terminalTimer) clearInterval(terminalTimer);
    terminalTimer = null;
  }
  async function refreshTerminals() {
    const id = active;
    if (!terminalOpen || !id || mode !== "live") return closeTerminal();
    const screen = el("terminal-screen");
    let mine;
    try {
      mine = (await client.invoke("terminal:list", null)).filter((t) => t.sessionId === id);
    } catch {
      screen.textContent = "This computer does not share terminals yet. Update Vocs Code on it.";
      return;
    }
    if (active !== id || !terminalOpen) return;
    const select = el("terminal-select");
    const previous = select.value;
    select.innerHTML = mine.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}${t.exit ? " (exited)" : ""}</option>`).join("");
    if (mine.some((t) => t.id === previous)) select.value = previous;
    if (!mine.length) {
      screen.textContent = "No terminal is open for this session on the desktop.";
      return;
    }
    terminalTimer ??= setInterval(() => void pollTerminal(), 1e3);
    await pollTerminal();
  }
  async function pollTerminal() {
    const terminalId = el("terminal-select").value;
    if (!terminalOpen || !terminalId || mode !== "live" || terminalBusy) return;
    terminalBusy = true;
    try {
      const view = await client.invoke("terminal:screen", { terminalId, lines: 200 });
      if (!terminalOpen || el("terminal-select").value !== terminalId) return;
      const screen = el("terminal-screen");
      const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
      screen.textContent = view.lines.join("\n");
      if (atBottom) screen.scrollTop = screen.scrollHeight;
    } catch {
    } finally {
      terminalBusy = false;
    }
  }
  function refreshTranscript() {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        const id = active;
        if (!id || mode !== "live") break;
        try {
          const page = await client.invoke("sessions:transcriptPage", { id, start: windowStart });
          if (active !== id || mode !== "live") break;
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
  async function loadEarlier() {
    const id = active;
    if (!id || mode !== "live" || windowStart === 0) return;
    const page = await client.invoke("sessions:transcriptPage", { id, start: Math.max(0, windowStart - PAGE), end: windowStart });
    if (active !== id) return;
    windowItems = [...page.items, ...windowItems];
    windowStart = page.start;
    renderTranscript(false, true);
  }
  function isRunning(status) {
    return status === "running" || status === "starting" || status === "awaiting";
  }
  function syncControls() {
    const running = mode === "live" && !viewOnly && isRunning(activeStatus);
    el("act-interrupt").hidden = !running;
    el("act-stop").hidden = !running;
    el("act-terminal").hidden = mode !== "live" || !active;
    if (mode !== "live" && terminalOpen) closeTerminal();
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
  function renderTranscript(jumpToEnd = false, keepOffset = false) {
    const root = el("transcript");
    const atBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 40;
    const fromBottom = root.scrollHeight - root.scrollTop;
    const earlier = el("load-earlier");
    earlier.hidden = mode !== "live" || windowStart === 0;
    earlier.textContent = `Load earlier messages (${windowStart})`;
    root.innerHTML = windowItems.map((i) => {
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
    if (keepOffset) root.scrollTop = root.scrollHeight - fromBottom;
    else if (jumpToEnd || atBottom) root.scrollTop = root.scrollHeight;
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
      const own = client.credentials()?.webDeviceId;
      list.innerHTML = devices.map((d) => deviceRow(d, d.deviceId === own)).join("");
    } catch (e) {
      if (e instanceof PairingRevokedError) {
        await pairingEnded(e);
        return;
      }
      el("devices-error").textContent = e instanceof Error ? e.message : String(e);
    }
  }
  function deviceRow(d, self) {
    const what = d.kind === "host" ? "Computer" : "Browser";
    const state = d.online ? "online now" : `last seen ${new Date(d.lastSeen).toLocaleString()}`;
    return `<div class="device-row"><span>${esc(what)}: ${esc(d.name)}${self ? ' <small class="muted">(this browser)</small>' : ""}<br><small class="muted">${esc(d.platform)} \xB7 ${esc(state)}</small></span><button class="danger" data-revoke="${esc(d.deviceId)}">Revoke</button></div>`;
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
        await refreshTranscript();
      }
      return;
    }
    if (channel === "push:sessionsChanged") {
      sessions = payload ?? sessions;
      renderSessionList();
      if (active) await refreshTranscript();
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
      const before = client.pairings().length;
      void client.revokeDevice(revoke.dataset.revoke).then(async () => {
        if (client.pairings().length < before) await afterPairingRemoved();
        else await refreshDevices();
      }).catch((e) => {
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
  void boot();
})();
