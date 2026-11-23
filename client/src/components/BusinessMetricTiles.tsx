import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Segmented, Spin, Tooltip } from 'antd';
import { BarChartOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { getBusinessMetrics } from '../api';
import type { BusinessMetric, BusinessMetricsResponse } from '../types';
import { DOMAIN_COLOR, Delta, bucketLabel } from './BusinessMetrics';

/**
 * Dashboard › Business measures — one tile per leadership measure (the same
 * 11 as the Business Metrics & Analysis tab, Vehicles Sold included), each a
 * column chart of quantity (y) per period over time (x). Live from
 * production telemetry (GET /api/business-kpis/metrics).
 */

const WINDOWS = [
  { label: '6 h', value: 6 },
  { label: '24 h', value: 24 },
  { label: '7 days', value: 168 },
  { label: '30 days', value: 720 },
];
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100_000 ? 1 : 0 }).format(n);

/** A round axis maximum ≥ max, and its tick values (0 … max in 2–4 steps). */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  const stepInt = max < 4 ? Math.max(1, Math.ceil(step)) : step;
  const ticks: number[] = [];
  for (let v = 0; v < max + stepInt * 0.999; v += stepInt) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

interface ColumnChartProps {
  values: number[];
  buckets: number[];
  stepSeconds: number;
  color: string;
  unit: string;
  label: string;
}

/** Quantity per period: y = count, x = time. Hover a column for its exact value. */
function ColumnChart({ values, buckets, stepSeconds, color, unit, label }: ColumnChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 250; const H = 110;
  const PAD = { l: 30, r: 4, t: 6, b: 18 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const ticks = niceTicks(Math.max(0, ...values));
  const yMax = ticks[ticks.length - 1] || 1;
  const n = Math.max(1, values.length);
  const slot = plotW / n;
  const barW = Math.max(1.5, slot - 2); // 2px gap between columns
  const y = (v: number) => PAD.t + plotH - (v / yMax) * plotH;
  const xLabels = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && buckets[v] !== undefined);

  return (
    <div>
      <div className="h-4 text-[11px] text-slate-600">
        {hover !== null ? <><span className="text-slate-500">{bucketLabel(buckets[hover], stepSeconds)}</span> · <span className="font-semibold text-slate-800">{values[hover].toLocaleString()}</span> {unit}</> : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} per period`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#cbd5e1' : '#eef2f7'} strokeWidth={1} />
            <text x={PAD.l - 4} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#64748b">{compact(t)}</text>
          </g>
        ))}
        {values.map((v, i) => {
          const x = PAD.l + i * slot + (slot - barW) / 2;
          const h = Math.max(0, y(0) - y(v));
          return (
            <g key={buckets[i] ?? i} onMouseEnter={() => setHover(i)}>
              {/* hit target: the full slot height, wider than the mark */}
              <rect x={PAD.l + i * slot} y={PAD.t} width={slot} height={plotH} fill="transparent" />
              {v > 0 ? (
                <path
                  d={h > 3
                    ? `M${x},${y(0)} V${y(v) + 2} Q${x},${y(v)} ${x + 2},${y(v)} H${x + barW - 2} Q${x + barW},${y(v)} ${x + barW},${y(v) + 2} V${y(0)} Z`
                    : `M${x},${y(0)} V${y(0) - Math.max(1.5, h)} H${x + barW} V${y(0)} Z`}
                  fill={color}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              ) : null}
            </g>
          );
        })}
        {xLabels.map((i, k) => (
          <text key={i} x={PAD.l + i * slot + slot / 2} y={H - 4} fontSize={10} fill="#64748b" textAnchor={k === 0 ? 'start' : k === xLabels.length - 1 ? 'end' : 'middle'}>
            {bucketLabel(buckets[i], stepSeconds)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function MeasureTile({ metric, buckets, stepSeconds }: { metric: BusinessMetric; buckets: number[]; stepSeconds: number }) {
  const color = DOMAIN_COLOR[metric.domain] || '#2a78d6';
  const totals = useMemo(() => buckets.map((_, i) => metric.series.reduce((n, s) => n + (s.points[i] || 0), 0)), [metric, buckets]);
  const top = metric.dimensions.find((d) => d.total > 0);
  return (
    <div className="rounded-lg border border-solid border-slate-200 bg-white p-3" style={{ boxShadow: `inset 3px 0 0 ${color}` }}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold leading-tight text-slate-800">{metric.label}</span>
        <Tooltip title={<div><div>{metric.definition}</div><div className="mt-1 opacity-80">Counted at: {metric.source}</div></div>} overlayStyle={{ maxWidth: 360 }}>
          <InfoCircleOutlined className="mt-0.5 text-slate-400" />
        </Tooltip>
      </div>
      <div className="text-[11px] text-slate-500">{metric.domain}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-slate-900">{compact(metric.total)}</span>
        <span className="text-xs text-slate-500">{metric.unit}</span>
        <span className="ml-auto"><Delta metric={metric} /></span>
      </div>
      <div className="h-4 truncate text-[11px] text-slate-500">
        {metric.value !== null && metric.valueLabel ? <>{metric.valueLabel} {money(metric.value)}</> : null}
        {metric.value !== null && metric.valueLabel && top ? ' · ' : null}
        {top ? <>top {metric.dimensionLabel.toLowerCase()}: {top.dimension}</> : null}
      </div>
      <ColumnChart values={totals} buckets={buckets} stepSeconds={stepSeconds} color={color} unit={metric.unit} label={metric.label} />
    </div>
  );
}

export default function BusinessMetricTiles() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<BusinessMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getBusinessMetrics(hours));
      setError(null);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load business measures');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const step = data?.stepSeconds || 3600;
  const per = step >= 86400 ? 'day' : step >= 3600 ? 'hour' : `${step / 60} minutes`;

  return (
    <section className="rounded-xl border border-solid border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BarChartOutlined className="text-slate-500" />
        <h2 className="m-0 text-base font-semibold text-slate-800">Business measures</h2>
        <span className="text-xs text-slate-500">quantity per {per}, live from production telemetry · change vs the previous {hours >= 168 ? `${hours / 24} days` : `${hours} hours`}</span>
        {loading ? <Spin size="small" /> : null}
        <Segmented className="ml-auto" size="small" value={hours} onChange={(v) => setHours(Number(v))} options={WINDOWS} />
      </div>
      {error ? <Alert type="warning" showIcon message="Business telemetry unavailable" description={<>{error} Start it with <code>mockprod/stack.sh start</code>.</>} /> : null}
      {data && !error ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {data.metrics.map((m) => <MeasureTile key={m.id} metric={m} buckets={data.buckets} stepSeconds={data.stepSeconds} />)}
        </div>
      ) : null}
    </section>
  );
}
