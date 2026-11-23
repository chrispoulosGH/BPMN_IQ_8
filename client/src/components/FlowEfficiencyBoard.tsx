import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Input, Segmented, Select, Spin, Table, Tooltip } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DashboardOutlined, InfoCircleOutlined, MinusOutlined, QuestionOutlined } from '@ant-design/icons';
import { getFlowEfficiency } from '../api';
import type { FlowEfficiencyResponse, FlowEfficiencyRow, FlowEfficiencyTrend, FlowEfficiencyVerdict } from '../types';
import { bucketLabel } from './BusinessMetrics';

/**
 * Dashboard › Throughput per cost — for each business process flow, completed
 * transactions per $1,000 of the flow's allocated cost, over time
 * (GET /api/business-kpis/flow-efficiency). Each flow's index is rebased to
 * its own window average = 100, so flows of very different volume and cost
 * read on one scale. A rising index is favorable; a trend is only called
 * favorable/unfavorable when its slope is statistically significant (|t| ≥ 2).
 */

const WINDOWS = [
  { label: '6 h', value: 6 },
  { label: '24 h', value: 24 },
  { label: '7 days', value: 168 },
  { label: '30 days', value: 720 },
];
// Reserved status colors; always shown with an icon and a label.
const VERDICT: Record<FlowEfficiencyVerdict, { label: string; color: string; ink: string; icon: JSX.Element; order: number }> = {
  unfavorable: { label: 'Unfavorable', color: '#dc2626', ink: '#b91c1c', icon: <ArrowDownOutlined />, order: 0 },
  favorable: { label: 'Favorable', color: '#16a34a', ink: '#15803d', icon: <ArrowUpOutlined />, order: 1 },
  steady: { label: 'Steady', color: '#64748b', ink: '#475569', icon: <MinusOutlined />, order: 2 },
  insufficient: { label: 'Not enough data', color: '#94a3b8', ink: '#64748b', icon: <QuestionOutlined />, order: 3 },
};
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100_000 ? 1 : 0 }).format(n);
const num = (n: number, d = 2) => new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(n);

function VerdictTag({ trend }: { trend: FlowEfficiencyTrend }) {
  const v = VERDICT[trend.verdict];
  const detail = trend.verdict === 'insufficient'
    ? `Only ${trend.observedSteps} period${trend.observedSteps === 1 ? '' : 's'} with telemetry; a trend needs at least 6.`
    : `Fitted change across the window: ${trend.change! > 0 ? '+' : ''}${num(trend.change!, 1)} index points (average = 100). t = ${num(trend.t!, 2)}; |t| ≥ 2 is treated as a real trend (≈95% confidence), anything less as steady.`;
  return (
    <Tooltip title={detail} overlayStyle={{ maxWidth: 320 }}>
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium" style={{ color: v.ink }}>
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-white" style={{ background: v.color }}>{v.icon}</span>
        {v.label}
        {trend.change !== null && trend.verdict !== 'insufficient' ? <span className="font-normal text-slate-500">{trend.change > 0 ? '+' : ''}{num(trend.change, 1)}</span> : null}
      </span>
    </Tooltip>
  );
}

/** Line path with gaps where values are null. */
function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    pen = true;
  });
  return d;
}

/** Fitted least-squares line over the observed points, for the trend overlay. */
function fittedLine(values: (number | null)[]): [number, number] | null {
  const pts = values.map((v, i) => [i, v] as const).filter(([, v]) => v !== null) as [number, number][];
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((a, [x]) => a + x, 0) / n;
  const my = pts.reduce((a, [, y]) => a + y, 0) / n;
  const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0) || 1;
  const slope = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx;
  return [my - slope * mx, slope];
}

function Sparkline({ values, verdict }: { values: (number | null)[]; verdict: FlowEfficiencyVerdict }) {
  const W = 140; const H = 30;
  const obs = values.filter((v): v is number => v !== null);
  if (!obs.length) return <span className="text-xs text-slate-400">no data</span>;
  const lo = Math.min(60, ...obs); const hi = Math.max(140, ...obs);
  const n = Math.max(2, values.length);
  const x = (i: number) => 2 + (i / (n - 1)) * (W - 4);
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  const fit = fittedLine(values);
  const firstObs = values.findIndex((v) => v !== null);
  const lastObs = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
  const color = verdict === 'favorable' || verdict === 'unfavorable' ? VERDICT[verdict].color : '#64748b';
  return (
    <svg width={W} height={H} role="img" aria-label="Throughput per cost index over time">
      <line x1={0} x2={W} y1={y(100)} y2={y(100)} stroke="#cbd5e1" strokeDasharray="3 3" />
      {fit && verdict !== 'insufficient' ? (
        <line x1={x(firstObs)} x2={x(lastObs)} y1={y(fit[0] + fit[1] * firstObs)} y2={y(fit[0] + fit[1] * lastObs)} stroke={color} strokeWidth={1} strokeDasharray="4 2" opacity={0.8} />
      ) : null}
      <path d={linePath(values, x, y)} fill="none" stroke="#334155" strokeWidth={1.5} strokeLinejoin="round" />
      {obs.length === 1 ? <circle cx={x(firstObs)} cy={y(obs[0])} r={2.5} fill="#334155" /> : null}
    </svg>
  );
}

/** Landscape index over time: line, 100 baseline, fitted trend, hover readout. */
function LandscapeChart({ data }: { data: FlowEfficiencyResponse }) {
  const [hover, setHover] = useState<number | null>(null);
  const { index, completed, trend } = data.landscape;
  const W = 900; const H = 200;
  const PAD = { l: 40, r: 12, t: 10, b: 22 };
  const obs = index.filter((v): v is number => v !== null);
  const lo = Math.floor(Math.min(80, ...obs) / 20) * 20;
  const hi = Math.ceil(Math.max(120, ...obs) / 20) * 20;
  const tickStep = (hi - lo) / 4 >= 50 ? 50 : (hi - lo) / 4 >= 20 ? 20 : 10;
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += tickStep) ticks.push(v);
  const n = Math.max(2, index.length);
  const x = (i: number) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  const fit = fittedLine(index);
  const firstObs = index.findIndex((v) => v !== null);
  const lastObs = index.length - 1 - [...index].reverse().findIndex((v) => v !== null);
  const trendColor = trend.verdict === 'favorable' || trend.verdict === 'unfavorable' ? VERDICT[trend.verdict].color : '#64748b';
  const labels = [0, Math.floor((index.length - 1) / 2), index.length - 1];
  return (
    <div>
      <div className="h-4 text-xs text-slate-600">
        {hover !== null ? (
          <>
            <span className="text-slate-500">{bucketLabel(data.buckets[hover], data.stepSeconds)}</span>{' · '}
            {index[hover] === null ? 'no telemetry' : <><span className="font-semibold text-slate-800">{num(index[hover]!, 1)}</span> index · {completed[hover]} completed</>}
          </>
        ) : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Landscape throughput per cost index over time" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={t === 100 ? '#94a3b8' : '#eef2f7'} strokeDasharray={t === 100 ? '4 3' : undefined} />
            <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#64748b">{t}</text>
          </g>
        ))}
        <text x={W - PAD.r} y={y(100) - 4} textAnchor="end" fontSize={10} fill="#64748b">window average = 100</text>
        {fit && trend.verdict !== 'insufficient' && firstObs >= 0 ? (
          <line x1={x(firstObs)} x2={x(lastObs)} y1={y(fit[0] + fit[1] * firstObs)} y2={y(fit[0] + fit[1] * lastObs)} stroke={trendColor} strokeWidth={1.5} strokeDasharray="6 3" />
        ) : null}
        <path d={linePath(index, x, y)} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {index.map((v, i) => (v === null ? null : (
          <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3} fill="#2a78d6" stroke="#fff" strokeWidth={2} />
        )))}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="#94a3b8" /> : null}
        {index.map((_, i) => (
          <rect key={`hit-${i}`} x={x(i) - (W / n) / 2} y={PAD.t} width={W / n} height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
        {labels.filter((v, i, a) => a.indexOf(v) === i).map((i, k, a) => (
          <text key={i} x={x(i)} y={H - 6} fontSize={10} fill="#64748b" textAnchor={k === 0 ? 'start' : k === a.length - 1 ? 'end' : 'middle'}>{bucketLabel(data.buckets[i], data.stepSeconds)}</text>
        ))}
      </svg>
    </div>
  );
}

interface FlowEfficiencyBoardProps {
  onOpenFlow?: (flow: { diagramId: string; neighborhoodName: string | null }) => void;
}

export default function FlowEfficiencyBoard({ onOpenFlow }: FlowEfficiencyBoardProps) {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<FlowEfficiencyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState<string>('all');
  const [verdict, setVerdict] = useState<'all' | FlowEfficiencyVerdict>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getFlowEfficiency(hours));
      setError(null);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load throughput per cost');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const domains = useMemo(() => [...new Set((data?.flows || []).map((f) => f.domain))].sort(), [data]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.flows || [])
      .filter((f) => (domain === 'all' || f.domain === domain) && (verdict === 'all' || f.trend.verdict === verdict) && (!q || f.name.toLowerCase().includes(q)))
      .sort((a, b) => VERDICT[a.trend.verdict].order - VERDICT[b.trend.verdict].order
        || (a.trend.verdict === 'favorable' ? (b.trend.change ?? 0) - (a.trend.change ?? 0) : (a.trend.change ?? 0) - (b.trend.change ?? 0))
        || b.trend.observedSteps - a.trend.observedSteps
        || b.totalCompleted - a.totalCompleted
        || a.name.localeCompare(b.name));
  }, [data, search, domain, verdict]);

  const step = data?.stepSeconds || 3600;
  const per = step >= 86400 ? 'day' : step >= 3600 ? 'hour' : `${step / 60} minutes`;

  const columns = [
    {
      title: 'Business process flow',
      key: 'name',
      render: (_: unknown, f: FlowEfficiencyRow) => (
        <div>
          {onOpenFlow ? (
            <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-medium text-blue-700 hover:underline" onClick={() => onOpenFlow({ diagramId: f.diagramId, neighborhoodName: f.neighborhoodName })}>{f.name}</button>
          ) : <span className="text-sm font-medium text-slate-800">{f.name}</span>}
          <div className="text-[11px] text-slate-500">{f.domain}</div>
        </div>
      ),
    },
    { title: `Index over time`, key: 'spark', width: 160, render: (_: unknown, f: FlowEfficiencyRow) => <Sparkline values={f.index} verdict={f.trend.verdict} /> },
    { title: 'Trend', key: 'trend', width: 170, render: (_: unknown, f: FlowEfficiencyRow) => <VerdictTag trend={f.trend} /> },
    {
      title: <Tooltip title="Completed transactions per $1,000 of allocated cost, averaged over the periods with telemetry">Per $1k</Tooltip>,
      key: 'raw', width: 90, align: 'right' as const,
      sorter: (a: FlowEfficiencyRow, b: FlowEfficiencyRow) => (a.rawIndex ?? 0) - (b.rawIndex ?? 0),
      render: (_: unknown, f: FlowEfficiencyRow) => (f.rawIndex === null ? '—' : num(f.rawIndex)),
    },
    {
      title: 'Completed', key: 'completed', width: 95, align: 'right' as const,
      sorter: (a: FlowEfficiencyRow, b: FlowEfficiencyRow) => a.totalCompleted - b.totalCompleted,
      render: (_: unknown, f: FlowEfficiencyRow) => f.totalCompleted.toLocaleString(),
    },
    {
      title: <Tooltip title="Allocated cost for the periods with telemetry ÷ completed transactions">Cost / txn</Tooltip>,
      key: 'cpt', width: 100, align: 'right' as const,
      sorter: (a: FlowEfficiencyRow, b: FlowEfficiencyRow) => (a.costPerTransaction ?? Infinity) - (b.costPerTransaction ?? Infinity),
      render: (_: unknown, f: FlowEfficiencyRow) => (f.costPerTransaction === null ? '—' : money(f.costPerTransaction)),
    },
    {
      title: 'Annual cost', key: 'cost', width: 105, align: 'right' as const,
      sorter: (a: FlowEfficiencyRow, b: FlowEfficiencyRow) => a.annualCost - b.annualCost,
      render: (_: unknown, f: FlowEfficiencyRow) => money(f.annualCost),
    },
  ];

  const explainer = (
    <div className="space-y-1">
      <div><b>Throughput</b>: completed instances of the flow per {per} (failed and abandoned runs don't count).</div>
      <div><b>Cost</b>: the flow's annual TCO{data?.tcoYear ? ` (${data.tcoYear})` : ''} — application run cost allocated by task usage plus its feature dev spend — prorated to each period.</div>
      <div><b>Index</b>: transactions per $1,000, rebased so each flow's window average = 100. Flows of any size then share one scale; 120 means 20% better than that flow's average.</div>
      <div><b>Trend</b>: least-squares slope of the index. Favorable (rising) or unfavorable (falling) only when |t| ≥ 2 (≈95% confidence); otherwise steady. Periods without telemetry are left out, not counted as zero.</div>
      <div className="opacity-80">Cost is a fixed annual allocation, so within a window the index moves with throughput; it shifts with cost when the TCO year changes.</div>
    </div>
  );

  return (
    <section className="rounded-xl border border-solid border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <DashboardOutlined className="text-slate-500" />
        <h2 className="m-0 text-base font-semibold text-slate-800">Throughput per cost</h2>
        <Tooltip title={explainer} overlayStyle={{ maxWidth: 440 }}><InfoCircleOutlined className="text-slate-400" /></Tooltip>
        <span className="text-xs text-slate-500">completed transactions per $1,000 of flow cost · rising is favorable</span>
        {loading ? <Spin size="small" /> : null}
        <Segmented className="ml-auto" size="small" value={hours} onChange={(v) => setHours(Number(v))} options={WINDOWS} />
      </div>

      {error ? <Alert type="warning" showIcon message="Throughput telemetry unavailable" description={<>{error} Start it with <code>mockprod/stack.sh start</code>.</>} /> : null}

      {data && !error ? (
        <>
          <div className="mb-3 grid gap-4 md:grid-cols-[260px_1fr]">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">All costed flows</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-semibold text-slate-900">{data.landscape.rawIndex === null ? '—' : num(data.landscape.rawIndex)}</span>
                <span className="text-xs text-slate-500">transactions per $1k</span>
              </div>
              <div className="mt-1"><VerdictTag trend={data.landscape.trend} /></div>
              <div className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                {(['unfavorable', 'favorable', 'steady', 'insufficient'] as FlowEfficiencyVerdict[]).map((v) => (
                  <button key={v} type="button" onClick={() => setVerdict(verdict === v ? 'all' : v)} className="col-span-2 grid cursor-pointer grid-cols-[1fr_auto] rounded border-0 bg-transparent px-1 py-0.5 text-left hover:bg-slate-50" style={{ outline: verdict === v ? '1px solid #cbd5e1' : undefined }}>
                    <span className="inline-flex items-center gap-1.5" style={{ color: VERDICT[v].ink }}>
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-white" style={{ background: VERDICT[v].color }}>{VERDICT[v].icon}</span>
                      {VERDICT[v].label}
                    </span>
                    <span className="font-medium text-slate-800">{data.counts[v]}</span>
                  </button>
                ))}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">{data.flows.length} flows · {money(data.landscape.annualCost)} annual cost{data.unmatched.length ? ` · ${data.unmatched.length} without cost data (${data.unmatched.map((u) => u.name).join(', ')})` : ''}</div>
            </div>
            <LandscapeChart data={data} />
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Input.Search size="small" allowClear placeholder="Search flows" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
            <Select size="small" value={domain} onChange={setDomain} style={{ width: 240 }} options={[{ value: 'all', label: 'All domains' }, ...domains.map((d) => ({ value: d, label: d }))]} />
            <Segmented
              size="small"
              value={verdict}
              onChange={(v) => setVerdict(v as typeof verdict)}
              options={[{ label: 'All', value: 'all' }, { label: 'Unfavorable', value: 'unfavorable' }, { label: 'Favorable', value: 'favorable' }, { label: 'Steady', value: 'steady' }]}
            />
            <span className="ml-auto text-xs text-slate-500">{rows.length} flows · unfavorable trends first</span>
          </div>
          <Table<FlowEfficiencyRow> size="small" rowKey="diagramId" columns={columns} dataSource={rows} pagination={{ pageSize: 12, showSizeChanger: false }} />
        </>
      ) : null}
    </section>
  );
}
