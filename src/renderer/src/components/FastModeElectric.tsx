import React from 'react';
import { useUiMode } from '../ui-mode';

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const timeBetween = (min: number, max: number) => randomBetween(min, max) / 1.35;
// The SVG overhangs the composer so strikes can cross its visible border, not hide inside it.
const bleed = 6;
const rimLength = 100;
const headLength = 28;
const clearance = 2.5;
const maxSpan = 20;
const maxTwigs = 10;
const twigSlots = Array.from({ length: maxTwigs }, (_, index) => index);
const stillSpans = [[4, 15], [39, 16], [72, 12]].map(([start, extent]) => ({ start, extent }));

type RimSpan = { start: number; extent: number };
type Point = { x: number; y: number };
type Twig = { path: string; joint: number };

// Reserve the entire stretch used by a bolt and its twigs, even across the seam.
function reserveSpan(occupied: RimSpan[]): RimSpan {
  const desired = randomBetween(11, maxSpan);
  if (!occupied.length) return { start: randomBetween(0, rimLength), extent: desired };
  const sorted = occupied.sort((a, b) => a.start - b.start);
  const gaps = sorted.map(({ start, extent }, i) => {
    const nextStart = sorted[i + 1]?.start ?? sorted[0].start + rimLength;
    return { start: start + extent + clearance, extent: nextStart - (start + extent) - 2 * clearance };
  });
  // With at most two other 20-unit bolts, at least one gap has room for the new bolt.
  const fits = gaps.filter((gap) => gap.extent >= desired);
  const gap = fits[Math.floor(Math.random() * fits.length)];
  return { start: (gap.start + randomBetween(0, gap.extent - desired)) % rimLength, extent: desired };
}

const pathThrough = (points: Point[]) => points.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

// Positive offsets point into the composer, negative ones out of it; the rim is the border line.
function makeBolt(rim: SVGRectElement, perimeter: number, { start, extent }: RimSpan, swing: number) {
  const wrap = (distance: number) => ((distance % perimeter) + perimeter) % perimeter;
  const sample = (distance: number, offset: number): Point => {
    const point = rim.getPointAtLength(wrap(distance));
    const before = rim.getPointAtLength(wrap(distance - 0.4));
    const after = rim.getPointAtLength(wrap(distance + 0.4));
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    // Round before tracking length so a twig waits for the exact joint that is drawn.
    return { x: Math.round((point.x - dy / length * offset) * 10) / 10, y: Math.round((point.y + dx / length * offset) * 10) / 10 };
  };
  const distance = extent / rimLength * perimeter;
  const direction = Math.random() < 0.5 ? 1 : -1;
  const origin = (direction > 0 ? start : start + extent) / rimLength * perimeter;
  const nodes = Math.max(6, Math.round(distance / 7.2));
  const reach = swing + 1.6;
  const limit = (offset: number) => Math.max(-reach, Math.min(reach, offset));
  const points: Point[] = [];
  const twigs: Twig[] = [];
  let nextTwig = 1;
  let length = 0;
  let inward = Math.random() < 0.5;
  const bend = Math.floor(randomBetween(1, nodes - 2));
  const rebound = bend + 2;
  const [deep, shallow] = inward ? [bend, rebound] : [rebound, bend];
  for (let i = 0; i <= nodes; i++) {
    const tip = i === 0 || i === nodes;
    const along = (i + (tip ? 0 : randomBetween(-0.34, 0.34))) / nodes * distance;
    // Vary the lateral travel, not the line width. Uneven bends avoid a repeating sawtooth.
    // Tips land on the border and every strike crosses it at least once each way.
    if (Math.random() < 0.68) inward = !inward;
    const offset = tip ? randomBetween(-0.4, 0.4)
      : i === deep ? swing * 0.98 : i === shallow ? -swing * 0.98
      : (inward ? 1 : -1) * swing * randomBetween(0.3, 1);
    const at = origin + direction * along;
    const point = sample(at, offset);
    const previous = points.at(-1);
    if (previous) length += Math.hypot(point.x - previous.x, point.y - previous.y);
    points.push(point);
    if (i === nextTwig && i < nodes && twigs.length < maxTwigs) {
      // Only small twigs from this channel. Keep their reach inside the same reservation.
      const run = Math.min(distance - along, randomBetween(2.8, 6.2));
      // Sparks fly off whichever side of the border the channel is on.
      const side = offset >= 0 ? 1 : -1;
      const spread = side * randomBetween(1.25, 2.65);
      twigs.push({ path: pathThrough([
        point,
        sample(at + direction * run * 0.52, limit(offset + spread * 0.38)),
        sample(at + direction * run, limit(offset + spread))
      ]), joint: length });
      nextTwig += Math.floor(randomBetween(2, 5));
    }
  }
  return { trunk: pathThrough(points), twigs: twigs.filter((twig) => twig.joint > 0).map((twig) => ({ ...twig, joint: twig.joint / length })) };
}

function paint(group: SVGGElement, rim: SVGRectElement, perimeter: number, swing: number, span: RimSpan) {
  const [trunk, head, ...paths] = group.querySelectorAll('path');
  const bolt = makeBolt(rim, perimeter, span, swing);
  group.dataset.rimStart = String(span.start);
  group.dataset.rimExtent = String(span.extent);
  trunk.setAttribute('d', bolt.trunk);
  head.setAttribute('d', bolt.trunk);
  paths.forEach((path, i) => {
    if (bolt.twigs[i]) path.setAttribute('d', bolt.twigs[i].path);
    else path.removeAttribute('d');
  });
  return { trunk, head, paths, twigs: bolt.twigs };
}

function discharge({ trunk, head, paths, twigs }: ReturnType<typeof paint>, delay: number) {
  const duration = timeBetween(680, 1040);
  const timing: KeyframeAnimationOptions = { duration, delay, fill: 'both' };
  const reachedEnd = randomBetween(0.69, 0.85);
  const fade = reachedEnd + 0.04;
  // Creeping current in the preview uses p = .84t + .16t², with no pauses or jumps.
  const easing = 'cubic-bezier(0.3333, 0.28, 0.6667, 0.6133)';
  const current = trunk.animate([
    { strokeDashoffset: `${rimLength}px`, opacity: 0.3, easing },
    { offset: reachedEnd, strokeDashoffset: '0px', opacity: 0.3 },
    { offset: fade, strokeDashoffset: '0px', opacity: 0.8, easing: 'ease-in-out' },
    { strokeDashoffset: '0px', opacity: 0 }
  ], timing);
  const tip = head.animate([
    { strokeDashoffset: `${headLength}px`, opacity: 0.52, easing },
    { offset: reachedEnd, strokeDashoffset: `${headLength - rimLength}px`, opacity: 0.82 },
    { offset: fade, strokeDashoffset: `${headLength - rimLength}px`, opacity: 0 },
    { strokeDashoffset: `${headLength - rimLength}px`, opacity: 0 }
  ], timing);

  const branches = twigs.map(({ joint }, i) => {
    // Invert the reveal curve so each twig starts only as the moving tip reaches it.
    const reached = 2 * joint / (0.84 + Math.sqrt(0.84 ** 2 + 0.64 * joint));
    const sprout = reached * reachedEnd + 0.01;
    const life = Math.min(1 - sprout, randomBetween(0.23, 0.39));
    return paths[i].animate([
      { offset: 0, strokeDashoffset: '100px', opacity: 0 },
      { offset: 0.34, strokeDashoffset: '0px', opacity: 0.53 },
      { offset: 1, strokeDashoffset: '0px', opacity: 0 }
    ], { duration: life * duration, delay: delay + sprout * duration, fill: 'both' });
  });
  return { current, tip, branches };
}

export function FastModeElectric() {
  const ref = React.useRef<SVGSVGElement>(null);
  const rimRef = React.useRef<SVGRectElement>(null);
  const uiMode = useUiMode();
  const [geometry, setGeometry] = React.useState<{ width: number; height: number; edge: number; radius: number }>();

  React.useEffect(() => {
    const svg = ref.current;
    const box = svg?.parentElement;
    if (!svg || !box || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (width < 12 + 2 * bleed || height < 12 + 2 * bleed) return;
      const style = getComputedStyle(box);
      const border = Number.parseFloat(style.borderTopWidth) || 0;
      // A real border is stroked inside the box; Zen draws its 1px ring as a shadow just outside it.
      const line = border > 0 ? border / 2 : -0.5;
      // The SVG starts `bleed` pixels outside the padding box, which sits `border` inside the box.
      const edge = bleed - border + line;
      const outerRadius = Number.parseFloat(style.borderTopLeftRadius) || 0;
      const radius = Math.max(0, Math.min(outerRadius - line, Math.min(width, height) / 2 - edge));
      setGeometry((last) => last?.width === width && last.height === height && last.edge === edge && last.radius === radius
        ? last : { width, height, edge, radius });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(svg);
    measure();
    return () => resize.disconnect();
  }, [uiMode]);

  React.useEffect(() => {
    const svg = ref.current;
    const rim = rimRef.current;
    if (!svg || !geometry || !rim || typeof rim.getTotalLength !== 'function') return;
    const perimeter = rim.getTotalLength();
    if (!perimeter) return;
    // Up to 3.25px either side of the border line: a zigzag about 6.5px wide, centred on it.
    const swing = Math.min(3.25, (Math.min(geometry.width, geometry.height) - 2 * bleed) / 8, Math.max(1, geometry.radius * 0.82));
    const groups = Array.from(svg.querySelectorAll<SVGGElement>('.fast-mode-electric-bolt'));
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const active = new Map<SVGGElement, ReturnType<typeof discharge> & { span: RimSpan }>();
    const cancel = (arc: ReturnType<typeof discharge>) => {
      arc.current.onfinish = null;
      arc.current.cancel();
      arc.tip.cancel();
      arc.branches.forEach((branch) => branch.cancel());
    };
    const stop = () => {
      active.forEach(cancel);
      active.clear();
    };
    const start = () => {
      stop();
      if (motion.matches || document.hidden) {
        groups.forEach((group, i) => paint(group, rim, perimeter, swing, stillSpans[i]));
        return;
      }
      groups.forEach((group, i) => {
        const next = (delay: number) => {
          const span = reserveSpan(Array.from(active.values(), (arc) => arc.span));
          const arc = { span, ...discharge(paint(group, rim, perimeter, swing, span), delay) };
          active.set(group, arc);
          arc.current.onfinish = () => {
            if (active.get(group) !== arc) return;
            cancel(arc);
            active.delete(group);
            next(timeBetween(90, 250));
          };
        };
        next(i * timeBetween(45, 125));
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
  }, [geometry]);

  return (
    <svg
      ref={ref}
      className="fast-mode-electric"
      style={{ top: -bleed, left: -bleed, width: `calc(100% + ${2 * bleed}px)`, height: `calc(100% + ${2 * bleed}px)` }}
      viewBox={geometry && `0 0 ${geometry.width} ${geometry.height}`}
      aria-hidden="true"
      focusable="false"
    >
      {geometry && <>
        {/* The rim traces the centre of the composer's visible border. */}
        <rect ref={rimRef} x={geometry.edge} y={geometry.edge} width={geometry.width - 2 * geometry.edge} height={geometry.height - 2 * geometry.edge} rx={geometry.radius} visibility="hidden" />
        {stillSpans.map(({ start }) => (
          <g className="fast-mode-electric-bolt" key={start}>
            <path className="fast-mode-electric-trace" pathLength={rimLength} />
            <path className="fast-mode-electric-head" pathLength={rimLength} strokeDasharray={`${headLength} ${rimLength}`} />
            {twigSlots.map((i) => <path className="fast-mode-electric-fork" pathLength={rimLength} key={i} />)}
          </g>
        ))}
      </>}
    </svg>
  );
}
