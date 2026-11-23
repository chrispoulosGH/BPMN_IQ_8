import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Segmented, Spin, Table, Tag, Tooltip } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, InfoCircleOutlined, MinusOutlined, ReloadOutlined } from '@ant-design/icons';
import Plot from 'react-plotly.js';
import { getBusinessMetrics } from '../api';
import type { BusinessMetric, BusinessMetricsResponse } from '../types';

/**
 * Business Metrics & Analysis: leadership measures derived from the business
 * flows, each counted once by the task that completes it (see
 * server/routes/businessKpis.js /metrics). KPI tiles on top; a 3D column chart
 * (measure × time × volume, stacked by breakdown) in the style of the YoY
 * Feature Cost chart; a table view of the same numbers.
 */

// Columns are colored by business domain (fixed order, validated palette) —
// 11 measures is too many hues; each measure is named on the X axis.
const DOMAIN_ORDER = [
  'Sales & Distribution',
  'Engineering & Product Development',
  'Manufacturing & Supply Chain',
  'After-Sales & Service',
  'Finance & Insurance',
  'Connected Vehicle & Mobility',
];
export const DOMAIN_COLOR: Record<string, string> = {
  'Sales & Distribution': '#2a78d6',
  'Manufacturing & Supply Chain': '#eb6834',
  'After-Sales & Service': '#1baf7a',
  'Finance & Insurance': '#eda100',
  'Connected Vehicle & Mobility': '#e87ba4',
  'Engineering & Product Development': '#6250d6',
};
const WINDOWS = [
  { label: '6 h', value: 6 },
  { label: '24 h', value: 24 },
  { label: '7 d', value: 168 },
  { label: '30 d', value: 720 },
];
const REFRESH_MS = 60_000;

// Same box triangulation as FeatureCost3DChart.
const BOX_I = [7, 0, 0, 0, 4, 4, 6, 6, 4, 0, 3, 2];
const BOX_J = [3, 4, 1, 2, 5, 6, 5, 2, 0, 1, 6, 3];
const BOX_K = [0, 7, 2, 3, 6, 7, 1, 1, 5, 5, 7, 6];
const COL_HALF_WIDTH = 0.36;
const COL_HALF_DEPTH = 0.36;
const DIVIDER_COLOR = 'rgba(255,255,255,0.9)';

const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100_000 ? 1 : 0 }).format(n);

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
/** The domain hue, darker → lighter across a measure's breakdown segments. */
function segmentColor(domain: string, index: number, count: number) {
  const [h, s, l] = hexToHsl(DOMAIN_COLOR[domain] || '#2a78d6');
  const spread = count <= 1 ? 0 : -10 + (index * 22) / (count - 1);
  return `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${Math.min(78, Math.max(28, l + spread)).toFixed(0)}%)`;
}

export function bucketLabel(t: number, stepSeconds: number) {
  const d = new Date(t);
  return stepSeconds >= 86400
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function Delta({ metric }: { metric: BusinessMetric }) {
  if (metric.previousTotal === null) return <span className="text-slate-400 text-xs">no prior period yet</span>;
  if (metric.previousTotal === 0) {
    return metric.total ? <span className="text-slate-500 text-xs">new this period</span> : <span className="text-slate-400 text-xs"><MinusOutlined /> flat</span>;
  }
  const pct = ((metric.total - metric.previousTotal) / metric.previousTotal) * 100;
  if (Math.abs(pct) < 0.5) return <span className="text-slate-500 text-xs"><MinusOutlined /> flat vs prior</span>;
  const up = pct > 0;
  const good = metric.lowerIsBetter ? !up : up;
  return (
    <span className="text-xs font-medium" style={{ color: good ? '#15803d' : '#b91c1c' }}>
      {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(pct).toFixed(0)}% vs prior
    </span>
  );
}

function MetricTile({ metric, selected, onToggle }: { metric: BusinessMetric; selected: boolean; onToggle: () => void }) {
  const color = DOMAIN_COLOR[metric.domain] || '#2a78d6';
  const top = metric.dimensions.filter((d) => d.total > 0).slice(0, 3);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-left rounded-lg bg-white p-3 cursor-pointer border-solid transition-shadow hover:shadow-md"
      style={{ borderWidth: 1, borderColor: selected ? color : '#e2e8f0', boxShadow: selected ? `inset 4px 0 0 ${color}` : undefined, opacity: selected ? 1 : 0.6 }}
      aria-pressed={selected}
      title={selected ? 'Shown in the 3D chart — click to hide' : 'Hidden from the 3D chart — click to show'}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800 leading-tight">{metric.label}</span>
        <Tooltip title={<div><div>{metric.definition}</div><div className="mt-1 opacity-80">Counted at: {metric.source}</div></div>}>
          <InfoCircleOutlined className="text-slate-400 mt-0.5" onClick={(e) => e.stopPropagation()} />
        </Tooltip>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold text-slate-900">{compact(metric.total)}</span>
        <span className="text-xs text-slate-500">{metric.unit}</span>
      </div>
      <Delta metric={metric} />
      {metric.valueLabel && (
        <div className="text-xs text-slate-600 mt-1">{metric.valueLabel}: <span className="font-medium text-slate-800">{money(metric.value || 0)}</span></div>
      )}
      <div className="text-[11px] text-slate-500 mt-1 truncate">
        {top.length ? `${metric.dimensionLabel}: ${top.map((d) => `${d.dimension} ${compact(d.total)}`).join(' · ')}` : `By ${metric.dimensionLabel.toLowerCase()}: no activity yet`}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
        {metric.domain}
      </div>
    </button>
  );
}

export default function BusinessMetrics() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<BusinessMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [scale, setScale] = useState<'index' | 'actual'>('index');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [resetKey, setResetKey] = useState(0);

  const load = useCallback((quiet = false) => {
    if (!quiet) setLoading(true);
    getBusinessMetrics(hours)
      .then((result) => { setData(result); setError(null); })
      .catch((err) => setError(err?.response?.data?.error || err?.message || 'Failed to load business metrics'))
      .finally(() => setLoading(false));
  }, [hours]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Grouped by domain along X, domains in fixed order.
  const ordered = useMemo(() => (data?.metrics || []).slice().sort(
    (a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain),
  ), [data]);
  const shown = useMemo(() => ordered.filter((m) => !hidden.has(m.id)), [ordered, hidden]);

  const toggle = (id: string) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const traces = useMemo(() => {
    if (!data || !shown.length) return [];
    const out: any[] = [];
    const nBuckets = data.buckets.length;
    shown.forEach((metric, mi) => {
      const columnTotals = Array.from({ length: nBuckets }, (_, b) => metric.series.reduce((n, s) => n + (s.points[b] || 0), 0));
      const peak = Math.max(...columnTotals, 0);
      const factor = scale === 'index' ? (peak > 0 ? 100 / peak : 0) : 1;
      const x0 = mi - COL_HALF_WIDTH, x1 = mi + COL_HALF_WIDTH;
      const stackTop = new Array(nBuckets).fill(0);
      const divider = { x: [] as (number | null)[], y: [] as (number | null)[], z: [] as (number | null)[] };

      metric.series.forEach((series, si) => {
        const mesh = { x: [] as number[], y: [] as number[], z: [] as number[], i: [] as number[], j: [] as number[], k: [] as number[], text: [] as string[] };
        series.points.forEach((count, b) => {
          if (count <= 0) return;
          const bottom = stackTop[b];
          const top = bottom + count * factor;
          stackTop[b] = top;
          const z0 = b - COL_HALF_DEPTH, z1 = b + COL_HALF_DEPTH;
          const base = mesh.x.length;
          mesh.x.push(x0, x1, x1, x0, x0, x1, x1, x0);
          mesh.y.push(bottom, bottom, bottom, bottom, top, top, top, top);
          mesh.z.push(z0, z0, z1, z1, z0, z0, z1, z1);
          mesh.i.push(...BOX_I.map((v) => v + base));
          mesh.j.push(...BOX_J.map((v) => v + base));
          mesh.k.push(...BOX_K.map((v) => v + base));
          const pctOfPeak = peak ? ` · column at ${Math.round((columnTotals[b] / peak) * 100)}% of peak` : '';
          const text = `<b>${metric.label}</b><br>${bucketLabel(data.buckets[b], data.stepSeconds)}<br>${metric.dimensionLabel}: ${series.dimension} — ${count.toLocaleString()} ${metric.unit}<br>All ${metric.dimensionLabel.toLowerCase()}s: ${columnTotals[b].toLocaleString()}${pctOfPeak}`;
          for (let v = 0; v < 8; v += 1) mesh.text.push(text);
          // seam at the segment top (white gap between stacked segments)
          divider.x.push(x0, x1, x1, x0, x0, null);
          divider.y.push(top, top, top, top, top, null);
          divider.z.push(z0, z0, z1, z1, z0, null);
        });
        if (!mesh.x.length) return;
        out.push({
          type: 'mesh3d', ...mesh, hovertext: mesh.text, hoverinfo: 'text',
          color: segmentColor(metric.domain, si, metric.series.length), flatshading: true, opacity: 1, showlegend: false,
        });
      });
      if (divider.x.length) {
        out.push({ type: 'scatter3d', mode: 'lines', ...divider, line: { color: DIVIDER_COLOR, width: 2 }, hoverinfo: 'skip', showlegend: false });
      }
      // translucent ribbon tracing the column tops through time (as in the cost chart)
      const ribbon = { x: [] as number[], y: [] as number[], z: [] as number[], i: [] as number[], j: [] as number[], k: [] as number[] };
      for (let b = 0; b < nBuckets - 1; b += 1) {
        if (stackTop[b] <= 0 && stackTop[b + 1] <= 0) continue;
        const base = ribbon.x.length;
        const zb = b + COL_HALF_DEPTH, zf = b + 1 - COL_HALF_DEPTH;
        ribbon.x.push(x0, x1, x1, x0);
        ribbon.y.push(stackTop[b], stackTop[b], stackTop[b + 1], stackTop[b + 1]);
        ribbon.z.push(zb, zb, zf, zf);
        ribbon.i.push(base, base); ribbon.j.push(base + 1, base + 2); ribbon.k.push(base + 2, base + 3);
      }
      if (ribbon.x.length) {
        out.push({ type: 'mesh3d', ...ribbon, color: DOMAIN_COLOR[metric.domain], opacity: 0.25, flatshading: true, hoverinfo: 'skip', showlegend: false });
      }
    });
    return out;
  }, [data, shown, scale]);

  const tableRows = useMemo(() => ordered.map((m) => {
    const row: Record<string, any> = { key: m.id, label: m.label, unit: m.unit, total: m.total, value: m.value };
    (data?.buckets || []).forEach((_, b) => { row[`b${b}`] = m.series.reduce((n, s) => n + (s.points[b] || 0), 0); });
    return row;
  }), [ordered, data]);

  if (loading && !data) return <Spin size="large" style={{ display: 'block', margin: '64px auto' }} />;

  const nBuckets = data?.buckets.length || 0;
  const tickEvery = nBuckets > 12 ? Math.ceil(nBuckets / 8) : 1;
  const xAspect = Math.max(1.2, shown.length * 0.3);
  const zAspect = Math.max(1, nBuckets * 0.075);
  const anyActivity = shown.some((m) => m.total > 0);

  return (
    <div className="p-4 flex flex-col gap-4" style={{ background: '#f8fafc', minHeight: '100%' }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <div className="text-lg font-semibold text-slate-900">Business Metrics &amp; Analysis</div>
          <div className="text-xs text-slate-500">
            Outcomes from the running business processes, each counted once by the task that completes it
            {data ? ` · updated ${new Date(data.generatedAt).toLocaleTimeString()}` : ''}
          </div>
        </div>
        <Segmented size="small" options={WINDOWS} value={hours} onChange={(v) => setHours(Number(v))} />
        <Button size="small" icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>Refresh</Button>
      </div>

      {error && (
        <Alert
          type="warning"
          showIcon
          message="Business metrics are unavailable"
          description={<span>{error} They come from the mock production telemetry; start it with <code>mockprod/stack.sh start</code>.</span>}
        />
      )}

      {data && (
        <>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
            {ordered.map((m) => <MetricTile key={m.id} metric={m} selected={!hidden.has(m.id)} onToggle={() => toggle(m.id)} />)}
          </div>

          <div className="rounded-lg bg-white border border-solid border-slate-200 p-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-slate-800">Volume over time</span>
              <Segmented size="small" value={view} onChange={(v) => setView(v as 'chart' | 'table')} options={[{ label: '3D chart', value: 'chart' }, { label: 'Table', value: 'table' }]} />
              {view === 'chart' && (
                <>
                  <Tooltip title="Measures differ by orders of magnitude (designs vs. vehicles updated). Indexed: each measure's busiest period = 100, so trends compare on one axis. Actual: raw counts.">
                    <Segmented size="small" value={scale} onChange={(v) => setScale(v as 'index' | 'actual')} options={[{ label: 'Indexed (peak = 100)', value: 'index' }, { label: 'Actual counts', value: 'actual' }]} />
                  </Tooltip>
                  <Button size="small" onClick={() => setResetKey((k) => k + 1)}>Reset view</Button>
                  <Button size="small" type="link" onClick={() => setHidden(new Set())} disabled={!hidden.size}>Show all</Button>
                </>
              )}
              <div className="ml-auto flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                {DOMAIN_ORDER.filter((d) => shown.some((m) => m.domain === d)).map((d) => (
                  <span key={d} className="inline-flex items-center gap-1">
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: DOMAIN_COLOR[d], display: 'inline-block' }} />{d}
                  </span>
                ))}
              </div>
            </div>

            {view === 'chart' ? (
              !shown.length ? (
                <Empty description="Select at least one measure above" style={{ margin: '48px 0' }} />
              ) : (
                <div style={{ height: 560, position: 'relative' }}>
                  {!anyActivity && (
                    <div className="absolute inset-x-0 top-4 text-center text-sm text-slate-500 z-10 pointer-events-none">
                      No outcomes recorded in this window yet — the simulator counts each as its flow completes.
                    </div>
                  )}
                  <Plot
                    data={traces}
                    layout={{
                      autosize: true,
                      uirevision: `${hours}::${scale}::${resetKey}`,
                      margin: { l: 0, r: 0, t: 0, b: 0 },
                      scene: {
                        aspectmode: 'manual',
                        aspectratio: { x: xAspect, y: 0.9, z: zAspect },
                        xaxis: {
                          title: { text: '' },
                          tickvals: shown.map((_, i) => i),
                          ticktext: shown.map((m) => m.label.replace(/ /g, '<br>')),
                          tickfont: { size: 10, color: '#334155' },
                          range: [-0.6, shown.length - 0.4],
                        },
                        yaxis: {
                          title: { text: scale === 'index' ? 'Index (peak = 100)' : 'Count', font: { size: 12, color: '#475569' } },
                          tickfont: { size: 10, color: '#64748b' },
                          rangemode: 'tozero',
                          gridcolor: '#e2e8f0',
                        },
                        zaxis: {
                          title: { text: data.stepSeconds >= 86400 ? 'Day' : 'Time', font: { size: 12, color: '#475569' } },
                          tickvals: data.buckets.map((_, i) => i).filter((i) => i % tickEvery === 0 || i === nBuckets - 1),
                          ticktext: data.buckets.map((t, i) => ({ t, i })).filter(({ i }) => i % tickEvery === 0 || i === nBuckets - 1).map(({ t }) => bucketLabel(t, data.stepSeconds)),
                          tickfont: { size: 10, color: '#64748b' },
                          range: [-0.6, nBuckets - 0.4],
                        },
                        // Oblique view: measures across, time receding (oldest at the back), volume up.
                        camera: { eye: { x: 0.55, y: 1.6, z: zAspect * 1.1 + 1.3 }, center: { x: 0, y: -0.12, z: 0 }, up: { x: 0, y: 1, z: 0 } },
                      },
                      showlegend: false,
                      paper_bgcolor: 'transparent',
                    }}
                    config={{ displayModeBar: false, scrollZoom: true }}
                    useResizeHandler
                    style={{ width: '100%', height: '100%' }}
                  />
                </div>
              )
            ) : (
              <Table
                size="small"
                pagination={false}
                scroll={{ x: 'max-content' }}
                dataSource={tableRows}
                columns={[
                  { title: 'Measure', dataIndex: 'label', fixed: 'left', render: (v: string, r: any) => <span><b>{v}</b> <span className="text-slate-400 text-xs">{r.unit}</span></span> },
                  { title: 'Total', dataIndex: 'total', align: 'right' as const, render: (v: number) => v.toLocaleString() },
                  { title: 'Value', dataIndex: 'value', align: 'right' as const, render: (v: number | null) => (v === null ? '' : money(v)) },
                  ...(data.buckets.map((t, b) => ({
                    title: bucketLabel(t, data.stepSeconds),
                    dataIndex: `b${b}`,
                    align: 'right' as const,
                    render: (v: number) => (v ? v.toLocaleString() : <span className="text-slate-300">0</span>),
                  }))),
                ]}
              />
            )}
            <div className="text-xs text-slate-500">
              Each column is one measure in one period, stacked by its breakdown (plant, channel, component…), darker to lighter. Hover a segment for the numbers. Click a tile above to show or hide its measure. Drag to rotate; scroll to zoom.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
