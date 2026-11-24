import React from 'react';
import { useUiMode } from '../ui-mode';

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const point = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const inset = 3.5;

const stillArcs = [[12, 4], [9, 24], [13, 40], [8, 66], [11, 84]] as const;
const rimLength = 100;
const clearance = 2.5;
const maxSpan = 17;
const dash = (length: number) => `${length}px ${rimLength - length}px`;

type RimSpan = { start: number; extent: number };

// Reserve the whole swept span, not just the visible dash at the start. Including the gap
// across zero keeps the arcs apart even when they cross the seam of the closed path.
function reserveSpan(occupied: RimSpan[]): RimSpan {
  const desired = randomBetween(8, maxSpan);
  if (!occupied.length) return { start: randomBetween(0, rimLength), extent: desired };
  const sorted = occupied.sort((a, b) => a.start - b.start);
  const gaps = sorted.map(({ start, extent }, i) => {
    const nextStart = sorted[i + 1]?.start ?? sorted[0].start + rimLength;
    return { start: start + extent + clearance, extent: nextStart - (start + extent) - 2 * clearance };
  });
  const fits = gaps.filter((gap) => gap.extent >= desired);
  // At most four other spans of 17 leave a gap of at least 8, enough for clearance and a spark.
  const gap = fits[Math.floor(Math.random() * fits.length)] ?? gaps.reduce((best, other) => other.extent > best.extent ? other : best);
  const extent = Math.min(desired, gap.extent);
  return { start: (gap.start + randomBetween(0, gap.extent - extent)) % rimLength, extent };
}

function discharge(flow: SVGPathElement, trace: SVGPathElement, birthDelay: number, span: RimSpan) {
  const duration = randomBetween(410, 890);
  const { start, extent } = span;
  const drift = extent * randomBetween(0.2, 0.35);
  const length = extent - drift;
  const peak = randomBetween(2.25, 3.55);
  const tip = randomBetween(0.45, 0.65);
  const timing: KeyframeAnimationOptions = { duration, delay: birthDelay, fill: 'both' };
  const current = flow.animate([
    { offset: 0, opacity: 0, length: length * 0.48 },
    { offset: 0.16, opacity: randomBetween(0.64, 0.85), length: length * 0.85 },
    { offset: randomBetween(0.35, 0.55), opacity: randomBetween(0.72, 0.98), length },
    { offset: randomBetween(0.65, 0.8), opacity: randomBetween(0.42, 0.68), length: length * randomBetween(0.66, 0.94) },
    { offset: 1, opacity: 0, length: length * 0.54 },
  ].map(({ offset, opacity, length }) => ({ offset, opacity, strokeDasharray: dash(length), strokeDashoffset: `${-(start + drift * offset)}px` })), timing);
  const thickness = trace.animate([
    { offset: 0, width: tip },
    { offset: randomBetween(0.21, 0.35), width: peak },
    { offset: randomBetween(0.45, 0.56), width: peak * randomBetween(0.35, 0.58) },
    { offset: randomBetween(0.62, 0.75), width: peak * randomBetween(0.68, 0.92) },
    { offset: 1, width: tip },
  ].map(({ offset, width }) => ({ offset, strokeWidth: `${width}px` })), timing);
  return { current, thickness, span };
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
    const active = new Map<number, ReturnType<typeof discharge>>();
    const cancel = (arc: ReturnType<typeof discharge>) => {
      arc.current.onfinish = null;
      arc.current.cancel();
      arc.thickness.cancel();
    };
    const stop = () => {
      active.forEach(cancel);
      active.clear();
    };
    const start = () => {
      stop();
      if (motion.matches || document.hidden) return;
      flows.forEach((flow, i) => {
        // Reroll only after the previous arc goes dark. Delayed bursts reserve space too.
        const next = (delay: number) => {
          const span = reserveSpan(Array.from(active.values(), (arc) => arc.span));
          const arc = discharge(flow, traces[i], delay, span);
          active.set(i, arc);
          arc.current.onfinish = () => {
            if (active.get(i) !== arc) return;
            cancel(arc);
            active.delete(i);
            next(randomBetween(60, 235));
          };
        };
        next(i * randomBetween(40, 75));
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
