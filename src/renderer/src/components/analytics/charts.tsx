/**
 * Chart primitives for the analytics dashboard, drawn as plain SVG so they follow the theme
 * tokens: stacked columns, lines, sparklines, horizontal bar lists, a part-to-whole bar, a meter
 * and a calendar heatmap. Every chart has hover values, a legend for two or more series and a
 * table twin (ChartCard), so no value is reachable through colour alone.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui';
import { fmtDay, fmtDayLong, fmtPct, type ChartSeries } from './model';

const M = { top: 10, right: 12, bottom: 24, left: 48 };

function useWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth) setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Clean axis ticks (1, 2, 5 × 10ⁿ steps) from zero to the first tick at or above `max`. */
export function niceTicks(max: number, count = 4, integer = false): number[] {
  if (!(max > 0)) return [0];
  const rough = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  let step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow * 10;
  if (integer) step = Math.max(1, Math.ceil(step));
  const ticks: number[] = [];
  for (let i = 0; i * step < max; i++) ticks.push(i * step);
  ticks.push(ticks.length * step);
  return ticks;
}

/** A rect with 4px rounded top corners, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

function Swatch({ color, line }: { color: string; line?: boolean }) {
  return <span className={`swatch ${line ? 'swatch-line' : ''}`} style={{ background: color }} aria-hidden />;
}

interface TipRow {
  label: string;
  value: string;
  color?: string;
}

function ChartTip({ x, width, title, rows, footer }: { x: number; width: number; title: string; rows: TipRow[]; footer?: string }) {
  const style: React.CSSProperties = x > width / 2 ? { right: width - x + 10 } : { left: x + 10 };
  return (
    <div className="chart-tip" style={style} role="status">
      <div className="chart-tip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="chart-tip-row">
          {r.color && <Swatch color={r.color} line />}
          <span className="chart-tip-value">{r.value}</span>
          <span className="chart-tip-label">{r.label}</span>
        </div>
      ))}
      {footer && <div className="chart-tip-footer">{footer}</div>}
    </div>
  );
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
}

/** Series keys; clickable entries hide and show a series, static ones only name the colours. */
export function Legend({ items, hidden, onToggle, line }: { items: LegendItem[]; hidden?: Set<string>; onToggle?: (key: string) => void; line?: boolean }) {
  return (
    <div className="chart-legend" role="list">
      {items.map((s) =>
        onToggle ? (
          <button key={s.key} type="button" role="listitem" className={`legend-item ${hidden?.has(s.key) ? 'off' : ''}`} onClick={() => onToggle(s.key)} title={hidden?.has(s.key) ? `Show ${s.label}` : `Hide ${s.label}`} aria-pressed={!hidden?.has(s.key)}>
            <Swatch color={s.color} line={line} />
            {s.label}
          </button>
        ) : (
          <span key={s.key} role="listitem" className="legend-item static">
            <Swatch color={s.color} line={line} />
            {s.label}
          </span>
        )
      )}
    </div>
  );
}

function useHidden(): [Set<string>, (key: string) => void] {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return [hidden, toggle];
}

function xLabelEvery(n: number, plotW: number): number {
  return Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 58))));
}

/** Label every k-th day and the last one, skipping a periodic label closer than a full period to the last. */
function showXLabel(i: number, n: number, every: number): boolean {
  if (i === n - 1) return true;
  return i % every === 0 && n - 1 - i >= every;
}

/** Two or more series need a legend; so does a lone fallback series, whose grey says nothing by itself. */
function needsLegend(series: ChartSeries[]): boolean {
  return series.length >= 2 || series.some((s) => s.key.startsWith('__'));
}

function keyNav(e: React.KeyboardEvent, n: number, hover: number | null, setHover: (i: number | null) => void): void {
  if (e.key === 'ArrowRight') setHover(hover === null ? 0 : Math.min(n - 1, hover + 1));
  else if (e.key === 'ArrowLeft') setHover(hover === null ? n - 1 : Math.max(0, hover - 1));
  else if (e.key === 'Home') setHover(0);
  else if (e.key === 'End') setHover(n - 1);
  else if (e.key === 'Escape') setHover(null);
  else return;
  e.preventDefault();
}

function Axis({ ticks, y, width, axis }: { ticks: number[]; y: (v: number) => number; width: number; axis: (v: number) => string }) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line className={t === 0 ? 'chart-baseline' : 'chart-grid'} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
          <text className="chart-axis" x={M.left - 6} y={y(t)} dy={3} textAnchor="end">
            {axis(t)}
          </text>
        </g>
      ))}
    </>
  );
}

export interface ColumnChartProps {
  dates: string[];
  series: ChartSeries[];
  format: (v: number) => string;
  axis?: (v: number) => string;
  /** Whole-number axis ticks (counts). */
  integer?: boolean;
  height?: number;
  ariaLabel: string;
  emptyText?: string;
}

/** Stacked columns per day: ≤ 24px wide, 4px rounded caps, 2px surface gaps between segments. */
export function ColumnChart({ dates, series, format, axis = format, integer, height = 210, ariaLabel, emptyText = 'Nothing recorded in this range yet.' }: ColumnChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hidden, toggle] = useHidden();
  const [hover, setHover] = useState<number | null>(null);
  const visible = series.filter((s) => !hidden.has(s.key));
  const n = dates.length;
  const hasData = series.some((s) => s.values.some((v) => (v ?? 0) > 0));
  if (n === 0 || !hasData) return <div className="chart-empty">{emptyText}</div>;

  const totals = dates.map((_, i) => visible.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals), 4, integer);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const band = plotW / n;
  const barW = Math.min(24, Math.max(2, band * 0.68));
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  const every = xLabelEvery(n, plotW);
  const tipRows: TipRow[] = hover === null ? [] : [...visible].reverse().filter((s) => (s.values[hover] ?? 0) > 0).map((s) => ({ label: s.label, value: format(s.values[hover] ?? 0), color: s.color }));

  return (
    <div className="chart" ref={ref}>
      {needsLegend(series) && <Legend items={series} hidden={hidden} onToggle={toggle} />}
      <svg width={width} height={height} role="img" aria-label={ariaLabel} tabIndex={0} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)} onKeyDown={(e) => keyNav(e, n, hover, setHover)}>
        <Axis ticks={ticks} y={y} width={width} axis={axis} />
        {dates.map((d, i) => {
          const x = M.left + i * band + (band - barW) / 2;
          let acc = 0;
          const segs: React.ReactNode[] = [];
          for (const s of visible) {
            const v = s.values[i] ?? 0;
            if (v <= 0) continue;
            const y1 = y(acc + v);
            const y0 = y(acc);
            const gap = acc === 0 ? 0 : 2;
            acc += v;
            const h = y0 - y1 - gap;
            if (h < 0.5) continue;
            const isTop = acc >= totals[i] - 1e-9;
            segs.push(isTop ? <path key={s.key} d={columnPath(x, y1, barW, h)} style={{ fill: s.color }} /> : <rect key={s.key} x={x} y={y1} width={barW} height={h} style={{ fill: s.color }} />);
          }
          const label = showXLabel(i, n, every);
          return (
            <g key={d} className={`chart-col ${hover === i ? 'hover' : hover === null ? '' : 'dim'}`}>
              {segs}
              {label && (
                <text className="chart-axis" x={M.left + i * band + band / 2} y={height - 7} textAnchor="middle">
                  {fmtDay(d)}
                </text>
              )}
              <rect className="chart-hit" x={M.left + i * band} y={M.top} width={band} height={plotH} onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && <ChartTip x={M.left + hover * band + band / 2} width={width} title={fmtDayLong(dates[hover])} rows={tipRows.length ? tipRows : [{ label: 'recorded', value: format(0) }]} footer={visible.length > 1 && tipRows.length > 1 ? `${format(totals[hover])} total` : undefined} />}
    </div>
  );
}

export interface LineChartProps {
  dates: string[];
  series: ChartSeries[];
  format: (v: number) => string;
  axis?: (v: number) => string;
  integer?: boolean;
  height?: number;
  ariaLabel: string;
  emptyText?: string;
  /** Fill the area under a single series with a wash of its colour. */
  area?: boolean;
}

/** 2px lines with ≥ 8px ringed markers; a crosshair snaps to the nearest day and lists every series. */
export function LineChart({ dates, series, format, axis = format, integer, height = 210, ariaLabel, emptyText = 'No samples in this range yet.', area }: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hidden, toggle] = useHidden();
  const [hover, setHover] = useState<number | null>(null);
  const visible = series.filter((s) => !hidden.has(s.key));
  const n = dates.length;
  const hasData = series.some((s) => s.values.some((v) => v !== null && v > 0));
  if (n === 0 || !hasData) return <div className="chart-empty">{emptyText}</div>;

  const all = visible.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.max(0, ...all), 4, integer);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = height - M.top - M.bottom;
  const step = n > 1 ? plotW / (n - 1) : 0;
  const x = (i: number) => (n > 1 ? M.left + i * step : M.left + plotW / 2);
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  const every = xLabelEvery(n, plotW);
  // Ringed markers on every point only while they stay sparse; longer ranges mark the hovered day.
  const markers = n <= 14;

  const pathOf = (values: (number | null)[]): string => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const areaOf = (values: (number | null)[]): string => {
    let d = '';
    let start = -1;
    for (let i = 0; i <= values.length; i++) {
      const v = i < values.length ? values[i] : null;
      if (v !== null && start === -1) start = i;
      if (v === null && start !== -1) {
        d += `M${x(start).toFixed(1)} ${y(0).toFixed(1)}`;
        for (let j = start; j < i; j++) d += `L${x(j).toFixed(1)} ${y(values[j] as number).toFixed(1)}`;
        d += `L${x(i - 1).toFixed(1)} ${y(0).toFixed(1)}Z`;
        start = -1;
      }
    }
    return d;
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    setHover(n > 1 ? Math.max(0, Math.min(n - 1, Math.round(px / step))) : 0);
  };
  const tipRows: TipRow[] = hover === null ? [] : visible.filter((s) => s.values[hover] !== null).map((s) => ({ label: s.label, value: format(s.values[hover] as number), color: s.color }));

  return (
    <div className="chart" ref={ref}>
      {needsLegend(series) && <Legend items={series} hidden={hidden} onToggle={toggle} line />}
      <svg width={width} height={height} role="img" aria-label={ariaLabel} tabIndex={0} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)} onKeyDown={(e) => keyNav(e, n, hover, setHover)}>
        <Axis ticks={ticks} y={y} width={width} axis={axis} />
        {dates.map((d, i) =>
          showXLabel(i, n, every) ? (
            <text key={d} className="chart-axis" x={x(i)} y={height - 7} textAnchor="middle">
              {fmtDay(d)}
            </text>
          ) : null
        )}
        {area && visible.length === 1 && <path className="chart-area" d={areaOf(visible[0].values)} style={{ fill: visible[0].color }} />}
        {visible.map((s) => (
          <g key={s.key}>
            <path className="chart-line" d={pathOf(s.values)} style={{ stroke: s.color }} />
            {s.values.map((v, i) => (v !== null && (markers || hover === i) ? <circle key={i} className="chart-marker" cx={x(i)} cy={y(v)} r={4} style={{ fill: s.color }} /> : null))}
          </g>
        ))}
        {hover !== null && <line className="chart-crosshair" x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + plotH} />}
        <rect className="chart-hit" x={M.left} y={M.top} width={plotW} height={plotH} onPointerMove={onMove} onPointerEnter={onMove} />
      </svg>
      {hover !== null && <ChartTip x={x(hover)} width={width} title={fmtDayLong(dates[hover])} rows={tipRows.length ? tipRows : [{ label: 'no sample', value: '—' }]} />}
    </div>
  );
}

/** A small trend for a stat tile: de-emphasised line, latest point in the accent. */
export function Sparkline({ values, width = 88, height = 26 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(0, ...values);
  if (values.length < 2 || max <= 0) return null;
  const step = (width - 6) / (values.length - 1);
  const pts = values.map((v, i) => `${(3 + i * step).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`);
  const [lx, ly] = pts[pts.length - 1].split(',');
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline points={pts.join(' ')} />
      <circle cx={lx} cy={ly} r={2.5} />
    </svg>
  );
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  sub?: string;
  title?: string;
  color?: string;
}

/** Horizontal bars for nominal categories: one hue, value at the tip, share of the total beside it. */
export function BarList({ rows, format, share = true, limit = 8, emptyText = 'Nothing recorded yet.' }: { rows: BarRow[]; format: (v: number) => string; share?: boolean; limit?: number; emptyText?: string }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <div className="chart-empty">{emptyText}</div>;
  const max = Math.max(0, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className="hbars">
      {shown.map((r) => (
        <div key={r.key} className="hbar" title={r.title ?? r.label}>
          <div className="hbar-label">
            <span className="hbar-name">{r.label}</span>
            {r.sub && <span className="hbar-sub">{r.sub}</span>}
          </div>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${max > 0 ? Math.max(1, (r.value / max) * 100) : 0}%`, background: r.color ?? 'var(--accent)' }} />
          </span>
          <span className="hbar-value">{format(r.value)}</span>
          {share && <span className="hbar-share">{total > 0 ? fmtPct(r.value / total) : ''}</span>}
        </div>
      ))}
      {rows.length > limit && (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      )}
    </div>
  );
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** One part-to-whole bar with 2px surface gaps, and a legend that carries the values. */
export function StackedBar({ segments, format, legend = true, height = 10, title }: { segments: Segment[]; format: (v: number) => string; legend?: boolean; height?: number; title?: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const live = segments.filter((s) => s.value > 0);
  return (
    <div className="stackbar-wrap">
      <div className="stackbar" style={{ height }} role="img" aria-label={title ?? live.map((s) => `${s.label} ${format(s.value)}`).join(', ')}>
        {total > 0 ? live.map((s) => <span key={s.key} style={{ flexGrow: s.value, background: s.color }} title={`${s.label} · ${format(s.value)} · ${fmtPct(s.value / total)}`} />) : <span className="stackbar-empty" />}
      </div>
      {legend && (
        <div className="stackbar-legend">
          {segments.map((s) => (
            <span key={s.key} className="stackbar-key" title={`${s.label} · ${fmtPct(total > 0 ? s.value / total : 0)}`}>
              <Swatch color={s.color} />
              <span className="stackbar-key-label">{s.label}</span>
              <span className="stackbar-key-value">{format(s.value)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A ratio against 100%: the track is a lighter step of the fill's own colour. */
export function Meter({ value, label, sub, tone = 'accent', title }: { value: number | null; label: string; sub?: string; tone?: 'accent' | 'amber' | 'red'; title?: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="meter" title={title}>
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">{fmtPct(value)}</span>
      </div>
      <div className={`meter-track tone-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      {sub && <div className="meter-sub">{sub}</div>}
    </div>
  );
}

/** Calendar heatmap (weeks × weekdays) of one value per UTC day, in five steps of the accent hue. */
export function Heatmap({ dates, values, format, ariaLabel }: { dates: string[]; values: number[]; format: (v: number) => string; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  const cells = useMemo(() => {
    if (dates.length === 0) return [];
    const byDate = new Map(dates.map((d, i) => [d, values[i] ?? 0]));
    const first = new Date(`${dates[0]}T00:00:00Z`);
    const last = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return [];
    // Start on the Monday of the first week so columns are whole weeks.
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
    const out: { date: string; value: number; col: number; row: number }[] = [];
    for (let t = first.getTime(), col = 0, i = 0; t <= last.getTime() && i < 400; t += 86_400_000, i++) {
      const date = new Date(t).toISOString().slice(0, 10);
      const row = (new Date(t).getUTCDay() + 6) % 7;
      if (row === 0 && i > 0) col++;
      out.push({ date, value: byDate.get(date) ?? 0, col, row });
    }
    return out;
  }, [dates, values]);
  if (cells.length === 0) return <div className="chart-empty">Nothing recorded in this range yet.</div>;
  const max = Math.max(0, ...cells.map((c) => c.value));
  const cols = cells[cells.length - 1].col + 1;
  const size = 13;
  const gap = 3;
  const left = 30;
  const topPad = 16;
  const level = (v: number) => (v <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4)));
  const h = topPad + 7 * (size + gap);
  const w = Math.max(width, left + cols * (size + gap));
  // One label per month, on the first week that starts inside it.
  const months: { col: number; label: string }[] = [];
  let lastMonth = '';
  for (const c of cells) {
    if (c.row !== 0) continue;
    const month = c.date.slice(0, 7);
    if (month === lastMonth) continue;
    lastMonth = month;
    months.push({ col: c.col, label: fmtDay(c.date).split(' ')[0] });
  }
  const hovered = hover === null ? null : cells[hover];
  return (
    <div className="chart heatmap" ref={ref}>
      <svg width={w} height={h} role="img" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
        {months.map((m) => (
          <text key={m.col} className="chart-axis" x={left + m.col * (size + gap)} y={10}>
            {m.label}
          </text>
        ))}
        {['Mon', 'Wed', 'Fri'].map((d, i) => (
          <text key={d} className="chart-axis" x={0} y={topPad + i * 2 * (size + gap) + size - 3}>
            {d}
          </text>
        ))}
        {cells.map((c, i) => (
          <rect key={c.date} className={`hm-cell hm-${level(c.value)} ${hover === i ? 'hover' : ''}`} x={left + c.col * (size + gap)} y={topPad + c.row * (size + gap)} width={size} height={size} rx={2} onPointerEnter={() => setHover(i)}>
            <title>{`${fmtDayLong(c.date)} · ${format(c.value)}`}</title>
          </rect>
        ))}
      </svg>
      {hovered && <ChartTip x={left + hovered.col * (size + gap)} width={w} title={fmtDayLong(hovered.date)} rows={[{ label: 'recorded', value: format(hovered.value) }]} />}
    </div>
  );
}

export interface TableSpec {
  columns: { label: string; numeric?: boolean }[];
  rows: React.ReactNode[][];
}

export function DataTable({ table, compact }: { table: TableSpec; compact?: boolean }) {
  return (
    <div className="atable-wrap">
      <table className={`atable ${compact ? 'compact' : ''}`}>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.label} className={c.numeric ? 'num' : ''}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} className={table.columns[j]?.numeric ? 'num' : ''}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Builds a table twin for a day-indexed chart: one row per day (latest first), one column per series. */
export function seriesTable(dates: string[], series: ChartSeries[], format: (v: number) => string): TableSpec {
  return {
    columns: [{ label: 'Day' }, ...series.map((s) => ({ label: s.label, numeric: true }))],
    rows: dates.map((d, i) => [fmtDayLong(d), ...series.map((s) => (s.values[i] === null ? '—' : format(s.values[i] as number)))]).reverse()
  };
}

/**
 * The card every chart sits in: a title, an optional subtitle and toolbar, and a table toggle that
 * swaps the plot for its data when `table` is given.
 */
export function ChartCard({ title, subtitle, actions, table, children, className, wide }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; table?: TableSpec; children: React.ReactNode; className?: string; wide?: boolean }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={`acard ${wide ? 'acard-wide' : ''} ${className ?? ''}`}>
      <header className="acard-head">
        <div className="acard-titles">
          <h3 className="acard-title">{title}</h3>
          {subtitle && <div className="acard-sub">{subtitle}</div>}
        </div>
        <div className="acard-actions">
          {actions}
          {table && <Button variant="ghost" size="sm" icon={showTable ? 'chart' : 'table'} className={showTable ? 'active' : ''} onClick={() => setShowTable((v) => !v)} title={showTable ? 'Show chart' : 'Show as table'} aria-pressed={showTable} />}
        </div>
      </header>
      <div className="acard-body">{table && showTable ? <DataTable table={table} compact /> : children}</div>
    </section>
  );
}

/** A segmented control for a small, exclusive set of options. */
export function Segmented<T extends string | number>({ value, options, onChange, ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={`segment ${o.value === value ? 'active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
