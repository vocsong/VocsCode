import React from 'react';

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
const point = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const slots = ['edge', 'end', 'anywhere'] as const;
const inset = 2.5;

// Sample a rounded rim in CSS pixels; stretching one path would flatten the corners on wide pills.
function traceArc(at: (distance: number) => DOMPoint, center: number, length: number) {
  const nodes = Math.ceil(length / 3);
  const branchAt = Math.floor(randomBetween(1, nodes));
  let fork = '';
  let trunk = '';
  for (let i = 0; i <= nodes; i++) {
    const tip = i === 0 || i === nodes;
    const progress = (i + (tip ? 0 : randomBetween(-0.32, 0.32))) / nodes;
    const distance = center + (progress - 0.5) * length;
    const base = at(distance);
    const before = at(distance - 0.5);
    const after = at(distance + 0.5);
    const magnitude = Math.hypot(after.x - before.x, after.y - before.y) || 1;
    const tx = (after.x - before.x) / magnitude;
    const ty = (after.y - before.y) / magnitude;
    const offset = tip ? 0 : randomBetween(-1.4, 1.8);
    const x = base.x - ty * offset;
    const y = base.y + tx * offset;
    trunk += `${i === 0 ? 'M' : ' L'}${point(x, y)}`;
    if (i === branchAt) {
      const reach = randomBetween(4, 8) * (Math.random() < 0.25 ? -1 : 1);
      const spread = randomBetween(1.6, 3);
      const branchPoint = (along: number, inward: number) => point(x + tx * along - ty * inward, y + ty * along + tx * inward);
      fork = `M${point(x, y)} L${branchPoint(reach * 0.45, spread * 0.7)} L${branchPoint(reach, spread)}`;
    }
  }
  return { trunk, fork };
}

export function FastModeElectric() {
  const ref = React.useRef<SVGSVGElement>(null);
  const rimRef = React.useRef<SVGRectElement>(null);

  React.useEffect(() => {
    const svg = ref.current;
    const rim = rimRef.current;
    if (!svg || !rim || typeof rim.getTotalLength !== 'function') return;
    const groups = Array.from(svg.querySelectorAll('g'));
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const timers: number[] = [];
    const fades: Animation[] = [];

    const stop = () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      fades.forEach((fade) => fade.cancel());
    };
    const reset = () => {
      stop();
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (width < 12 || height < 12) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const rimWidth = width - 2 * inset;
      const rimHeight = height - 2 * inset;
      const radius = Math.min(5, rimWidth / 2, rimHeight / 2);
      rim.setAttribute('width', String(rimWidth));
      rim.setAttribute('height', String(rimHeight));
      rim.setAttribute('rx', String(radius));
      const perimeter = rim.getTotalLength();
      if (!perimeter) return;
      const topLength = rimWidth - 2 * radius;
      const at = (distance: number) => rim.getPointAtLength(((distance % perimeter) + perimeter) % perimeter);
      const moving = !motion.matches && !document.hidden;
      const recentSides: number[][] = [[], []];

      const strike = (index: number) => {
        const group = groups[index];
        const [trunkPath, forkPath] = group.querySelectorAll('path');
        const slot = slots[index];
        // Give the short ends their own sparks. Avoid three strikes in a row on the same side.
        const history = recentSides[index];
        const side = history?.length === 2 && history[0] === history[1] ? 1 - history[0] : Math.floor(Math.random() * 2);
        if (history) {
          history.push(side);
          if (history.length > 2) history.shift();
        }
        const opposite = side * perimeter / 2;
        const center = slot === 'end' ? opposite + (topLength + perimeter / 2) / 2 + randomBetween(-7, 7)
          : slot === 'edge' ? opposite + randomBetween(0, topLength) : randomBetween(0, perimeter);
        const length = slot === 'end' ? randomBetween(8, 19) : randomBetween(12, 36);
        const { trunk, fork } = traceArc(at, center, length);
        trunkPath.setAttribute('d', trunk);
        forkPath.setAttribute('d', fork);
        const brightness = moving ? randomBetween(0.6, 0.95) : 0.55;
        group.style.opacity = String(brightness);
        if (!moving) return;
        fades[index]?.cancel();
        fades[index] = group.animate([
          { opacity: brightness },
          { opacity: brightness * 0.65, offset: 0.34 },
          { opacity: 0 },
        ], { duration: randomBetween(145, 280), fill: 'forwards' });
        timers[index] = window.setTimeout(() => strike(index), randomBetween(250, 440));
      };

      groups.forEach((group, index) => {
        if (moving && index > 0) {
          group.style.opacity = '0';
          timers[index] = window.setTimeout(() => strike(index), randomBetween(40, 160));
        } else {
          strike(index);
        }
      });
    };

    const resize = new ResizeObserver(reset);
    resize.observe(svg);
    motion.addEventListener('change', reset);
    document.addEventListener('visibilitychange', reset);
    reset();
    return () => {
      stop();
      resize.disconnect();
      motion.removeEventListener('change', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, []);

  return (
    <svg ref={ref} className="fast-mode-electric" aria-hidden="true" focusable="false">
      <rect ref={rimRef} x={inset} y={inset} visibility="hidden" />
      {slots.map((slot) => <g key={slot}><path /><path className="fast-mode-electric-fork" /></g>)}
    </svg>
  );
}
