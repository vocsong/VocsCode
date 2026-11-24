import { useEffect, useRef } from 'react';

// The public entries in vocsong/vocs.io's src/data/vocs-products.ts. Millie is private and
// appears in that product's own signed-in switcher only.
const products = [
  { id: 'vocs', name: 'vocs.io', description: 'Lab, projects and writing', href: 'https://vocs.io/', glyph: 'v.' },
  { id: 'code', name: 'Vocs Code', description: 'Every coding agent, one interface', href: '/', glyph: 'C' },
  { id: 'mcp', name: 'MCP Hub', description: 'Your AI capabilities', href: 'https://mcp.vocs.io/', glyph: 'M' },
  { id: 'account', name: 'Account', description: 'Sign-in and security', href: 'https://auth.vocs.io/account', glyph: 'A' }
] as const;

export function ProductSwitcher() {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) details.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !details.current?.open) return;
      event.preventDefault();
      details.current.open = false;
      summary.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <details className="v-switcher" ref={details}>
      <summary className="v-icon-btn" aria-label="Vocs products" ref={summary}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {[5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2" />))}
        </svg>
      </summary>
      <nav className="v-switcher-panel" aria-label="Vocs products">
        <p className="v-switcher-head">Vocs</p>
        {products.map(({ id, name, description, href, glyph }) => (
          <a key={id} className="v-switcher-item" data-p={id} href={href} aria-current={id === 'code' ? 'true' : undefined}>
            <span className="v-glyph" aria-hidden="true">{glyph}</span>
            <span>
              <span className="v-switcher-name">{name}</span>
              <span className="v-switcher-desc">{description}</span>
            </span>
          </a>
        ))}
        <div className="v-switcher-foot"><span>One Vocs account</span><span className="v-mono">vocs.io</span></div>
      </nav>
    </details>
  );
}
