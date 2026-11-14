/** App-owned structured questions over Pi's RPC dialog transport, not its TUI-only custom UI. */
export const QUESTION_TOOL = 'ask_user';
export const QUESTION_MARKER = 'VCODE_QUESTION::';
const MAX_TEXT = 10_000;
export const QUESTION_RESPONSE_LIMIT = 50_000;

export interface QuestionInput {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  allowOther?: boolean;
}
export interface QuestionPayload extends QuestionInput {
  version: 1;
  nonce: string;
  toolCallId: string;
}
export interface QuestionReply {
  cancelled: boolean;
  answer?: string;
  comment?: string;
}
interface QuestionContext {
  hasUI?: boolean;
  ui?: { select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid question payload.');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid question ${field}.`);
  return value.trim();
}
export function parseQuestionInput(value: unknown): QuestionInput {
  const raw = object(value);
  const result: QuestionInput = { question: text(raw.question, 'text', MAX_TEXT) };
  if (raw.header !== undefined) result.header = text(raw.header, 'header', 200);
  if (raw.allowOther !== undefined && typeof raw.allowOther !== 'boolean') throw new Error('Invalid question allowOther.');
  result.allowOther = raw.allowOther !== false;
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 12) throw new Error('Questions support one to twelve options, or omit options for a typed answer.');
    result.options = raw.options.map((value) => {
      const option = object(value);
      return { label: text(option.label, 'option label', 200), ...(option.description !== undefined ? { description: text(option.description, 'option description', 2_000) } : {}) };
    });
    if (new Set(result.options.map((option) => option.label)).size !== result.options.length) throw new Error('Question option labels must be unique.');
  }
  if (!result.allowOther && !result.options?.length) throw new Error('A question without options must allow a typed answer.');
  return result;
}

export function parseQuestionPayload(raw: string, nonce: string): QuestionPayload {
  if (raw.length > QUESTION_RESPONSE_LIMIT) throw new Error('Question payload is too large.');
  const value = object(JSON.parse(raw));
  if (!nonce || value.version !== 1 || value.nonce !== nonce) throw new Error('Question belongs to another Pi runtime.');
  return { ...parseQuestionInput(value), version: 1, nonce, toolCallId: text(value.toolCallId, 'tool id', 200) };
}

export function createQuestionTool() {
  return {
    name: QUESTION_TOOL,
    label: 'Ask user',
    description: 'Ask the user one structured clarification or decision question. They can choose an option, type an alternative, add context, or skip. Use when user input is genuinely needed to proceed.',
    promptSnippet: 'Ask one user question with described options and optional context',
    promptGuidelines: [
      'Use ask_user for a genuine user decision or clarification instead of leaving a question only in prose. Ask one question at a time and wait for its answer; do not ask when safe progress is possible without it.',
      'For ask_user, provide clear option labels and descriptions explaining tradeoffs. The user may select an option and add context, or type another answer. If skipped or unavailable, do not invent an answer.',
      'ask_user is not a tool-permission grant: it must never replace or bypass Vocs Code approval cards.',
    ],
    executionMode: 'sequential' as const,
    parameters: {
      type: 'object', required: ['question'], additionalProperties: false,
      properties: {
        question: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'The single question to ask.' },
        header: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional short topic, such as Deployment.' },
        options: {
          type: 'array', minItems: 1, maxItems: 12, description: 'Suggested choices; omit for a typed answer.',
          items: {
            type: 'object', required: ['label'], additionalProperties: false,
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 200 },
              description: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Visible explanation or tradeoff, not a tooltip.' },
            },
          },
        },
        allowOther: { type: 'boolean', description: 'Allow a typed alternative. Defaults to true.' },
      },
    },
    async execute(toolCallId: string, params: QuestionInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: QuestionContext) {
      const question = parseQuestionInput(params);
      const nonce = process.env.VOCS_CODE_PI_NONCE;
      if (process.env.VOCS_CODE_MISSION_POLICY) throw new Error('Managed Mission questions must use the Mission broker, not ask_user.');
      if (!nonce || !ctx.hasUI || typeof ctx.ui?.select !== 'function') throw new Error('The Vocs Code question UI is unavailable; no user answer was obtained.');
      if (signal?.aborted) throw new Error('Question was interrupted before it could be asked.');
      const payload: QuestionPayload = { ...question, version: 1, nonce, toolCallId };
      const raw = await ctx.ui.select(QUESTION_MARKER + JSON.stringify(payload), question.options?.map((option) => option.label) ?? ['Answer'], { signal });
      let reply: QuestionReply = { cancelled: true };
      if (!signal?.aborted && raw !== undefined) {
        if (typeof raw !== 'string' || raw.length > QUESTION_RESPONSE_LIMIT) throw new Error('The app returned an invalid question response.');
        const value = object(JSON.parse(raw));
        if (typeof value.cancelled !== 'boolean') throw new Error('The app returned an invalid question outcome.');
        reply = {
          cancelled: value.cancelled,
          ...(!value.cancelled && value.answer !== undefined ? { answer: text(value.answer, 'answer', QUESTION_RESPONSE_LIMIT) } : {}),
          ...(value.comment !== undefined ? { comment: text(value.comment, 'comment', QUESTION_RESPONSE_LIMIT) } : {}),
        };
        if (!reply.cancelled && !reply.answer && !reply.comment) throw new Error('The app returned no user answer.');
        if (!reply.cancelled && !question.allowOther && reply.answer && !question.options?.some((option) => option.label === reply.answer)) throw new Error('The app returned an answer outside the offered options.');
      }
      const details = { question: question.question, ...reply };
      return {
        content: [{ type: 'text', text: `${JSON.stringify(details, null, 2)}${reply.cancelled ? '\nNo answer was provided. Do not infer a choice from this cancellation.' : ''}` }],
        details,
      };
    },
  };
}
