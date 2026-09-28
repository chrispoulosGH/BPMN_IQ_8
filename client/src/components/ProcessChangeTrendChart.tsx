import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty } from 'antd';
import { RAG_COLOR } from '../utils/domainExposure';
import type { ProcessChangeSnapshot } from '../types';

interface ProcessChangeTrendChartProps {
  history: ProcessChangeSnapshot[];
  /** Scope the chart to one domain's counts (from each day's byDomain
   * breakdown) instead of the whole-landscape aggregate. */
  domain?: string;
  /** Chart height in px — the global chart and the per-domain mini charts
   * share this component but want different sizes. */
  height?: number;
  /** Hide the legend for the small per-domain charts, where the color
   * meaning is already established by the global chart above them. */
  showLegend?: boolean;
}

function formatDateTick(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Stacked area trend of on-track/needs-attention/critical flow counts, one
 * point per day the Process Change Heat Map was opened (see
 * server/models/ProcessChangeSnapshot.js — there's no periodic job, a
 * visit *is* the snapshot). Stacked green-at-bottom, red-on-top so the
 * total band height is "flows impacted that day" and the reddest layer is
 * the one most likely to draw the eye. Same RAG_COLOR palette as the grid
 * below it and the Dashboard tab's Change Exposure Board, so a color never
 * means something different from one view to the next.
 *
 * Reused twice: once for the whole-landscape aggregate (no `domain` prop —
 * reads the snapshot's top-level counts) and once per domain, sorted by
 * criticality by the caller (ProcessChangeHeatMap passes `domain` — reads
 * that day's byDomain entry instead). A history row recorded before
 * byDomain existed just has no entry for a domain, which is treated the
 * same as "no data that day" rather than zero.
 */
export default function ProcessChangeTrendChart({ history, domain, height = 160, showLegend = true }: ProcessChangeTrendChartProps) {
  const points = domain
    ? history
        .map((s) => {
          const d = s.byDomain?.find((b) => b.domain === domain);
          if (!d) return null;
          return { date: s.date, greenCount: d.greenCount, amberCount: d.amberCount, redCount: d.redCount };
        })
        .filter((p): p is { date: string; greenCount: number; amberCount: number; redCount: number } => p !== null)
    : history.map((s) => ({ date: s.date, greenCount: s.greenCount, amberCount: s.amberCount, redCount: s.redCount }));

  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50" style={{ height }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            points.length === 1
              ? 'Only one day recorded so far — come back tomorrow to see a trend.'
              : 'No history yet — opening this tab records a data point for today.'
          }
        />
      </div>
    );
  }

  const data = points.map((p) => ({
    date: p.date,
    label: formatDateTick(p.date),
    'On track': p.greenCount,
    'Needs attention': p.amberCount,
    Critical: p.redCount,
  }));

  return (
    <div className="w-full rounded-lg border border-slate-200 bg-white p-2" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8892a6' }} axisLine={{ stroke: '#c3c2b7' }} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#8892a6' }} axisLine={false} tickLine={false} width={28} />
          <Tooltip
            formatter={(value, name) => [`${value} flow${value === 1 ? '' : 's'}`, name]}
            labelFormatter={(_label, payload) => (payload && payload[0] ? (payload[0].payload as { date: string }).date : '')}
          />
          {showLegend && <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />}
          <Area type="monotone" dataKey="On track" stackId="rag" stroke={RAG_COLOR.green} fill={RAG_COLOR.green} fillOpacity={0.25} strokeWidth={2} />
          <Area type="monotone" dataKey="Needs attention" stackId="rag" stroke={RAG_COLOR.amber} fill={RAG_COLOR.amber} fillOpacity={0.3} strokeWidth={2} />
          <Area type="monotone" dataKey="Critical" stackId="rag" stroke={RAG_COLOR.red} fill={RAG_COLOR.red} fillOpacity={0.35} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
