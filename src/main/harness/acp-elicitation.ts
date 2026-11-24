/** Maps ACP form elicitation (`elicitation/create`) schemas to normalized Vocs Code question cards and back. */
import type * as acp from '@agentclientprotocol/sdk';
import type { ApprovalDecision, ApprovalQuestion } from '../../shared/types';

interface ElicitationOption {
  label: string;
  value: string;
  description?: string;
}

type ElicitationField =
  | { key: string; kind: 'single'; options: ElicitationOption[]; otherKey?: string }
  | { key: string; kind: 'multi'; options: ElicitationOption[]; otherKey?: string }
  | { key: string; kind: 'text'; otherKey?: undefined }
  | { key: string; kind: 'boolean'; otherKey?: undefined }
  | { key: string; kind: 'number' | 'integer'; otherKey?: undefined };

export interface AcpElicitationPlan {
  title: string;
  description?: string;
  toolItemId?: string;
  questions: ApprovalQuestion[];
  supportsQuestionComment: boolean;
  fields: ElicitationField[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractEnumOptions(rawOneOf: unknown, rawEnum: unknown): ElicitationOption[] | null {
  const rawList: { value: string; title?: string; description?: string }[] = [];
  if (Array.isArray(rawOneOf) && rawOneOf.length > 0) {
    for (const item of rawOneOf) {
      if (!isPlainObject(item) || typeof item.const !== 'string') continue;
      rawList.push({
        value: item.const,
        title: trimmedString(item.title),
        description: trimmedString(item.description)
      });
    }
  } else if (Array.isArray(rawEnum) && rawEnum.length > 0) {
    for (const item of rawEnum) {
      if (typeof item !== 'string') continue;
      rawList.push({ value: item });
    }
  }
  if (!rawList.length) return null;

  const seen = new Set<string>();
  return rawList.map((entry, index) => {
    const base = entry.title || entry.value;
    let label = base;
    if (seen.has(label)) label = `${base} (${entry.value})`;
    if (seen.has(label)) label = `${base} (${index + 1})`;
    seen.add(label);
    return {
      label,
      value: entry.value,
      ...(entry.description ? { description: entry.description } : {})
    };
  });
}

function singleSelectOptions(prop: Record<string, unknown>): ElicitationOption[] | null {
  if (prop.type !== 'string') return null;
  return extractEnumOptions(prop.oneOf, prop.enum);
}

function multiSelectOptions(prop: Record<string, unknown>): ElicitationOption[] | null {
  if (prop.type !== 'array' || !isPlainObject(prop.items)) return null;
  return extractEnumOptions(prop.items.anyOf, prop.items.enum);
}

function isPlainStringProperty(prop: unknown): boolean {
  if (!isPlainObject(prop) || prop.type !== 'string') return false;
  return !Array.isArray(prop.oneOf) && !Array.isArray(prop.enum);
}

function questionHeading(key: string, prop: Record<string, unknown>): { header?: string; question: string } {
  const title = trimmedString(prop.title);
  const description = trimmedString(prop.description);
  if (title && description && title !== description) return { header: title, question: description };
  return { question: title || description || key };
}

function isGenericAgentQuestionMessage(message: string): boolean {
  return /^The agent has (?:\d+|a) questions?\.?$/i.test(message);
}

/**
 * Translates an ACP `elicitation/create` (`mode: "form"`) request into a normalized question card
 * plan. Returns `null` when the request uses an unsupported mode, carries no renderable fields, or
 * requires a custom/unknown schema property that cannot be safely rendered.
 */
export function planAcpFormElicitation(params: acp.CreateElicitationRequest, agentName: string): AcpElicitationPlan | null {
  if (!isPlainObject(params) || params.mode !== 'form') return null;
  const schema = (params as { requestedSchema?: unknown }).requestedSchema;
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return null;
  const properties = schema.properties;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : []);

  // Agents like Antigravity pair each choice field (`q1`) with a companion free-text field
  // (`q1_other`). Fold those pairs into one question card entry with `allowOther: true`.
  const consumedOtherKeys = new Set<string>();
  const pairedOtherKey = new Map<string, string>();
  for (const [key, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop)) continue;
    if (!singleSelectOptions(prop) && !multiSelectOptions(prop)) continue;
    const candidate = `${key}_other`;
    if (candidate in properties && isPlainStringProperty(properties[candidate])) {
      consumedOtherKeys.add(candidate);
      pairedOtherKey.set(key, candidate);
    }
  }

  const questions: ApprovalQuestion[] = [];
  const fields: ElicitationField[] = [];

  for (const [key, rawProp] of Object.entries(properties)) {
    if (consumedOtherKeys.has(key)) continue;
    if (!isPlainObject(rawProp)) {
      if (required.has(key)) return null;
      continue;
    }

    const heading = questionHeading(key, rawProp);
    const single = singleSelectOptions(rawProp);
    if (single) {
      const otherKey = pairedOtherKey.get(key);
      fields.push({ key, kind: 'single', options: single, otherKey });
      questions.push({
        id: key,
        ...heading,
        options: single.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })),
        allowOther: !!otherKey
      });
      continue;
    }

    const multi = multiSelectOptions(rawProp);
    if (multi) {
      const otherKey = pairedOtherKey.get(key);
      fields.push({ key, kind: 'multi', options: multi, otherKey });
      questions.push({
        id: key,
        ...heading,
        options: multi.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })),
        allowOther: !!otherKey,
        multiSelect: true
      });
      continue;
    }

    if (rawProp.type === 'string') {
      fields.push({ key, kind: 'text' });
      questions.push({ id: key, ...heading, allowOther: true });
      continue;
    }

    if (rawProp.type === 'boolean') {
      fields.push({ key, kind: 'boolean' });
      questions.push({
        id: key,
        ...heading,
        options: [{ label: 'Yes' }, { label: 'No' }],
        allowOther: false
      });
      continue;
    }

    if (rawProp.type === 'number' || rawProp.type === 'integer') {
      fields.push({ key, kind: rawProp.type });
      questions.push({ id: key, ...heading, allowOther: true });
      continue;
    }

    // Per ACP spec, unknown or custom `_` schema types must not be rendered as a known control.
    if (required.has(key)) return null;
  }

  if (!fields.length) return null;

  const rawMessage = trimmedString(params.message);
  const schemaTitle = trimmedString(schema.title);
  const schemaDesc = trimmedString(schema.description);
  const defaultTitle = fields.length > 1 ? `${agentName} has ${fields.length} questions` : `${agentName} has a question`;
  const title = schemaTitle || defaultTitle;
  const descParts = [
    rawMessage && !isGenericAgentQuestionMessage(rawMessage) && rawMessage !== title ? rawMessage : undefined,
    schemaDesc && schemaDesc !== title && schemaDesc !== rawMessage ? schemaDesc : undefined
  ].filter((part): part is string => !!part);

  const toolCallId = 'toolCallId' in params ? trimmedString(params.toolCallId) : undefined;
  return {
    title,
    ...(descParts.length ? { description: descParts.join(' — ') } : {}),
    ...(toolCallId ? { toolItemId: toolCallId } : {}),
    questions,
    supportsQuestionComment: fields.some((field) => !!field.otherKey),
    fields
  };
}

/** Converts the user's normalized question card decision into an ACP `elicitation/create` response. */
export function buildAcpElicitationResponse(plan: AcpElicitationPlan, decision: ApprovalDecision): acp.CreateElicitationResponse {
  if (decision.optionId !== 'allow') return { action: 'decline' };

  const content: Record<string, acp.ElicitationContentValue> = {};
  for (const field of plan.fields) {
    const rawAnswer = decision.answers?.[field.key]?.trim() ?? '';
    switch (field.kind) {
      case 'single': {
        if (!rawAnswer) break;
        const matched = field.options.find((o) => o.label === rawAnswer);
        if (matched) content[field.key] = matched.value;
        else if (field.otherKey) content[field.otherKey] = rawAnswer;
        break;
      }
      case 'multi': {
        const chosen = decision.multiAnswers?.[field.key] ?? [];
        const values: string[] = [];
        for (const label of chosen) {
          const matched = field.options.find((o) => o.label === label);
          if (matched && !values.includes(matched.value)) values.push(matched.value);
        }
        if (values.length) content[field.key] = values;
        if (rawAnswer && field.otherKey) content[field.otherKey] = rawAnswer;
        break;
      }
      case 'text': {
        if (rawAnswer) content[field.key] = rawAnswer;
        break;
      }
      case 'boolean': {
        if (rawAnswer === 'Yes') content[field.key] = true;
        else if (rawAnswer === 'No') content[field.key] = false;
        break;
      }
      case 'number':
      case 'integer': {
        if (!rawAnswer) break;
        const parsed = Number(rawAnswer);
        if (Number.isFinite(parsed) && (field.kind === 'number' || Number.isInteger(parsed))) {
          content[field.key] = parsed;
        }
        break;
      }
    }
  }

  const note = decision.note?.trim();
  if (note && plan.supportsQuestionComment) {
    const otherFields = plan.fields.filter((field): field is Extract<ElicitationField, { otherKey?: string }> & { otherKey: string } => !!field.otherKey);
    const target = otherFields[otherFields.length - 1];
    if (target) {
      const existing = typeof content[target.otherKey] === 'string' ? (content[target.otherKey] as string) : '';
      if (existing) content[target.otherKey] = `${existing}\n\nAdditional context: ${note}`;
      else if (content[target.key] !== undefined || Object.keys(content).length > 0) content[target.otherKey] = `Additional context: ${note}`;
      else content[target.otherKey] = note;
    }
  }

  return { action: 'accept', content };
}
