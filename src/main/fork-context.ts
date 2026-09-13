/** Renders a session's prior conversation as a one-shot handoff preamble for a cross-harness fork. */
import { HARNESS_BY_ID } from '../shared/harness-meta';
import type { HarnessId, TranscriptItem } from '../shared/types';
import { truncate } from './util/async';

/** Per-item and whole-context caps keep the handoff from crowding out the target model's window. */
const MAX_ITEM_CHARS = 1_500;
const MAX_TOTAL_CHARS = 24_000;

/**
 * A different harness cannot resume the source's provider session, so the copied transcript is
 * rendered as plain text and prefixed to the next user message. Recent items win when the source
 * is longer than the budget, because they matter most for continuing the work.
 */
export function renderForkContext(items: TranscriptItem[], from: HarnessId, to: HarnessId): string {
  const blocks = items.map(renderItem).filter((b): b is string => !!b);
  let total = 0;
  const kept: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (kept.length && total + block.length > MAX_TOTAL_CHARS) break;
    kept.unshift(block);
    total += block.length;
  }
  const header = [
    `# Handoff from ${HARNESS_BY_ID[from].name} to ${HARNESS_BY_ID[to].name}`,
    '',
    "This session was forked into a different harness in the same working directory. The conversation below is what happened before the fork; treat it as your prior context and continue from it. The user's next message follows the transcript.",
    ''
  ];
  if (kept.length < blocks.length) header.push(`(${blocks.length - kept.length} earlier item(s) omitted for length.)`, '');
  return [...header, ...kept, '--- End of previous conversation ---'].join('\n');
}

function renderItem(item: TranscriptItem): string | null {
  switch (item.kind) {
    case 'user': {
      const images = item.images?.length ? `\n[${item.images.length} image(s) attached]` : '';
      return `**User:**\n${truncate(item.text, MAX_ITEM_CHARS)}${images}`;
    }
    case 'assistant': {
      const text = truncate(item.text ?? '', MAX_ITEM_CHARS);
      return text.trim() ? `**Assistant:**\n${text}` : null;
    }
    case 'tool': {
      const summary = item.summary ? ` — ${truncate(item.summary, 200)}` : '';
      // Only failures carry output worth passing on; a successful tool's result is usually
      // summarised in the following assistant reply.
      const output = item.status === 'error' || item.status === 'declined' ? `\n${truncate(item.output ?? '', 800)}` : '';
      return `**Tool ${item.name}${summary}** [${item.status}]${output}`;
    }
    case 'plan':
      return `**Plan:**\n${item.entries.map((e) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`).join('\n')}`;
    case 'info':
      return item.level === 'info' ? null : `**${item.level === 'error' ? 'Error' : 'Warning'}:** ${truncate(item.text, 500)}`;
    default:
      return null;
  }
}
