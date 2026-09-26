import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Spin, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { getProcessChangeHistory, getProcessChangeRadar, saveProcessChangeSnapshot } from '../api';
import { computeDomainExposure, computeFlowExposure, RAG_COLOR, RAG_LABEL, RAG_TEXT_COLOR, type FlowExposure } from '../utils/domainExposure';
import ProcessChangeTrendChart from './ProcessChangeTrendChart';
import type { ProcessChangeSnapshot } from '../types';

const { Title, Text } = Typography;

const fmt = (n: number) => n.toLocaleString();

interface DomainGroup {
  domain: string;
  flows: FlowExposure[];
  worstRag: FlowExposure['rag'];
  maxRatio: number;
}

interface ProcessChangeHeatMapProps {
  /** Called when the reader clicks a flow tile — App.tsx wires this to jump
   * to the Process Change Radar tab with that exact flow selected. */
  onSelectFlow?: (flow: { diagramId: string; domain: string }) => void;
}

/**
 * "Process Change Heat Map" — every business flow Process Change Radar has
 * matched at least one Jira issue to, laid out as a grid of uniform tiles
 * grouped by domain, colored red/amber/green by current jeopardy (see
 * classifyIssues in utils/domainExposure.ts — the same jeopardy math and the
 * same RAG_COLOR palette the Dashboard tab's Change Exposure Board uses,
 * just applied per-flow instead of per-domain, so a flow is never one color
 * here and a different one there). Deliberately flat categorical color, not
 * a continuous gradient — the underlying rag classification is a discrete
 * judgment call (e.g. "amber" just means *any* due-soon/overdue issue,
 * regardless of how much), so a smooth ramp would visually promise more
 * precision than the data actually carries and could show a flow the legend
 * calls "critical" rendered as barely-tinted green. A true heat map (uniform
 * cells, color-only encoding) rather than the Dashboard's magnitude-sorted
 * bars — this view is for scanning every flow at once, not comparing
 * domain-level scope.
 */
export default function ProcessChangeHeatMap({ onSelectFlow }: ProcessChangeHeatMapProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [flows, setFlows] = useState<FlowExposure[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [history, setHistory] = useState<ProcessChangeSnapshot[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    try {
      const data = await getProcessChangeRadar();
      const referenceDate = new Date(data.generatedAt);
      const computedFlows = computeFlowExposure(data, referenceDate);
      setGeneratedAt(data.generatedAt);
      setFlows(computedFlows);

      // Today's row for the trend chart — a visit to this tab *is* the
      // snapshot (see server/models/ProcessChangeSnapshot.js). Uses the
      // domain rollup's already-deduped totals rather than summing per-flow
      // numbers, since the same issue can touch more than one flow.
      const { totals } = computeDomainExposure(data, referenceDate);
      const snapshot: ProcessChangeSnapshot = {
        date: data.generatedAt.slice(0, 10),
        generatedAt: data.generatedAt,
        totalFlows: computedFlows.length,
        redCount: computedFlows.filter((f) => f.rag === 'red').length,
        amberCount: computedFlows.filter((f) => f.rag === 'amber').length,
        greenCount: computedFlows.filter((f) => f.rag === 'green').length,
        totalIssues: totals.issueCount,
        totalPoints: totals.totalPoints,
        overduePoints: totals.overduePoints,
        dueSoon7Points: totals.dueSoon7Points,
      };
      // Best-effort — a failed snapshot write shouldn't block the heat map
      // itself from showing today's data, so this is deliberately not
      // awaited into the same try/catch as the rest of the load.
      saveProcessChangeSnapshot(snapshot)
        .then(() => getProcessChangeHistory())
        .then(setHistory)
        .catch(() => {});
    } catch (err: any) {
      const responseData = err?.response?.data;
      if (responseData?.configured === false) setNotConfigured(true);
      setError(responseData?.error || err?.message || 'Failed to load Process Change Heat Map.');
      setFlows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Loaded independently of (and in parallel with) the Jira fetch above, so
  // prior days' history shows immediately instead of waiting on today's
  // snapshot round-trip — that round-trip still re-fetches this afterward
  // (see the .then(getProcessChangeHistory) chain above) to pick up today's
  // freshly-posted point once it lands.
  useEffect(() => { getProcessChangeHistory().then(setHistory).catch(() => {}); }, []);

  useEffect(() => { void load(); }, [load]);

  const ragRank: Record<FlowExposure['rag'], number> = { red: 2, amber: 1, green: 0 };

  const groups = useMemo<DomainGroup[]>(() => {
    const byDomain = new Map<string, FlowExposure[]>();
    for (const flow of flows) {
      if (!byDomain.has(flow.domain)) byDomain.set(flow.domain, []);
      byDomain.get(flow.domain)!.push(flow);
    }
    const result: DomainGroup[] = [];
    for (const [domain, domainFlows] of byDomain.entries()) {
      domainFlows.sort((a, b) => b.jeopardyRatio - a.jeopardyRatio);
      const worstRag = domainFlows.reduce<FlowExposure['rag']>(
        (worst, f) => (ragRank[f.rag] > ragRank[worst] ? f.rag : worst), 'green'
      );
      const maxRatio = Math.max(0, ...domainFlows.map((f) => f.jeopardyRatio));
      result.push({ domain, flows: domainFlows, worstRag, maxRatio });
    }
    result.sort((a, b) => (ragRank[b.worstRag] - ragRank[a.worstRag]) || (b.maxRatio - a.maxRatio) || a.domain.localeCompare(b.domain));
    return result;
  }, [flows]);

  const ragCounts = useMemo(() => ({
    red: flows.filter((f) => f.rag === 'red').length,
    amber: flows.filter((f) => f.rag === 'amber').length,
    green: flows.filter((f) => f.rag === 'green').length,
  }), [flows]);

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <div>
          <Title level={5} className="!mb-0.5">Process Change Heat Map</Title>
          <Text type="secondary" className="text-xs">Current state of every business flow touched by in-flight Jira work — color shows on track / needs attention / critical.</Text>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!loading && !error && flows.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span>{flows.length} flow{flows.length === 1 ? '' : 's'}</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#f5222d' }} />{ragCounts.red} critical</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#faad14' }} />{ragCounts.amber} needs attention</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: '#52c41a' }} />{ragCounts.green} on track</span>
            </div>
          )}
          {generatedAt && !loading && (
            <Text type="secondary" className="text-xs">as of {new Date(generatedAt).toLocaleTimeString()}</Text>
          )}
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>Refresh</Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70">
            <Spin size="large" tip="Querying Jira for in-flight changes…" />
          </div>
        )}
        {!loading && notConfigured && (
          <div className="flex h-full items-center justify-center p-8">
            <Empty description={<span className="max-w-md text-sm text-slate-600">{error}</span>} />
          </div>
        )}
        {!loading && !notConfigured && error && (
          <div className="p-4">
            <Alert type="error" showIcon message="Couldn't load Process Change Heat Map" description={error} />
          </div>
        )}
        {!loading && !notConfigured && !error && !flows.length && (
          <div className="flex h-full items-center justify-center p-8">
            <Empty description="No business process flows are currently affected by in-flight Jira changes." />
          </div>
        )}
        {!loading && !notConfigured && !error && flows.length > 0 && (
          <div className="flex flex-col gap-5 p-4">
            <div>
              <div className="mb-2 text-[13px] font-semibold text-slate-700">Trend</div>
              <ProcessChangeTrendChart history={history} />
            </div>
            {groups.map((group) => (
              <div key={group.domain}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-slate-700">{group.domain}</span>
                  <span className="text-[11px] text-slate-400">{group.flows.length} flow{group.flows.length === 1 ? '' : 's'}</span>
                </div>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}>
                  {group.flows.map((flow) => {
                    const bg = RAG_COLOR[flow.rag];
                    const ink = RAG_TEXT_COLOR[flow.rag];
                    return (
                      <Tooltip
                        key={flow.diagramId}
                        title={(
                          <div>
                            <div className="font-semibold">{flow.name}</div>
                            <div className="mt-1 text-xs opacity-90">
                              {RAG_LABEL[flow.rag]} · {fmt(flow.issueCount)} issue{flow.issueCount === 1 ? '' : 's'} · {fmt(flow.totalPoints)} pts
                              {flow.overdueCount > 0 && <> · {flow.overdueCount} overdue</>}
                            </div>
                          </div>
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => onSelectFlow?.({ diagramId: flow.diagramId, domain: flow.domain })}
                          className="flex h-[72px] flex-col justify-between rounded-lg p-2.5 text-left shadow-sm transition-transform hover:scale-[1.03] hover:shadow-md"
                          style={{ background: bg, color: ink }}
                        >
                          <span className="line-clamp-2 text-[11.5px] font-medium leading-tight">{flow.name}</span>
                          <span className="text-[10.5px] font-semibold opacity-90">{fmt(flow.issueCount)} issue{flow.issueCount === 1 ? '' : 's'}</span>
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
