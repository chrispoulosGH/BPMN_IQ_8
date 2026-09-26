import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty } from 'antd';
import { RAG_COLOR } from '../utils/domainExposure';
import type { ProcessChangeSnapshot } from '../types';

interface ProcessChangeTrendChartProps {
  history: ProcessChangeSnapshot[];
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
 */
export default function ProcessChangeTrendChart({ history }: ProcessChangeTrendChartProps) {
  if (history.length < 2) {
    return (
      <div className="flex h-[160px] items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            history.length === 1
              ? "Only one day recorded so far — come back tomorrow to see a trend."
              : 'No history yet — opening this tab records a data point for today.'
          }
        />
      </div>
    );
  }

  const data = history.map((s) => ({
    date: s.date,
    label: formatDateTick(s.date),
    'On track': s.greenCount,
    'Needs attention': s.amberCount,
    Critical: s.redCount,
  }));

  return (
    <div className="h-[160px] w-full rounded-lg border border-slate-200 bg-white p-2">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e1e0d9" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8892a6' }} axisLine={{ stroke: '#c3c2b7' }} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#8892a6' }} axisLine={false} tickLine={false} width={28} />
          <Tooltip
            formatter={(value, name) => [`${value} flow${value === 1 ? '' : 's'}`, name]}
            labelFormatter={(_label, payload) => (payload && payload[0] ? (payload[0].payload as { date: string }).date : '')}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
          <Area type="monotone" dataKey="On track" stackId="rag" stroke={RAG_COLOR.green} fill={RAG_COLOR.green} fillOpacity={0.25} strokeWidth={2} />
          <Area type="monotone" dataKey="Needs attention" stackId="rag" stroke={RAG_COLOR.amber} fill={RAG_COLOR.amber} fillOpacity={0.3} strokeWidth={2} />
          <Area type="monotone" dataKey="Critical" stackId="rag" stroke={RAG_COLOR.red} fill={RAG_COLOR.red} fillOpacity={0.35} strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
