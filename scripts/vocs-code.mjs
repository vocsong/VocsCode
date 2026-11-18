import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { controlIdSchema, controlParams } from '../src/shared/control.ts';
import {
  decodeLocalControlTarget, localControlReplySchema, LOCAL_CONTROL_VERSION,
  LOCAL_CONTROL_REQUEST_BYTES, LOCAL_CONTROL_REPLY_BYTES, LOCAL_CONTROL_METHODS,
} from '../src/shared/local-control.ts';

const HELP = `Vocs Code local control (Windows source checkout; Node 22.23+)

  node scripts/vocs-code.mjs --target <value> status [--json]
  node scripts/vocs-code.mjs --target <value> projects list [--offset N] [--limit N] [--json]
  node scripts/vocs-code.mjs --target <value> sessions list --project <handle> [--offset N] [--limit N] [--json]
  node scripts/vocs-code.mjs --target <value> mcp serve --stdio
  node scripts/vocs-code.mjs --help

Copy the target from the intended running desktop. Use a handle from projects list for --project.
Exit codes: 0 success, 2 invalid input, 3 denied, 4 unavailable, 5 incompatible, 1 other.
`;
const errors = {
  invalid_request: [2, 'Invalid arguments. See --help.'],
  denied: [3, 'Access denied or the desktop does not match the target.'],
  unavailable: [4, 'Local control is unavailable. Check that the desktop and its local grant are active.'],
  incompatible: [5, 'Incompatible local control version.'],
  busy: [1, 'Local control is busy.'],
  conflict: [1, 'Local control reported a conflict.'],
  expired: [1, 'The request expired.'],
  storage_unavailable: [1, 'Local control storage is unavailable.'],
  unknown: [1, 'Local control failed.'],
};

class CliError extends Error {
  constructor(code, message = errors[code][1]) {
    super(message);
    this.code = code;
  }
}

const toolInputs = {
  capabilities: controlParams.capabilities,
  'projects.list': controlParams['projects.list'].omit({ instanceId: true }),
  'sessions.list': controlParams['sessions.list'].omit({ instanceId: true }),
};
const page = (item) => z.strictObject({
  items: z.array(item).max(100),
  nextOffset: z.number().int().min(1).max(1_000_100).nullable(),
});
// Match the local v1 projection, not the broader remote DTOs. Never print unexpected fields.
const resultSchemas = {
  capabilities: z.strictObject({
    version: z.number().int().positive(), instanceId: z.uuid(),
    methods: z.array(z.enum(LOCAL_CONTROL_METHODS)).max(LOCAL_CONTROL_METHODS.length),
  }),
  'projects.list': page(z.strictObject({ id: controlIdSchema, name: z.string().min(1).max(255) })),
  'sessions.list': page(z.strictObject({
    id: controlIdSchema, title: z.string().max(160),
    status: z.string().max(32).regex(/^[a-z][a-z-]*$/),
    harness: z.string().max(32).regex(/^[a-z][a-z-]*$/),
  })),
};
const toolDescriptions = {
  capabilities: 'Report the read-only capabilities of the explicitly selected Vocs Code desktop.',
  'projects.list': 'List the projects authorized by the desktop’s local grant.',
  'sessions.list': 'List ordinary session metadata for one authorized project handle (projectId).',
};

function parseArgs(args) {
  if (args.length === 1 && ['--help', 'help'].includes(args[0])) return { kind: 'help' };
  if (args[0] !== '--target' || !args[1]) {
    throw new CliError('invalid_request', 'Pass --target <value> first. See --help.');
  }
  let target;
  try { target = decodeLocalControlTarget(args[1]); } catch {
    throw new CliError('invalid_request', 'Invalid local target. Copy it from the intended desktop.');
  }
  const command = args[2];
  if (command === 'mcp' && args[3] === 'serve' && args[4] === '--stdio' && args.length === 5) {
    return { kind: 'mcp', target };
  }
  let method;
  let flagsAt;
  if (command === 'status') {
    method = 'capabilities';
    flagsAt = 3;
  } else if ((command === 'projects' || command === 'sessions') && args[3] === 'list') {
    method = `${command}.list`;
    flagsAt = 4;
  } else {
    throw new CliError('invalid_request');
  }
  const seen = new Set();
  const params = {};
  for (let i = flagsAt; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new CliError('invalid_request');
    seen.add(flag);
    if (flag === '--json') continue;
    if (method === 'sessions.list' && flag === '--project') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new CliError('invalid_request');
      params.projectId = value;
    } else if (method !== 'capabilities' && (flag === '--offset' || flag === '--limit')) {
      const value = args[++i];
      if (!value || !/^(0|[1-9][0-9]{0,6})$/.test(value)) throw new CliError('invalid_request');
      params[flag.slice(2)] = Number(value);
    } else {
      throw new CliError('invalid_request');
    }
  }
  const parsed = toolInputs[method].safeParse(params);
  if (!parsed.success) throw new CliError('invalid_request');
  return { kind: 'read', target, method, params: parsed.data, json: seen.has('--json') };
}

const helper = fileURLToPath(new URL('../resources/control/windows-pipe.ps1', import.meta.url));
const nativeReplyBytes = 'reply '.length + 4 * Math.ceil(LOCAL_CONTROL_REPLY_BYTES / 3) + '\r\n'.length;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeReply(stdout) {
  if (stdout.length > nativeReplyBytes) throw new CliError('unavailable');
  const line = stdout.toString('latin1');
  const frame = /^reply ([A-Za-z0-9+/]+={0,2})\r?\n$/.exec(line);
  if (!frame || frame[0].length !== line.length) throw new CliError('unavailable');
  const bytes = Buffer.from(frame[1], 'base64');
  if (bytes.length > LOCAL_CONTROL_REPLY_BYTES || bytes.toString('base64') !== frame[1]) throw new CliError('unavailable');
  try { return localControlReplySchema.parse(JSON.parse(utf8.decode(bytes))); } catch {
    throw new CliError('unavailable');
  }
}

export function exchange(child, requestLine, signal, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let inputFailed = false;
    let finished = false;
    const timer = setTimeout(stop, timeoutMs);
    function cleanup() {
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
    function stop() {
      if (finished) return;
      cleanup();
      child.kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new CliError('unavailable'));
    }
    child.on('error', stop);
    child.stdin.on('error', () => { inputFailed = true; });
    child.stdout.on('error', stop);
    child.stderr.on('error', stop);
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > nativeReplyBytes) stop();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes > LOCAL_CONTROL_REQUEST_BYTES) stop();
    });
    child.once('close', (code) => {
      if (finished) return;
      cleanup();
      if (code === 3) return reject(new CliError('denied'));
      if (code !== 0 || inputFailed) return reject(new CliError('unavailable'));
      try { resolve(decodeReply(Buffer.concat(chunks, outBytes))); } catch (error) { reject(error); }
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    else child.stdin.end(requestLine, 'ascii');
  });
}

async function readDesktop(target, method, params, signal) {
  const request = { method, params: method === 'capabilities' ? params : { ...params, instanceId: target.instanceId } };
  const payload = Buffer.from(JSON.stringify({
    v: LOCAL_CONTROL_VERSION, profileId: target.profileId, instanceId: target.instanceId, request,
  }), 'utf8');
  if (payload.length > LOCAL_CONTROL_REQUEST_BYTES) throw new CliError('invalid_request');
  if (signal?.aborted) throw new CliError('unavailable');
  let child;
  try {
    // Resolve the OS's SystemRoot object; neither PATH nor a shell environment selects the executable.
    const root = realpathSync.native(String.raw`\\?\GLOBALROOT\SystemRoot`);
    const psHome = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0');
    child = spawn(path.join(psHome, 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-Mode', 'Call',
      '-PipeName', target.pipeName, '-ExpectedPid', String(target.pid), '-ExpectedStarted', target.started,
    ], {
      cwd: path.dirname(helper), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
  } catch {
    throw new CliError('unavailable');
  }
  const reply = await exchange(child, `request ${payload.toString('base64')}\n`, signal);
  if (!reply.ok) throw new CliError(reply.error);
  const result = resultSchemas[method].safeParse(reply.result);
  if (!result.success) throw new CliError('unavailable');
  const value = result.data;
  if (method === 'capabilities') {
    if (value.instanceId !== target.instanceId) throw new CliError('denied');
    if (value.version !== LOCAL_CONTROL_VERSION) throw new CliError('incompatible');
  } else if (value.items.length > params.limit || (value.nextOffset !== null && value.nextOffset !== params.offset + params.limit)) {
    throw new CliError('unavailable');
  }
  return value;
}

const errorCode = (error) => error instanceof CliError ? error.code : 'unknown';

export function createMcpServer(target, read = readDesktop) {
  const server = new McpServer({ name: 'vocs-code-local', version: '1.0.0' }, { maxToolInputElements: 16 });
  server.server.onerror = () => undefined;
  let inFlight = false;
  for (const method of LOCAL_CONTROL_METHODS) {
    server.registerTool(method.replaceAll('.', '_'), {
      description: toolDescriptions[method], inputSchema: toolInputs[method],
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (params, { signal }) => {
      const result = (data) => ({ structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
      const failure = (code) => ({ ...result({ error: code }), isError: true });
      if (inFlight) return failure('busy');
      inFlight = true;
      try { return result(await read(target, method, params, signal)); } catch (error) {
        return failure(errorCode(error));
      } finally { inFlight = false; }
    });
  }
  return server;
}

// JSON quotes C0 controls; escape C1 and bidi/line controls too for a single safe terminal row.
const label = (value) => JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/gu,
  (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function formatResult(method, value, json) {
  if (json) return `${JSON.stringify(value)}\n`;
  if (method === 'capabilities') return `Local control available (v${value.version})\nMethods: ${value.methods.join(', ')}\n`;
  const lines = value.items.map((item) => method === 'projects.list'
    ? `${item.id}\t${label(item.name)}`
    : `${item.id}\t${item.status}\t${item.harness}\t${label(item.title)}`);
  if (!lines.length) lines.push(method === 'projects.list' ? 'No projects on this page.' : 'No sessions on this page.');
  if (value.nextOffset !== null) lines.push(`Next page: --offset ${value.nextOffset}`);
  return `${lines.join('\n')}\n`;
}

async function main(args) {
  try {
    const command = parseArgs(args);
    if (command.kind === 'help') return void process.stdout.write(HELP);
    if (process.platform !== 'win32') throw new CliError('unavailable', 'This local control preview requires Windows.');
    if (command.kind === 'mcp') {
      const server = createMcpServer(command.target);
      process.stdout.once('error', () => { void server.close().catch(() => undefined); });
      await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 }));
      return;
    }
    const value = await readDesktop(command.target, command.method, command.params);
    process.stdout.write(formatResult(command.method, value, command.json));
  } catch (error) {
    const code = errorCode(error);
    process.exitCode = errors[code][0];
    const machine = args.includes('--json') || args.includes('--stdio');
    process.stderr.write(machine ? `${JSON.stringify({ error: code })}\n` : `${error instanceof CliError ? error.message : errors[code][1]}\n`);
  }
}

if (import.meta.main) {
  process.stdout.on('error', () => { process.exitCode ??= 1; });
  await main(process.argv.slice(2));
}
