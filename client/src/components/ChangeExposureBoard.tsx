import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Spin, Tag, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { getProcessChangeRadar } from '../api';
import { computeDomainExposure, RAG_COLOR, RAG_LABEL, type DomainExposureSummary } from '../utils/domainExposure';

const { Title, Text } = Typography;

function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const fraction = rawStep / Math.pow(10, exponent);
  const niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  return niceFraction * Math.pow(10, exponent);
}

/** 4 evenly spaced ticks from 0 up to a round number that clears maxValue. */
function computeAxis(maxValue: number, tickCount = 4): { axisMax: number; ticks: number[] } {
  if (maxValue <= 0) return { axisMax: tickCount, ticks: Array.from({ length: tickCount + 1 }, (_, i) => i) };
  const step = niceStep((maxValue * 1.1) / tickCount) || 1;
  let axisMax = step * tickCount;
  while (axisMax < maxValue) axisMax += step;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round(step * i));
  return { axisMax, ticks: [...new Set(ticks)].filter((t) => t <= axisMax) };
}

const fmt = (n: number) => n.toLocaleString();

interface ChangeExposureBoardProps {
  /** Called when the reader wants to drill into one domain's flows — App.tsx
   * wires this to jump to the Process Change Radar tab pre-filtered to it. */
  onSelectDomain?: (domain: string) => void;
}

/**
 * Executive "is my area OK, or do I need to act" rollup — one row per
 * business domain, bar length = story points in flight, color = how much of
 * that is overdue / due soon / on track. First widget on the new Dashboard
 * tab (see App.tsx); built from the same Process Change Radar data as that
 * tab, aggregated by utils/domainExposure.ts. Fetches its own fresh copy —
 * deliberately not sharing state with the Process Change Radar tab, which
 * unmounts/remounts on every visit (destroyInactiveTabPane) and would make a
 * shared cache stale as often as not.
 */
export default function ChangeExposureBoard({ onSelectDomain }: ChangeExposureBoardProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [exposure, setExposure] = useState<DomainExposureSummary | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    try {
      const data = await getProcessChangeRadar();
      setGeneratedAt(data.generatedAt);
      setExposure(computeDomainExposure(data, new Date(data.generatedAt)));
    } catch (err: any) {
      const responseData = err?.response?.data;
      if (responseData?.configured === false) setNotConfigured(true);
      setError(responseData?.error || err?.message || 'Failed to load Change Exposure Board.');
      setExposure(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const maxDomainPoints = useMemo(
    () => Math.max(0, ...(exposure?.domains.map((d) => d.totalPoints) || [])),
    [exposure]
  );
  const { axisMax, ticks } = useMemo(() => computeAxis(maxDomainPoints), [maxDomainPoints]);

  const attentionCount = exposure ? exposure.ragCounts.amber + exposure.ragCounts.red : 0;
  const domainCount = exposure?.domains.length || 0;
  const atRiskPct = exposure && exposure.totals.totalPoints > 0
    ? Math.round(((exposure.totals.overduePoints + exposure.totals.dueSoon7Points) / exposure.totals.totalPoints) * 100)
    : 0;
  const nearestDueLabel = exposure?.totals.nearestDue
    ? new Date(exposure.totals.nearestDue + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '—';

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <div>
          <Title level={5} className="!mb-0.5">Change Exposure Board</Title>
          <Text type="secondary" className="text-xs">Story-point exposure and date jeopardy across every business domain touched by in-flight Jira work.</Text>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {generatedAt && !loading && (
            <Text type="secondary" className="text-xs">as of {new Date(generatedAt).toLocaleTimeString()}</Text>
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>Refresh</Button>
        </div>
      </div>

      <div className="p-5">
        {loading && (
          <div className="flex items-center justify-center py-14">
            <Spin tip="Querying Jira for in-flight changes…" />
          </div>
        )}
        {!loading && notConfigured && (
          <Empty description={<span className="max-w-md text-sm text-slate-600">{error}</span>} />
        )}
        {!loading && !notConfigured && error && (
          <Alert type="error" showIcon message="Couldn't load Change Exposure Board" description={error} />
        )}
        {!loading && !notConfigured && !error && exposure && !exposure.domains.length && (
          <Empty description="No business process flows are currently affected by in-flight Jira changes." />
        )}
        {!loading && !notConfigured && !error && exposure && exposure.domains.length > 0 && (
          <>
            {/* ---------- KPI strip ---------- */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-slate-200 p-3.5" style={{ borderTopWidth: 3, borderTopColor: attentionCount ? RAG_COLOR.amber : RAG_COLOR.green }}>
                <div className="text-xs font-medium text-slate-500">Domains needing attention</div>
                <div className="mt-1 font-mono text-2xl font-semibold text-slate-900">
                  {attentionCount}<span className="text-base font-normal text-slate-400"> / {domainCount}</span>
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <Tag color="gold" className="!m-0">{exposure.ragCounts.amber} amber</Tag>
                  <Tag color="red" className="!m-0">{exposure.ragCounts.red} red</Tag>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3.5">
                <div className="text-xs font-medium text-slate-500">Points at risk (≤ 7 days)</div>
                <div className="mt-1 font-mono text-2xl font-semibold text-slate-900">{fmt(exposure.totals.overduePoints + exposure.totals.dueSoon7Points)}</div>
                <div className="mt-1.5 text-xs text-slate-400">{atRiskPct}% of all points in flight{exposure.totals.overduePoints > 0 ? ` — ${fmt(exposure.totals.overduePoints)} already overdue` : ' — none yet overdue'}</div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3.5">
                <div className="text-xs font-medium text-slate-500">Points in flight</div>
                <div className="mt-1 font-mono text-2xl font-semibold text-slate-900">{fmt(exposure.totals.totalPoints)}</div>
                <div className="mt-1.5 text-xs text-slate-400">≈ {fmt(exposure.totals.totalPoints)} dev-days across {exposure.totals.flowCount} flows, {domainCount} domains</div>
              </div>
              <div className="rounded-lg border border-slate-200 p-3.5">
                <div className="text-xs font-medium text-slate-500">Nearest due date</div>
                <div className="mt-1 font-mono text-2xl font-semibold text-slate-900">{nearestDueLabel}</div>
                <div className="mt-1.5 text-xs text-slate-400">click a domain below to see its flows</div>
              </div>
            </div>

            {/* ---------- chart ---------- */}
            <div className="mt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-slate-700">Story points by domain, colored by jeopardy</div>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RAG_COLOR.green }} />On track</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RAG_COLOR.amber }} />Due within 7 days</span>
                  <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RAG_COLOR.red }} />Overdue</span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className="min-w-[560px]">
                  {/* ruler */}
                  <div className="mb-1.5 grid grid-cols-[200px_1fr_70px] items-center gap-3">
                    <div />
                    <div className="relative h-4">
                      {ticks.map((t) => (
                        <div key={t} className="absolute top-0 h-full border-l border-slate-200" style={{ left: (t / axisMax * 100) + '%' }}>
                          <span className="absolute -top-0.5 left-0 text-[10px] text-slate-400" style={{ transform: t === 0 ? undefined : 'translateX(-50%)' }}>{t === 0 ? '0' : fmt(t)}</span>
                        </div>
                      ))}
                    </div>
                    <div />
                  </div>

                  {exposure.domains.map((d) => {
                    const segments = [
                      { key: 'on-track', value: d.onTrackPoints, label: 'On track', color: RAG_COLOR.green },
                      { key: 'due-soon', value: d.dueSoon7Points, label: 'Due within 7 days', color: RAG_COLOR.amber },
                      { key: 'overdue', value: d.overduePoints, label: 'Overdue', color: RAG_COLOR.red },
                    ].filter((s) => s.value > 0);
                    const barWidthPct = Math.min(100, (d.totalPoints / axisMax) * 100);
                    return (
                      <button
                        key={d.domain}
                        type="button"
                        onClick={() => onSelectDomain?.(d.domain)}
                        className="grid w-full grid-cols-[200px_1fr_70px] items-center gap-3 border-b border-slate-100 py-1.5 text-left last:border-b-0 hover:bg-slate-50"
                        title={`View ${d.domain} flows in Process Change Radar`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-slate-800">{d.domain}</div>
                          <div className="text-[11px] text-slate-400">{d.flowCount} flow{d.flowCount === 1 ? '' : 's'} · {RAG_LABEL[d.rag]}</div>
                        </div>
                        <div className="h-6">
                          <div className="flex h-full gap-0.5" style={{ width: barWidthPct + '%' }}>
                            {segments.map((seg, idx) => (
                              <Tooltip key={seg.key} title={`${d.domain} — ${seg.label}: ${fmt(seg.value)} pts`}>
                                <div
                                  className={idx === 0 ? 'rounded-l' : idx === segments.length - 1 ? 'rounded-r' : ''}
                                  style={{ flexBasis: (seg.value / d.totalPoints * 100) + '%', background: seg.color, height: '100%' }}
                                />
                              </Tooltip>
                            ))}
                          </div>
                        </div>
                        <div className="text-right font-mono text-xs text-slate-600">{fmt(d.totalPoints)} pts</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowTable((v) => !v)}
                className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                {showTable ? '▾' : '▸'} View as table
              </button>

              {showTable && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="border-b border-slate-200 px-2 py-1.5 text-left">Domain</th>
                        <th className="border-b border-slate-200 px-2 py-1.5 text-left">Status</th>
                        <th className="border-b border-slate-200 px-2 py-1.5 text-right">Flows</th>
                        <th className="border-b border-slate-200 px-2 py-1.5 text-right">Points</th>
                        <th className="border-b border-slate-200 px-2 py-1.5 text-right">On track</th>
                        <th className="border-b border-slate-200 px-2 py-1.5 text-right">Due ≤ 7d</th>
                        <th className="border-b border-slate-200 px-2 py-1.5 text-right">Overdue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exposure.domains.map((d) => (
                        <tr key={d.domain} className="hover:bg-slate-50">
                          <td className="border-b border-slate-100 px-2 py-1.5">{d.domain}</td>
                          <td className="border-b border-slate-100 px-2 py-1.5">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: RAG_COLOR[d.rag] }} />
                              {RAG_LABEL[d.rag]}
                            </span>
                          </td>
                          <td className="border-b border-slate-100 px-2 py-1.5 text-right font-mono">{d.flowCount}</td>
                          <td className="border-b border-slate-100 px-2 py-1.5 text-right font-mono">{fmt(d.totalPoints)}</td>
                          <td className="border-b border-slate-100 px-2 py-1.5 text-right font-mono">{fmt(d.onTrackPoints)}</td>
                          <td className="border-b border-slate-100 px-2 py-1.5 text-right font-mono">{fmt(d.dueSoon7Points)}</td>
                          <td className="border-b border-slate-100 px-2 py-1.5 text-right font-mono">{fmt(d.overduePoints)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-400">
                <b className="text-slate-500">Reading this board:</b> a domain's bar reflects every story point in flight for the flows in it; an issue that touches flows in more than one domain counts in each, so domain totals can add up to more than the {fmt(exposure.totals.totalPoints)}-point portfolio total above.
                {' '}<b className="text-slate-500">Click a domain</b> to open its flows in Process Change Radar.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
