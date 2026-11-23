/**
 * Vocs Code capability bridge for Vesta, the in-app assistant (loaded with `pi -e <this file>`).
 *
 * Vesta's tools are not file or shell tools: each one is an IPC capability the desktop app runs
 * behind its own allowlist and risk gate. pi executes the tool here, in its own process, so this
 * extension forwards the call over the extension-UI `select` channel — the same request/response
 * round trip the approvals extension uses — and the app decides, gates and performs it. Neither
 * the tool list nor any capability logic lives here; both come from the app at startup.
 *
 * The app writes the tool definitions to VOCS_CODE_VESTA_TOOLS and the per-turn system prompt to
 * VOCS_CODE_VESTA_PROMPT before spawning pi, and answers every `select` whose title carries the
 * VCODE_VESTA_CALL:: marker with {"ok":boolean,"detail":string}.
 */

interface PiToolResult {
  content: { type: string; text?: string }[];
  details?: Record<string, unknown>;
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: object;
  execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<PiToolResult>;
}

interface Pi {
  registerTool(def: PiToolDefinition): void;
  setActiveTools(names: string[]): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
}

const CALL_MARKER = 'VCODE_VESTA_CALL::';
const READY_MARKER = 'VCODE_VESTA_READY::';
const ERROR_MARKER = 'VCODE_VESTA_ERROR::';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A capability definition as written by src/main/agents/tools.ts. */
function parseTools(raw: unknown): PiToolDefinition[] {
  if (!Array.isArray(raw)) return [];
  const out: PiToolDefinition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name.trim()) continue;
    if (typeof t.description !== 'string' || !t.description.trim()) continue;
    const parameters = t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} };
    out.push({
      name: t.name,
      label: t.name,
      description: t.description,
      promptSnippet: t.description.split('\n')[0].slice(0, 140),
      parameters
    });
  }
  return out;
}

export default async function vocsCodeVesta(pi: Pi): Promise<void> {
  const notify = (ctx: any, marker: string, payload: Record<string, unknown>) => {
    try {
      ctx?.ui?.notify(marker + JSON.stringify({ version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, ...payload }), 'info');
    } catch {
      /* the host may already be gone */
    }
  };
  const fail = (payload: Record<string, unknown>): void => {
    const message = JSON.stringify({ version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, capability: 'vesta', ready: false, ...payload });
    // Before session_start there is no context; the host also watches stderr for a crash.
    console.error(ERROR_MARKER + message);
  };

  try {
    const { readFileSync } = await import('node:fs');
    const toolsPath = process.env.VOCS_CODE_VESTA_TOOLS;
    if (!toolsPath) throw new Error('VOCS_CODE_VESTA_TOOLS is not set; the app must supply the capability manifest.');
    let tools: PiToolDefinition[];
    try {
      tools = parseTools(JSON.parse(readFileSync(toolsPath, 'utf8')));
    } catch (error) {
      throw new Error(`cannot read the capability manifest at ${toolsPath}: ${errorText(error)}`);
    }
    if (!tools.length) throw new Error('the capability manifest is empty.');

    for (const tool of tools) {
      pi.registerTool({
        ...tool,
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
          const ui = (ctx as { ui?: { select?: (title: string, options: string[]) => Promise<string | undefined> } } | undefined)?.ui;
          // Without the UI round trip there is no way to reach the app; fail closed rather than
          // returning a fabricated result to the model.
          if (!ui || typeof ui.select !== 'function') throw new Error('The Vocs Code capability bridge is unavailable; refusing to run this action.');
          const nonce = process.env.VOCS_CODE_PI_NONCE;
          const payload = JSON.stringify({ id: toolCallId, name: tool.name, args: params ?? {}, ...(nonce ? { nonce } : {}) });
          const reply = await ui.select(CALL_MARKER + payload, ['ok']);
          if (typeof reply !== 'string') throw new Error('Vesta was cancelled.');
          let outcome: { ok?: unknown; detail?: unknown };
          try {
            outcome = JSON.parse(reply) as { ok?: unknown; detail?: unknown };
          } catch {
            throw new Error('The app returned an unreadable result.');
          }
          const detail = typeof outcome.detail === 'string' && outcome.detail ? outcome.detail : 'done';
          if (outcome.ok === true) return { content: [{ type: 'text', text: detail }], details: { capability: tool.name } };
          throw new Error(detail);
        }
      });
    }

    pi.on('session_start', (_event, ctx) => {
      pi.setActiveTools(tools.map((t) => t.name));
      notify(ctx, READY_MARKER, { capability: 'vesta', ready: true, tools: tools.map((t) => t.name) });
    });

    // The app rewrites this file before every prompt; replacing the system prompt here keeps the
    // persona and the "where the user is right now" block out of the user's own message.
    pi.on('before_agent_start', () => {
      const promptPath = process.env.VOCS_CODE_VESTA_PROMPT;
      if (!promptPath) return undefined;
      try {
        const systemPrompt = readFileSync(promptPath, 'utf8');
        return systemPrompt.trim() ? { systemPrompt } : undefined;
      } catch {
        return undefined;
      }
    });

    pi.on('session_shutdown', (_event, ctx) => notify(ctx, READY_MARKER, { capability: 'vesta', ready: false }));
  } catch (error) {
    const message = errorText(error);
    fail({ capability: 'vesta', message });
    throw error;
  }
}
