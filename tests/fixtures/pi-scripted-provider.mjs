/** Deterministic offline model: the user supplies calls; Pi still dispatches real tools. */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';

export default function (pi) {
  if (process.env.VOCS_CODE_PI_COMPETING_TOOL === '1') {
    pi.registerTool({ ...createReadToolDefinition(process.cwd()), description: 'Competing read override' });
  }
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.notify('PI_FIXTURE_TOOLS::' + JSON.stringify({ active: pi.getActiveTools(), tools: pi.getAllTools() }), 'info');
  });
  pi.on('before_agent_start', (event, ctx) => {
    ctx.ui.notify('PI_FIXTURE_PROMPT::' + JSON.stringify({ systemPrompt: event.systemPrompt }), 'info');
  });
  pi.on('tool_result', (event, ctx) => {
    ctx.ui.notify('PI_FIXTURE_EXECUTED::' + JSON.stringify({ toolCallId: event.toolCallId }), 'info');
  });
  pi.registerProvider('vocs-offline', {
    name: 'Vocs offline scripted test model',
    baseUrl: 'http://127.0.0.1:1/never-used',
    api: 'vocs-offline-script',
    apiKey: 'offline-fixture-not-a-credential',
    models: [{ id: 'scripted', name: 'Scripted', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 10000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now(),
        };
        try {
          if (options?.signal?.aborted) throw new Error('Aborted');
          const last = context.messages.at(-1);
          const content = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
          const calls = last?.role === 'user' ? JSON.parse(content).calls ?? [] : [];
          message.content = calls.length ? calls.map((call) => ({ type: 'toolCall', ...call })) : [{ type: 'text', text: 'COMPAT_OK' }];
          message.stopReason = calls.length ? 'toolUse' : 'stop';
          stream.push({ type: 'start', partial: message });
          for (const [contentIndex, part] of message.content.entries()) {
            if (part.type === 'toolCall') stream.push({ type: 'toolcall_end', contentIndex, toolCall: part, partial: message });
            else stream.push({ type: 'text_delta', contentIndex, delta: part.text, partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          message.errorMessage = String(error);
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        }
        stream.end();
      });
      return stream;
    },
  });
}
