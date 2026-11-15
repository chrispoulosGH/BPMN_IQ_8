import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Segmented, Spin, Tooltip } from 'antd';
import { CarOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { getVehiclesSold } from '../api';
import type { VehiclesSoldResponse } from '../types';

/**
 * Dashboard › Vehicles sold — live from production telemetry
 * (GET /api/business-kpis/vehicles-sold). A vehicle counts once, when it
 * changes hands (delivery / fleet delivery / wholesale completion), however
 * many flows its deal went through.
 */

const BAR = '#2563eb';
const CHANNEL_LABEL: Record<string, string> = { online: 'Online', 'in-store': 'In-store', fleet: 'Fleet', wholesale: 'Wholesale (used)' };
const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`);

export default function VehiclesSoldTile() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<VehiclesSoldResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getVehiclesSold(hours));
      setError(null);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load vehicles sold');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Channel totals (new + used rows of the same channel merged) and the hourly total series.
  const channels = useMemo(() => {
    const byChannel = new Map<string, { units: number; revenue: number }>();
    for (const c of data?.channels || []) {
      const entry = byChannel.get(c.channel) || { units: 0, revenue: 0 };
      entry.units += c.units;
      entry.revenue = Math.max(entry.revenue, c.revenue);
      byChannel.set(c.channel, entry);
    }
    return [...byChannel.entries()].map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.units - a.units);
  }, [data]);
  const buckets = useMemo(() => {
    // Sum channels per bucket, then place them on the full zero-filled timeline.
    const totals = new Map<number, number>();
    for (const s of data?.series || []) for (const p of s.points) totals.set(p.t, (totals.get(p.t) || 0) + p.units);
    const step = (data?.stepSeconds || 3600) * 1000;
    const nearest = (t: number) => {
      for (const [bt, units] of totals) if (Math.abs(bt - t) < step / 2) return units;
      return 0;
    };
    return (data?.buckets || []).map((t) => ({ t, units: nearest(t) }));
  }, [data]);
  const maxChannel = Math.max(1, ...channels.map((c) => c.units));
  const maxBucket = Math.max(1, ...buckets.map((b) => b.units));
  const bucketLabel = (t: number) => {
    const d = new Date(t);
    return (data?.stepSeconds || 3600) >= 86400 ? d.toLocaleDateString() : d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
  };

  return (
    <section className="rounded-xl border border-solid border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <CarOutlined className="text-slate-500" />
        <h2 className="m-0 text-base font-semibold text-slate-800">Vehicles sold</h2>
        <Tooltip title={data?.definition || 'Counted when the vehicle changes hands, once per deal.'} overlayStyle={{ maxWidth: 360 }}>
          <InfoCircleOutlined className="text-slate-400" />
        </Tooltip>
        <span className="text-xs text-slate-500">live from production telemetry</span>
        {loading ? <Spin size="small" /> : null}
        <Segmented
          className="ml-auto"
          size="small"
          value={hours}
          onChange={(v) => setHours(Number(v))}
          options={[{ label: '24 h', value: 24 }, { label: '7 days', value: 168 }, { label: '30 days', value: 720 }]}
        />
      </div>

      {error ? <Alert type="warning" showIcon message="Sales telemetry unavailable" description={error} /> : null}

      {data && !error ? (
        <div className="grid gap-5 md:grid-cols-[220px_1fr_1.4fr]">
          <div>
            <div className="text-4xl font-semibold leading-none text-slate-900">{data.totalUnits.toLocaleString()}</div>
            <div className="mt-1 text-xs text-slate-500">vehicles in the last {hours >= 168 ? `${Math.round(hours / 24)} days` : `${hours} hours`}</div>
            <div className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
              <span className="text-slate-500">New</span><span className="text-right font-medium text-slate-800">{data.newUnits.toLocaleString()}</span>
              <span className="text-slate-500">Used</span><span className="text-right font-medium text-slate-800">{data.usedUnits.toLocaleString()}</span>
              <span className="text-slate-500">Revenue</span><span className="text-right font-medium text-slate-800">{money(data.revenue)}</span>
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">By channel</div>
            {channels.map((c) => (
              <div key={c.channel} className="mb-1.5 grid grid-cols-[110px_1fr_48px] items-center gap-2 text-sm">
                <span className="text-slate-700">{CHANNEL_LABEL[c.channel] || c.channel}</span>
                <Tooltip title={`${c.units} vehicles · ${money(c.revenue)}`}>
                  <div className="h-2.5 rounded bg-slate-100">
                    <div className="h-2.5 rounded" style={{ width: `${(c.units / maxChannel) * 100}%`, background: BAR, minWidth: c.units ? 3 : 0 }} />
                  </div>
                </Tooltip>
                <span className="text-right font-medium text-slate-800">{c.units}</span>
              </div>
            ))}
          </div>

          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Per {(data.stepSeconds || 3600) >= 86400 ? 'day' : (data.stepSeconds || 3600) > 3600 ? `${(data.stepSeconds || 3600) / 3600} hours` : 'hour'}
            </div>
            <div className="flex h-[92px] items-end gap-[2px]" role="img" aria-label="Vehicles sold over time">
              {buckets.map((b) => (
                <Tooltip key={b.t} title={`${bucketLabel(b.t)}: ${b.units} vehicles`}>
                  <div className="flex-1 rounded-t-sm" style={{ height: `${Math.max(b.units ? 4 : 1, (b.units / maxBucket) * 92)}px`, background: b.units ? BAR : '#e2e8f0' }} />
                </Tooltip>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-400">
              <span>{buckets[0] ? bucketLabel(buckets[0].t) : ''}</span>
              <span>{buckets.length ? bucketLabel(buckets[buckets.length - 1].t) : ''}</span>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
