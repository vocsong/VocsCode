import React from 'react';
import { useUiMode } from '../ui-mode';

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const point = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const inset = 2.5;

// Each dash/gap pair keeps its share of the 100-unit lap as the discharge grows and recedes.
function dashPattern(expanded: boolean) {
  return [40, 35, 25].flatMap((span, i) => {
    const arc = [22, 18, 13][i] + randomBetween(expanded ? 2 : -2, expanded ? 5 : 1);
    return [arc, span - arc].map((value) => value.toFixed(2));
  }).join(' ');
}

function traceRim(rim: SVGRectElement, perimeter: number) {
  // Sample in CSS pixels so a wide button doesn't stretch the zigzags or flatten the corners.
  const nodes = Math.ceil(perimeter / 3);
  const at = (distance: number) => rim.getPointAtLength((distance + perimeter) % perimeter);
  let trunk = '';
  let forks = '';
  let nextFork = 4;
  for (let i = 0; i < nodes; i++) {
    const distance = (i + randomBetween(-0.24, 0.24)) / nodes * perimeter;
    const base = at(distance);
    const before = at(distance - 0.5);
    const after = at(distance + 0.5);
    const magnitude = Math.hypot(after.x - before.x, after.y - before.y) || 1;
    const tx = (after.x - before.x) / magnitude;
    const ty = (after.y - before.y) / magnitude;
    const offset = randomBetween(-1.1, 1.6);
    const x = base.x - ty * offset;
    const y = base.y + tx * offset;
    trunk += `${i === 0 ? 'M' : ' L'}${point(x, y)}`;
    if (i === nextFork) {
      const reach = randomBetween(4, 8) * (Math.random() < 0.25 ? -1 : 1);
      const spread = randomBetween(1.6, 3);
      const branchPoint = (along: number, inward: number) => point(x + tx * along - ty * inward, y + ty * along + tx * inward);
      forks += `M${point(x, y)} L${branchPoint(reach * 0.45, spread * 0.7)} L${branchPoint(reach, spread)} `;
      nextFork += Math.floor(randomBetween(7, 13));
    }
  }
  return { trunk: `${trunk} Z`, forks };
}

export function FastModeElectric() {
  const ref = React.useRef<SVGSVGElement>(null);
  const rimRef = React.useRef<SVGRectElement>(null);
  const maskId = React.useId();
  const uiMode = useUiMode();
  const [dashes] = React.useState(() => ({ '--fast-dashes': dashPattern(false), '--fast-dashes-expanded': dashPattern(true) } as React.CSSProperties));
  const [geometry, setGeometry] = React.useState<{ width: number; height: number; trunk: string; forks: string }>();

  React.useEffect(() => {
    const svg = ref.current;
    const rim = rimRef.current;
    if (!svg || !rim || typeof rim.getTotalLength !== 'function') return;
    let lastWidth = 0;
    let lastHeight = 0;
    const measure = () => {
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (width < 12 || height < 12 || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width;
      lastHeight = height;
      const rimWidth = width - 2 * inset;
      const rimHeight = height - 2 * inset;
      rim.setAttribute('width', String(rimWidth));
      rim.setAttribute('height', String(rimHeight));
      const radius = Number.parseFloat(getComputedStyle(svg).borderTopLeftRadius) || 0;
      rim.setAttribute('rx', String(Math.max(0, Math.min(radius - inset, rimWidth / 2, rimHeight / 2))));
      const perimeter = rim.getTotalLength();
      if (perimeter) setGeometry({ width, height, ...traceRim(rim, perimeter) });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(svg);
    measure();
    return () => resize.disconnect();
  }, [uiMode]);

  return (
    <svg ref={ref} className="fast-mode-electric" viewBox={geometry && `0 0 ${geometry.width} ${geometry.height}`} style={dashes} aria-hidden="true" focusable="false">
      <rect ref={rimRef} x={inset} y={inset} visibility="hidden" />
      {geometry && <>
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={geometry.width} height={geometry.height}>
            <path className="fast-mode-electric-flow" d={geometry.trunk} pathLength={100} />
          </mask>
        </defs>
        <path className="fast-mode-electric-trace" d={geometry.trunk} mask={`url(#${maskId})`} />
        <path className="fast-mode-electric-fork" d={geometry.forks} mask={`url(#${maskId})`} />
      </>}
    </svg>
  );
}
