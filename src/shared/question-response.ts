/** Model-facing Pi question envelope and validation, shared with the UI before an answer is final. */
import type { ApprovalDecision, ApprovalRequest } from './types';

export function questionResponse(decision: ApprovalDecision, questionId: string) {
  const comment = decision.note?.trim();
  const answer = decision.optionId === 'allow' ? decision.answers?.[questionId]?.trim() : undefined;
  return {
    cancelled: decision.optionId !== 'allow' || (!answer && !comment),
    ...(answer ? { answer } : {}),
    ...(comment ? { comment } : {}),
  };
}

export function validateQuestionResponse(request: Pick<ApprovalRequest, 'options' | 'questions' | 'maxQuestionResponseLength'>, decision: ApprovalDecision): void {
  if (request.maxQuestionResponseLength === undefined) return;
  const accepted = request.options.find((option) => option.id === decision.optionId)?.kind.startsWith('allow') ?? false;
  const response = questionResponse({ ...decision, optionId: accepted ? 'allow' : 'deny' }, request.questions?.[0]?.id ?? 'answer');
  if (accepted && response.cancelled) throw new Error('Choose an option, type an answer, or add context before submitting.');
  if (JSON.stringify(response).length > request.maxQuestionResponseLength) {
    throw new Error(`The answer and context exceed the ${request.maxQuestionResponseLength.toLocaleString()}-character response limit. Shorten them and try again.`);
  }
}
