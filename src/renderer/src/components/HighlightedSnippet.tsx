import React, { useMemo } from 'react';

/** Render main's \u0001/\u0002 match markers as <mark> nodes; all snippet content stays text. */
export function HighlightedSnippet({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/[\u0001\u0002]/), [text]);
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>))}
    </>
  );
}
