#!/usr/bin/env node
/**
 * The Mission mode tools' stdio MCP server: a dependency-free thin client of the app's Mission
 * gateway (src/main/mission-mode/gateway.ts).
 *
 * The app injects one copy into each session of a live mission, with the loopback endpoint in
 * `VOCS_MISSION_GATEWAY_URL` and the session's capability in `VOCS_MISSION_GATEWAY_TOKEN`.
 * `tools/list` posts to `/list` (the gateway answers with the tools of the token's role) and
 * `tools/call` to `/call`; nothing is decided here. A missing, invalid, denied or unavailable
 * gateway fails closed: no tools are listed and every call is a tool error. The token never
 * reaches stdout or stderr.
 */
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_RESPONSE_BYTES = 4_000_000;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isToolResult(result) {
  return isObject(result) && Object.keys(result).every((key) => key === 'content' || key === 'isError')
    && (result.isError === undefined || typeof result.isError === 'boolean')
    && Array.isArray(result.content) && result.content.every((item) => isObject(item) && item.type === 'text' && typeof item.text === 'string' && Object.keys(item).length === 2);
}

function isToolListing(tool) {
  return isObject(tool) && typeof tool.name === 'string' && typeof tool.description === 'string' && isObject(tool.inputSchema);
}

/** Throws on a configuration that is not a loopback endpoint plus a 43-character capability. */
export function createMissionClient({ url, token, timeoutMs = 90_000 }) {
  const port = typeof url === 'string' && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(url)?.[1];
  if (!port || Number(port) > 65535 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Invalid Mission gateway configuration.');
  }
  const post = async (path, payload, cancelled) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = cancelled ? AbortSignal.any([cancelled, timeout]) : timeout;
    const body = JSON.stringify(payload);
    // Do not follow redirects, use a proxy, or resolve a DNS name with a bearer.
    const response = await new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port, path, method: 'POST', agent: false, signal,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` }
      }, resolve);
      req.on('error', reject);
      req.end(body);
    });
    if (response.statusCode !== 200 || response.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
      response.destroy();
      return { denied: response.statusCode === 401 || response.statusCode === 403 };
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) return {};
      chunks.push(chunk);
    }
    return { payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  };
  return {
    async list() {
      try {
        const { payload } = await post('/list', {});
        const tools = payload?.tools;
        return Array.isArray(tools) && tools.every(isToolListing) ? tools : [];
      } catch {
        return [];
      }
    },
    async call(name, args, cancelled) {
      try {
        const { payload, denied } = await post('/call', { tool: name, arguments: args }, cancelled);
        if (denied) return errorResult('The Mission gateway denied this call: this session is no longer part of a live mission.');
        return isToolResult(payload?.result) ? payload.result : errorResult('The Mission gateway is unavailable. Restart the session to reconnect.');
      } catch {
        // Neither HTTP errors nor the endpoint belong in MCP diagnostics.
        return errorResult('The Mission gateway is unavailable. Restart the session to reconnect.');
      }
    }
  };
}

export async function runMissionServer({ input, output, gateway = null, log = () => {} } = {}) {
  if (!input || !output) throw new Error('runMissionServer: input and output streams are required');
  // An absent or invalid configuration still serves MCP, with no tools: the harness keeps its session.
  let client = null;
  try {
    if (gateway) client = createMissionClient(gateway);
  } catch {
    log('Invalid Mission gateway configuration.');
  }
  if (!client) log('No Mission gateway configured; serving no tools.');
  const token = typeof gateway?.token === 'string' && gateway.token ? gateway.token : null;
  const pending = new Map();
  let buffer = '';
  let closed = false;
  const write = (message) => {
    if (closed) return;
    try {
      const json = JSON.stringify(message);
      output.write(`${token ? json.replaceAll(token, '<redacted>') : json}\n`);
    } catch {
      /* the host is gone */
    }
  };
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (message) => {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === 'notifications/cancelled') pending.get(params?.requestId)?.abort();
      return; // Notifications (including a tool call with no request id) never dispatch a tool.
    }
    if ((typeof id !== 'string' && !Number.isFinite(id)) || pending.has(id)) return;
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vocs-mission', version: '1.0.0' },
        instructions: 'Mission mode coordination tools. Your role prompt says how and when to use them; the app runs every call.'
      });
      return;
    }
    if (method === 'ping') {
      respond(id, {});
      return;
    }
    if (method === 'tools/list') {
      const controller = new AbortController();
      pending.set(id, controller);
      try {
        const tools = client ? await client.list() : [];
        if (!controller.signal.aborted) respond(id, { tools });
      } finally {
        pending.delete(id);
      }
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments === undefined ? {} : params.arguments;
      if (typeof name !== 'string' || !isObject(args)) return respondError(id, -32602, 'Expected a tool name and an arguments object');
      const controller = new AbortController();
      pending.set(id, controller);
      try {
        const result = client ? await client.call(name, args, controller.signal) : errorResult('The Mission tools are not available in this session.');
        if (!controller.signal.aborted) respond(id, result);
      } catch {
        if (!controller.signal.aborted) respond(id, errorResult('The Mission gateway call failed.'));
      } finally {
        pending.delete(id);
      }
      return;
    }
    respondError(id, -32601, 'Method not found');
  };

  input.setEncoding?.('utf8');
  const onData = (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      void handle(message).catch(() => log('Mission MCP handler failed'));
    }
  };
  await new Promise((resolve) => {
    const finish = () => {
      closed = true;
      input.off('data', onData);
      input.off('end', finish);
      input.off('close', finish);
      for (const controller of pending.values()) controller.abort();
      resolve();
    };
    input.once('end', finish);
    input.once('close', finish);
    input.on('data', onData);
    if (input.readableEnded || input.destroyed) finish();
  });
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { VOCS_MISSION_GATEWAY_URL: url, VOCS_MISSION_GATEWAY_TOKEN: token } = process.env;
  // Nothing this process spawns (it spawns nothing today) may inherit the capability.
  delete process.env.VOCS_MISSION_GATEWAY_URL;
  delete process.env.VOCS_MISSION_GATEWAY_TOKEN;
  await runMissionServer({
    input: process.stdin,
    output: process.stdout,
    gateway: url !== undefined || token !== undefined ? { url, token } : null,
    log: (message) => console.error(`vocs-mission: ${message}`)
  });
}
