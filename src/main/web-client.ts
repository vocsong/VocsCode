/** The browser-side Transport implementation, served as /harness-client.js by the web
 *  server. Binds the same Transport contract the preload binds to ipcRenderer onto a
 *  WebSocket (docs/REMOTE-ACCESS.md). Plain JS, no build step, no template literals. */
export const HARNESS_CLIENT_JS = String.raw`(function () {
  'use strict';
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var url = protocol + '//' + window.location.host + '/harness?token=' + encodeURIComponent(token);
  var ws = null;
  var pending = new Map();
  var listeners = new Map();
  var queued = [];
  var nextId = 0;
  var backoffMs = 500;

  function deliver(channel, payload) {
    var set = listeners.get(channel);
    if (!set) return;
    set.forEach(function (fn) {
      try { fn(payload); } catch (e) { /* a listener error must not kill the bridge */ }
    });
  }

  function scheduleReconnect() {
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 8000);
  }

  function connect() {
    var socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    socket.onopen = function () {
      ws = socket;
      backoffMs = 500;
      var q = queued;
      queued = [];
      for (var i = 0; i < q.length; i++) socket.send(JSON.stringify(q[i]));
    };
    socket.onmessage = function (ev) {
      var frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'result') {
        var entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.ok) entry.resolve(frame.value);
        else entry.reject(new Error(frame.error || 'invoke failed'));
      } else if (frame.type === 'push') {
        deliver(frame.channel, frame.payload);
      }
    };
    socket.onclose = function () {
      if (ws === socket) ws = null;
      pending.forEach(function (entry) { entry.reject(new Error('harness connection closed')); });
      pending.clear();
      scheduleReconnect();
    };
  }

  connect();

  window.harness = {
    invoke: function (channel, request) {
      return new Promise(function (resolve, reject) {
        var id = ++nextId;
        pending.set(id, { resolve: resolve, reject: reject });
        var frame = { type: 'invoke', id: id, channel: channel, request: request === undefined ? null : request };
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
        else queued.push(frame);
      });
    },
    on: function (channel, listener) {
      var set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      return function () { set.delete(listener); };
    },
    platform: 'browser'
  };
})();`;