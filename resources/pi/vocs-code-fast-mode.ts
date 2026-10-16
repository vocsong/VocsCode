/** Session-local Fast mode. This is a service request, never a thinking/effort override.
 * The host sets an explicit initial value (including on resume) and toggles it through an
 * acknowledged, nonce-bound RPC extension command. Nothing is saved in Pi's global settings.
 */
export const PI_FAST_MODE_MARKER = 'VCODE_PI_FAST_MODE::';
export const PI_FAST_MODE_COMMAND = 'vocs-code-fast-mode';
const FAST_BETA = 'fast-mode-2026-02-01';

interface ModelLike { provider?: string; id?: string; api?: string; baseUrl?: string }
interface ContextLike {
  model?: ModelLike;
  isIdle(): boolean;
  ui: { notify(message: string, type?: string): void };
}
interface EventLike {
  payload?: unknown;
  status?: number;
  model?: ModelLike;
  message?: { role?: string; stopReason?: string; errorMessage?: string };
}
interface PiLike {
  on(name: string, handler: (event: EventLike, ctx: ContextLike) => unknown): unknown;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: ContextLike): Promise<void> }): void;
}

/** Check the effective runtime model and endpoint, not just the host's picker/config. */
export function supportsPiFastMode(model: ModelLike | undefined): boolean {
  if (!model?.id || !model.baseUrl) return false;
  let endpoint: URL;
  try { endpoint = new URL(model.baseUrl); } catch { return false; }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) return false;
  const url = endpoint.origin + endpoint.pathname.replace(/\/+$/, '');
  if (model.provider === 'anthropic') {
    return model.api === 'anthropic-messages' && url === 'https://api.anthropic.com' &&
      /^claude-opus-(?:4[.-]8|5(?:[.-]\d+)?)(?:-|$)/i.test(model.id);
  }
  if (!/^gpt-(?:5|6)(?:[.-]|$)/i.test(model.id) || /spark/i.test(model.id)) return false;
  if (model.provider === 'openai') return (model.api === 'openai-responses' || model.api === 'openai-completions') && url === 'https://api.openai.com/v1';
  return (model.provider === 'openai-codex' || model.provider === 'codex') && model.api === 'openai-codex-responses' &&
    ['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/codex', 'https://chatgpt.com/backend-api/codex/responses'].includes(url);
}

export default function vocsCodeFastMode(pi: PiLike): void {
  const nonce = process.env.VOCS_CODE_PI_NONCE;
  const initial = process.env.VOCS_CODE_FAST_MODE;
  let enabled = initial === '1';
  let revision = 0;
  const valid = !!nonce && (initial === '0' || initial === '1');
  const status = (ctx: ContextLike, state?: 'requested' | 'unavailable' | 'cooldown', detail?: string, requestId?: string) => {
    const supported = supportsPiFastMode(ctx.model);
    ctx.ui.notify(PI_FAST_MODE_MARKER + JSON.stringify({ version: 1, nonce, enabled, revision, requestId,
      state: !enabled ? 'off' : !supported ? 'unavailable' : state ?? 'requested',
      effectiveModel: supported ? { provider: ctx.model!.provider, model: ctx.model!.id } : undefined,
      detail: detail ?? (enabled ? supported ? 'Fast service requested; Pi does not expose the confirmed response tier.' : 'Fast mode is not supported by this Pi provider, endpoint or model.' : undefined),
    }), 'info');
  };
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.notify('VCODE_PI_READY::' + JSON.stringify({ version: 1, nonce, capability: 'fast-mode', ready: valid }), 'info');
    if (valid) status(ctx);
  });
  pi.on('model_select', (event, ctx) => status({ ...ctx, model: event.model ?? ctx.model }));
  pi.registerCommand(PI_FAST_MODE_COMMAND, {
    description: 'Host-only session Fast mode bridge',
    handler: async (args, ctx) => {
      // JSON rather than truthiness: "false", missing fields and foreign sessions must not enable it.
      const choice = JSON.parse(args) as Record<string, unknown>;
      if (!valid || !choice || choice.nonce !== nonce || typeof choice.enabled !== 'boolean' ||
          typeof choice.requestId !== 'string' || !choice.requestId || !Number.isSafeInteger(choice.revision) || (choice.revision as number) <= revision) {
        throw new Error('Invalid Pi Fast mode bridge request.');
      }
      if (!ctx.isIdle()) throw new Error('Pi Fast mode can only change while idle.');
      if (choice.enabled && !supportsPiFastMode(ctx.model)) throw new Error('Fast mode is unavailable for the effective Pi model or endpoint.');
      enabled = choice.enabled;
      revision = choice.revision as number;
      status(ctx, undefined, undefined, choice.requestId);
    }
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (!valid || !supportsPiFastMode(ctx.model)) return undefined;
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      status(ctx, 'unavailable', 'Pi supplied an invalid provider payload; no Fast mode fields were sent.');
      throw new Error('Invalid Pi provider payload for Fast mode.');
    }
    status(ctx);
    const payload = event.payload as Record<string, unknown>;
    // Explicit default overrides inherited priority and the OpenAI project's default tier.
    if (ctx.model?.provider !== 'anthropic') return { ...payload, service_tier: enabled ? 'priority' : 'default' };
    // Anthropic SDK beta.messages.create moves `betas` to anthropic-beta. Preserve Pi's own betas.
    const betas = Array.isArray(payload.betas) ? payload.betas.filter((value): value is string => typeof value === 'string') : [];
    if (enabled) return { ...payload, speed: 'fast', betas: [...new Set([...betas, FAST_BETA])] };
    const standard = { ...payload };
    if (standard.speed === 'fast') delete standard.speed;
    if (Array.isArray(payload.betas)) standard.betas = betas.filter((beta) => beta !== FAST_BETA);
    return standard;
  });
  pi.on('after_provider_response', (event, ctx) => {
    if (!enabled || !supportsPiFastMode(ctx.model)) return;
    // Response bodies (service_tier/speed) are not exposed by Pi 0.85.1. A successful HTTP
    // response alone is not evidence that priority/fast was served, so never claim "on".
    if (event.status && event.status >= 400) status(ctx, event.status === 429 ? 'cooldown' : 'unavailable', `Fast service request returned HTTP ${event.status}.`);
  });
  pi.on('message_end', (event, ctx) => {
    if (enabled && supportsPiFastMode(ctx.model) && event.message?.role === 'assistant' && event.message.stopReason === 'error') {
      status(ctx, 'unavailable', 'Pi provider request failed; Fast service was not confirmed.');
    }
  });
}
