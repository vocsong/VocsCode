import React from 'react';
import { useUiMode } from '../ui-mode';

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const point = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const inset = 2.5;

const stillArcs = [[12, 4], [20, 34], [15, 70]] as const;
const dash = (length: number) => `${length}px ${100 - length}px`;

function discharge(flow: SVGPathElement, trace: SVGPathElement, birthDelay: number) {
  const duration = randomBetween(1050, 2250);
  const start = randomBetween(0, 100);
  const drift = duration / randomBetween(6500, 10000) * 100;
  const length = randomBetween(7, 24);
  const timing: KeyframeAnimationOptions = { duration, delay: birthDelay, fill: 'both' };
  const current = flow.animate([
    { offset: 0, opacity: 0, length: length * 0.48 },
    { offset: 0.16, opacity: randomBetween(0.64, 0.85), length: length * 0.85 },
    { offset: randomBetween(0.35, 0.55), opacity: randomBetween(0.72, 0.98), length },
    { offset: randomBetween(0.65, 0.8), opacity: randomBetween(0.42, 0.68), length: length * randomBetween(0.66, 0.94) },
    { offset: 1, opacity: 0, length: length * 0.54 },
  ].map(({ offset, opacity, length }) => ({ offset, opacity, strokeDasharray: dash(length), strokeDashoffset: `${-(start + drift * offset)}px` })), timing);
  const thickness = trace.animate([
    { offset: 0, strokeWidth: '0.48px' },
    { offset: randomBetween(0.16, 0.3), strokeWidth: `${randomBetween(0.84, 1.15)}px` },
    { offset: randomBetween(0.35, 0.55), strokeWidth: `${randomBetween(0.48, 0.68)}px` },
    { offset: randomBetween(0.62, 0.82), strokeWidth: `${randomBetween(0.77, 1.07)}px` },
    { offset: 1, strokeWidth: '0.48px' },
  ], timing);
  return { current, thickness };
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
  const [geometry, setGeometry] = React.useState<{ width: number; height: number; trunk: string; forks: string }>();
  const hasGeometry = Boolean(geometry);

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

  React.useEffect(() => {
    const svg = ref.current;
    if (!svg || !hasGeometry) return;
    const flows = svg.querySelectorAll<SVGPathElement>('.fast-mode-electric-flow');
    const traces = svg.querySelectorAll<SVGPathElement>('.fast-mode-electric-trace');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const active: ReturnType<typeof discharge>[] = [];
    const cancel = (arc: ReturnType<typeof discharge>) => {
      arc.current.onfinish = null;
      arc.current.cancel();
      arc.thickness.cancel();
    };
    const stop = () => active.splice(0).forEach(cancel);
    const start = () => {
      stop();
      if (motion.matches || document.hidden) return;
      flows.forEach((flow, i) => {
        // Each arc has its own clock. Reroll only once it's gone, so nothing jumps while visible.
        const next = (delay: number) => {
          if (active[i]) cancel(active[i]);
          const arc = discharge(flow, traces[i], delay);
          active[i] = arc;
          arc.current.onfinish = () => next(randomBetween(180, 950));
        };
        next(i * randomBetween(100, 230));
      });
    };
    start();
    motion.addEventListener('change', start);
    document.addEventListener('visibilitychange', start);
    return () => {
      stop();
      motion.removeEventListener('change', start);
      document.removeEventListener('visibilitychange', start);
    };
  }, [hasGeometry]);

  return (
    <svg ref={ref} className="fast-mode-electric" viewBox={geometry && `0 0 ${geometry.width} ${geometry.height}`} aria-hidden="true" focusable="false">
      <rect ref={rimRef} x={inset} y={inset} visibility="hidden" />
      {geometry && <>
        <defs>
          {stillArcs.map(([length, position], i) => (
            <mask key={i} id={`${maskId}-${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width={geometry.width} height={geometry.height}>
              <path className="fast-mode-electric-flow" d={geometry.trunk} pathLength={100} strokeDasharray={dash(length)} strokeDashoffset={-position} opacity="0.65" />
            </mask>
          ))}
        </defs>
        {stillArcs.map((_, i) => (
          <g key={i} mask={`url(#${maskId}-${i})`}>
            <path className="fast-mode-electric-trace" d={geometry.trunk} />
            <path className="fast-mode-electric-fork" d={geometry.forks} />
          </g>
        ))}
      </>}
    </svg>
  );
}
