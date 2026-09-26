/** Phone viewport plumbing: the visible height when an on-screen keyboard is up, so the composer
 *  can sit above it instead of behind it. `100dvh` in CSS handles the browser chrome. */
import { useEffect, useState } from 'react';

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      // How much of the layout viewport the keyboard covers. Negative values (zoom) clamp to 0.
      setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
