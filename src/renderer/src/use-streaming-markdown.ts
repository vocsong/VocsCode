/**
 * Throttled markdown rendering for a streaming transcript message. Parsing the whole growing
 * reply every animation frame is quadratic; while a message streams we re-parse at most every
 * 100ms and always parse once more when the stream finishes.
 */
import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from './markdown';

export const STREAM_MARKDOWN_INTERVAL_MS = 100;

export function useStreamingMarkdown(text: string, streaming: boolean | undefined): string {
  const [html, setHtml] = useState(() => renderMarkdown(text, { fileLinks: true, cache: !streaming }));
  const last = useRef({ text, streaming: !!streaming, at: Date.now() });
  useEffect(() => {
    // Completion must populate the cache even when the last throttled render had identical text.
    if (last.current.text === text && last.current.streaming === !!streaming) return;
    // Streaming text arrives faster than the interval: wait out the remainder of the window and
    // parse the latest text then. A finished message parses immediately.
    const dueIn = streaming ? Math.max(0, STREAM_MARKDOWN_INTERVAL_MS - (Date.now() - last.current.at)) : 0;
    if (dueIn === 0) {
      last.current = { text, streaming: !!streaming, at: Date.now() };
      setHtml(renderMarkdown(text, { fileLinks: true, cache: !streaming }));
      return;
    }
    const t = setTimeout(() => {
      last.current = { text, streaming: !!streaming, at: Date.now() };
      setHtml(renderMarkdown(text, { fileLinks: true, cache: !streaming }));
    }, dueIn);
    return () => clearTimeout(t);
  }, [text, streaming]);
  return html;
}
