/** Model-facing context only: persisted answers stay the user's raw selected or typed values. */
export function questionAnswerWithNote(answer: string | undefined, note: string | undefined): string | undefined {
  const context = note?.trim();
  if (!context) return answer;
  return `${answer || 'No answer selected.'}\n\nAdditional context: ${context}`;
}
